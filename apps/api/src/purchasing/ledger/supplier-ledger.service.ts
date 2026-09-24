import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  SupplierDebitNoteStatus,
  SupplierInvoiceSource,
  SupplierInvoiceStatus,
} from "@prisma/client";
import { AuditService } from "../../audit/audit.service";
import { dateKeyToUtc } from "../../common/business-date.util";
import { nextTenantDocumentNumber } from "../../common/document-sequence.util";
import { IDEMPOTENCY_SCOPE } from "../../common/idempotency.constants";
import {
  isPrismaUniqueFieldError,
  normalizeIdempotencyKey,
} from "../../common/idempotency.util";
import { PrismaService } from "../../prisma/prisma.service";
import {
  AllocationDto,
  ApplyDebitNoteDto,
  CreateSupplierInvoiceRecordDto,
  RecordSupplierPaymentLedgerDto,
} from "./supplier-ledger.dto";
import {
  allocateOldestFirst,
  dec,
  invoiceLineNet,
  invoiceStatus,
  invoiceTotals,
  threeWayMatch,
} from "./supplier-ledger.math";

type Tx = Prisma.TransactionClient;

function parseDate(value: string, label: string): Date {
  try {
    return dateKeyToUtc(value.slice(0, 10));
  } catch {
    throw new BadRequestException(`${label} must be a valid date`);
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function money(value: Prisma.Decimal.Value): string {
  return dec(value).toFixed(2);
}

/** Lock the invoice rows a change will settle, in id order, so two payments can't overpay one. */
async function lockInvoices(tx: Tx, tenantId: string, invoiceIds: string[]) {
  const ids = [...new Set(invoiceIds)].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`
    SELECT id FROM supplier_invoice
    WHERE tenant_id = ${tenantId}::uuid AND id = ANY(${ids}::uuid[])
    ORDER BY id
    FOR UPDATE
  `;
}

/**
 * Re-derive what has been settled on each invoice from the allocations against it.
 *
 * `paidAmount` is kept on the invoice because every list needs it, but it is only ever written
 * here, from the ledger: payments that were not voided, plus debit notes that were not voided.
 * Nothing adds to it directly, which is what let the old flow drift.
 */
export async function refreshInvoiceSettlement(
  tx: Tx,
  tenantId: string,
  invoiceIds: string[],
) {
  for (const invoiceId of [...new Set(invoiceIds)]) {
    const invoice = await tx.supplierInvoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { id: true, totalAmount: true, status: true },
    });
    if (!invoice) continue;
    const paid = await tx.supplierPaymentAllocation.aggregate({
      where: { tenantId, invoiceId, payment: { voidedAt: null } },
      _sum: { amount: true },
    });
    const debited = await tx.supplierDebitAllocation.aggregate({
      where: {
        tenantId,
        invoiceId,
        debitNote: { status: { not: SupplierDebitNoteStatus.voided } },
      },
      _sum: { amount: true },
    });
    const settled = dec(paid._sum.amount).plus(dec(debited._sum.amount));
    await tx.supplierInvoice.updateMany({
      where: { id: invoiceId, tenantId },
      data: {
        paidAmount: settled,
        status: invoiceStatus(invoice.status, invoice.totalAmount, settled),
      },
    });
  }
}

/**
 * Raise the debit note a completed supplier return is owed.
 *
 * Returning stock used to reduce what was on the shelf and nothing else, so the money for it
 * stayed owed to the supplier. The claim is valued at what the return lines say, or failing
 * that at what the pharmacy paid for those units.
 */
export async function raiseDebitNoteForReturn(
  tx: Tx,
  params: {
    tenantId: string;
    branchId: string;
    userId: string;
    goodsReturnId: string;
    supplierId: string;
    reason: string | null;
    lines: Array<{
      qty: number;
      unitPrice: Prisma.Decimal;
      batchCost: Prisma.Decimal | null;
    }>;
  },
) {
  const existing = await tx.supplierDebitNote.findFirst({
    where: { tenantId: params.tenantId, goodsReturnId: params.goodsReturnId },
  });
  if (existing) return existing;

  let amount = new Prisma.Decimal(0);
  for (const line of params.lines) {
    const each = line.unitPrice.gt(0)
      ? line.unitPrice
      : (line.batchCost ?? new Prisma.Decimal(0));
    amount = amount.plus(each.mul(line.qty));
  }
  amount = amount.toDecimalPlaces(2);
  if (amount.lte(0)) return null;

  const debitNo = await nextTenantDocumentNumber(
    tx,
    params.tenantId,
    "supplier_debit_note",
    "DN-",
  );
  return tx.supplierDebitNote.create({
    data: {
      tenantId: params.tenantId,
      supplierId: params.supplierId,
      branchId: params.branchId,
      debitNo,
      goodsReturnId: params.goodsReturnId,
      issuedOn: new Date(new Date().toISOString().slice(0, 10)),
      amount,
      reason: params.reason,
      createdBy: params.userId,
    },
  });
}

