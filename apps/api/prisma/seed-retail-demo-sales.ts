/**
 * Generates sales history for the retail demo catalog (`seed-retail-demo-products.ts`) so
 * Reports → Profitability (and Category Sales / Margin by Category) show real revenue across
 * every commercial department, not just Medicines. Must run AFTER
 * `seed-retail-demo-products.ts` — it needs that script's products and "RTL-INIT" batches to
 * already exist.
 *
 * Frequency per product/branch is department-weighted (`DEPARTMENT_SALES_PROFILE` — daily
 * consumables like food/beverage or personal care sell far more often than a blood pressure
 * monitor), spread across the same ~8-month window `seed-demo-ops.ts` uses so Medicines still
 * dominates total transaction volume while every other department reads as a believable,
 * proportionate minority rather than a flat, undifferentiated trickle.
 *
 * Unlike the Medicines side, RTL stock is never replenished mid-window, so each sale is clamped
 * to the batch's actual remaining quantity (reconstructed from the ledger) to avoid selling into
 * negative stock — the one deliberately under-stocked SKU per department
 * (`LOW_STOCK_EXAMPLE_SKUS`, MAIN branch only) is *meant* to run out partway through, which is
 * exactly what the clamp produces.
 *
 * Idempotent — a (branch, product, sale index) combination is skipped if its invoice number
 * already exists, so reruns only fill in gaps rather than duplicating sales.
 *
 * Usage:
 *   npx tsx prisma/seed-retail-demo-sales.ts             # all tenants
 *   npx tsx prisma/seed-retail-demo-sales.ts --tenant=demo
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { daysAgo, seedSale, syncSeedStock } from "./seed-helpers";
import { DEMO_PRODUCTS, DEPARTMENT_SALES_PROFILE, departmentKeyOf } from "./seed-retail-demo-products";

/** Matches seed-demo-ops.ts' HISTORY_DAYS so both halves of the demo cover the same overall
 *  timeframe (needed for Stock Health's 6-month ageing trend to have real data throughout). */
const WINDOW_DAYS = 240;
const DEFAULT_SALES_PER_WINDOW = 10;

const canonicalKeyBySku = new Map(DEMO_PRODUCTS.map((p) => [p.sku, p.canonicalKey]));

function salesFrequencyFor(sku: string): number {
  const canonicalKey = canonicalKeyBySku.get(sku);
  if (!canonicalKey) return DEFAULT_SALES_PER_WINDOW;
  return DEPARTMENT_SALES_PROFILE[departmentKeyOf(canonicalKey)]?.salesPerWindow ?? DEFAULT_SALES_PER_WINDOW;
}

export async function seedRetailDemoSales(prisma: PrismaClient, tenantId: string, tenantCode: string) {
  const branches = await prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, code: true } });
  const cashier = await prisma.appUser.findFirst({ where: { tenantId }, select: { id: true } });
  if (branches.length === 0 || !cashier) {
    console.log(`[${tenantCode}] no active branches/users — skipping retail sales`);
    return;
  }

  const products = await prisma.product.findMany({
    where: { tenantId, sku: { startsWith: "RTL-" } },
    select: { id: true, sku: true },
  });
  if (products.length === 0) {
    console.log(`[${tenantCode}] no RTL- products found — run seed-retail-demo-products.ts first`);
    return;
  }

  let created = 0;
  let skipped = 0;
  for (const branch of branches) {
    for (const product of products) {
      const batch = await prisma.batch.findFirst({
        where: { tenantId, branchId: branch.id, productId: product.id, batchNo: "RTL-INIT" },
        select: { id: true, sellingPrice: true },
      });
      if (!batch) continue;

      const ledgerAgg = await prisma.stockLedger.aggregate({
        where: { tenantId, branchId: branch.id, productId: product.id, batchId: batch.id },
        _sum: { qtyDelta: true },
      });
      let remaining = ledgerAgg._sum.qtyDelta ?? 0;
      const freq = salesFrequencyFor(product.sku);

      for (let i = 0; i < freq; i++) {
        if (remaining <= 0) break;
        const invoiceNo = `RTL-SALE-${product.sku}-${i}`;
        const existing = await prisma.sale.findFirst({
          where: { tenantId, branchId: branch.id, invoiceNo },
          select: { id: true },
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        const qty = Math.min(1 + Math.floor(Math.random() * 4), remaining);
        const daysBack = Math.floor((i / freq) * WINDOW_DAYS) + Math.floor(Math.random() * 8);
        await seedSale(prisma, {
          tenantId,
          branchId: branch.id,
          soldBy: cashier.id,
          invoiceNo,
          soldAt: daysAgo(daysBack),
          lines: [{ productId: product.id, batchId: batch.id, qty, unitPrice: batch.sellingPrice }],
        });
        remaining -= qty;
        created += 1;
      }
    }
  }

  await syncSeedStock(prisma, tenantId);
  console.log(`[${tenantCode}] retail demo sales: ${created} sales created, ${skipped} already existed`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) throw new Error("DATABASE_URL is not set.");
  const tenantArg = process.argv.find((a) => a.startsWith("--tenant="));
  const tenantCode = tenantArg?.split("=")[1]?.trim();

  const adapter = new PrismaPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const tenants = await prisma.tenant.findMany({
      where: tenantCode ? { code: tenantCode } : {},
      select: { id: true, code: true },
      orderBy: { code: "asc" },
    });
    if (tenants.length === 0) {
      throw new Error(tenantCode ? `Tenant "${tenantCode}" not found.` : "No tenants found.");
    }
    for (const tenant of tenants) {
      await seedRetailDemoSales(prisma, tenant.id, tenant.code);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only auto-run when executed directly — see the matching guard in seed-retail-demo-products.ts.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
