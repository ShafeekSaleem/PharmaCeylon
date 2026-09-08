import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PaymentMethod,
  Prisma,
  RoleName,
  SaleStatus,
  StockMovementType,
  GoodsReturnStatus,
  GoodsReturnType,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import {
  isPrismaUniqueFieldError,
  normalizeIdempotencyKey,
} from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TaxService } from "../pricing/tax.service";
import { CheckoutDto } from "./dto/checkout.dto";
import { RefundSaleDto } from "./dto/refund-sale.dto";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { softRxMatchWarnings } from "./rx-match.util";
import { SetupReadinessService } from "../setup/setup-readiness.service";
import {
  getSaleReturnableByLine,
  refundUnitPrice,
  saleLineKey,
  totalRemainingQty,
} from "./sale-returnable";

/** Everything a receipt / POS success state needs, in one shape. */
const SALE_INCLUDE = {
  items: { include: { product: true, batch: true } },
  payments: true,
  customer: { select: { id: true, fullName: true, phone: true } },
  prescription: {
    select: { id: true, rxNumber: true, patientName: true, doctorName: true },
  },
  seller: { select: { id: true, fullName: true } },
  dispenser: { select: { id: true, fullName: true } },
} satisfies Prisma.SaleInclude;

async function qtyForBatchTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  batchId: string,
): Promise<number> {
  const agg = await tx.stockLedger.aggregate({
    where: { tenantId, branchId, batchId },
    _sum: { qtyDelta: true },
  });
  return agg._sum.qtyDelta ?? 0;
}

function d(s: string): Prisma.Decimal {
  return new Prisma.Decimal(s);
}

/** UTC calendar date at 00:00:00.000Z for "today". */
function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function isBatchExpired(
  expiryDate: Date,
  todayUtc = startOfTodayUtc(),
): boolean {
  const exp = new Date(expiryDate);
  const expUtc = new Date(
    Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate()),
  );
  return expUtc < todayUtc;
}

