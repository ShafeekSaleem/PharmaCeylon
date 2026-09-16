/**
 * Idempotent demo-data seed for the catalog taxonomy redesign: retail/manual products across
 * every non-Medicines commercial department, so Settings → Catalog → Categories, the Products
 * page, POS, and reports all have real variety to test/screenshot instead of an empty tree.
 *
 * Safe to rerun — products are matched by SKU (skipped if already present), and enabling a
 * department / setting a primary category is itself idempotent.
 *
 * Usage:
 *   npx tsx prisma/seed-retail-demo-products.ts             # all tenants
 *   npx tsx prisma/seed-retail-demo-products.ts --tenant=demo
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { CategoryTaxonomyOps } from "../src/catalog/category-taxonomy.util";
import { seedReceiveStock, daysFromNow, syncSeedStock } from "./seed-helpers";

type DemoProduct = {
  sku: string;
  barcode: string;
  name: string;
  brandName: string;
  unit: string;
  packSize: string;
  reorderLevel: number;
  canonicalKey: string;
  costPrice: number;
  sellingPrice: number;
};

let seq = 1;
function p(
  name: string,
  brandName: string,
  canonicalKey: string,
  costPrice: number,
  sellingPrice: number,
  opts?: { unit?: string; packSize?: string; reorderLevel?: number },
): DemoProduct {
  const n = seq++;
  return {
    sku: `RTL-${String(n).padStart(4, "0")}`,
    barcode: `890${String(1000000 + n)}`,
    name,
    brandName,
    unit: opts?.unit ?? "unit",
    packSize: opts?.packSize ?? "1",
    reorderLevel: opts?.reorderLevel ?? 15,
    canonicalKey,
    costPrice,
    sellingPrice,
  };
}

export const DEMO_PRODUCTS: DemoProduct[] = [
  // Vitamins & Supplements
  p("Vitamin C 1000mg Effervescent (20s)", "Redoxon", "VITAMINS_SUPPLEMENTS_VITAMINS", 650, 950, { packSize: "20 tablets" }),
  p("Vitamin D3 1000IU Softgel (60s)", "Nature's Bounty", "VITAMINS_SUPPLEMENTS_VITAMINS", 900, 1350, { packSize: "60 softgels" }),
  p("Adult Multivitamin Tablets (30s)", "Centrum", "VITAMINS_SUPPLEMENTS_MULTIVITAMINS", 1400, 2100, { packSize: "30 tablets" }),
  p("Energy Multivitamin Effervescent (15s)", "Berocca", "VITAMINS_SUPPLEMENTS_MULTIVITAMINS", 1200, 1800, { packSize: "15 tablets" }),
  p("Calcium + Magnesium + Zinc Tablets (30s)", "Osteocare", "VITAMINS_SUPPLEMENTS_MINERALS", 800, 1200, { packSize: "30 tablets" }),
  p("Ginseng Extract Capsules (30s)", "NutraLeaf", "VITAMINS_SUPPLEMENTS_HERBAL", 950, 1450, { packSize: "30 capsules" }),
  p("Whey Protein Isolate Vanilla 1kg", "MuscleFuel", "VITAMINS_SUPPLEMENTS_SPORTS", 6500, 8900, { packSize: "1kg", unit: "tub" }),
  p("Fish Oil Omega-3 1000mg (60s)", "Seven Seas", "VITAMINS_SUPPLEMENTS_OTHER", 1100, 1650, { packSize: "60 softgels" }),

  // Baby & Mother Care
  p("Baby Dry Diapers Size 3 (44s)", "Pampers", "BABY_CARE_DIAPERS", 2200, 3200, { packSize: "44 diapers", unit: "pack" }),
  p("Premium Care Diapers Size 4 (36s)", "Pampers", "BABY_CARE_DIAPERS", 2400, 3500, { packSize: "36 diapers", unit: "pack" }),
  p("NAN Pro 1 Infant Formula 400g", "Nestle", "BABY_CARE_BABY_FORMULA", 1800, 2600, { packSize: "400g", unit: "tin" }),
  p("Wheat Baby Cereal 400g", "Cerelac", "BABY_CARE_BABY_FOOD", 750, 1100, { packSize: "400g", unit: "box" }),
  p("Baby Lotion 200ml", "Johnson's Baby", "BABY_CARE_BABY_SKIN_CARE", 450, 680, { packSize: "200ml", unit: "bottle" }),
  p("Baby Shampoo 200ml", "Johnson's Baby", "BABY_CARE_BABY_TOILETRIES", 420, 620, { packSize: "200ml", unit: "bottle" }),
  p("Baby Feeding Bottle 250ml", "Pigeon", "BABY_CARE_FEEDING", 550, 850, { unit: "each" }),
  p("Nursing Breast Pads (24s)", "Avent", "BABY_CARE_MOTHER_CARE", 600, 900, { packSize: "24 pads", unit: "pack" }),

  // Personal Care
  p("Total Toothpaste 150g", "Colgate", "PERSONAL_CARE_ORAL_CARE", 320, 480, { packSize: "150g", unit: "tube" }),
  p("Soft Toothbrush", "Oral-B", "PERSONAL_CARE_ORAL_CARE", 150, 250, { unit: "each" }),
  p("Shampoo 340ml", "Sunsilk", "PERSONAL_CARE_HAIR_CARE", 480, 720, { packSize: "340ml", unit: "bottle" }),
  p("Anti-Dandruff Shampoo 340ml", "Clear", "PERSONAL_CARE_HAIR_CARE", 520, 780, { packSize: "340ml", unit: "bottle" }),
  p("Antiseptic Soap 105g", "Dettol", "PERSONAL_CARE_BATH_BODY", 130, 200, { packSize: "105g", unit: "bar" }),
  p("Body Wash 250ml", "Dove", "PERSONAL_CARE_BATH_BODY", 560, 850, { packSize: "250ml", unit: "bottle" }),
  p("Ultra Sanitary Pads (16s)", "Whisper", "PERSONAL_CARE_FEMININE_CARE", 380, 580, { packSize: "16 pads", unit: "pack" }),
  p("Mach3 Razor", "Gillette", "PERSONAL_CARE_MENS_GROOMING", 850, 1250, { unit: "each" }),
  p("Men Deodorant Spray 150ml", "Rexona", "PERSONAL_CARE_DEODORANTS", 420, 650, { packSize: "150ml", unit: "can" }),
  p("Hand Sanitizer Gel 100ml", "Dettol", "PERSONAL_CARE_HYGIENE", 250, 380, { packSize: "100ml", unit: "bottle" }),

  // Beauty & Skin Care
  p("Cold Cream 100ml", "Pond's", "BEAUTY_SKIN_CARE_FACE_CARE", 380, 580, { packSize: "100ml", unit: "jar" }),
  p("Body Lotion 400ml", "Vaseline", "BEAUTY_SKIN_CARE_BODY_CARE", 480, 720, { packSize: "400ml", unit: "bottle" }),
  p("Sun Protect SPF50 Lotion 200ml", "Nivea", "BEAUTY_SKIN_CARE_SUN_CARE", 1200, 1750, { packSize: "200ml", unit: "bottle" }),
  p("Matte Lipstick", "Maybelline", "BEAUTY_SKIN_CARE_COSMETICS", 900, 1400, { unit: "each" }),
  p("Acne Face Wash 100ml", "Clean & Clear", "BEAUTY_SKIN_CARE_ACNE_CARE", 420, 650, { packSize: "100ml", unit: "bottle" }),

  // Medical Devices
  p("Digital Blood Pressure Monitor", "Omron", "MEDICAL_DEVICES_BP_MONITORS", 5500, 7900, { unit: "each", reorderLevel: 5 }),
  p("Glucose Test Strips (50s)", "Accu-Chek", "MEDICAL_DEVICES_GLUCOSE_MONITORING", 3200, 4500, { packSize: "50 strips", unit: "box", reorderLevel: 10 }),
  p("Digital Thermometer", "Omron", "MEDICAL_DEVICES_THERMOMETERS", 650, 950, { unit: "each" }),
  p("Compressor Nebulizer", "Omron", "MEDICAL_DEVICES_NEBULIZERS", 6800, 9500, { unit: "each", reorderLevel: 5 }),

  // First Aid
  p("Sterile Gauze Dressing Pad", "MediPlus", "FIRST_AID_DRESSINGS", 60, 100, { unit: "each" }),
  p("Elastic Crepe Bandage 4 inch", "MediPlus", "FIRST_AID_BANDAGES", 150, 250, { unit: "each" }),
  p("Antiseptic Solution 100ml", "Betadine", "FIRST_AID_ANTISEPTICS", 380, 580, { packSize: "100ml", unit: "bottle" }),
  p("Family First Aid Kit Box", "MediPlus", "FIRST_AID_KITS", 1800, 2600, { unit: "each", reorderLevel: 5 }),

  // Nutrition & Wellness
  p("Nutrition Powder 400g", "Ensure", "NUTRITION_WELLNESS_PROTEIN_NUTRITION", 1900, 2700, { packSize: "400g", unit: "tin" }),
  p("Meal Replacement Shake 500g", "SlimFuel", "NUTRITION_WELLNESS_WEIGHT_MANAGEMENT", 2100, 3000, { packSize: "500g", unit: "tub" }),
  p("Electrolyte Rehydration Sachets (10s)", "ORSL", "NUTRITION_WELLNESS_HYDRATION", 450, 700, { packSize: "10 sachets", unit: "box" }),

  // Food & Beverages
  p("Bottled Drinking Water 1.5L", "Sparkle", "FOOD_BEVERAGE_WATER", 60, 110, { packSize: "1.5L", unit: "bottle" }),
  p("Energy Drink 250ml", "Red Bull", "FOOD_BEVERAGE_ENERGY_DRINK", 280, 420, { packSize: "250ml", unit: "can" }),
  p("Soft Drink 400ml", "Coca-Cola", "FOOD_BEVERAGE_SOFT_DRINKS", 90, 150, { packSize: "400ml", unit: "bottle" }),
  p("Mixed Fruit Juice 1L", "Real", "FOOD_BEVERAGE_JUICES", 320, 480, { packSize: "1L", unit: "carton" }),
  p("Potato Chips 52g", "Lays", "FOOD_BEVERAGE_SNACKS", 100, 160, { packSize: "52g", unit: "pack" }),
  p("Chocolate Bar", "KitKat", "FOOD_BEVERAGE_CONFECTIONERY", 90, 150, { unit: "each" }),

  // Household & Convenience
  p("Facial Tissues Box (100s)", "Kleenex", "HOUSEHOLD_CONVENIENCE_TISSUES", 250, 380, { packSize: "100 tissues", unit: "box" }),
  p("Surface Sanitizer Spray 500ml", "Dettol", "HOUSEHOLD_CONVENIENCE_SANITIZERS", 520, 780, { packSize: "500ml", unit: "bottle" }),
  p("Floor Cleaner 1L", "Dettol", "HOUSEHOLD_CONVENIENCE_CLEANING", 380, 580, { packSize: "1L", unit: "bottle" }),
];

const DEPARTMENTS_TO_ENABLE = [
  "VITAMINS_SUPPLEMENTS",
  "BABY_CARE",
  "PERSONAL_CARE",
  "BEAUTY_SKIN_CARE",
  "MEDICAL_DEVICES",
  "FIRST_AID",
  "NUTRITION_WELLNESS",
  "FOOD_BEVERAGE",
  "HOUSEHOLD_CONVENIENCE",
];

/**
 * Relative real-life transaction frequency per department over the ~8-month sales window
 * `seed-retail-demo-sales.ts` generates — daily-consumable departments (food/beverage,
 * personal care, household) sell far more often than big-ticket, rarely-repurchased ones
 * (medical devices). Medicines still dominates total transaction volume by a wide margin (see
 * `seed-demo-ops.ts`); this table only controls the realistic *mix* among the non-Medicines
 * departments, not their share of total store revenue.
 */
