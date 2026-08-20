/**
 * Generates sales history for the retail demo catalog (`seed-retail-demo-products.ts`) so
 * Reports → Profitability (and Category Sales / Margin by Category) show real revenue across
 * every commercial department, not just Medicines. Must run AFTER
 * `seed-retail-demo-products.ts` — it needs that script's products and "RTL-INIT" batches to
 * already exist.
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
import { daysAgo, seedSale } from "./seed-helpers";

/** Modest per product/branch so the retail catalog reads as "real but secondary" next to the
 *  curated Medicines scenario, spread across the same ~90-day window the ops sales use. */
const SALES_PER_PRODUCT_PER_BRANCH = 6;
const WINDOW_DAYS = 88;

async function seedTenant(prisma: PrismaClient, tenantId: string, tenantCode: string) {
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

      for (let i = 0; i < SALES_PER_PRODUCT_PER_BRANCH; i++) {
        const invoiceNo = `RTL-SALE-${product.sku}-${i}`;
        const existing = await prisma.sale.findFirst({
          where: { tenantId, branchId: branch.id, invoiceNo },
          select: { id: true },
        });
        if (existing) {
          skipped += 1;
          continue;
        }
        const qty = 1 + Math.floor(Math.random() * 4);
        const daysBack = Math.floor((i / SALES_PER_PRODUCT_PER_BRANCH) * WINDOW_DAYS) + Math.floor(Math.random() * 8);
        await seedSale(prisma, {
          tenantId,
          branchId: branch.id,
          soldBy: cashier.id,
          invoiceNo,
          soldAt: daysAgo(daysBack),
          lines: [{ productId: product.id, batchId: batch.id, qty, unitPrice: batch.sellingPrice }],
        });
        created += 1;
      }
    }
  }

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
      await seedTenant(prisma, tenant.id, tenant.code);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
