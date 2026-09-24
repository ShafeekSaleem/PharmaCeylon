import { Prisma, StockMovementType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import {
  convertLegacyStockState,
  rebuildBatchStock,
} from "../src/inventory/stock/stock-projection";

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

/**
 * Seeds write the ledger in bulk, without `StockService`, so the running totals it would have
 * kept are rebuilt here once the writing is done. Also converts seed rows written the old way
 * (reservation ledger rows, whole-batch quarantine flags) into reservations and quarantined
 * quantities. Call after the last stock write for a tenant.
 */
export async function syncSeedStock(prisma: PrismaClient, tenantId: string): Promise<void> {
  await convertLegacyStockState(prisma, tenantId);
  await rebuildBatchStock(prisma, tenantId);
  await syncSupplierPrices(prisma, tenantId);
  await syncSupplierLedger(prisma, tenantId);
}

/**
 * Seeds write supplier invoices with a paid amount and nothing else, the way the old code did.
 * The ledger derives `paidAmount` from payments, so this gives every seeded invoice what the
 * migration gives an existing pharmacy: the supplier's-or-placeholder source, its delivery link
 * and lines, and a payment for whatever is marked paid. Idempotent.
 */
export async function syncSupplierLedger(prisma: PrismaClient, tenantId: string): Promise<void> {
  // An invoice with no delivery behind it was entered from a supplier's document.
  await prisma.$executeRaw`
    UPDATE supplier_invoice SET source = 'supplier'
    WHERE tenant_id = ${tenantId}::uuid AND source = 'system' AND goods_receipt_id IS NULL
  `;
  await prisma.$executeRaw`
    UPDATE supplier_invoice SET subtotal_amount = total_amount
    WHERE tenant_id = ${tenantId}::uuid AND subtotal_amount = 0
  `;
  await prisma.$executeRaw`
    INSERT INTO supplier_invoice_receipt (id, tenant_id, invoice_id, goods_receipt_id, created_at)
    SELECT gen_random_uuid(), si.tenant_id, si.id, si.goods_receipt_id, si.created_at
    FROM supplier_invoice si
    WHERE si.tenant_id = ${tenantId}::uuid AND si.goods_receipt_id IS NOT NULL
    ON CONFLICT DO NOTHING
  `;
  await prisma.$executeRaw`
    INSERT INTO supplier_invoice_line (id, tenant_id, invoice_id, product_id, qty, unit_cost, line_total, created_at)
    SELECT gen_random_uuid(), si.tenant_id, si.id, gri.product_id,
           gri.received_qty + gri.rejected_qty,
           COALESCE(gri.unit_cost, b.cost_price),
           COALESCE(gri.unit_cost, b.cost_price) * (gri.received_qty + gri.rejected_qty),
           si.created_at
    FROM supplier_invoice si
    JOIN goods_receipt_item gri ON gri.goods_receipt_id = si.goods_receipt_id
    JOIN batch b ON b.id = gri.batch_id
    WHERE si.tenant_id = ${tenantId}::uuid
      AND si.goods_receipt_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM supplier_invoice_line l WHERE l.invoice_id = si.id)
  `;
  // Whatever is marked paid but has no payment behind it gets one, dated when it was last
  // touched. Numbered separately so demo payments are recognisable.
  await prisma.$executeRaw`
    WITH gaps AS (
      SELECT si.id, si.tenant_id, si.supplier_id, si.branch_id, si.updated_at,
             si.paid_amount - COALESCE(SUM(a.amount), 0) AS missing,
             row_number() OVER (ORDER BY si.updated_at, si.id)
               + (SELECT count(*) FROM supplier_payment p
                  WHERE p.tenant_id = ${tenantId}::uuid AND p.payment_no LIKE 'PAY-SEED-%') AS seq
      FROM supplier_invoice si
      LEFT JOIN supplier_payment_allocation a ON a.invoice_id = si.id
      WHERE si.tenant_id = ${tenantId}::uuid
      GROUP BY si.id
      HAVING si.paid_amount - COALESCE(SUM(a.amount), 0) > 0
    ), payer AS (
      SELECT id FROM app_user WHERE tenant_id = ${tenantId}::uuid ORDER BY created_at LIMIT 1
    ), created AS (
      INSERT INTO supplier_payment (id, tenant_id, supplier_id, branch_id, payment_no, paid_on,
                                    amount, method, notes, created_by, created_at)
      SELECT gen_random_uuid(), g.tenant_id, g.supplier_id, g.branch_id,
             'PAY-SEED-' || lpad(g.seq::text, 5, '0'), g.updated_at::date, g.missing,
             'bank_transfer', 'Demo payment', (SELECT id FROM payer), g.updated_at
      FROM gaps g
      WHERE EXISTS (SELECT 1 FROM payer)
      ON CONFLICT (tenant_id, payment_no) DO NOTHING
      RETURNING id, payment_no
    )
    INSERT INTO supplier_payment_allocation (id, tenant_id, payment_id, invoice_id, amount, created_at)
    SELECT gen_random_uuid(), g.tenant_id, c.id, g.id, g.missing, now()
    FROM created c
    JOIN gaps g ON 'PAY-SEED-' || lpad(g.seq::text, 5, '0') = c.payment_no
  `;
}

/**
 * Build each supplier's price list from what the seeded batches say they were paid, the same
 * way the migration does for an existing pharmacy. Without it a freshly seeded demo has a
 * price-list screen with nothing in it, which is not what any real tenant sees after upgrading.
 */
export async function syncSupplierPrices(prisma: PrismaClient, tenantId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO supplier_product_price (
      id, tenant_id, supplier_id, product_id, units_per_pack,
      unit_cost, last_unit_cost, last_purchased_at, created_at, updated_at
    )
    SELECT gen_random_uuid(), b.tenant_id, b.supplier_id, b.product_id,
           GREATEST(COALESCE(p.units_per_pack, 1), 1),
           b.cost_price, b.cost_price, b.received_at, now(), now()
    FROM (
      SELECT DISTINCT ON (t.tenant_id, t.supplier_id, t.product_id)
        t.tenant_id, t.supplier_id, t.product_id, t.cost_price, t.received_at
      FROM batch t
      WHERE t.tenant_id = ${tenantId}::uuid AND t.supplier_id IS NOT NULL
      ORDER BY t.tenant_id, t.supplier_id, t.product_id, t.received_at DESC
    ) b
    JOIN product p ON p.id = b.product_id
    ON CONFLICT (tenant_id, supplier_id, product_id) DO NOTHING
  `;
}