export const DEPARTMENT_SALES_PROFILE: Record<string, { salesPerWindow: number }> = {
  VITAMINS_SUPPLEMENTS: { salesPerWindow: 14 },
  BABY_CARE: { salesPerWindow: 18 },
  PERSONAL_CARE: { salesPerWindow: 24 },
  BEAUTY_SKIN_CARE: { salesPerWindow: 11 },
  MEDICAL_DEVICES: { salesPerWindow: 4 },
  FIRST_AID: { salesPerWindow: 8 },
  NUTRITION_WELLNESS: { salesPerWindow: 10 },
  FOOD_BEVERAGE: { salesPerWindow: 26 },
  HOUSEHOLD_CONVENIENCE: { salesPerWindow: 20 },
};

/** Every DEMO_PRODUCTS canonicalKey is `${department}_${subcategory}`, so a prefix match against
 *  the profile table above always resolves to exactly one department. */
export function departmentKeyOf(canonicalKey: string): string {
  return Object.keys(DEPARTMENT_SALES_PROFILE).find((dept) => canonicalKey.startsWith(dept)) ?? "OTHER";
}

const AVG_QTY_PER_SALE = 2.5;
/** Normal stock gets ~1.8x the expected total demand over the window so it never runs out —
 *  RTL products aren't replenished mid-window the way the Medicines side is. */
