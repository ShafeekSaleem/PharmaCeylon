/**
 * Bulk demo operations for dashboards / analytics (~8 months of activity).
 * Called from seed.ts after NMRA catalog + scenario fixtures.
 *
 * The window is deliberately wider than any report's own date-range filter (max "Last 90
 * days") because Stock Health's ageing trend reconstructs the last 6 *months* of age
 * composition from the ledger — if all stock were received within the last 90 days, the
 * older trend points would be flat zero. Batch `receivedAt` values below are staggered across
 * the full window for the same reason: a realistic pharmacy has a spread of stock ages, not a
 * single cliff, and the spread is what lets Stock Ageing/Dead Stock surface genuine 91-180 and
 * 180+ day examples instead of only ever showing "everything is fresh."
 *
 * Idempotent with full seed re-runs (seed.ts clears ops first).
 */
import { randomUUID } from "crypto";
import {
  GoodsReturnStatus,
  GoodsReturnType,
  PaymentMethod,
  PoPriority,
  PoStatus,
  Prisma,
  PrismaClient,
  SaleStatus,
  StockMovementType,
  TransferStatus,
} from "@prisma/client";
import { dateOnly, daysAgo, daysFromNow, dec } from "./seed-helpers";
import {
  DEMO_STOCK_REG_NOS,
  demoPricingForProduct,
  type NmraProductRow,
} from "../src/nmra/nmra-normalize";

