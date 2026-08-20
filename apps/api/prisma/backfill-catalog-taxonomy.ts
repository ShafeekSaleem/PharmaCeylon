/**
 * Idempotent backfill for the catalog taxonomy redesign (CategoryDimension /
 * CategorySource / CategoryAssignmentSource / Product.source). Safe to rerun.
 *
 * The migration SQL (20260815090000_catalog_taxonomy_dimensions) already backfills
 * `dimension`/`source` on every existing ProductCategory/ProductCategoryMap row by
 * walking each category to its root ancestor. This script does the two things that
 * are easier and safer to express in TypeScript than in raw SQL:
 *
 *   1. Seed the standard COMMERCIAL merchandising template for every tenant that
 *      doesn't have it yet (matched by canonicalKey — reruns are no-ops).
 *   2. Assign every product that still has no primary COMMERCIAL category to
 *      Medicines → Unclassified Medicines (matched by existing primary map — reruns
 *      only touch products that still lack one).
 *   3. Run the deterministic generic-name/dosage-form classifier (tier 1 of the
 *      commercial-classification design) over whatever is still sitting in
 *      Unclassified Medicines, moving confident matches into a real department.
 *      Never touches a MANUAL or previously AUTO_CLASSIFIED assignment.
 *
 * Usage:
 *   npx tsx prisma/backfill-catalog-taxonomy.ts             # all tenants
 *   npx tsx prisma/backfill-catalog-taxonomy.ts --tenant=demo # one tenant by code
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { CategoryTaxonomyOps } from "../src/catalog/category-taxonomy.util";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../src/catalog/commercial-category-template";

const BATCH = 500;

async function backfillTenant(prisma: PrismaClient, tenantId: string, tenantCode: string) {
  const taxonomy = new CategoryTaxonomyOps(prisma);
  await taxonomy.ensureCommercialTemplate(tenantId);

  const productIds = (
    await prisma.product.findMany({ where: { tenantId }, select: { id: true } })
  ).map((p) => p.id);

  let assigned = 0;
  for (let i = 0; i < productIds.length; i += BATCH) {
    const chunk = productIds.slice(i, i + BATCH);
    assigned += await taxonomy.assignMissingPrimaryCommercial(
      tenantId,
      chunk,
      UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
      "SYSTEM_DEFAULT",
    );
  }

  const { reclassified, stillUnclassified } = await taxonomy.applyDeterministicMedicineClassification(tenantId);

  console.log(
    `[${tenantCode}] commercial template ensured; ${assigned}/${productIds.length} products assigned to Unclassified Medicines; ` +
      `${reclassified} reclassified by deterministic rules (${stillUnclassified} left for human review)`,
  );
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL is not set.");
  }
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
      await backfillTenant(prisma, tenant.id, tenant.code);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
