import { Prisma, StockMovementType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export function dec(value: number | string | Prisma.Decimal): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function dateOnly(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Local-calendar-day arithmetic (not UTC) — "today" (n=0) must match what a
 * Colombo-timezone dashboard considers today. UTC arithmetic drifts a full
 * calendar day off local "today" whenever the local offset is positive and
 * it's late enough in the UTC day (e.g. after 18:30 UTC for UTC+5:30).
 */
export function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10, 0, 0, 0);
  return d;
}

/** Calendar date n days from today (UTC), for relative expiry in seed data. */
export function daysFromNow(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return dateOnly(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export type SeedBatchRef = {
  batchId: string;
  productId: string;
  sellingPrice: Prisma.Decimal;
};

/** Create batch + purchase_in ledger (simulates goods receipt). */
export async function seedReceiveStock(
  prisma: PrismaClient,
  opts: {
    tenantId: string;
    branchId: string;
    productId: string;
    userId: string;
    batchNo: string;
    expiryDate: Date;
    qty: number;
    costPrice: number | string;
    sellingPrice: number | string;
    referenceId: string;
    receivedAt?: Date;
    supplierId?: string;
  },
): Promise<SeedBatchRef> {
  const batch = await prisma.batch.create({
    data: {
      tenantId: opts.tenantId,
      branchId: opts.branchId,
      productId: opts.productId,
      batchNo: opts.batchNo,
      expiryDate: opts.expiryDate,
      costPrice: dec(opts.costPrice),
      sellingPrice: dec(opts.sellingPrice),
      receivedAt: opts.receivedAt ?? new Date(),
      supplierId: opts.supplierId,
    },
  });

  await prisma.stockLedger.create({
    data: {
      tenantId: opts.tenantId,
      branchId: opts.branchId,
      productId: opts.productId,
      batchId: batch.id,
      movementType: StockMovementType.purchase_in,
      qtyDelta: opts.qty,
      referenceType: "goods_receipt",
      referenceId: opts.referenceId,
      createdBy: opts.userId,
      occurredAt: opts.receivedAt ?? new Date(),
    },
  });

  return {
    batchId: batch.id,
    productId: opts.productId,
    sellingPrice: batch.sellingPrice,
  };
}

/** Posted sale + sale_out ledger lines. */
export async function seedSale(
  prisma: PrismaClient,
  opts: {
    tenantId: string;
    branchId: string;
    soldBy: string;
    invoiceNo: string;
    soldAt: Date;
    lines: Array<{
      productId: string;
      batchId: string;
      qty: number;
      unitPrice: number | string | Prisma.Decimal;
      discountAmount?: number | string | Prisma.Decimal;
      taxAmount?: number | string | Prisma.Decimal;
    }>;
  },
) {
  const mapped = opts.lines.map((l) => {
    const unitPrice = dec(l.unitPrice);
    const discountAmount = dec(l.discountAmount ?? 0);
    const taxAmount = dec(l.taxAmount ?? 0);
    const base = unitPrice.mul(l.qty);
    const lineTotal = base.sub(discountAmount).add(taxAmount);
    return { ...l, unitPrice, discountAmount, taxAmount, lineTotal };
  });

  const subtotal = mapped.reduce(
    (acc, l) => acc.add(l.unitPrice.mul(l.qty)),
    new Prisma.Decimal(0),
  );
  const discountTotal = mapped.reduce((acc, l) => acc.add(l.discountAmount), new Prisma.Decimal(0));
  const taxTotal = mapped.reduce((acc, l) => acc.add(l.taxAmount), new Prisma.Decimal(0));
  const grandTotal = mapped.reduce((acc, l) => acc.add(l.lineTotal), new Prisma.Decimal(0));

  const sale = await prisma.sale.create({
    data: {
      tenantId: opts.tenantId,
      branchId: opts.branchId,
      invoiceNo: opts.invoiceNo,
      soldAt: opts.soldAt,
      subtotal,
      discountTotal,
      taxTotal,
      grandTotal,
      soldBy: opts.soldBy,
      items: {
        create: mapped.map((l) => ({
          tenantId: opts.tenantId,
          productId: l.productId,
          batchId: l.batchId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountAmount: l.discountAmount,
          taxAmount: l.taxAmount,
          lineTotal: l.lineTotal,
        })),
      },
    },
  });

  for (const l of mapped) {
    await prisma.stockLedger.create({
      data: {
        tenantId: opts.tenantId,
        branchId: opts.branchId,
        productId: l.productId,
        batchId: l.batchId,
        movementType: StockMovementType.sale_out,
        qtyDelta: -l.qty,
        referenceType: "sale",
        referenceId: sale.id,
        createdBy: opts.soldBy,
        occurredAt: opts.soldAt,
      },
    });
  }

  return sale;
}