const BATCH = 150;
const HISTORY_DAYS = 240;
/** Target daily sales across all branches (weekday; weekends lower). */
const SALES_PER_DAY_WEEKDAY = 55;
const SALES_PER_DAY_WEEKEND = 32;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ean13CheckDigit(body12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(body12[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Synthetic EAN-13 under Sri Lanka GS1-ish 479 prefix; deterministic per index. */
export function syntheticEan13(index: number): string {
  const body = `479${String(100000000 + (index % 900000000)).slice(0, 9)}`;
  return body + ean13CheckDigit(body);
}

async function createManyBatched<T extends object>(
  run: (chunk: T[]) => Promise<unknown>,
  rows: T[],
  label: string,
) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await run(chunk);
    if ((i + chunk.length) % 2000 === 0 || i + chunk.length >= rows.length) {
      console.log(`  ${label}: ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
    }
  }
}

export type DemoOpsBranch = {
  id: string;
  code: string;
  /** Share of daily sales (sums ~1 across branches). */
  salesWeight: number;
};

export type DemoOpsUsers = {
  cashierId: string;
  managerId: string;
  pharmacistId: string;
  clerkId: string;
  /** Extra branch-scoped cashiers (beyond cashierId) so Staff Productivity shows more than one name per branch. */
  cashiersByBranch?: Record<string, string[]>;
};

export type DemoOpsResult = {
  rangedProducts: number;
  referenceProducts: number;
  inactiveProducts: number;
  barcodesAdded: number;
  branchBatches: number;
  sales: number;
  salePayments: number;
  purchaseOrders: number;
  goodsReceipts: number;
  transfers: number;
  customerReturns: number;
  nearExpiryBatches: number;
};

type StockLot = {
  batchId: string;
  productId: string;
  qty: number;
  sellingPrice: Prisma.Decimal;
  costPrice: Prisma.Decimal;
  branchId: string;
};

/**
 * 1) Activate stratified sellable set; deactivate remaining catalog.
 * 2) Ensure synthetic barcodes on sellable SKUs missing one.
 * 3) Stock secondary branches + near-expiry samples.
 * 4) Generate ~8 months of sales / POs / GRNs / transfers / returns with coherent ledger.
 */
export async function seedDemoOps(
  prisma: PrismaClient,
  opts: {
    tenantId: string;
    /** When set, credit sales are attached to these customers (receivables customers). */
    customerIds?: string[];
    branches: DemoOpsBranch[];
    users: DemoOpsUsers;
    productBySku: Map<string, string>;
    nmraProducts: NmraProductRow[];
    demoStockRegNos: string[];
    supplierIds: string[];
  },
): Promise<DemoOpsResult> {
  const {
    tenantId,
    branches,
    users,
    productBySku,
    nmraProducts,
    demoStockRegNos,
    supplierIds,
    customerIds = [],
  } = opts;
  const rng = mulberry32(20260804);
  const main = branches.find((b) => b.code === "MAIN");
  if (!main) throw new Error("seedDemoOps requires MAIN branch");

  /** Per-branch seller pool for attributing sales; falls back to the single shared cashier. */
  const cashierPoolByBranch = new Map<string, string[]>();
  for (const branch of branches) {
    const extra = users.cashiersByBranch?.[branch.id] ?? [];
    cashierPoolByBranch.set(branch.id, [users.cashierId, ...extra]);
  }

  const sellableRegs = new Set(demoStockRegNos);
  for (const [key, reg] of Object.entries(DEMO_STOCK_REG_NOS)) {
    // PCL-0029 is intentionally inactive in NMRA seed — keep it out of sellable set.
    if (key === "PCL-0029") continue;
    sellableRegs.add(reg);
  }

  const sellableProductIds = new Set<string>();
  for (const reg of sellableRegs) {
    const id = productBySku.get(reg);
    if (id) sellableProductIds.add(id);
  }
  for (const [key, reg] of Object.entries(DEMO_STOCK_REG_NOS)) {
    if (key === "PCL-0029") continue;
    const id = productBySku.get(key) ?? productBySku.get(reg);
    if (id) sellableProductIds.add(id);
  }

  console.log("\n── Demo ops: range sellable / keep the rest as reference ──");
  // This used to switch `isActive` off across the whole catalog and back on for the sellable
  // subset — a hand-rolled stand-in for "do we sell this", written into the one boolean that
  // was available at the time. That meaning now has its own field, so the seed says it
  // directly: everything imported from the NMRA register is REFERENCE, and only the products
  // the demo pharmacy actually trades are RANGED. `isActive` is left alone here; it answers
  // "is this record enabled", which is a separate question handled below.
  await prisma.product.updateMany({
    where: { tenantId },
    data: { rangeStatus: "REFERENCE", rangedAt: null },
  });

  const sellableIdList = [...sellableProductIds];
  for (let i = 0; i < sellableIdList.length; i += BATCH) {
    const chunk = sellableIdList.slice(i, i + BATCH);
    await prisma.product.updateMany({
      where: { tenantId, id: { in: chunk } },
      data: { rangeStatus: "RANGED", rangedAt: new Date() },
    });
  }

  // A handful of discontinued lines, so the demo shows the two flags are independent: these
  // are products the pharmacy ranged and then stopped selling, which is not the same thing
  // as a registry record it never carried.
  const discontinued = await prisma.product.findMany({
    where: { tenantId, rangeStatus: "RANGED" },
    select: { id: true },
    orderBy: { sku: "asc" },
    take: 12,
    skip: 40,
  });
  if (discontinued.length > 0) {
    await prisma.product.updateMany({
      where: { tenantId, id: { in: discontinued.map((p) => p.id) } },
      data: { isActive: false },
    });
  }

  const rangedProducts = await prisma.product.count({
    where: { tenantId, rangeStatus: "RANGED" },
  });
  const referenceProducts = await prisma.product.count({
    where: { tenantId, rangeStatus: "REFERENCE" },
  });
  const inactiveProducts = await prisma.product.count({ where: { tenantId, isActive: false } });
  console.log(
    `  Ranged: ${rangedProducts}, reference: ${referenceProducts}, inactive: ${inactiveProducts}`,
  );

  // Synthetic barcodes for sellable products missing one
  console.log("── Demo ops: synthetic barcodes ──");
  const needBarcode = await prisma.product.findMany({
    // Only the products the demo pharmacy sells need a scannable barcode — the reference
    // catalog keeps whatever the register carried.
    where: {
      tenantId,
      rangeStatus: "RANGED",
      OR: [{ barcode: null }, { barcode: "" }],
    },
    select: { id: true, sku: true },
    orderBy: { sku: "asc" },
  });
  let barcodesAdded = 0;
  const usedBarcodes = new Set(
    (
      await prisma.product.findMany({
        where: { tenantId, barcode: { not: null } },
        select: { barcode: true },
      })
    )
      .map((p) => p.barcode)
      .filter(Boolean) as string[],
  );
  const barcodeAssignments: Array<{ id: string; barcode: string }> = [];
  for (let i = 0; i < needBarcode.length; i++) {
    const p = needBarcode[i]!;
    let barcode = syntheticEan13(i + 1);
    let attempt = 0;
    while (usedBarcodes.has(barcode) && attempt < 20) {
      barcode = syntheticEan13(i + 1 + attempt * 9973);
      attempt++;
    }
    if (usedBarcodes.has(barcode)) continue;
    usedBarcodes.add(barcode);
    barcodeAssignments.push({ id: p.id, barcode });
  }
  for (let i = 0; i < barcodeAssignments.length; i += 50) {
    const chunk = barcodeAssignments.slice(i, i + 50);
    await Promise.all(
      chunk.map(async (row) => {
        await prisma.product.update({
          where: { id: row.id },
          data: { barcode: row.barcode },
        });
        await prisma.productAlias
          .create({
            data: {
              tenantId,
              productId: row.id,
              aliasText: row.barcode,
              aliasType: "barcode",
            },
          })
          .catch(() => undefined);
      }),
    );
    console.log(
      `  barcodes: ${Math.min(i + chunk.length, barcodeAssignments.length)}/${barcodeAssignments.length}`,
    );
  }
  barcodesAdded = barcodeAssignments.length;

  // Product meta for pricing
  const productMeta = new Map<string, NmraProductRow>();
  for (const p of nmraProducts) {
    productMeta.set(p.id, p);
    if (!productMeta.has(p.sku)) productMeta.set(p.sku, p);
  }

  // "Sellable" is the shop's range, not the register. This used to read `isActive: true`,
  // which was the right question back when that one boolean also meant "do we sell this" —
  // after the split it matches all 15,000 imported NMRA rows, so the ops seed handed stock,
  // purchase orders and sales to products the demo pharmacy never carried. Stock arriving on
  // a product ranges it (ensureProductsRanged), so stocking a REFERENCE row here produced
  // data the app itself would never create.
  const sellableProducts = await prisma.product.findMany({
    where: { tenantId, isActive: true, rangeStatus: "RANGED" },
    select: {
      id: true,
      sku: true,
      schedule: true,
      dosageForm: true,
      isControlled: true,
      requiresPrescription: true,
    },
  });

  console.log("── Demo ops: secondary-branch stock + near-expiry ──");
  const secondaryBranches = branches.filter((b) => b.code !== "MAIN");
  const batchRows: Prisma.BatchCreateManyInput[] = [];
  const ledgerRows: Prisma.StockLedgerCreateManyInput[] = [];
  const stockLots = new Map<string, StockLot>(); // `${branchId}:${productId}` → primary lot

  // Load existing MAIN batches into stock tracker
  const existingBatches = await prisma.batch.findMany({
    where: { tenantId },
    select: {
      id: true,
      branchId: true,
      productId: true,
      sellingPrice: true,
      costPrice: true,
      batchNo: true,
    },
  });
  const ledgerAgg = await prisma.stockLedger.groupBy({
    by: ["batchId"],
    where: { tenantId },
    _sum: { qtyDelta: true },
  });
  const qtyByBatch = new Map(ledgerAgg.map((r) => [r.batchId, r._sum.qtyDelta ?? 0]));

  for (const b of existingBatches) {
    const qty = qtyByBatch.get(b.id) ?? 0;
    if (qty <= 0) continue;
    const key = `${b.branchId}:${b.productId}`;
    const prev = stockLots.get(key);
    if (!prev || qty > prev.qty) {
      stockLots.set(key, {
        batchId: b.id,
        productId: b.productId,
        qty,
        sellingPrice: b.sellingPrice,
        costPrice: b.costPrice,
        branchId: b.branchId,
      });
    }
  }

  // Stock each secondary branch with a stratified subset (~40% of sellable)
  let branchBatches = 0;
  let nearExpiryBatches = 0;
  const seedGrSecondary = "00000000-0000-4000-8000-0000000000b2";

  for (const branch of secondaryBranches) {
    const subset = sellableProducts.filter((_, idx) => {
      // Deterministic ~40% coverage, denser for BRANCH2
      const mod = branch.code === "BRANCH2" ? 2 : 3;
      return idx % mod === 0;
    });
    for (let i = 0; i < subset.length; i++) {
      const prod = subset[i]!;
      const meta = productMeta.get(prod.id);
      const pricing = demoPricingForProduct(
        {
          schedule: prod.schedule ?? meta?.schedule,
          isControlled: prod.isControlled || meta?.isControlled,
          dosageFormGroup: meta?.dosageFormGroup ?? prod.dosageForm ?? undefined,
        },
        i,
      );
      // Secondary branches hold less depth
      const qty = Math.max(8, Math.round(pricing.qty * (branch.code === "BRANCH2" ? 0.45 : 0.35)));
      const batchId = randomUUID();
      const monthsAhead = 6 + (i % 12);
      const expiry = new Date(Date.UTC(2026, 8, 1));
      expiry.setUTCMonth(expiry.getUTCMonth() + monthsAhead);
      // Staggered across the full history window (not a flat 50-70 days) so each secondary
      // branch — viewable on its own via the branch filter — has its own realistic age spread
      // rather than looking artificially all-fresh once you're not looking at MAIN.
      const receivedAt = daysAgo(20 + ((i * 17) % 220));

      batchRows.push({
        id: batchId,
        tenantId,
        branchId: branch.id,
        productId: prod.id,
        batchNo: `OPS-${branch.code}-${prod.sku.slice(0, 12)}-A`,
        expiryDate: dateOnly(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 12),
        costPrice: dec(pricing.cost),
        sellingPrice: dec(pricing.sell),
        receivedAt,
        supplierId: supplierIds.length > 0 ? supplierIds[i % supplierIds.length] : undefined,
      });
      ledgerRows.push({
        id: randomUUID(),
        tenantId,
        branchId: branch.id,
        productId: prod.id,
        batchId,
        movementType: StockMovementType.purchase_in,
        qtyDelta: qty,
        referenceType: "goods_receipt",
        referenceId: seedGrSecondary,
        createdBy: users.clerkId,
        occurredAt: receivedAt,
      });
      stockLots.set(`${branch.id}:${prod.id}`, {
        batchId,
        productId: prod.id,
        qty,
        sellingPrice: dec(pricing.sell),
        costPrice: dec(pricing.cost),
        branchId: branch.id,
      });
      branchBatches++;
    }
  }

  // Near-expiry samples (~25 extra lots for dashboard widgets), spread across every
  // branch — not just MAIN — so Batch & Expiry Monitor has real data regardless of
  // which branch a manager/pharmacist is currently viewing.
  const nearPick = sellableProducts.filter((_, i) => i % 28 === 0).slice(0, 25);
  const seedGrNearOps = "00000000-0000-4000-8000-0000000000a1";
  const nearExpiryBranchCycle = [main, main, ...secondaryBranches];
  for (let i = 0; i < nearPick.length; i++) {
    const prod = nearPick[i]!;
    const meta = productMeta.get(prod.id);
    const pricing = demoPricingForProduct(
      {
        schedule: prod.schedule ?? meta?.schedule,
        isControlled: prod.isControlled || meta?.isControlled,
        dosageFormGroup: meta?.dosageFormGroup ?? prod.dosageForm ?? undefined,
      },
      i + 900,
    );
    const nearBranch = nearExpiryBranchCycle[i % nearExpiryBranchCycle.length]!;
    const batchId = randomUUID();
    const daysUntil = 5 + (i % 25); // 5–29 days
    const receivedAt = daysAgo(70);
    batchRows.push({
      id: batchId,
      tenantId,
      branchId: nearBranch.id,
      productId: prod.id,
      batchNo: `OPS-NEAR-${nearBranch.code}-${prod.sku.slice(0, 10)}-${i}`,
      expiryDate: daysFromNow(daysUntil),
      costPrice: dec(pricing.cost),
      sellingPrice: dec(pricing.sell),
      receivedAt,
      supplierId: supplierIds.length > 0 ? supplierIds[i % supplierIds.length] : undefined,
    });
    ledgerRows.push({
      id: randomUUID(),
      tenantId,
      branchId: nearBranch.id,
      productId: prod.id,
      batchId,
      movementType: StockMovementType.purchase_in,
      qtyDelta: 4 + (i % 8),
      referenceType: "goods_receipt",
      referenceId: seedGrNearOps,
      createdBy: users.clerkId,
      occurredAt: receivedAt,
    });
    nearExpiryBatches++;
  }

  await createManyBatched(
    (chunk) => prisma.batch.createMany({ data: chunk, skipDuplicates: true }),
    batchRows,
    "ops batches",
  );
  await createManyBatched(
    (chunk) => prisma.stockLedger.createMany({ data: chunk }),
    ledgerRows,
    "ops stock-in ledger",
  );
  console.log(
    `  Secondary batches: ${branchBatches}, near-expiry: ${nearExpiryBatches}`,
  );

  // Ensure MAIN has a stock lot for every sellable product (top-up if missing)
  console.log("── Demo ops: MAIN stock top-up for sellable gaps ──");
  const mainTopUpBatches: Prisma.BatchCreateManyInput[] = [];
  const mainTopUpLedger: Prisma.StockLedgerCreateManyInput[] = [];
  const seedGrMainTop = "00000000-0000-4000-8000-0000000000a2";
  let mainTopUps = 0;
  for (let i = 0; i < sellableProducts.length; i++) {
    const prod = sellableProducts[i]!;
    const key = `${main.id}:${prod.id}`;
    if (stockLots.has(key)) continue;
    const meta = productMeta.get(prod.id);
    const pricing = demoPricingForProduct(
      {
        schedule: prod.schedule ?? meta?.schedule,
        isControlled: prod.isControlled || meta?.isControlled,
        dosageFormGroup: meta?.dosageFormGroup ?? prod.dosageForm ?? undefined,
      },
      i,
    );
    const batchId = randomUUID();
    const monthsAhead = 5 + (i % 14);
    const expiry = new Date(Date.UTC(2026, 8, 1));
    expiry.setUTCMonth(expiry.getUTCMonth() + monthsAhead);
    // Staggered (not a flat 55 days) for the same reason as the secondary-branch stock above.
    const receivedAt = daysAgo(15 + ((i * 13) % 215));
    const qty = pricing.qty;
    mainTopUpBatches.push({
      id: batchId,
      tenantId,
      branchId: main.id,
      productId: prod.id,
      batchNo: `OPS-MAIN-${prod.sku.slice(0, 12)}-T`,
      expiryDate: dateOnly(expiry.getUTCFullYear(), expiry.getUTCMonth() + 1, 8),
      costPrice: dec(pricing.cost),
      sellingPrice: dec(pricing.sell),
      receivedAt,
      supplierId: supplierIds.length > 0 ? supplierIds[i % supplierIds.length] : undefined,
    });
    mainTopUpLedger.push({
      id: randomUUID(),
      tenantId,
      branchId: main.id,
      productId: prod.id,
      batchId,
      movementType: StockMovementType.purchase_in,
      qtyDelta: qty,
      referenceType: "goods_receipt",
      referenceId: seedGrMainTop,
      createdBy: users.clerkId,
      occurredAt: receivedAt,
    });
    stockLots.set(key, {
      batchId,
      productId: prod.id,
      qty,
      sellingPrice: dec(pricing.sell),
      costPrice: dec(pricing.cost),
      branchId: main.id,
    });
    mainTopUps++;
  }
  await createManyBatched(
    (chunk) => prisma.batch.createMany({ data: chunk, skipDuplicates: true }),
    mainTopUpBatches,
    "MAIN top-up batches",
  );
  await createManyBatched(
    (chunk) => prisma.stockLedger.createMany({ data: chunk }),
    mainTopUpLedger,
    "MAIN top-up ledger",
  );
  console.log(`  MAIN top-ups: ${mainTopUps}`);

  // ── Historical purchases (weekly replenishment) ──────────────────────────
  console.log("── Demo ops: historical POs / GRNs ──");
  const poRows: Prisma.PurchaseOrderCreateManyInput[] = [];
  const poItemRows: Prisma.PurchaseOrderItemCreateManyInput[] = [];
  const grRows: Prisma.GoodsReceiptCreateManyInput[] = [];
  const grItemRows: Prisma.GoodsReceiptItemCreateManyInput[] = [];
  const poBatchRows: Prisma.BatchCreateManyInput[] = [];
  const poLedgerRows: Prisma.StockLedgerCreateManyInput[] = [];

  let poSeq = 200;
  let grSeq = 200;
  const activeSuppliers = supplierIds.length ? supplierIds : [];

  // Weekly replenishment cycles spanning the full history window (scales with HISTORY_DAYS so
  // supply keeps pace with the sales volume generated below — without this, extending
  // HISTORY_DAYS alone would starve later days of stock since replenishment stayed fixed at 12
  // weeks/~84 days while demand grew to match the full window).
  const REPLENISHMENT_WEEKS = Math.ceil(HISTORY_DAYS / 7);
  for (let week = 0; week < REPLENISHMENT_WEEKS; week++) {
    const daysBack = HISTORY_DAYS - week * 7 - 2;
    if (daysBack < 1) continue;
    for (const branch of branches) {
      if (activeSuppliers.length === 0) continue;
      const supplierId = activeSuppliers[week % activeSuppliers.length]!;
      const poId = randomUUID();
      const grId = randomUUID();
      const poNumber = `PO-${branch.code}-OPS-${String(poSeq++).padStart(4, "0")}`;
      const grnNumber = `GRN-${branch.code}-OPS-${String(grSeq++).padStart(4, "0")}`;
      const createdAt = daysAgo(daysBack + 3);
      const receivedOn = daysAgo(daysBack);

      poRows.push({
        id: poId,
        tenantId,
        branchId: branch.id,
        supplierId,
        poNumber,
        status: PoStatus.received,
        priority: PoPriority.normal,
        expectedOn: receivedOn,
        notes: "Ops seed replenishment",
        paymentTermsDays: 30,
        createdBy: users.managerId,
        createdAt,
      });

      // 6–10 line items per PO from products stocked at this branch
      const candidates = sellableProducts.filter((p) =>
        stockLots.has(`${branch.id}:${p.id}`),
      );
      const lineCount = 6 + Math.floor(rng() * 5);
      const picked = new Set<number>();
      for (let li = 0; li < lineCount && candidates.length > 0; li++) {
        let idx = Math.floor(rng() * candidates.length);
        let guard = 0;
        while (picked.has(idx) && guard++ < 20) idx = Math.floor(rng() * candidates.length);
        picked.add(idx);
        const prod = candidates[idx]!;
        const lot = stockLots.get(`${branch.id}:${prod.id}`)!;
        const orderedQty = 20 + Math.floor(rng() * 80);
        const unitCost = Number(lot.costPrice);
        poItemRows.push({
          id: randomUUID(),
          tenantId,
          purchaseOrderId: poId,
          productId: prod.id,
          orderedQty,
          unitCost: dec(unitCost),
          taxPercent: dec(18),
        });

        const batchId = randomUUID();
        const sell = Number(lot.sellingPrice);
        poBatchRows.push({
          id: batchId,
          tenantId,
          branchId: branch.id,
          productId: prod.id,
          batchNo: `OPS-RCV-${branch.code}-${poSeq}-${li}`,
          expiryDate: daysFromNow(180 + Math.floor(rng() * 400)),
          costPrice: dec(unitCost),
          sellingPrice: dec(sell),
          receivedAt: receivedOn,
          supplierId,
        });
        grItemRows.push({
          id: randomUUID(),
          tenantId,
          goodsReceiptId: grId,
          productId: prod.id,
          batchId,
          receivedQty: orderedQty,
        });
        poLedgerRows.push({
          id: randomUUID(),
          tenantId,
          branchId: branch.id,
          productId: prod.id,
          batchId,
          movementType: StockMovementType.purchase_in,
          qtyDelta: orderedQty,
          referenceType: "goods_receipt",
          referenceId: grId,
          createdBy: users.clerkId,
          occurredAt: receivedOn,
        });
        // Switch the tracked "current sellable" lot to this new batch. Reset (not add) —
        // every later sale_out for this product/branch is posted against `lot.batchId`, so if
        // this pooled `qty` carried the old batch's leftover forward, sales would debit more
        // than THIS specific batch's own `orderedQty` purchase_in ever credited it, eventually
        // driving that batch's real ledger balance negative once cumulative debits exceed its
        // own receipt. The old batch's untouched leftover isn't lost — it just correctly stays
        // parked on the old batchId as aging stock, which is what a real goods-receipt switch
        // looks like anyway.
        lot.qty = orderedQty;
        lot.batchId = batchId;
        lot.costPrice = dec(unitCost);
        lot.sellingPrice = dec(sell);
      }

      grRows.push({
        id: grId,
        tenantId,
        branchId: branch.id,
        purchaseOrderId: poId,
        grnNumber,
        receivedOn,
        receivedBy: users.clerkId,
        createdAt: receivedOn,
      });
    }
  }

  await createManyBatched(
    (chunk) => prisma.purchaseOrder.createMany({ data: chunk }),
    poRows,
    "ops POs",
  );
  await createManyBatched(
    (chunk) => prisma.purchaseOrderItem.createMany({ data: chunk }),
    poItemRows,
    "ops PO items",
  );
  await createManyBatched(
    (chunk) => prisma.batch.createMany({ data: chunk, skipDuplicates: true }),
    poBatchRows,
    "ops receipt batches",
  );
  await createManyBatched(
    (chunk) => prisma.goodsReceipt.createMany({ data: chunk }),
    grRows,
    "ops GRNs",
  );
  await createManyBatched(
    (chunk) => prisma.goodsReceiptItem.createMany({ data: chunk }),
    grItemRows,
    "ops GRN items",
  );
  await createManyBatched(
    (chunk) => prisma.stockLedger.createMany({ data: chunk }),
    poLedgerRows,
    "ops receipt ledger",
  );

  // ── Historical sales ─────────────────────────────────────────────────────
  console.log(`── Demo ops: historical sales (~${HISTORY_DAYS} days) ──`);
  const saleRows: Prisma.SaleCreateManyInput[] = [];
  const saleItemRows: Prisma.SaleItemCreateManyInput[] = [];
  const paymentRows: Prisma.SalePaymentCreateManyInput[] = [];
  const saleLedgerRows: Prisma.StockLedgerCreateManyInput[] = [];
  // A handful of today's sales get marked partially_refunded (with a matching
  // GoodsReturn below) so cashier/pharmacist "Returns today" widgets — which
  // read Sale.status, not GoodsReturn — aren't structurally always zero.
  const todayReturnCandidates: Array<{
    saleId: string;
    branchId: string;
    productId: string;
    batchId: string;
    qty: number;
    unitPrice: Prisma.Decimal;
    soldAt: Date;
  }> = [];

  const weightSum = branches.reduce((a, b) => a + b.salesWeight, 0);
  let invoiceSeq = 1000;
  let salesCreated = 0;

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 0; dayOffset--) {
    const soldDay = daysAgo(dayOffset);
    const dow = soldDay.getUTCDay(); // 0 Sun … 6 Sat
    const isWeekend = dow === 0 || dow === 6;
    const dayTotal = isWeekend ? SALES_PER_DAY_WEEKEND : SALES_PER_DAY_WEEKDAY;
    // Mild weekday variance
    const daySales = Math.max(
      8,
      Math.round(dayTotal * (0.85 + rng() * 0.3)),
    );

    for (let s = 0; s < daySales; s++) {
      // Pick branch by weight
      let r = rng() * weightSum;
      let branch = branches[0]!;
      for (const b of branches) {
        r -= b.salesWeight;
        if (r <= 0) {
          branch = b;
          break;
        }
      }

      const candidates = sellableProducts.filter((p) => {
        const lot = stockLots.get(`${branch.id}:${p.id}`);
        return lot && lot.qty >= 1;
      });
      if (candidates.length === 0) continue;

      const lineCount = 1 + Math.floor(rng() * 3); // 1–3 lines
      const lines: Array<{
        productId: string;
        batchId: string;
        qty: number;
        unitPrice: Prisma.Decimal;
        lineTotal: Prisma.Decimal;
      }> = [];
      const usedProd = new Set<string>();

      for (let li = 0; li < lineCount; li++) {
        const prod = candidates[Math.floor(rng() * candidates.length)]!;
        if (usedProd.has(prod.id)) continue;
        usedProd.add(prod.id);
        const lot = stockLots.get(`${branch.id}:${prod.id}`);
        if (!lot || lot.qty < 1) continue;
        const qty = Math.min(lot.qty, 1 + Math.floor(rng() * 3));
        const unitPrice = lot.sellingPrice;
        const lineTotal = unitPrice.mul(qty);
        lines.push({
          productId: prod.id,
          batchId: lot.batchId,
          qty,
          unitPrice,
          lineTotal,
        });
        lot.qty -= qty;
      }
      if (lines.length === 0) continue;

      const saleId = randomUUID();
      const subtotal = lines.reduce(
        (acc, l) => acc.add(l.lineTotal),
        new Prisma.Decimal(0),
      );
      const hour = 7 + Math.floor(rng() * 15); // 07–21 — matches the dashboard's hourly workload chart range
      const minute = Math.floor(rng() * 60);
      const soldAt = new Date(soldDay);
      // Local setter (not UTC) — the dashboard buckets "today"/hour-of-day using the
      // viewer's local Date methods, so the wall-clock hour must be set the same way
      // or it drifts by the server's UTC offset (e.g. +5:30 for Asia/Colombo).
      soldAt.setHours(hour, minute, Math.floor(rng() * 60), 0);

      // Today gets a few partially_refunded sales — see todayReturnCandidates above.
      const isReturnCandidate =
        dayOffset === 0 && todayReturnCandidates.length < 4 && rng() < 0.08;

      const invoiceNo = `INV-${branch.code}-OPS-${String(invoiceSeq++).padStart(5, "0")}`;
      const branchCashiers = cashierPoolByBranch.get(branch.id) ?? [users.cashierId];
      const sellerId =
        rng() < 0.12
          ? users.pharmacistId
          : branchCashiers[Math.floor(rng() * branchCashiers.length)]!;

      const payRoll = rng();
      let customerId: string | null = null;
      // Today gets a richer registered-customer mix so the cashier's "Customers
      // Today" panel isn't dominated by walk-ins (historical days keep the lower rate).
      const creditThreshold = dayOffset === 0 ? 0.22 : 0.07;
      if (payRoll < creditThreshold && Number(subtotal) >= 400) {
        if (customerIds.length > 0) {
          customerId = customerIds[Math.floor(rng() * customerIds.length)]!;
        }
        paymentRows.push({
          id: randomUUID(),
          tenantId,
          saleId,
          method: PaymentMethod.credit,
          amount: subtotal,
          reference: `CR-${invoiceSeq}`,
          createdAt: soldAt,
        });
      } else if (payRoll < 0.15 && Number(subtotal) >= 500) {
        const cashAmt = dec(Math.round(Number(subtotal) * 0.4));
        const cardAmt = subtotal.sub(cashAmt);
        paymentRows.push({
          id: randomUUID(),
          tenantId,
          saleId,
          method: PaymentMethod.cash,
          amount: cashAmt,
          createdAt: soldAt,
        });
        paymentRows.push({
          id: randomUUID(),
          tenantId,
          saleId,
          method: PaymentMethod.card,
          amount: cardAmt,
          reference: `AUTH-${invoiceSeq}`,
          createdAt: soldAt,
        });
      } else {
        const method =
          payRoll < 0.48
            ? PaymentMethod.cash
            : payRoll < 0.85
              ? PaymentMethod.card
              : PaymentMethod.mobile_wallet;
        paymentRows.push({
          id: randomUUID(),
          tenantId,
          saleId,
          method,
          amount: subtotal,
          reference:
            method === PaymentMethod.cash
              ? null
              : `${method === PaymentMethod.card ? "CARD" : "WALLET"}-${invoiceSeq}`,
          createdAt: soldAt,
        });
      }

      saleRows.push({
        id: saleId,
        tenantId,
        branchId: branch.id,
        invoiceNo,
        status: isReturnCandidate ? SaleStatus.partially_refunded : SaleStatus.posted,
        soldAt,
        subtotal,
        discountTotal: dec(0),
        taxTotal: dec(0),
        grandTotal: subtotal,
        amountPaid: customerId ? dec(0) : subtotal,
        changeDue: dec(0),
        soldBy: sellerId,
        dispensedBy: rng() < 0.08 ? users.pharmacistId : null,
        customerId,
        createdAt: soldAt,
      });

      for (const l of lines) {
        saleItemRows.push({
          id: randomUUID(),
          tenantId,
          saleId,
          productId: l.productId,
          batchId: l.batchId,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountAmount: dec(0),
          taxAmount: dec(0),
          lineTotal: l.lineTotal,
          createdAt: soldAt,
        });
        saleLedgerRows.push({
          id: randomUUID(),
          tenantId,
          branchId: branch.id,
          productId: l.productId,
          batchId: l.batchId,
          movementType: StockMovementType.sale_out,
          qtyDelta: -l.qty,
          referenceType: "sale",
          referenceId: saleId,
          createdBy: sellerId,
          occurredAt: soldAt,
        });
      }

      if (isReturnCandidate) {
        const firstLine = lines[0]!;
        todayReturnCandidates.push({
          saleId,
          branchId: branch.id,
          productId: firstLine.productId,
          batchId: firstLine.batchId,
          qty: Math.min(firstLine.qty, 1),
          unitPrice: firstLine.unitPrice,
          soldAt,
        });
      }

      salesCreated++;
    }

    if (dayOffset % 15 === 0) {
      console.log(`  sales progress: day -${dayOffset} (${salesCreated} invoices so far)`);
    }
  }

  await createManyBatched(
    (chunk) => prisma.sale.createMany({ data: chunk }),
    saleRows,
    "ops sales",
  );
  await createManyBatched(
    (chunk) => prisma.saleItem.createMany({ data: chunk }),
    saleItemRows,
    "ops sale items",
  );
  await createManyBatched(
    (chunk) => prisma.salePayment.createMany({ data: chunk }),
    paymentRows,
    "ops payments",
  );
  await createManyBatched(
    (chunk) => prisma.stockLedger.createMany({ data: chunk }),
    saleLedgerRows,
    "ops sale ledger",
  );

  // ── Today's partially_refunded sales get a matching GoodsReturn ──────────
  if (todayReturnCandidates.length > 0) {
    console.log(`── Demo ops: today's returns (${todayReturnCandidates.length}) ──`);
    for (let i = 0; i < todayReturnCandidates.length; i++) {
      const cand = todayReturnCandidates[i]!;
      const retId = randomUUID();
      const amount = cand.unitPrice.mul(cand.qty);
      await prisma.goodsReturn.create({
        data: {
          id: retId,
          tenantId,
          branchId: cand.branchId,
          returnNumber: `RET-TODAY-${String(i + 1).padStart(4, "0")}`,
          type: GoodsReturnType.customer,
          status: GoodsReturnStatus.completed,
          customerName: "Counter customer",
          saleId: cand.saleId,
          reason: "Counter refund",
          amount,
          requestedBy: users.cashierId,
          approvedBy: users.managerId,
          processedBy: users.managerId,
          createdAt: cand.soldAt,
          items: {
            create: [
              {
                tenantId,
                productId: cand.productId,
                batchId: cand.batchId,
                qty: cand.qty,
                unitPrice: cand.unitPrice,
              },
            ],
          },
        },
      });
      await prisma.stockLedger.create({
        data: {
          tenantId,
          branchId: cand.branchId,
          productId: cand.productId,
          batchId: cand.batchId,
          movementType: StockMovementType.customer_return_in,
          qtyDelta: cand.qty,
          referenceType: "goods_return",
          referenceId: retId,
          createdBy: users.managerId,
          occurredAt: cand.soldAt,
        },
      });
    }
  }

  // ── Transfers between branches (modest volume) ───────────────────────────
  console.log("── Demo ops: inter-branch transfers ──");
  let transferSeq = 200;
  let transfers = 0;
  const transferPairs: Array<[DemoOpsBranch, DemoOpsBranch]> = [];
  for (const a of branches) {
    for (const b of branches) {
      if (a.id !== b.id) transferPairs.push([a, b]);
    }
  }

  for (let t = 0; t < 24; t++) {
    const [from, to] = transferPairs[t % transferPairs.length]!;
    const daysBack = 5 + t * 3;
    if (daysBack > HISTORY_DAYS) continue;
    const candidates = sellableProducts.filter((p) => {
      const lot = stockLots.get(`${from.id}:${p.id}`);
      return lot && lot.qty >= 5;
    });
    if (candidates.length === 0) continue;
    const prod = candidates[Math.floor(rng() * candidates.length)]!;
    const lot = stockLots.get(`${from.id}:${prod.id}`)!;
    const qty = Math.min(lot.qty - 1, 3 + Math.floor(rng() * 8));
    if (qty < 1) continue;

    const transferId = randomUUID();
    const createdAt = daysAgo(daysBack);
    const status =
      t % 5 === 0
        ? TransferStatus.in_transit
        : t % 5 === 1
          ? TransferStatus.approved
          : TransferStatus.received;

    await prisma.transfer.create({
      data: {
        id: transferId,
        tenantId,
        fromBranchId: from.id,
        toBranchId: to.id,
        transferNumber: `TR-OPS-${String(transferSeq++).padStart(4, "0")}`,
        status,
        notes: "Ops seed transfer",
        expectedOn: daysAgo(Math.max(0, daysBack - 2)),
        requestedBy: users.clerkId,
        approvedBy: users.managerId,
        receivedBy: status === TransferStatus.received ? users.managerId : null,
        createdAt,
        updatedAt: daysAgo(Math.max(0, daysBack - 1)),
        items: {
          create: [
            {
              tenantId,
              productId: prod.id,
              batchId: lot.batchId,
              qty,
              receivedQty: status === TransferStatus.received ? qty : 0,
            },
          ],
        },
      },
    });

    await prisma.stockLedger.create({
      data: {
        tenantId,
        branchId: from.id,
        productId: prod.id,
        batchId: lot.batchId,
        movementType: StockMovementType.transfer_out,
        qtyDelta: -qty,
        referenceType: "transfer",
        referenceId: transferId,
        createdBy: users.managerId,
        occurredAt: daysAgo(Math.max(0, daysBack - 1)),
      },
    });
    lot.qty -= qty;

    if (status === TransferStatus.received) {
      const destBatchId = randomUUID();
      await prisma.batch.create({
        data: {
          id: destBatchId,
          tenantId,
          branchId: to.id,
          productId: prod.id,
          batchNo: `OPS-TR-${to.code}-${transferSeq}`,
          expiryDate: daysFromNow(200 + t),
          costPrice: lot.costPrice,
          sellingPrice: lot.sellingPrice,
          receivedAt: daysAgo(Math.max(0, daysBack - 2)),
        },
      });
      await prisma.stockLedger.create({
        data: {
          tenantId,
          branchId: to.id,
          productId: prod.id,
          batchId: destBatchId,
          movementType: StockMovementType.transfer_in,
          qtyDelta: qty,
          referenceType: "transfer",
          referenceId: transferId,
          createdBy: users.managerId,
          occurredAt: daysAgo(Math.max(0, daysBack - 2)),
        },
      });
      const destKey = `${to.id}:${prod.id}`;
      const destLot = stockLots.get(destKey);
      // Same reset-not-add rule as the PO replenishment switch above: point at the new batch
      // and track only what IT was actually credited, so later sales can never debit more than
      // this specific batchId's own transfer_in receipt.
      if (destLot) {
        destLot.qty = qty;
        destLot.batchId = destBatchId;
      } else {
        stockLots.set(destKey, {
          batchId: destBatchId,
          productId: prod.id,
          qty,
          sellingPrice: lot.sellingPrice,
          costPrice: lot.costPrice,
          branchId: to.id,
        });
      }
    }
    transfers++;
  }

  // ── Modest customer returns linked to recent ops sales ───────────────────
  console.log("── Demo ops: customer returns ──");
  let customerReturns = 0;
  const recentSales = await prisma.sale.findMany({
    where: {
      tenantId,
      invoiceNo: { startsWith: "INV-" },
      status: SaleStatus.posted,
      soldAt: { gte: daysAgo(45) },
    },
    include: { items: { take: 1 } },
    orderBy: { soldAt: "desc" },
    take: 40,
  });

  for (let i = 0; i < Math.min(28, recentSales.length); i++) {
    const sale = recentSales[i]!;
    const item = sale.items[0];
    if (!item?.batchId) continue;
    const retId = randomUUID();
    const createdAt = new Date(sale.soldAt);
    createdAt.setUTCDate(createdAt.getUTCDate() + 1 + (i % 3));
    const amount = item.unitPrice.mul(Math.min(item.qty, 1));

    await prisma.goodsReturn.create({
      data: {
        id: retId,
        tenantId,
        branchId: sale.branchId,
        returnNumber: `RET-OPS-${String(i + 1).padStart(4, "0")}`,
        type: GoodsReturnType.customer,
        status: i % 4 === 0 ? GoodsReturnStatus.completed : GoodsReturnStatus.pending_approval,
        customerName: "Ops seed customer",
        saleId: sale.id,
        reason: i % 2 === 0 ? "Unused sealed pack" : "Wrong item",
        amount,
        requestedBy: users.cashierId,
        approvedBy: users.managerId,
        processedBy: i % 4 === 0 ? users.managerId : null,
        createdAt,
        items: {
          create: [
            {
              tenantId,
              productId: item.productId,
              batchId: item.batchId,
              qty: Math.min(item.qty, 1),
              unitPrice: item.unitPrice,
            },
          ],
        },
      },
    });

    if (i % 4 === 0) {
      await prisma.stockLedger.create({
        data: {
          tenantId,
          branchId: sale.branchId,
          productId: item.productId,
          batchId: item.batchId,
          movementType: StockMovementType.customer_return_in,
          qtyDelta: Math.min(item.qty, 1),
          referenceType: "goods_return",
          referenceId: retId,
          createdBy: users.managerId,
          occurredAt: createdAt,
        },
      });
    }
    customerReturns++;
  }

  // Document sequences for all branches (bump above ops numbers)
  for (const branch of branches) {
    for (const docType of ["po", "grn", "stocktake"] as const) {
      await prisma.documentSequence.upsert({
        where: {
          tenantId_branchId_docType: {
            tenantId,
            branchId: branch.id,
            docType,
          },
        },
        update: { nextValue: 500 },
        create: {
          tenantId,
          branchId: branch.id,
          docType,
          nextValue: 500,
        },
      });
    }
  }
  await prisma.documentSequence.upsert({
    where: {
      tenantId_branchId_docType: {
        tenantId,
        branchId: main.id,
        docType: "tenant:transfer",
      },
    },
    update: { nextValue: 500 },
    create: {
      tenantId,
      branchId: main.id,
      docType: "tenant:transfer",
      nextValue: 500,
    },
  });

  console.log("── Demo ops complete ──");
  return {
    rangedProducts,
    referenceProducts,
    inactiveProducts,
    barcodesAdded,
    branchBatches,
    sales: salesCreated,
    salePayments: paymentRows.length,
    purchaseOrders: poRows.length,
    goodsReceipts: grRows.length,
    transfers,
    customerReturns,
    nearExpiryBatches,
  };
}