@Injectable()
export class SupplierLedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Invoices ────────────────────────────────────────────────────────────────────────────

  async listInvoices(
    tenantId: string,
    branchId: string,
    filters: {
      supplierId?: string;
      status?: string;
      source?: string;
      from?: string;
      to?: string;
      q?: string;
    } = {},
  ) {
    const invoiceDate: Prisma.DateTimeFilter = {};
    if (filters.from) invoiceDate.gte = parseDate(filters.from, "From date");
    if (filters.to) invoiceDate.lte = parseDate(filters.to, "To date");
    const q = filters.q?.trim();
    const today = new Date(new Date().toISOString().slice(0, 10));

    const statusFilter: Prisma.SupplierInvoiceWhereInput =
      filters.status === "overdue"
        ? {
            status: {
              in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial],
            },
            dueDate: { lt: today },
          }
        : filters.status === "outstanding"
          ? {
              status: {
                in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial],
              },
            }
          : filters.status && filters.status !== "all"
            ? { status: filters.status as SupplierInvoiceStatus }
            : { status: { not: SupplierInvoiceStatus.voided } };

    const rows = await this.prisma.supplierInvoice.findMany({
      where: {
        tenantId,
        // A branch sees its own invoices and any raised for the business as a whole.
        OR: [{ branchId }, { branchId: null }],
        ...statusFilter,
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(filters.source === "system" || filters.source === "supplier"
          ? { source: filters.source as SupplierInvoiceSource }
          : {}),
        ...(Object.keys(invoiceDate).length > 0 ? { invoiceDate } : {}),
        ...(q
          ? {
              AND: [
                {
                  OR: [
                    { invoiceNumber: { contains: q, mode: "insensitive" } },
                    {
                      supplier: { name: { contains: q, mode: "insensitive" } },
                    },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ dueDate: "asc" }, { invoiceDate: "desc" }],
      take: 300,
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        receipts: {
          select: { goodsReceipt: { select: { id: true, grnNumber: true } } },
        },
      },
    });

    return rows.map((invoice) => {
      const balance = invoice.totalAmount.minus(invoice.paidAmount);
      const outstanding =
        invoice.status === SupplierInvoiceStatus.open ||
        invoice.status === SupplierInvoiceStatus.partial;
      return {
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        source: invoice.source,
        supplier: invoice.supplier,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        totalAmount: money(invoice.totalAmount),
        paidAmount: money(invoice.paidAmount),
        balance: money(balance),
        status: invoice.status,
        overdue: outstanding && balance.gt(0) && invoice.dueDate < today,
        deliveries: invoice.receipts.map((link) => link.goodsReceipt),
      };
    });
  }

  async getInvoice(tenantId: string, id: string) {
    const invoice = await this.prisma.supplierInvoice.findFirst({
      where: { id, tenantId },
      include: {
        supplier: {
          select: { id: true, code: true, name: true, paymentTermsDays: true },
        },
        branch: { select: { id: true, code: true, name: true } },
        lines: {
          include: { product: { select: { id: true, sku: true, name: true } } },
        },
        receipts: {
          include: {
            goodsReceipt: {
              include: {
                purchaseOrder: {
                  include: {
                    items: {
                      include: {
                        product: { select: { id: true, name: true } },
                      },
                    },
                  },
                },
                items: {
                  include: { product: { select: { id: true, name: true } } },
                },
              },
            },
          },
        },
        paymentParts: {
          include: {
            payment: {
              select: {
                id: true,
                paymentNo: true,
                paidOn: true,
                method: true,
                reference: true,
                voidedAt: true,
              },
            },
          },
        },
        debitParts: {
          include: {
            debitNote: { select: { id: true, debitNo: true, status: true } },
          },
        },
      },
    });
    if (!invoice) throw new NotFoundException("Invoice not found");

    // The orders behind these deliveries, each counted once even when several deliveries
    // came against the same order.
    const orders = new Map<
      string,
      (typeof invoice.receipts)[number]["goodsReceipt"]["purchaseOrder"]
    >();
    for (const link of invoice.receipts) {
      orders.set(
        link.goodsReceipt.purchaseOrder.id,
        link.goodsReceipt.purchaseOrder,
      );
    }
    const billedProducts = new Set(
      invoice.lines.map((line) => line.productId).filter(Boolean),
    );
    const receivedProducts = new Set(
      invoice.receipts.flatMap((link) =>
        link.goodsReceipt.items.map((item) => item.productId),
      ),
    );

    const match = threeWayMatch({
      // Only the order lines this invoice is about: a big order billed across several invoices
      // should not make each one look short.
      ordered: [...orders.values()].flatMap((po) =>
        po.items
          .filter(
            (item) =>
              billedProducts.has(item.productId) ||
              receivedProducts.has(item.productId),
          )
          .map((item) => ({
            productId: item.productId,
            product: item.product.name,
            qty: item.orderedQty,
            unitCost: item.unitCost,
          })),
      ),
      received: invoice.receipts.flatMap((link) =>
        link.goodsReceipt.items.map((item) => ({
          productId: item.productId,
          product: item.product.name,
          qty: item.receivedQty + item.rejectedQty,
          unitCost: item.unitCost,
        })),
      ),
      billed: invoice.lines.map((line) => ({
        productId: line.productId,
        product: line.product?.name ?? line.description ?? "Other",
        qty: line.qty,
        unitCost: line.qty > 0 ? line.lineTotal.div(line.qty) : line.unitCost,
      })),
    });

    return {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      source: invoice.source,
      status: invoice.status,
      supplier: invoice.supplier,
      branch: invoice.branch,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      subtotalAmount: money(invoice.subtotalAmount),
      taxAmount: money(invoice.taxAmount),
      shippingAmount: money(invoice.shippingAmount),
      totalAmount: money(invoice.totalAmount),
      paidAmount: money(invoice.paidAmount),
      balance: money(invoice.totalAmount.minus(invoice.paidAmount)),
      notes: invoice.notes,
      lines: invoice.lines.map((line) => ({
        id: line.id,
        product: line.product,
        description: line.description,
        qty: line.qty,
        unitCost: money(line.unitCost),
        discountPercent: Number(line.discountPercent),
        taxPercent: Number(line.taxPercent),
        lineTotal: money(line.lineTotal),
      })),
      deliveries: invoice.receipts.map((link) => ({
        id: link.goodsReceipt.id,
        grnNumber: link.goodsReceipt.grnNumber,
        receivedOn: link.goodsReceipt.receivedOn.toISOString().slice(0, 10),
        poNumber: link.goodsReceipt.purchaseOrder.poNumber,
      })),
      match,
      payments: invoice.paymentParts.map((part) => ({
        paymentId: part.payment.id,
        paymentNo: part.payment.paymentNo,
        paidOn: part.payment.paidOn.toISOString().slice(0, 10),
        method: part.payment.method,
        reference: part.payment.reference,
        amount: money(part.amount),
        voided: part.payment.voidedAt !== null,
      })),
      debitNotes: invoice.debitParts.map((part) => ({
        debitNoteId: part.debitNote.id,
        debitNo: part.debitNote.debitNo,
        amount: money(part.amount),
        voided: part.debitNote.status === SupplierDebitNoteStatus.voided,
      })),
    };
  }

  /**
   * Deliveries from this supplier that no real invoice covers yet — what the "record invoice"
   * form offers to link. A delivery only has a system placeholder until someone types the
   * supplier's invoice in.
   */
  async unbilledDeliveries(
    tenantId: string,
    branchId: string,
    supplierId: string,
  ) {
    const receipts = await this.prisma.goodsReceipt.findMany({
      where: {
        tenantId,
        branchId,
        purchaseOrder: { supplierId },
        invoiceLinks: {
          none: {
            invoice: {
              source: SupplierInvoiceSource.supplier,
              status: { not: SupplierInvoiceStatus.voided },
            },
          },
        },
      },
      orderBy: { receivedOn: "desc" },
      take: 100,
      include: {
        purchaseOrder: { select: { poNumber: true } },
        items: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
            batch: { select: { costPrice: true } },
          },
        },
      },
    });
    return receipts.map((gr) => ({
      id: gr.id,
      grnNumber: gr.grnNumber,
      receivedOn: gr.receivedOn.toISOString().slice(0, 10),
      poNumber: gr.purchaseOrder.poNumber,
      supplierDeliveryNote: gr.supplierDeliveryNote,
      lines: gr.items.map((item) => ({
        product: item.product,
        // Billed units: what arrived and was charged for, damaged included, free excluded.
        qty: item.receivedQty + item.rejectedQty,
        // Older deliveries kept their cost on the batch only, the same fallback the migration
        // used when it wrote their lines.
        unitCost: money(item.unitCost ?? item.batch.costPrice),
      })),
    }));
  }

  async createInvoice(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: CreateSupplierInvoiceRecordDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId },
      select: { id: true, name: true, paymentTermsDays: true },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");

    const invoiceNumber = dto.invoiceNumber.trim();
    if (!invoiceNumber)
      throw new BadRequestException("Enter the supplier's invoice number");
    const invoiceDate = parseDate(dto.invoiceDate, "Invoice date");
    const dueDate = dto.dueDate
      ? parseDate(dto.dueDate, "Due date")
      : addDays(invoiceDate, supplier.paymentTermsDays ?? 30);
    if (dueDate < invoiceDate) {
      throw new BadRequestException(
        "The due date can't be before the invoice date",
      );
    }

    const receiptIds = [...new Set(dto.receiptIds ?? [])];
    if (receiptIds.length > 0) {
      const receipts = await this.prisma.goodsReceipt.findMany({
        where: { tenantId, id: { in: receiptIds } },
        select: {
          id: true,
          grnNumber: true,
          purchaseOrder: { select: { supplierId: true } },
        },
      });
      if (receipts.length !== receiptIds.length) {
        throw new BadRequestException(
          "One of the deliveries could not be found",
        );
      }
      const foreign = receipts.find(
        (gr) => gr.purchaseOrder.supplierId !== supplier.id,
      );
      if (foreign) {
        throw new BadRequestException(
          `${foreign.grnNumber} was delivered by a different supplier and can't be on ${supplier.name}'s invoice`,
        );
      }
    }

    const productIds = [
      ...new Set(
        dto.lines
          .map((line) => line.productId)
          .filter((id): id is string => !!id),
      ),
    ];
    if (productIds.length > 0) {
      const found = await this.prisma.product.count({
        where: { tenantId, id: { in: productIds } },
      });
      if (found !== productIds.length)
        throw new BadRequestException("One of the products no longer exists");
    }
    for (const line of dto.lines) {
      if (!line.productId && !line.description?.trim()) {
        throw new BadRequestException(
          "Each line needs a product or a description",
        );
      }
      if (dec(line.unitCost).lt(0))
        throw new BadRequestException("A line cost can't be negative");
    }

    const totals = invoiceTotals({
      lines: dto.lines,
      taxAmount: dto.taxAmount?.trim() || null,
      shippingAmount: dto.shippingAmount?.trim() || null,
    });
    if (totals.total.lte(0))
      throw new BadRequestException("The invoice total must be more than zero");

    try {
      const invoiceId = await this.prisma.$transaction(async (tx) => {
        const invoice = await tx.supplierInvoice.create({
          data: {
            tenantId,
            supplierId: supplier.id,
            branchId,
            invoiceNumber,
            source: SupplierInvoiceSource.supplier,
            invoiceDate,
            dueDate,
            subtotalAmount: totals.subtotal,
            taxAmount: totals.tax,
            shippingAmount: totals.shipping,
            totalAmount: totals.total,
            status: SupplierInvoiceStatus.open,
            notes: dto.notes?.trim() || null,
            createdBy: userId,
            lines: {
              create: dto.lines.map((line) => ({
                tenantId,
                productId: line.productId ?? null,
                description: line.description?.trim() || null,
                qty: line.qty,
                unitCost: dec(line.unitCost),
                discountPercent: dec(line.discountPercent ?? 0),
                taxPercent: dec(line.taxPercent ?? 0),
                lineTotal: invoiceLineNet(line),
              })),
            },
            receipts: {
              create: receiptIds.map((goodsReceiptId) => ({
                tenantId,
                goodsReceiptId,
              })),
            },
          },
        });

        // The placeholders the system wrote for these deliveries are replaced by the real
        // invoice. Anything already paid against a placeholder moves with it, so paying a
        // delivery note before the invoice arrived is never lost or double-counted.
        const superseded: string[] = [];
        if (receiptIds.length > 0) {
          const placeholders = await tx.supplierInvoice.findMany({
            where: {
              tenantId,
              source: SupplierInvoiceSource.system,
              status: { not: SupplierInvoiceStatus.voided },
              receipts: { some: { goodsReceiptId: { in: receiptIds } } },
            },
            select: { id: true, invoiceNumber: true },
          });
          if (placeholders.length > 0) {
            await lockInvoices(tx, tenantId, [
              invoice.id,
              ...placeholders.map((p) => p.id),
            ]);
          }
          for (const placeholder of placeholders) {
            const moved = await tx.supplierPaymentAllocation.findMany({
              where: { tenantId, invoiceId: placeholder.id },
            });
            for (const part of moved) {
              const clash = await tx.supplierPaymentAllocation.findFirst({
                where: {
                  tenantId,
                  paymentId: part.paymentId,
                  invoiceId: invoice.id,
                },
              });
              if (clash) {
                await tx.supplierPaymentAllocation.updateMany({
                  where: { id: clash.id, tenantId },
                  data: { amount: clash.amount.plus(part.amount) },
                });
                await tx.supplierPaymentAllocation.deleteMany({
                  where: { id: part.id, tenantId },
                });
              } else {
                await tx.supplierPaymentAllocation.updateMany({
                  where: { id: part.id, tenantId },
                  data: { invoiceId: invoice.id },
                });
              }
            }
            await tx.supplierDebitAllocation.updateMany({
              where: { tenantId, invoiceId: placeholder.id },
              data: { invoiceId: invoice.id },
            });
            await tx.supplierInvoice.updateMany({
              where: { id: placeholder.id, tenantId },
              data: {
                status: SupplierInvoiceStatus.voided,
                paidAmount: 0,
                notes: `Replaced by the supplier's invoice ${invoiceNumber}`,
              },
            });
            superseded.push(placeholder.invoiceNumber);
          }
        }

        await refreshInvoiceSettlement(tx, tenantId, [invoice.id]);
        const settled = await tx.supplierInvoice.findFirstOrThrow({
          where: { id: invoice.id, tenantId },
          select: { paidAmount: true, totalAmount: true },
        });
        if (settled.paidAmount.gt(settled.totalAmount)) {
          throw new BadRequestException(
            `More has already been paid against these deliveries (${money(settled.paidAmount)}) than this invoice totals (${money(settled.totalAmount)}). Check the invoice total.`,
          );
        }

        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: "supplier_invoice.recorded",
            entityName: "supplier_invoice",
            entityId: invoice.id,
            payload: {
              invoiceNumber,
              supplierId: supplier.id,
              total: totals.total.toFixed(2),
              deliveries: receiptIds.length,
              superseded,
            },
          },
          tx,
        );
        return invoice.id;
      });
      return this.getInvoice(tenantId, invoiceId);
    } catch (e) {
      // A new invoice's only unique constraint that can collide is (tenant, supplier, number):
      // its lines and delivery links are all fresh rows. Driver adapters report the target in
      // either spelling, so the code is the reliable signal.
      if (
        (e as { code?: string })?.code === "P2002" ||
        isPrismaUniqueFieldError(e, "invoice_number") ||
        isPrismaUniqueFieldError(e, "invoiceNumber")
      ) {
        throw new ConflictException(
          `${supplier.name}'s invoice ${invoiceNumber} has already been recorded`,
        );
      }
      throw e;
    }
  }

  async voidInvoice(
    tenantId: string,
    userId: string,
    id: string,
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await lockInvoices(tx, tenantId, [id]);
      const invoice = await tx.supplierInvoice.findFirst({
        where: { id, tenantId },
      });
      if (!invoice) throw new NotFoundException("Invoice not found");
      if (invoice.status === SupplierInvoiceStatus.voided) return;
      const payments = await tx.supplierPaymentAllocation.count({
        where: { tenantId, invoiceId: id, payment: { voidedAt: null } },
      });
      const debits = await tx.supplierDebitAllocation.count({
        where: {
          tenantId,
          invoiceId: id,
          debitNote: { status: { not: SupplierDebitNoteStatus.voided } },
        },
      });
      if (payments > 0 || debits > 0) {
        throw new BadRequestException(
          "Payments or debit notes are set against this invoice. Void those first, so the money is accounted for.",
        );
      }
      await tx.supplierInvoice.updateMany({
        where: { id, tenantId },
        data: {
          status: SupplierInvoiceStatus.voided,
          notes: [invoice.notes, `Voided: ${reason}`]
            .filter(Boolean)
            .join(" | "),
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId: invoice.branchId ?? undefined,
          actorUserId: userId,
          eventName: "supplier_invoice.voided",
          entityName: "supplier_invoice",
          entityId: id,
          payload: { invoiceNumber: invoice.invoiceNumber, reason },
        },
        tx,
      );
    });
    return this.getInvoice(tenantId, id);
  }

  // ── Payments ────────────────────────────────────────────────────────────────────────────

  async listPayments(
    tenantId: string,
    branchId: string,
    filters: { supplierId?: string; from?: string; to?: string } = {},
  ) {
    const paidOn: Prisma.DateTimeFilter = {};
    if (filters.from) paidOn.gte = parseDate(filters.from, "From date");
    if (filters.to) paidOn.lte = parseDate(filters.to, "To date");
    const rows = await this.prisma.supplierPayment.findMany({
      where: {
        tenantId,
        OR: [{ branchId }, { branchId: null }],
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(Object.keys(paidOn).length > 0 ? { paidOn } : {}),
      },
      orderBy: [{ paidOn: "desc" }, { createdAt: "desc" }],
      take: 300,
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        creator: { select: { id: true, fullName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
    });
    return rows.map((payment) => ({
      id: payment.id,
      paymentNo: payment.paymentNo,
      supplier: payment.supplier,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: money(payment.amount),
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      recordedBy: payment.creator,
      voided: payment.voidedAt !== null,
      allocations: payment.allocations.map((part) => ({
        invoiceId: part.invoice.id,
        invoiceNumber: part.invoice.invoiceNumber,
        amount: money(part.amount),
      })),
    }));
  }

  /**
   * Validate and place allocations against a supplier's open invoices, locking them first.
   * Explicit allocations must each fit the invoice's balance; omitted ones settle the oldest
   * due first. Either way the whole amount has to land somewhere — money recorded as paid but
   * set against nothing is exactly the ambiguity this ledger exists to remove.
   */
  private async placeAllocations(
    tx: Tx,
    tenantId: string,
    supplierId: string,
    amount: Prisma.Decimal,
    requested: AllocationDto[] | undefined,
  ) {
    const open = await tx.supplierInvoice.findMany({
      where: {
        tenantId,
        supplierId,
        status: {
          in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial],
        },
      },
      select: {
        id: true,
        invoiceNumber: true,
        dueDate: true,
        invoiceDate: true,
      },
    });
    const candidateIds = requested?.length
      ? requested.map((a) => a.invoiceId)
      : open.map((i) => i.id);
    await lockInvoices(tx, tenantId, candidateIds);

    const locked = await tx.supplierInvoice.findMany({
      where: { tenantId, id: { in: candidateIds } },
      select: {
        id: true,
        invoiceNumber: true,
        supplierId: true,
        status: true,
        totalAmount: true,
        paidAmount: true,
        dueDate: true,
        invoiceDate: true,
      },
    });
    const byId = new Map(locked.map((invoice) => [invoice.id, invoice]));

    if (requested?.length) {
      let sum = new Prisma.Decimal(0);
      const placed: Array<{ invoiceId: string; amount: Prisma.Decimal }> = [];
      for (const part of requested) {
        const invoice = byId.get(part.invoiceId);
        if (!invoice || invoice.supplierId !== supplierId) {
          throw new BadRequestException(
            "One of the invoices belongs to a different supplier",
          );
        }
        if (
          invoice.status !== SupplierInvoiceStatus.open &&
          invoice.status !== SupplierInvoiceStatus.partial
        ) {
          throw new BadRequestException(
            `${invoice.invoiceNumber} is ${invoice.status}, so nothing more can be set against it`,
          );
        }
        const value = dec(part.amount).toDecimalPlaces(2);
        if (value.lte(0))
          throw new BadRequestException(
            "Each allocation must be more than zero",
          );
        const balance = invoice.totalAmount.minus(invoice.paidAmount);
        if (value.gt(balance)) {
          throw new BadRequestException(
            `${invoice.invoiceNumber} only has ${money(balance)} left to pay`,
          );
        }
        sum = sum.plus(value);
        placed.push({ invoiceId: invoice.id, amount: value });
      }
      if (!sum.equals(amount)) {
        throw new BadRequestException(
          `The allocations add up to ${money(sum)}, but the payment is ${money(amount)}`,
        );
      }
      return placed;
    }

    const { allocations, unplaced } = allocateOldestFirst(
      amount,
      locked.map((invoice) => ({
        id: invoice.id,
        dueDate: invoice.dueDate,
        invoiceDate: invoice.invoiceDate,
        balance: invoice.totalAmount.minus(invoice.paidAmount),
      })),
    );
    if (unplaced.gt(0)) {
      const owed = amount.minus(unplaced);
      throw new BadRequestException(
        `That is more than is owed to this supplier (${money(owed)} outstanding). Record the invoice first, or pay the amount owed.`,
      );
    }
    return allocations;
  }

  async recordPayment(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: RecordSupplierPaymentLedgerDto,
    idempotencyKeyRaw?: string,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId },
      select: { id: true, name: true },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");
    const amount = dec(dto.amount).toDecimalPlaces(2);
    if (amount.lte(0)) throw new BadRequestException("Enter the amount paid");
    const paidOn = parseDate(dto.paidOn, "Payment date");
    if (paidOn > new Date())
      throw new BadRequestException("A payment can't be dated in the future");

    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const seen = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.supplierPayment,
            idempotencyKey: idemKey,
          },
        },
      });
      if (seen) return this.paymentById(tenantId, seen.resourceId);
    }

    try {
      const paymentId = await this.prisma.$transaction(async (tx) => {
        const allocations = await this.placeAllocations(
          tx,
          tenantId,
          supplier.id,
          amount,
          dto.allocations,
        );
        const paymentNo = await nextTenantDocumentNumber(
          tx,
          tenantId,
          "supplier_payment",
          "PAY-",
        );
        const payment = await tx.supplierPayment.create({
          data: {
            tenantId,
            supplierId: supplier.id,
            branchId,
            paymentNo,
            paidOn,
            amount,
            method: dto.method,
            reference: dto.reference?.trim() || null,
            notes: dto.notes?.trim() || null,
            createdBy: userId,
            allocations: {
              create: allocations.map((part) => ({
                tenantId,
                invoiceId: part.invoiceId,
                amount: part.amount,
              })),
            },
          },
        });
        await refreshInvoiceSettlement(
          tx,
          tenantId,
          allocations.map((part) => part.invoiceId),
        );
        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: "supplier_payment.recorded",
            entityName: "supplier_payment",
            entityId: payment.id,
            payload: {
              paymentNo,
              supplierId: supplier.id,
              amount: amount.toFixed(2),
              method: dto.method,
              invoices: allocations.length,
            },
          },
          tx,
        );
        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.supplierPayment,
              idempotencyKey: idemKey,
              resourceId: payment.id,
            },
          });
        }
        return payment.id;
      });
      return this.paymentById(tenantId, paymentId);
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        const row = await this.prisma.idempotencyRecord.findUnique({
          where: {
            tenantId_userId_scope_idempotencyKey: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.supplierPayment,
              idempotencyKey: idemKey,
            },
          },
        });
        if (row) return this.paymentById(tenantId, row.resourceId);
      }
      throw e;
    }
  }

  private async paymentById(tenantId: string, id: string) {
    const [row] = (await this.listPaymentsByIds(tenantId, [id])) ?? [];
    if (!row) throw new NotFoundException("Payment not found");
    return row;
  }

  private async listPaymentsByIds(tenantId: string, ids: string[]) {
    const rows = await this.prisma.supplierPayment.findMany({
      where: { tenantId, id: { in: ids } },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        creator: { select: { id: true, fullName: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
    });
    return rows.map((payment) => ({
      id: payment.id,
      paymentNo: payment.paymentNo,
      supplier: payment.supplier,
      paidOn: payment.paidOn.toISOString().slice(0, 10),
      amount: money(payment.amount),
      method: payment.method,
      reference: payment.reference,
      notes: payment.notes,
      recordedBy: payment.creator,
      voided: payment.voidedAt !== null,
      allocations: payment.allocations.map((part) => ({
        invoiceId: part.invoice.id,
        invoiceNumber: part.invoice.invoiceNumber,
        amount: money(part.amount),
      })),
    }));
  }

  /**
   * Reverse a payment recorded in error. The row stays — money that was recorded as moving is
   * history, and an auditor asking "why did this balance go back up" needs to find it.
   */
  async voidPayment(
    tenantId: string,
    userId: string,
    id: string,
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.supplierPayment.findFirst({
        where: { id, tenantId },
        include: { allocations: { select: { invoiceId: true } } },
      });
      if (!payment) throw new NotFoundException("Payment not found");
      if (payment.voidedAt) return;
      const invoiceIds = payment.allocations.map((part) => part.invoiceId);
      await lockInvoices(tx, tenantId, invoiceIds);
      const claimed = await tx.supplierPayment.updateMany({
        where: { id, tenantId, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidedBy: userId,
          notes: [payment.notes, `Voided: ${reason}`]
            .filter(Boolean)
            .join(" | "),
        },
      });
      if (claimed.count !== 1) return;
      await refreshInvoiceSettlement(tx, tenantId, invoiceIds);
      await this.audit.log(
        {
          tenantId,
          branchId: payment.branchId ?? undefined,
          actorUserId: userId,
          eventName: "supplier_payment.voided",
          entityName: "supplier_payment",
          entityId: id,
          payload: {
            paymentNo: payment.paymentNo,
            amount: money(payment.amount),
            reason,
          },
        },
        tx,
      );
    });
    return this.paymentById(tenantId, id);
  }

  // ── Debit notes ─────────────────────────────────────────────────────────────────────────

  async listDebitNotes(
    tenantId: string,
    branchId: string,
    filters: { supplierId?: string; status?: string } = {},
  ) {
    const rows = await this.prisma.supplierDebitNote.findMany({
      where: {
        tenantId,
        branchId,
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(filters.status && filters.status !== "all"
          ? { status: filters.status as SupplierDebitNoteStatus }
          : {}),
      },
      orderBy: { issuedOn: "desc" },
      take: 300,
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        goodsReturn: { select: { id: true, returnNumber: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
    });
    return rows.map((note) => ({
      id: note.id,
      debitNo: note.debitNo,
      supplier: note.supplier,
      goodsReturn: note.goodsReturn,
      issuedOn: note.issuedOn.toISOString().slice(0, 10),
      amount: money(note.amount),
      appliedAmount: money(note.appliedAmount),
      remaining: money(note.amount.minus(note.appliedAmount)),
      status: note.status,
      reason: note.reason,
      allocations: note.allocations.map((part) => ({
        invoiceId: part.invoice.id,
        invoiceNumber: part.invoice.invoiceNumber,
        amount: money(part.amount),
      })),
    }));
  }

  /** Set what a return is owed back against the supplier's invoices — like a payment in kind. */
  async applyDebitNote(
    tenantId: string,
    userId: string,
    id: string,
    dto: ApplyDebitNoteDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM supplier_debit_note
        WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid
        FOR UPDATE
      `;
      const note = await tx.supplierDebitNote.findFirst({
        where: { id, tenantId },
      });
      if (!note) throw new NotFoundException("Debit note not found");
      if (note.status !== SupplierDebitNoteStatus.open) {
        throw new BadRequestException(
          `${note.debitNo} is ${note.status}, so it can't be applied`,
        );
      }
      const remaining = note.amount.minus(note.appliedAmount);
      const requested = dto.allocations?.length ? dto.allocations : undefined;
      const toApply = requested
        ? requested.reduce(
            (sum, part) => sum.plus(dec(part.amount)),
            new Prisma.Decimal(0),
          )
        : remaining;
      if (toApply.gt(remaining)) {
        throw new BadRequestException(
          `${note.debitNo} only has ${money(remaining)} left to apply`,
        );
      }

      let placed: Array<{ invoiceId: string; amount: Prisma.Decimal }>;
      try {
        placed = await this.placeAllocations(
          tx,
          tenantId,
          note.supplierId,
          toApply,
          requested,
        );
      } catch (e) {
        // Auto-apply may place less than the whole note when less is owed; that is fine for a
        // credit, which simply stays open for the next invoice.
        if (requested || !(e instanceof BadRequestException)) throw e;
        const open = await tx.supplierInvoice.findMany({
          where: {
            tenantId,
            supplierId: note.supplierId,
            status: {
              in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial],
            },
          },
          select: {
            id: true,
            dueDate: true,
            invoiceDate: true,
            totalAmount: true,
            paidAmount: true,
          },
        });
        placed = allocateOldestFirst(
          toApply,
          open.map((invoice) => ({
            id: invoice.id,
            dueDate: invoice.dueDate,
            invoiceDate: invoice.invoiceDate,
            balance: invoice.totalAmount.minus(invoice.paidAmount),
          })),
        ).allocations;
      }
      if (placed.length === 0) {
        throw new BadRequestException(
          "Nothing is owed to this supplier right now to set the debit note against",
        );
      }

      for (const part of placed) {
        const existing = await tx.supplierDebitAllocation.findFirst({
          where: { tenantId, debitNoteId: id, invoiceId: part.invoiceId },
        });
        if (existing) {
          await tx.supplierDebitAllocation.updateMany({
            where: { id: existing.id, tenantId },
            data: { amount: existing.amount.plus(part.amount) },
          });
        } else {
          await tx.supplierDebitAllocation.create({
            data: {
              tenantId,
              debitNoteId: id,
              invoiceId: part.invoiceId,
              amount: part.amount,
            },
          });
        }
      }
      const applied = note.appliedAmount.plus(
        placed.reduce(
          (sum, part) => sum.plus(part.amount),
          new Prisma.Decimal(0),
        ),
      );
      await tx.supplierDebitNote.updateMany({
        where: { id, tenantId },
        data: {
          appliedAmount: applied,
          status: applied.gte(note.amount)
            ? SupplierDebitNoteStatus.settled
            : SupplierDebitNoteStatus.open,
        },
      });
      await refreshInvoiceSettlement(
        tx,
        tenantId,
        placed.map((part) => part.invoiceId),
      );
      await this.audit.log(
        {
          tenantId,
          branchId: note.branchId,
          actorUserId: userId,
          eventName: "supplier_debit_note.applied",
          entityName: "supplier_debit_note",
          entityId: id,
          payload: {
            debitNo: note.debitNo,
            applied: placed.map((part) => ({
              invoiceId: part.invoiceId,
              amount: money(part.amount),
            })),
          },
        },
        tx,
      );
    });
    const [note] = await this.listDebitNotesByIds(tenantId, [id]);
    return note;
  }

  async voidDebitNote(
    tenantId: string,
    userId: string,
    id: string,
    reason: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const note = await tx.supplierDebitNote.findFirst({
        where: { id, tenantId },
      });
      if (!note) throw new NotFoundException("Debit note not found");
      if (note.status === SupplierDebitNoteStatus.voided) return;
      if (note.appliedAmount.gt(0)) {
        throw new BadRequestException(
          `${note.debitNo} has already been set against invoices. It can't be voided once the money has been counted.`,
        );
      }
      await tx.supplierDebitNote.updateMany({
        where: {
          id,
          tenantId,
          status: { not: SupplierDebitNoteStatus.voided },
        },
        data: {
          status: SupplierDebitNoteStatus.voided,
          notes: [note.notes, `Voided: ${reason}`].filter(Boolean).join(" | "),
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId: note.branchId,
          actorUserId: userId,
          eventName: "supplier_debit_note.voided",
          entityName: "supplier_debit_note",
          entityId: id,
          payload: { debitNo: note.debitNo, reason },
        },
        tx,
      );
    });
    const [note] = await this.listDebitNotesByIds(tenantId, [id]);
    return note;
  }

  private async listDebitNotesByIds(tenantId: string, ids: string[]) {
    const rows = await this.prisma.supplierDebitNote.findMany({
      where: { tenantId, id: { in: ids } },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        goodsReturn: { select: { id: true, returnNumber: true } },
        allocations: {
          include: { invoice: { select: { id: true, invoiceNumber: true } } },
        },
      },
    });
    return rows.map((note) => ({
      id: note.id,
      debitNo: note.debitNo,
      supplier: note.supplier,
      goodsReturn: note.goodsReturn,
      issuedOn: note.issuedOn.toISOString().slice(0, 10),
      amount: money(note.amount),
      appliedAmount: money(note.appliedAmount),
      remaining: money(note.amount.minus(note.appliedAmount)),
      status: note.status,
      reason: note.reason,
      allocations: note.allocations.map((part) => ({
        invoiceId: part.invoice.id,
        invoiceNumber: part.invoice.invoiceNumber,
        amount: money(part.amount),
      })),
    }));
  }

  /** One line per supplier: what is owed, overdue, and waiting to be credited. */
  async payablesSummary(tenantId: string, branchId: string) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const open = await this.prisma.supplierInvoice.findMany({
      where: {
        tenantId,
        OR: [{ branchId }, { branchId: null }],
        status: {
          in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial],
        },
      },
      select: {
        source: true,
        totalAmount: true,
        paidAmount: true,
        dueDate: true,
      },
    });
    let outstanding = new Prisma.Decimal(0);
    let overdue = new Prisma.Decimal(0);
    let unbilled = new Prisma.Decimal(0);
    let unbilledCount = 0;
    for (const invoice of open) {
      const balance = invoice.totalAmount.minus(invoice.paidAmount);
      outstanding = outstanding.plus(balance);
      if (invoice.dueDate < today) overdue = overdue.plus(balance);
      if (invoice.source === SupplierInvoiceSource.system) {
        unbilled = unbilled.plus(balance);
        unbilledCount += 1;
      }
    }
    const credits = await this.prisma.supplierDebitNote.aggregate({
      where: { tenantId, branchId, status: SupplierDebitNoteStatus.open },
      _sum: { amount: true, appliedAmount: true },
    });
    return {
      outstanding: money(outstanding),
      overdue: money(overdue),
      awaitingInvoice: money(unbilled),
      awaitingInvoiceCount: unbilledCount,
      openCredits: money(
        dec(credits._sum.amount).minus(dec(credits._sum.appliedAmount)),
      ),
    };
  }
}