const NORMAL_COVERAGE_MULTIPLIER = 1.8;
/** The one deliberately under-stocked "low stock" example per department gets just over half
 *  of expected demand, so it genuinely depletes toward zero partway through the window. */
const LOW_STOCK_COVERAGE_MULTIPLIER = 0.55;

function initialStockQty(canonicalKey: string, isLowStockExample: boolean, jitter: number): number {
  const freq = DEPARTMENT_SALES_PROFILE[departmentKeyOf(canonicalKey)]?.salesPerWindow ?? 10;
  const coverage = isLowStockExample ? LOW_STOCK_COVERAGE_MULTIPLIER : NORMAL_COVERAGE_MULTIPLIER;
  return Math.max(5, Math.round(freq * AVG_QTY_PER_SALE * coverage * jitter));
}

/** One SKU per department — the first one listed — deliberately under-stocked at MAIN only, so
 *  Inventory Summary / Stock Health / Reorder Alerts have a real "low stock" example in every
 *  commercial department, not just Medicines, while the same product stays healthy at the other
 *  branches (a genuine transfer-opportunity signal, not just a broken-looking zero). */
export const LOW_STOCK_EXAMPLE_SKUS: ReadonlySet<string> = (() => {
  const seenDept = new Set<string>();
  const skus = new Set<string>();
  for (const dp of DEMO_PRODUCTS) {
    const dept = departmentKeyOf(dp.canonicalKey);
    if (seenDept.has(dept)) continue;
    seenDept.add(dept);
    skus.add(dp.sku);
  }
  return skus;
})();

