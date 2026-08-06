import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DEMO_STOCK_REG_NOS,
  EXPANDED_DEMO_STOCK_TARGET,
  SCHEDULE_LABELS,
  UNBRANDED_BRAND_LABEL,
  demoReorderLevelForIndex,
  loadNmraProductsFromExcel as loadNmraFromExcelPath,
  looksLikeSpcAgent,
  selectDemoStockRegistrationNos,
  type NmraProductRow,
  type ParseNmraOptions,
} from "../src/nmra/nmra-normalize";

export {
  DEMO_STOCK_REG_NOS,
  EXPANDED_DEMO_STOCK_TARGET,
  SCHEDULE_LABELS,
  UNBRANDED_BRAND_LABEL,
  isCodedBrandName,
  splitBrandAndProductName,
  normalizeSchedule,
  normalizeDosageFormGroup,
  scheduleFlags,
  selectDemoStockRegistrationNos,
  demoPricingForProduct,
  demoStockLineForIndex,
  type NmraProductRow,
  type ParseNmraOptions,
} from "../src/nmra/nmra-normalize";

function resolveNmraXlsPath(): string {
  const fromEnv = process.env.NMRA_XLS_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const bundled = path.join(__dirname, "data", "nmra-valid-registration.xls");
  if (fs.existsSync(bundled)) return bundled;
  const downloads = path.join(
    process.env.USERPROFILE ?? process.env.HOME ?? "",
    "Downloads",
    "6a61cef97cc8aa123e9de5c4_VALID REGISTRATION-23.07.2026.xls",
  );
  if (fs.existsSync(downloads)) return downloads;
  throw new Error(
    "NMRA Excel not found. Place it at apps/api/prisma/data/nmra-valid-registration.xls or set NMRA_XLS_PATH.",
  );
}

/** Seed/review helper — resolves bundled NMRA Excel when path omitted. */
export function loadNmraProductsFromExcel(
  filePath?: string,
  options?: ParseNmraOptions,
) {
  return loadNmraFromExcelPath(filePath ?? resolveNmraXlsPath(), options);
}

/** Optional CSV: registrationNo,barcode — enriches NMRA rows that lack barcodes. */
function loadBarcodeMap(): Map<string, string> {
  const map = new Map<string, string>();
  const candidates = [
    process.env.NMRA_BARCODE_CSV_PATH?.trim(),
    path.join(__dirname, "data", "nmra-barcodes.csv"),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) continue;
    const header = lines[0]!.split(",").map((h) => h.trim().toLowerCase());
    const regIdx = header.findIndex((h) =>
      /^(registrationno|registration_no|reg\.?no\.?|regno)$/.test(h),
    );
    const bcIdx = header.findIndex((h) => /^(barcode|ean|gtin|upc)$/.test(h));
    if (regIdx < 0 || bcIdx < 0) continue;
    for (const line of lines.slice(1)) {
      const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      const reg = cols[regIdx];
      const barcode = cols[bcIdx]?.replace(/\s+/g, "");
      if (reg && barcode) map.set(reg, barcode);
    }
    console.log(`  Barcode map loaded: ${map.size} rows from ${filePath}`);
    break;
  }
  return map;
}

const BATCH = 400;

async function createManyBatched<T extends object>(
  run: (chunk: T[]) => Promise<unknown>,
  rows: T[],
  label: string,
) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    await run(chunk);
    if ((i + chunk.length) % 2000 === 0 || i + chunk.length >= rows.length) {
      console.log(`  ${label}: ${Math.min(i + chunk.length, rows.length)}/${rows.length}`);
    }
  }
}

export type NmraSeedResult = {
  productBySku: Map<string, string>;
  products: NmraProductRow[];
  /** Registration numbers selected for demo inventory (includes PCL-mapped regs). */
  demoStockRegNos: string[];
  categoryCount: number;
  brandCount: number;
  dosageFormGroupCount: number;
  scheduleCount: number;
};