/** `INV-YYMM-000123` — human-readable at the counter, unique per branch. */
async function nextInvoiceNo(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<string> {
  const now = new Date();
  const period = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return nextDocumentNumber(
    tx,
    tenantId,
    branchId,
    "sale",
    `INV-${period}-`,
    6,
  );
}

type BranchRoleEntry = { branchId: string; role: RoleName };

@Injectable()
export class SalesService {
  private static readonly CONTROLLED_SALE_ROLES: RoleName[] = [
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
  ];

  private static readonly VOID_ROLES: RoleName[] = [
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
  ];

  private static readonly REFUND_ROLES: RoleName[] = [
    RoleName.owner,
    RoleName.manager,
    RoleName.pharmacist,
    RoleName.cashier,
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tax: TaxService,
    private readonly pharmacistApproval: PharmacistApprovalService,
    private readonly setupReadiness: SetupReadinessService,
  ) {}

  private branchEffectiveRoles(
    branchRoles: BranchRoleEntry[],
    branchId: string,
  ): RoleName[] {
    const ownerAnywhere = branchRoles.some((b) => b.role === RoleName.owner);
    const atBranch = branchRoles
      .filter((b) => b.branchId === branchId)
      .map((b) => b.role);
    if (ownerAnywhere) {
      return [...new Set([...atBranch, RoleName.owner])];
    }
    return atBranch;
  }

  /**
   * Prescription-required lines need a linked Rx.
   * Controlled (schedule) lines also need dispense authority: elevated session OR PIN co-sign.
   * Returns dispensedBy user id when authority is resolved (self or approver).
   */
  private async resolveDispenseAuthority(input: {
    tenantId: string;
    branchId: string;
    userId: string;
    branchRoles: BranchRoleEntry[];
    products: Array<{
      id: string;
      name: string;
      isControlled: boolean;
      requiresPrescription: boolean;
    }>;
    prescriptionId: string | undefined;
    pharmacistApproval: CheckoutDto["pharmacistApproval"];
  }): Promise<string | null> {
    const needsRx = input.products.filter(
      (p) => p.requiresPrescription || p.isControlled,
    );
    const controlled = input.products.filter((p) => p.isControlled);

    if (needsRx.length > 0 && !input.prescriptionId) {
      const names = needsRx.map((p) => p.name).join(", ");
      throw new BadRequestException(
        `A prescription must be linked before dispensing: ${names}`,
      );
    }

    if (controlled.length === 0) {
      // Rx-required only — cashier may complete once Rx is linked.
      return input.prescriptionId ? input.userId : null;
    }

    const roles = this.branchEffectiveRoles(input.branchRoles, input.branchId);
    const selfCanDispense = roles.some((r) =>
      SalesService.CONTROLLED_SALE_ROLES.includes(r),
    );
    if (selfCanDispense) return input.userId;

    if (
      !input.pharmacistApproval?.approverUserId ||
      !input.pharmacistApproval.pin
    ) {
      throw new ForbiddenException(
        "Controlled medicines need pharmacist approval. Ask a pharmacist to enter their till PIN, or park this sale for handoff.",
      );
    }

    const verified = await this.pharmacistApproval.verifyApproverPin(
      input.tenantId,
      input.branchId,
      input.pharmacistApproval.approverUserId,
      input.pharmacistApproval.pin,
      input.userId,
    );
    return verified.approverUserId;
  }

  /** Tender validation: never post a sale that is short-paid. */
  private resolvePayments(
    dto: CheckoutDto,
    grandTotal: Prisma.Decimal,
  ): {
    payments: Array<{
      method: PaymentMethod;
      amount: Prisma.Decimal;
      reference: string | null;
    }>;
    amountPaid: Prisma.Decimal;
    changeDue: Prisma.Decimal;
  } {
    const provided = dto.payments ?? [];
    if (provided.length === 0) {
      return {
        payments: [{ method: "cash", amount: grandTotal, reference: null }],
        amountPaid: grandTotal,
        changeDue: new Prisma.Decimal(0),
      };
    }

    const payments = provided.map((p) => {
      const amount = d(p.amount);
      if (amount.lte(0)) {
        throw new BadRequestException(
          "Each payment amount must be greater than zero",
        );
      }
      return {
        method: p.method,
        amount,
        reference: p.reference?.trim() || null,
      };
    });

    const amountPaid = payments.reduce(
      (acc, p) => acc.add(p.amount),
      new Prisma.Decimal(0),
    );
    if (amountPaid.lt(grandTotal)) {
      throw new BadRequestException(
        `Tendered ${amountPaid.toFixed(2)} is short of the ${grandTotal.toFixed(2)} due`,
      );
    }

    const nonCash = payments
      .filter((p) => p.method !== "cash")
      .reduce((acc, p) => acc.add(p.amount), new Prisma.Decimal(0));
    if (nonCash.gt(grandTotal)) {
      throw new BadRequestException(
        "Card and wallet tenders cannot exceed the amount due",
      );
    }

    return { payments, amountPaid, changeDue: amountPaid.sub(grandTotal) };
  }

  async checkout(
    tenantId: string,
    branchId: string,
    userId: string,
    branchRoles: BranchRoleEntry[],
    dto: CheckoutDto,
    idempotencyKeyRaw: string | undefined,
  ) {
    await this.setupReadiness.assertCanSell(tenantId, branchId);
    const idempotencyKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idempotencyKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.checkout,
            idempotencyKey,
          },
        },
      });
      if (existing) {
        const replay = await this.prisma.sale.findFirst({
          where: { id: existing.resourceId, tenantId, branchId },
          include: SALE_INCLUDE,
        });
        if (replay) return replay;
        throw new BadRequestException(
          "Idempotency-Key is already recorded but the sale could not be replayed",
        );
      }
    }

    const checkoutPolicy = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { posRequireCustomer: true, posMaxDiscountPercent: true },
    });
    if (checkoutPolicy?.posRequireCustomer && !dto.customerId) {
      throw new BadRequestException(
        "Select a customer before completing this sale",
      );
    }
    const effectiveRoles = this.branchEffectiveRoles(branchRoles, branchId);
    const mayOverrideDiscount = effectiveRoles.some(
      (role) => role === RoleName.owner || role === RoleName.manager,
    );
    const maximumDiscountPercent = Number(
      checkoutPolicy?.posMaxDiscountPercent ?? 10,
    );
    if (!mayOverrideDiscount) {
      for (const item of dto.items) {
        const gross = d(item.unitPrice).mul(item.qty);
        const discount = d(item.discountAmount ?? "0");
        if (discount.lt(0) || discount.gt(gross)) {
          throw new BadRequestException(
            "Line discount must be between zero and the line subtotal",
          );
        }
        const discountPercent = gross.isZero()
          ? 0
          : discount.div(gross).mul(100).toNumber();
        if (discountPercent > maximumDiscountPercent) {
          throw new ForbiddenException(
            `Discount exceeds the ${maximumDiscountPercent}% limit and requires a manager`,
          );
        }
      }
    }

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, isActive: true },
      select: {
        id: true,
        name: true,
        isControlled: true,
        requiresPrescription: true,
      },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products are invalid");
    }

    let customerName: string | null = null;
    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId },
        select: { id: true, fullName: true },
      });
      if (!customer) throw new BadRequestException("Customer not found");
      customerName = customer.fullName;
    }

    let rxWarnings: ReturnType<typeof softRxMatchWarnings> = [];
    if (dto.prescriptionId) {
      const prescription = await this.prisma.prescription.findFirst({
        where: { id: dto.prescriptionId, tenantId, branchId },
        select: {
          id: true,
          validUntil: true,
          patientName: true,
          customerId: true,
        },
      });
      if (!prescription)
        throw new BadRequestException("Prescription not found at this branch");
      if (
        prescription.validUntil &&
        prescription.validUntil < startOfTodayUtc()
      ) {
        throw new BadRequestException(
          "Prescription has expired and cannot be dispensed",
        );
      }
      // Hard block only when both sides are registered customers and disagree.
      if (
        dto.customerId &&
        prescription.customerId &&
        dto.customerId !== prescription.customerId
      ) {
        throw new BadRequestException(
          "Linked prescription belongs to a different registered customer. Unlink or pick the matching customer.",
        );
      }
      rxWarnings = softRxMatchWarnings({
        patientName: prescription.patientName,
        customerName,
        prescriptionCustomerId: prescription.customerId,
        saleCustomerId: dto.customerId,
      });
    }

    const dispensedBy = await this.resolveDispenseAuthority({
      tenantId,
      branchId,
      userId,
      branchRoles,
      products,
      prescriptionId: dto.prescriptionId,
      pharmacistApproval: dto.pharmacistApproval,
    });
    const productNames = new Map(products.map((p) => [p.id, p.name]));

    try {
      const sale = await this.prisma.$transaction(async (tx) => {
        const lines: Array<{
          productId: string;
          batchId: string;
          qty: number;
          unitPrice: Prisma.Decimal;
          discountAmount: Prisma.Decimal;
          taxAmount: Prisma.Decimal;
          lineTotal: Prisma.Decimal;
        }> = [];

        const todayUtc = startOfTodayUtc();

        // Resolved once per checkout, not per line — TenantSettings.vatRatePercent overrides
        // the env-configured PRICING_VAT_RATE_PERCENT default when a tenant has set one.
        const tenantVatSettings = await tx.tenantSettings.findUnique({
          where: { tenantId },
          select: { vatRatePercent: true },
        });
        const effectiveVatRatePercent =
          tenantVatSettings?.vatRatePercent != null
            ? Number(tenantVatSettings.vatRatePercent)
            : this.tax.getVatRatePercent();

        for (const item of dto.items) {
          let batch =
            item.batchId != null && String(item.batchId).trim() !== ""
              ? await tx.batch.findFirst({
                  where: {
                    id: item.batchId,
                    tenantId,
                    branchId,
                    productId: item.productId,
                  },
                })
              : null;

          if (
            !batch &&
            (item.batchId == null || String(item.batchId).trim() === "")
          ) {
            // FEFO: earliest expiry among non-expired, non-quarantined batches with enough qty
            const candidates = await tx.batch.findMany({
              where: {
                tenantId,
                branchId,
                productId: item.productId,
                isQuarantined: false,
                needsExpiryReview: false,
                expiryDate: { gte: todayUtc },
              },
              orderBy: { expiryDate: "asc" },
            });
            for (const candidate of candidates) {
              const available = await qtyForBatchTx(
                tx,
                tenantId,
                branchId,
                candidate.id,
              );
              if (available >= item.qty) {
                batch = candidate;
                break;
              }
            }
            if (!batch) {
              throw new BadRequestException(
                "No sellable batch with sufficient quantity (FEFO auto-pick)",
              );
            }
          }

          if (!batch) {
            throw new BadRequestException("Invalid batch for checkout line");
          }

          if (batch.needsExpiryReview) {
            throw new BadRequestException(
              "Confirm the actual expiry date in Inventory before selling this batch",
            );
          }

          if (batch.isQuarantined) {
            throw new BadRequestException(
              "Batch is quarantined and cannot be sold",
            );
          }

          if (isBatchExpired(batch.expiryDate, todayUtc)) {
            throw new BadRequestException(
              `Cannot sell expired batch ${batch.batchNo}`,
            );
          }

          const available = await qtyForBatchTx(
            tx,
            tenantId,
            branchId,
            batch.id,
          );
          if (available < item.qty) {
            const name = productNames.get(item.productId) ?? "product";
            throw new BadRequestException(
              `Insufficient stock for ${name} batch ${batch.batchNo}: ${available} available, ${item.qty} requested`,
            );
          }

          const unitPrice = d(item.unitPrice);
          const discountAmount = d(item.discountAmount ?? "0");
          const taxAmount =
            item.taxAmount !== undefined &&
            item.taxAmount !== null &&
            String(item.taxAmount).trim() !== ""
              ? d(item.taxAmount as string)
              : this.tax.computeLineVatExclusiveAtRate(
                  effectiveVatRatePercent,
                  unitPrice,
                  item.qty,
                  discountAmount,
                );
          const base = unitPrice.mul(item.qty);
          const lineTotal = base.sub(discountAmount).add(taxAmount);

          lines.push({
            productId: item.productId,
            batchId: batch.id,
            qty: item.qty,
            unitPrice,
            discountAmount,
            taxAmount,
            lineTotal,
          });
        }

        const subtotal = lines.reduce(
          (acc, l) => acc.add(l.unitPrice.mul(l.qty)),
          new Prisma.Decimal(0),
        );
        const discountTotal = lines.reduce(
          (acc, l) => acc.add(l.discountAmount),
          new Prisma.Decimal(0),
        );
        const taxTotal = lines.reduce(
          (acc, l) => acc.add(l.taxAmount),
          new Prisma.Decimal(0),
        );
        const grandTotal = lines.reduce(
          (acc, l) => acc.add(l.lineTotal),
          new Prisma.Decimal(0),
        );
        const tender = this.resolvePayments(dto, grandTotal);

        let invoiceNo = await nextInvoiceNo(tx, tenantId, branchId);
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            const sale = await tx.sale.create({
              data: {
                tenantId,
                branchId,
                invoiceNo,
                status: SaleStatus.posted,
                subtotal,
                discountTotal,
                taxTotal,
                grandTotal,
                amountPaid: tender.amountPaid,
                changeDue: tender.changeDue,
                customerId: dto.customerId ?? null,
                prescriptionId: dto.prescriptionId ?? null,
                notes: dto.notes?.trim() || null,
                soldBy: userId,
                dispensedBy: dispensedBy,
                items: {
                  create: lines.map((l) => ({
                    tenantId,
                    productId: l.productId,
                    batchId: l.batchId,
                    qty: l.qty,
                    unitPrice: l.unitPrice,
                    discountAmount: l.discountAmount,
                    taxAmount: l.taxAmount,
                    lineTotal: l.lineTotal,
                  })),
                },
                payments: {
                  create: tender.payments.map((p) => ({
                    tenantId,
                    method: p.method,
                    amount: p.amount,
                    reference: p.reference,
                  })),
                },
              },
              include: SALE_INCLUDE,
            });

            for (const l of lines) {
              await tx.stockLedger.create({
                data: {
                  tenantId,
                  branchId,
                  productId: l.productId,
                  batchId: l.batchId,
                  movementType: StockMovementType.sale_out,
                  qtyDelta: -l.qty,
                  referenceType: "sale",
                  referenceId: sale.id,
                  createdBy: userId,
                },
              });
            }

            if (dto.heldSaleId) {
              await tx.heldSale.deleteMany({
                where: { id: dto.heldSaleId, tenantId, branchId },
              });
            }

            if (idempotencyKey) {
              await tx.idempotencyRecord.create({
                data: {
                  tenantId,
                  userId,
                  scope: IDEMPOTENCY_SCOPE.checkout,
                  idempotencyKey,
                  resourceId: sale.id,
                },
              });
            }

            return sale;
          } catch (e) {
            if (isPrismaUniqueFieldError(e, "invoice")) {
              invoiceNo = await nextInvoiceNo(tx, tenantId, branchId);
              continue;
            }
            throw e;
          }
        }
        throw new BadRequestException(
          "Could not allocate a unique invoice number",
        );
      });

      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: userId,
        eventName: "sale.posted",
        entityName: "sale",
        entityId: sale.id,
        payload: {
          invoiceNo: sale.invoiceNo,
          grandTotal: sale.grandTotal.toFixed(2),
          customerId: sale.customerId,
          prescriptionId: sale.prescriptionId,
          dispensedBy,
          rxWarnings: rxWarnings.map((w) => w.code),
          pharmacistCosign: Boolean(
            dispensedBy && dispensedBy !== userId && dto.pharmacistApproval,
          ),
        },
      });

      if (dispensedBy && dispensedBy !== userId) {
        await this.audit.log({
          tenantId,
          branchId,
          actorUserId: dispensedBy,
          eventName: "sale.pharmacist_approved",
          entityName: "sale",
          entityId: sale.id,
          payload: {
            invoiceNo: sale.invoiceNo,
            soldBy: userId,
            prescriptionId: sale.prescriptionId,
          },
        });
      }

      return this.prisma.sale.findFirst({
        where: { id: sale.id },
        include: SALE_INCLUDE,
      });
    } catch (e) {
      if (idempotencyKey && isPrismaUniqueFieldError(e, "idempotency")) {
        const row = await this.prisma.idempotencyRecord.findUnique({
          where: {
            tenantId_userId_scope_idempotencyKey: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.checkout,
              idempotencyKey,
            },
          },
        });
        if (row) {
          return this.prisma.sale.findFirst({
            where: { id: row.resourceId, tenantId, branchId },
            include: SALE_INCLUDE,
          });
        }
      }
      throw e;
    }
  }

  async voidSale(
    tenantId: string,
    branchId: string,
    userId: string,
    branchRoles: BranchRoleEntry[],
    saleId: string,
    reason?: string,
  ) {
    const roles = this.branchEffectiveRoles(branchRoles, branchId);
    const can = roles.some((r) => SalesService.VOID_ROLES.includes(r));
    if (!can) {
      throw new ForbiddenException(
        "Only owner, manager, or pharmacist may void a sale",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId, branchId },
        include: { items: true },
      });
      if (!sale) throw new NotFoundException("Sale not found");
      if (sale.status !== SaleStatus.posted) {
        throw new BadRequestException(
          "Only posted sales with no prior returns can be voided",
        );
      }

      const { lines } = await getSaleReturnableByLine(
        tx,
        tenantId,
        branchId,
        saleId,
      );
      for (const line of sale.items) {
        const key = saleLineKey(line.productId, line.batchId);
        const rem = lines.get(key);
        if (!rem || rem.remainingQty < line.qty) {
          throw new BadRequestException(
            "Cannot void a sale that already has returns or refunds — use the Returns workflow instead",
          );
        }
      }

      for (const line of sale.items) {
        await tx.stockLedger.create({
          data: {
            tenantId,
            branchId,
            productId: line.productId,
            batchId: line.batchId,
            movementType: StockMovementType.sale_void_in,
            qtyDelta: line.qty,
            referenceType: "sale_void",
            referenceId: sale.id,
            createdBy: userId,
          },
        });
      }

      await tx.sale.update({
        where: { id: saleId, tenantId, branchId },
        data: { status: SaleStatus.voided },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "sale.voided",
      entityName: "sale",
      entityId: saleId,
      payload: { reason: reason ?? null },
    });

    return this.getSale(tenantId, branchId, saleId);
  }

  async refundSale(
    tenantId: string,
    branchId: string,
    userId: string,
    branchRoles: BranchRoleEntry[],
    saleId: string,
    dto: RefundSaleDto,
  ) {
    const roles = this.branchEffectiveRoles(branchRoles, branchId);
    const can = roles.some((r) => SalesService.REFUND_ROLES.includes(r));
    if (!can) {
      throw new ForbiddenException("Insufficient role to refund a sale");
    }

    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException("Enter a reason for the refund");

    const refundMethod = dto.refundMethod ?? PaymentMethod.cash;
    let goodsReturnId: string | null = null;
    let refundTotal = new Prisma.Decimal(0);
    let nextStatus: SaleStatus = SaleStatus.refunded;

    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId, branchId },
        include: {
          items: {
            include: {
              product: { select: { id: true, isControlled: true, name: true } },
            },
          },
          customer: { select: { fullName: true } },
        },
      });
      if (!sale) throw new NotFoundException("Sale not found");
      if (
        sale.status !== SaleStatus.posted &&
        sale.status !== SaleStatus.partially_refunded
      ) {
        throw new BadRequestException(
          "Only posted or partially refunded sales can be refunded",
        );
      }

      const needsControlledGate =
        Boolean(sale.prescriptionId) ||
        sale.items.some((i) => i.product.isControlled);
      if (needsControlledGate) {
        const elevated = roles.some((r) =>
          SalesService.CONTROLLED_SALE_ROLES.includes(r),
        );
        if (!elevated) {
          throw new ForbiddenException(
            "Controlled or prescription-linked sales require a pharmacist, manager, or owner to refund",
          );
        }
      }

      const { lines } = await getSaleReturnableByLine(
        tx,
        tenantId,
        branchId,
        saleId,
      );

      const requested: {
        productId: string;
        batchId: string;
        qty: number;
        unitPrice: Prisma.Decimal;
      }[] = [];

      if (dto.items?.length) {
        for (const item of dto.items) {
          const key = saleLineKey(item.productId, item.batchId);
          const rem = lines.get(key);
          if (!rem) {
            throw new BadRequestException(
              "Refund line product/batch must match a line on the referenced sale",
            );
          }
          if (item.qty > rem.remainingQty) {
            throw new BadRequestException(
              rem.remainingQty <= 0
                ? "This sale line has already been fully returned"
                : `Only ${rem.remainingQty} unit(s) remain returnable on this sale line`,
            );
          }
          requested.push({
            productId: item.productId,
            batchId: item.batchId,
            qty: item.qty,
            unitPrice: refundUnitPrice(rem),
          });
        }
      } else {
        for (const rem of lines.values()) {
          if (rem.remainingQty <= 0) continue;
          requested.push({
            productId: rem.productId,
            batchId: rem.batchId,
            qty: rem.remainingQty,
            unitPrice: refundUnitPrice(rem),
          });
        }
      }

      if (requested.length === 0) {
        throw new BadRequestException(
          "Nothing remains returnable on this sale",
        );
      }

      const remainingBefore = totalRemainingQty(lines);
      const refundedQty = requested.reduce((n, line) => n + line.qty, 0);

      refundTotal = requested.reduce(
        (sum, line) => sum.add(line.unitPrice.mul(line.qty)),
        new Prisma.Decimal(0),
      );

      if (dto.refundAmount != null && dto.refundAmount.trim() !== "") {
        const expected = d(dto.refundAmount);
        if (!expected.eq(refundTotal)) {
          throw new BadRequestException(
            `Refund amount must equal ${refundTotal.toFixed(2)} for the selected lines`,
          );
        }
      }

      const returnNumber = await this.nextPosReturnNumber(
        tx,
        tenantId,
        branchId,
      );
      const created = await tx.goodsReturn.create({
        data: {
          tenantId,
          branchId,
          returnNumber,
          type: GoodsReturnType.customer,
          status: GoodsReturnStatus.completed,
          customerName: sale.customer?.fullName ?? "Walk-in",
          saleId: sale.id,
          reason,
          notes: `POS refund · ${sale.invoiceNo}`,
          amount: refundTotal,
          requestedBy: userId,
          approvedBy: userId,
          processedBy: userId,
          items: {
            create: requested.map((line) => ({
              tenantId,
              productId: line.productId,
              batchId: line.batchId,
              qty: line.qty,
              unitPrice: line.unitPrice,
            })),
          },
        },
      });
      goodsReturnId = created.id;

      for (const line of requested) {
        await tx.stockLedger.create({
          data: {
            tenantId,
            branchId,
            productId: line.productId,
            batchId: line.batchId,
            movementType: StockMovementType.customer_return_in,
            qtyDelta: line.qty,
            referenceType: "goods_return",
            referenceId: created.id,
            createdBy: userId,
          },
        });
      }

      await tx.salePayment.create({
        data: {
          tenantId,
          saleId: sale.id,
          method: refundMethod,
          amount: refundTotal.neg(),
          reference: `POS refund ${created.returnNumber}`,
        },
      });

      nextStatus =
        remainingBefore - refundedQty <= 0
          ? SaleStatus.refunded
          : SaleStatus.partially_refunded;

      await tx.sale.update({
        where: { id: saleId, tenantId, branchId },
        data: { status: nextStatus },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "sale.refunded",
      entityName: "sale",
      entityId: saleId,
      payload: {
        reason,
        goodsReturnId,
        refundMethod,
        refundTotal: refundTotal.toFixed(2),
        status: nextStatus,
      },
    });

    return this.getSale(tenantId, branchId, saleId);
  }

  private async nextPosReturnNumber(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
  ): Promise<string> {
    const year = new Date().getFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    try {
      const n = await tx.goodsReturn.count({
        where: {
          tenantId,
          branchId,
          createdAt: { gte: yearStart, lt: yearEnd },
        },
      });
      return `RET-${year}-${String(n + 1).padStart(5, "0")}`;
    } catch {
      return `RET-${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    }
  }

  async getSaleReturnable(tenantId: string, branchId: string, saleId: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId, branchId },
      include: {
        items: {
          include: {
            product: {
              select: { id: true, name: true, sku: true, isControlled: true },
            },
            batch: { select: { id: true, batchNo: true } },
          },
        },
      },
    });
    if (!sale) throw new NotFoundException("Sale not found");

    const { lines } = await getSaleReturnableByLine(
      this.prisma,
      tenantId,
      branchId,
      saleId,
    );
    const requiresPharmacist =
      Boolean(sale.prescriptionId) ||
      sale.items.some((i) => i.product.isControlled);

    return {
      saleId: sale.id,
      invoiceNo: sale.invoiceNo,
      status: sale.status,
      requiresPharmacist,
      lines: [...lines.values()].map((rem) => {
        const item = sale.items.find(
          (i) => i.productId === rem.productId && i.batchId === rem.batchId,
        );
        const refundUnit = refundUnitPrice(rem);
        return {
          saleItemId: item?.id ?? `${rem.productId}:${rem.batchId}`,
          productId: rem.productId,
          batchId: rem.batchId,
          productName: item?.product.name ?? "Product",
          sku: item?.product.sku ?? "",
          isControlled: item?.product.isControlled ?? false,
          batchNo: item?.batch.batchNo ?? "",
          soldQty: rem.soldQty,
          remainingQty: rem.remainingQty,
          unitPrice: rem.unitPrice,
          refundUnitPrice: refundUnit.toFixed(2),
          lineTotal: rem.paidTotal,
        };
      }),
      totalRemainingQty: totalRemainingQty(lines),
    };
  }

  async listSales(tenantId: string, branchId: string, take = 50) {
    return this.prisma.sale.findMany({
      where: {
        tenantId,
        branchId,
        status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
      },
      orderBy: { soldAt: "desc" },
      take,
      include: SALE_INCLUDE,
    });
  }

  async getSale(tenantId: string, branchId: string, id: string) {
    const sale = await this.prisma.sale.findFirst({
      where: { id, tenantId, branchId },
      include: SALE_INCLUDE,
    });
    if (!sale) throw new NotFoundException("Sale not found");
    return sale;
  }

  /** Invoice lookup for the POS returns lane (exact, contains, then suffix). */
  async findByInvoice(tenantId: string, branchId: string, invoiceNo: string) {
    const term = invoiceNo.trim().replace(/\s+/g, "");
    if (!term) throw new BadRequestException("Enter an invoice number");

    const base = { tenantId, branchId } as const;

    const sale =
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { equals: term, mode: "insensitive" } },
        include: SALE_INCLUDE,
      })) ??
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { contains: term, mode: "insensitive" } },
        orderBy: { soldAt: "desc" },
        include: SALE_INCLUDE,
      })) ??
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { endsWith: term, mode: "insensitive" } },
        orderBy: { soldAt: "desc" },
        include: SALE_INCLUDE,
      }));

    if (!sale) throw new NotFoundException(`No sale found for invoice ${term}`);
    return sale;
  }

  /**
   * Typeahead for the POS returns lane — match invoice number or customer name.
   * Prefers posted sales (refundable) but still surfaces voided/refunded so cashiers
   * can see why a bill cannot be refunded again.
   */
  async searchInvoices(
    tenantId: string,
    branchId: string,
    q: string,
    take = 12,
  ) {
    const term = q.trim();
    if (term.length < 1) return [];

    const limit = Math.min(Math.max(take, 1), 25);

    const rows = await this.prisma.sale.findMany({
      where: {
        tenantId,
        branchId,
        OR: [
          { invoiceNo: { contains: term, mode: "insensitive" } },
          {
            customer: {
              is: { fullName: { contains: term, mode: "insensitive" } },
            },
          },
          { customer: { is: { phone: { contains: term } } } },
        ],
      },
      orderBy: { soldAt: "desc" },
      take: Math.min(limit * 3, 50),
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        soldAt: true,
        grandTotal: true,
        customer: { select: { fullName: true, phone: true } },
        _count: { select: { items: true } },
      },
    });

    const statusRank = (status: SaleStatus) => {
      if (status === SaleStatus.posted) return 0;
      if (status === SaleStatus.partially_refunded) return 1;
      return 2;
    };

    return rows
      .sort((a, b) => {
        const rank = statusRank(a.status) - statusRank(b.status);
        if (rank !== 0) return rank;
        return b.soldAt.getTime() - a.soldAt.getTime();
      })
      .slice(0, limit);
  }
}