export async function seedRetailDemoProducts(prisma: PrismaClient, tenantId: string, tenantCode: string) {
  const taxonomy = new CategoryTaxonomyOps(prisma);
  await taxonomy.ensureCommercialTemplate(tenantId);
  for (const key of DEPARTMENTS_TO_ENABLE) {
    await taxonomy.setDepartmentEnabled(tenantId, key, true);
  }

  const branches = await prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, code: true } });
  const anyUser = await prisma.appUser.findFirst({ where: { tenantId }, select: { id: true } });
  if (branches.length === 0 || !anyUser) {
    console.log(`[${tenantCode}] no active branches/users — skipping stock receipt (products/categories still seeded)`);
  }
  const canonicalIds = await taxonomy.commercialCanonicalIds(tenantId);

  let created = 0;
  let stocked = 0;
  for (const dp of DEMO_PRODUCTS) {
    const existing = await prisma.product.findFirst({ where: { tenantId, sku: dp.sku }, select: { id: true } });
    let productId = existing?.id;
    if (!productId) {
      const product = await prisma.product.create({
        data: {
          id: randomUUID(),
          tenantId,
          sku: dp.sku,
          barcode: dp.barcode,
          name: dp.name,
          brandName: dp.brandName,
          unit: dp.unit,
          packSize: dp.packSize,
          taxCategory: "Standard rate",
          source: "MANUAL",
          reorderLevel: dp.reorderLevel,
          isActive: true,
        },
      });
      productId = product.id;
      created += 1;
    }

    const categoryId = canonicalIds.get(dp.canonicalKey);
    if (!categoryId) throw new Error(`Unknown canonicalKey ${dp.canonicalKey} — template not seeded?`);
    await taxonomy.setPrimaryCommercialCategory(tenantId, productId, categoryId, {
      assignmentSource: "MANUAL",
    });

    if (branches.length > 0 && anyUser) {
      for (const branch of branches) {
        const hasStock = await prisma.batch.findFirst({
          where: { tenantId, branchId: branch.id, productId, batchNo: "RTL-INIT" },
          select: { id: true },
        });
        if (hasStock) continue;
        const isLowStockExample = branch.code === "MAIN" && LOW_STOCK_EXAMPLE_SKUS.has(dp.sku);
        const jitter = 0.85 + Math.random() * 0.3;
        await seedReceiveStock(prisma, {
          tenantId,
          branchId: branch.id,
          productId,
          userId: anyUser.id,
          batchNo: "RTL-INIT",
          expiryDate: daysFromNow(540),
          qty: initialStockQty(dp.canonicalKey, isLowStockExample, jitter),
          costPrice: dp.costPrice,
          sellingPrice: dp.sellingPrice,
          referenceId: randomUUID(),
        });
        stocked += 1;
      }
    }
  }

  await syncSeedStock(prisma, tenantId);

  console.log(
    `[${tenantCode}] retail demo catalog: ${created} products created (${DEMO_PRODUCTS.length - created} already existed), ` +
      `${stocked} branch stock receipts posted, ${DEPARTMENTS_TO_ENABLE.length} departments enabled`,
  );
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
      await seedRetailDemoProducts(prisma, tenant.id, tenant.code);
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only auto-run when executed directly (`npx tsx prisma/seed-retail-demo-products.ts`) — this
// module is also imported by seed.ts, which must NOT trigger a second, unscoped, all-tenants run
// as a side effect of importing `seedRetailDemoProducts`.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