/**
 * Replace tenant catalog with full NMRA approved-medicines list.
 * Caller must already have cleared operational rows that reference products.
 */
export async function seedNmraCatalog(
  prisma: PrismaClient,
  tenantId: string,
  options?: { xlsPath?: string; demoStockTarget?: number },
): Promise<NmraSeedResult> {
  const barcodeByRegNo = loadBarcodeMap();
  const products = loadNmraProductsFromExcel(options?.xlsPath, {
    inactiveRegs: new Set([DEMO_STOCK_REG_NOS["PCL-0029"]!]),
    barcodeByRegNo,
  });
  console.log(`NMRA rows loaded: ${products.length}`);
  const withBarcode = products.filter((p) => p.barcode).length;
  if (withBarcode > 0) {
    console.log(`  Rows with barcode: ${withBarcode}`);
  }

  // Clear catalog metadata + products (ops data already cleared by seed).
  await prisma.productAlias.deleteMany({ where: { tenantId } });
  await prisma.productTagMap.deleteMany({ where: { tenantId } });
  await prisma.productCategoryMap.deleteMany({ where: { tenantId } });
  await prisma.productSimilarity.deleteMany({ where: { tenantId } });
  await prisma.product.deleteMany({ where: { tenantId } });
  await prisma.productCategory.deleteMany({ where: { tenantId } });
  await prisma.productTag.deleteMany({ where: { tenantId } });

  const productData: Prisma.ProductCreateManyInput[] = products.map((p) => ({
    id: p.id,
    tenantId,
    sku: p.sku,
    barcode: p.barcode,
    name: p.name,
    brandName: p.brandName,
    genericName: p.genericName,
    manufacturer: p.manufacturer,
    dosageForm: p.dosageForm,
    strength: p.strength,
    unit: p.unit,
    packSize: p.packSize,
    packType: p.packType,
    registrationNo: p.registrationNo,
    registrationDate: p.registrationDate,
    schedule: p.schedule,
    regType: p.regType,
    dossierNo: p.dossierNo,
    countryOfOrigin: p.countryOfOrigin,
    localAgent: p.localAgent,
    taxCategory: "Standard rate",
    isControlled: p.isControlled,
    requiresPrescription: p.requiresPrescription,
    reorderLevel: p.reorderLevel,
    isActive: p.isActive,
  }));

  console.log("Inserting products…");
  await createManyBatched(
    (chunk) => prisma.product.createMany({ data: chunk }),
    productData,
    "products",
  );

  // Categories: Dosage form / NMRA Schedule / Registration type
  const dosageParentId = randomUUID();
  const scheduleParentId = randomUUID();
  const regTypeParentId = randomUUID();

  const dosageGroups = [...new Set(products.map((p) => p.dosageFormGroup))].sort();
  const scheduleGroups = [...new Set(products.map((p) => p.scheduleGroup).filter(Boolean) as string[])].sort();
  const regTypes = [...new Set(products.map((p) => p.regType).filter(Boolean) as string[])].sort();

  const dosageCatId = new Map<string, string>();
  const scheduleCatId = new Map<string, string>();
  const regTypeCatId = new Map<string, string>();

  const categories: Prisma.ProductCategoryCreateManyInput[] = [
    { id: dosageParentId, tenantId, name: "Dosage form", parentCategoryId: null },
    { id: scheduleParentId, tenantId, name: "NMRA Schedule", parentCategoryId: null },
    { id: regTypeParentId, tenantId, name: "Registration type", parentCategoryId: null },
  ];

  for (const name of dosageGroups) {
    const id = randomUUID();
    dosageCatId.set(name, id);
    categories.push({ id, tenantId, name, parentCategoryId: dosageParentId });
  }
  for (const name of scheduleGroups) {
    const id = randomUUID();
    scheduleCatId.set(name, id);
    categories.push({
      id,
      tenantId,
      name: SCHEDULE_LABELS[name] ?? `Schedule ${name}`,
      parentCategoryId: scheduleParentId,
    });
  }
  for (const name of regTypes) {
    const id = randomUUID();
    regTypeCatId.set(name, id);
    categories.push({ id, tenantId, name, parentCategoryId: regTypeParentId });
  }

  await prisma.productCategory.createMany({ data: categories });

  const categoryMaps: Prisma.ProductCategoryMapCreateManyInput[] = [];
  for (const p of products) {
    const dId = dosageCatId.get(p.dosageFormGroup);
    if (dId) categoryMaps.push({ id: randomUUID(), tenantId, productId: p.id, categoryId: dId });
    if (p.scheduleGroup) {
      const sId = scheduleCatId.get(p.scheduleGroup);
      if (sId) categoryMaps.push({ id: randomUUID(), tenantId, productId: p.id, categoryId: sId });
    }
    if (p.regType) {
      const rId = regTypeCatId.get(p.regType);
      if (rId) categoryMaps.push({ id: randomUUID(), tenantId, productId: p.id, categoryId: rId });
    }
  }

  console.log("Inserting category maps…");
  await createManyBatched(
    (chunk) => prisma.productCategoryMap.createMany({ data: chunk }),
    categoryMaps,
    "category maps",
  );

  const demoStockTarget = options?.demoStockTarget ?? EXPANDED_DEMO_STOCK_TARGET;
  const demoStockRegNos = selectDemoStockRegistrationNos(products, demoStockTarget);
  const demoStockSet = new Set(demoStockRegNos);
  console.log(
    `Demo stock selection: ${demoStockRegNos.length} SKUs (target ${demoStockTarget}; PCL ops keys: ${Object.keys(DEMO_STOCK_REG_NOS).length})`,
  );

  // Tags for catalog facets / filtering — aligned with NMRA selling rules
  const tagDefs: Array<{
    name: string;
    all?: true;
    pred?: (p: NmraProductRow) => boolean;
  }> = [
    { name: "NMRA registered", all: true },
    { name: "Unbranded", pred: (p) => p.isUnbranded || p.brandName === UNBRANDED_BRAND_LABEL },
    {
      name: "SPC / state supply",
      pred: (p) => looksLikeSpcAgent(p.localAgent, p.manufacturer),
    },
    { name: "Grocery / Schedule I", pred: (p) => p.schedule === "I" },
    { name: "Pharmacy OTC / Schedule II A", pred: (p) => p.schedule === "II A" },
    { name: "Prescription / Schedule II B", pred: (p) => p.schedule === "II B" },
    { name: "Controlled Rx / Schedule II C", pred: (p) => p.schedule === "II C" },
    { name: "Narcotic / Schedule III (Osusala)", pred: (p) => p.schedule === "III" },
    { name: "Prescription required", pred: (p) => p.requiresPrescription },
    { name: "Controlled medicine", pred: (p) => p.isControlled },
    {
      name: "Demo stocked",
      pred: (p) => demoStockSet.has(p.registrationNo),
    },
  ];

  const tagIdByName = new Map<string, string>();
  for (const t of tagDefs) {
    const id = randomUUID();
    tagIdByName.set(t.name, id);
    await prisma.productTag.create({ data: { id, tenantId, name: t.name } });
  }

  const tagMaps: Prisma.ProductTagMapCreateManyInput[] = [];
  for (const p of products) {
    for (const t of tagDefs) {
      const match = t.all ? true : t.pred ? t.pred(p) : false;
      if (!match) continue;
      tagMaps.push({
        id: randomUUID(),
        tenantId,
        productId: p.id,
        tagId: tagIdByName.get(t.name)!,
      });
    }
  }

  console.log("Inserting tag maps…");
  await createManyBatched(
    (chunk) => prisma.productTagMap.createMany({ data: chunk }),
    tagMaps,
    "tag maps",
  );

  // Useful search aliases: registration no + brand + barcode
  const aliases: Prisma.ProductAliasCreateManyInput[] = [];
  for (const p of products) {
    aliases.push({
      id: randomUUID(),
      tenantId,
      productId: p.id,
      aliasText: p.registrationNo,
      aliasType: "registration_no",
    });
    if (p.dossierNo && p.dossierNo !== p.registrationNo) {
      aliases.push({
        id: randomUUID(),
        tenantId,
        productId: p.id,
        aliasText: p.dossierNo,
        aliasType: "dossier_no",
      });
    }
    if (p.brandName && p.brandName.toLowerCase() !== p.name.toLowerCase()) {
      aliases.push({
        id: randomUUID(),
        tenantId,
        productId: p.id,
        aliasText: p.brandName,
        aliasType: "brand",
      });
    }
    if (p.barcode) {
      aliases.push({
        id: randomUUID(),
        tenantId,
        productId: p.id,
        aliasText: p.barcode,
        aliasType: "barcode",
      });
    }
  }

  console.log("Inserting aliases…");
  await createManyBatched(
    (chunk) => prisma.productAlias.createMany({ data: chunk, skipDuplicates: true }),
    aliases,
    "aliases",
  );

  const productBySku = new Map<string, string>();
  for (const p of products) {
    productBySku.set(p.sku, p.id);
    // First occurrence of a registration number is also addressable by bare REG.NO.
    if (!productBySku.has(p.registrationNo)) {
      productBySku.set(p.registrationNo, p.id);
    }
  }

  // Keep legacy demo keys working for operational seed scenarios.
  for (const [demoKey, regNo] of Object.entries(DEMO_STOCK_REG_NOS)) {
    const id = productBySku.get(regNo);
    if (!id) {
      throw new Error(`Demo stock product missing for ${demoKey} → ${regNo}`);
    }
    productBySku.set(demoKey, id);
  }

  // Raise reorder levels for PCL ops keys + expanded demo stock.
  const demoReorder: Record<string, number> = {
    "PCL-0001": 50,
    "PCL-0002": 30,
    "PCL-0003": 40,
    "PCL-0004": 25,
    "PCL-0005": 20,
    "PCL-0006": 15,
    "PCL-0007": 20,
    "PCL-0008": 25,
    "PCL-0009": 35,
    "PCL-0010": 15,
    "PCL-0011": 10,
    "PCL-0012": 20,
    "PCL-0013": 15,
    "PCL-0014": 10,
    "PCL-0015": 20,
    "PCL-0016": 15,
    "PCL-0017": 10,
    "PCL-0018": 15,
    "PCL-0019": 20,
    "PCL-0020": 15,
    "PCL-0021": 5,
    "PCL-0022": 5,
    "PCL-0023": 5,
    "PCL-0024": 10,
    "PCL-0025": 8,
    "PCL-0026": 5,
    "PCL-0027": 15,
    "PCL-0028": 10,
    "PCL-0030": 10,
  };
  for (const [demoKey, level] of Object.entries(demoReorder)) {
    const id = productBySku.get(demoKey);
    if (!id) continue;
    await prisma.product.update({ where: { id }, data: { reorderLevel: level } });
  }

  const pclRegs = new Set(Object.values(DEMO_STOCK_REG_NOS));
  let demoIdx = 0;
  for (const regNo of demoStockRegNos) {
    if (pclRegs.has(regNo)) continue;
    const id = productBySku.get(regNo);
    if (!id) continue;
    await prisma.product.update({
      where: { id },
      data: { reorderLevel: demoReorderLevelForIndex(demoIdx) },
    });
    demoIdx += 1;
  }

  const brandCount = new Set(products.map((p) => p.brandName).filter(Boolean)).size;

  return {
    productBySku,
    products,
    demoStockRegNos,
    categoryCount: categories.length,
    brandCount,
    dosageFormGroupCount: dosageGroups.length,
    scheduleCount: scheduleGroups.length,
  };
}
