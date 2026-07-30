import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PaymentMethod, Prisma, RoleName, SaleStatus, StockMovementType } from "@prisma/client";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { TaxService } from "../pricing/tax.service";
import { CheckoutDto } from "./dto/checkout.dto";

/** Everything a receipt / POS success state needs, in one shape. */
const SALE_INCLUDE = {
  items: { include: { product: true, batch: true } },
  payments: true,
  customer: { select: { id: true, fullName: true, phone: true } },
  prescription: {
    select: { id: true, rxNumber: true, patientName: true, doctorName: true },
  },
  seller: { select: { id: true, fullName: true } },
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
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function isBatchExpired(expiryDate: Date, todayUtc = startOfTodayUtc()): boolean {
  const exp = new Date(expiryDate);
  const expUtc = new Date(Date.UTC(exp.getUTCFullYear(), exp.getUTCMonth(), exp.getUTCDate()));
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
  return nextDocumentNumber(tx, tenantId, branchId, "sale", `INV-${period}-`, 6);
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
  ) {}

  private branchEffectiveRoles(branchRoles: BranchRoleEntry[], branchId: string): RoleName[] {
    const ownerAnywhere = branchRoles.some((b) => b.role === RoleName.owner);
    const atBranch = branchRoles.filter((b) => b.branchId === branchId).map((b) => b.role);
    if (ownerAnywhere) {
      return [...new Set([...atBranch, RoleName.owner])];
    }
    return atBranch;
  }

  private assertControlledSaleAllowed(
    branchRoles: BranchRoleEntry[],
    branchId: string,
    products: Array<{ id: string; name: string; isControlled: boolean }>,
    prescriptionId: string | undefined,
  ) {
    const controlled = products.filter((p) => p.isControlled);
    if (controlled.length === 0) return;
    const roles = this.branchEffectiveRoles(branchRoles, branchId);
    const allowed = roles.some((r) => SalesService.CONTROLLED_SALE_ROLES.includes(r));
    if (!allowed) {
      throw new ForbiddenException(
        "Selling controlled medicines requires pharmacist, manager, or owner on this branch",
      );
    }
    if (!prescriptionId) {
      const names = controlled.map((p) => p.name).join(", ");
      throw new BadRequestException(
        `A prescription must be linked before dispensing controlled medicine: ${names}`,
      );
    }
  }

  /** Tender validation: never post a sale that is short-paid. */
  private resolvePayments(
    dto: CheckoutDto,
    grandTotal: Prisma.Decimal,
  ): {
    payments: Array<{ method: PaymentMethod; amount: Prisma.Decimal; reference: string | null }>;
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
        throw new BadRequestException("Each payment amount must be greater than zero");
      }
      return { method: p.method, amount, reference: p.reference?.trim() || null };
    });

    const amountPaid = payments.reduce((acc, p) => acc.add(p.amount), new Prisma.Decimal(0));
    if (amountPaid.lt(grandTotal)) {
      throw new BadRequestException(
        `Tendered ${amountPaid.toFixed(2)} is short of the ${grandTotal.toFixed(2)} due`,
      );
    }

    const nonCash = payments
      .filter((p) => p.method !== "cash")
      .reduce((acc, p) => acc.add(p.amount), new Prisma.Decimal(0));
    if (nonCash.gt(grandTotal)) {
      throw new BadRequestException("Card and wallet tenders cannot exceed the amount due");
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

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, isActive: true },
      select: { id: true, name: true, isControlled: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products are invalid");
    }

    if (dto.customerId) {
      const customer = await this.prisma.customer.findFirst({
        where: { id: dto.customerId, tenantId },
        select: { id: true },
      });
      if (!customer) throw new BadRequestException("Customer not found");
    }

    if (dto.prescriptionId) {
      const prescription = await this.prisma.prescription.findFirst({
        where: { id: dto.prescriptionId, tenantId, branchId },
        select: { id: true, validUntil: true },
      });
      if (!prescription) throw new BadRequestException("Prescription not found at this branch");
      if (prescription.validUntil && prescription.validUntil < startOfTodayUtc()) {
        throw new BadRequestException("Prescription has expired and cannot be dispensed");
      }
    }

    this.assertControlledSaleAllowed(branchRoles, branchId, products, dto.prescriptionId);
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

          if (!batch && (item.batchId == null || String(item.batchId).trim() === "")) {
            // FEFO: earliest expiry among non-expired, non-quarantined batches with enough qty
            const candidates = await tx.batch.findMany({
              where: {
                tenantId,
                branchId,
                productId: item.productId,
                isQuarantined: false,
                expiryDate: { gte: todayUtc },
              },
              orderBy: { expiryDate: "asc" },
            });
            for (const candidate of candidates) {
              const available = await qtyForBatchTx(tx, tenantId, branchId, candidate.id);
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

          if (batch.isQuarantined) {
            throw new BadRequestException("Batch is quarantined and cannot be sold");
          }

          if (isBatchExpired(batch.expiryDate, todayUtc)) {
            throw new BadRequestException(`Cannot sell expired batch ${batch.batchNo}`);
          }

          const available = await qtyForBatchTx(tx, tenantId, branchId, batch.id);
          if (available < item.qty) {
            const name = productNames.get(item.productId) ?? "product";
            throw new BadRequestException(
              `Insufficient stock for ${name} batch ${batch.batchNo}: ${available} available, ${item.qty} requested`,
            );
          }

          const unitPrice = d(item.unitPrice);
          const discountAmount = d(item.discountAmount ?? "0");
          const taxAmount =
            item.taxAmount !== undefined && item.taxAmount !== null && String(item.taxAmount).trim() !== ""
              ? d(item.taxAmount as string)
              : this.tax.computeLineVatExclusive(unitPrice, item.qty, discountAmount);
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

        const subtotal = lines.reduce((acc, l) => acc.add(l.unitPrice.mul(l.qty)), new Prisma.Decimal(0));
        const discountTotal = lines.reduce((acc, l) => acc.add(l.discountAmount), new Prisma.Decimal(0));
        const taxTotal = lines.reduce((acc, l) => acc.add(l.taxAmount), new Prisma.Decimal(0));
        const grandTotal = lines.reduce((acc, l) => acc.add(l.lineTotal), new Prisma.Decimal(0));
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
        throw new BadRequestException("Could not allocate a unique invoice number");
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
        },
      });

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
      throw new ForbiddenException("Only owner, manager, or pharmacist may void a sale");
    }

    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId, branchId },
        include: { items: true },
      });
      if (!sale) throw new NotFoundException("Sale not found");
      if (sale.status !== SaleStatus.posted) {
        throw new BadRequestException("Only posted sales can be voided");
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
        where: { id: saleId },
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
    reason?: string,
  ) {
    const roles = this.branchEffectiveRoles(branchRoles, branchId);
    const can = roles.some((r) => SalesService.REFUND_ROLES.includes(r));
    if (!can) {
      throw new ForbiddenException("Insufficient role to refund a sale");
    }

    await this.prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId, tenantId, branchId },
        include: { items: true },
      });
      if (!sale) throw new NotFoundException("Sale not found");
      if (sale.status !== SaleStatus.posted) {
        throw new BadRequestException("Only posted sales can be refunded");
      }

      for (const line of sale.items) {
        await tx.stockLedger.create({
          data: {
            tenantId,
            branchId,
            productId: line.productId,
            batchId: line.batchId,
            movementType: StockMovementType.sale_refund_in,
            qtyDelta: line.qty,
            referenceType: "sale_refund",
            referenceId: sale.id,
            createdBy: userId,
          },
        });
      }

      await tx.sale.update({
        where: { id: saleId },
        data: { status: SaleStatus.refunded },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "sale.refunded",
      entityName: "sale",
      entityId: saleId,
      payload: { reason: reason ?? null },
    });

    return this.getSale(tenantId, branchId, saleId);
  }

  async listSales(tenantId: string, branchId: string, take = 50) {
    return this.prisma.sale.findMany({
      where: { tenantId, branchId, status: SaleStatus.posted },
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

  /** Invoice lookup for the POS returns lane (exact match, then suffix match). */
  async findByInvoice(tenantId: string, branchId: string, invoiceNo: string) {
    const term = invoiceNo.trim();
    if (!term) throw new BadRequestException("Enter an invoice number");

    const sale =
      (await this.prisma.sale.findFirst({
        where: { tenantId, branchId, invoiceNo: term },
        include: SALE_INCLUDE,
      })) ??
      (await this.prisma.sale.findFirst({
        where: { tenantId, branchId, invoiceNo: { endsWith: term, mode: "insensitive" } },
        orderBy: { soldAt: "desc" },
        include: SALE_INCLUDE,
      }));

    if (!sale) throw new NotFoundException(`No sale found for invoice ${term}`);
    return sale;
  }
}
