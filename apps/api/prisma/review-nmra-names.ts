/**
 * Offline review of NMRA naming after loadNmraProductsFromExcel.
 * Run: npx tsx prisma/review-nmra-names.ts
 */
import {
  isCodedBrandName,
  loadNmraProductsFromExcel,
  type NmraProductRow,
} from "./seed-nmra";

function main() {
  const products = loadNmraProductsFromExcel();
  console.log(`Loaded ${products.length} products\n`);

  const coded = products.filter((p) => p.brandName && isCodedBrandName(p.brandName));
  const unbranded = products.filter((p) => p.brandName === "UNBRANDED");
  const nameEqBrand = products.filter(
    (p) => p.brandName && p.name === p.brandName && !isCodedBrandName(p.brandName),
  );
  const nameIsGeneric = products.filter(
    (p) => p.genericName && p.name === p.genericName,
  );
  const regAsName = products.filter((p) => p.name === p.registrationNo);
  const lowerCaseLeak = products.filter(
    (p) =>
      /[a-z]/.test(p.name) ||
      (p.brandName != null && /[a-z]/.test(p.brandName)) ||
      (p.genericName != null && /[a-z]/.test(p.genericName)) ||
      (p.dosageForm != null && /[a-z]/.test(p.dosageForm)) ||
      (p.packType != null && /[a-z]/.test(p.packType)) ||
      (p.unit != null && /[a-z]/.test(p.unit)),
  );

  // Duplicate SKUs
  const skuCounts = new Map<string, number>();
  for (const p of products) skuCounts.set(p.sku, (skuCounts.get(p.sku) ?? 0) + 1);
  const dupSkus = [...skuCounts.entries()].filter(([, n]) => n > 1);

  // Same display name + brand + strength across different regs (informational)
  const nameBrandKey = (p: NmraProductRow) =>
    `${p.name}|${p.brandName ?? ""}|${p.strength ?? ""}`;
  const nameGroups = new Map<string, NmraProductRow[]>();
  for (const p of products) {
    const k = nameBrandKey(p);
    const list = nameGroups.get(k) ?? [];
    list.push(p);
    nameGroups.set(k, list);
  }
  const dupNames = [...nameGroups.entries()].filter(([, rows]) => rows.length > 1);

  // Brand facet: coded brands that incorrectly became product titles
  const codedNameEqualsBrand = coded.filter((p) => p.name === p.brandName);

  console.log("=== Summary ===");
  console.log(`Coded brands (10 D, 1000D…): ${coded.length}`);
  console.log(`UNBRANDED brands: ${unbranded.length}`);
  console.log(`Name === generic: ${nameIsGeneric.length}`);
  console.log(`Name === brand (real brands, same strength-less title): ${nameEqBrand.length}`);
  console.log(`Name === registrationNo (should be 0): ${regAsName.length}`);
  console.log(`Lowercase leaks in caps fields (should be 0): ${lowerCaseLeak.length}`);
  console.log(`Duplicate SKUs (should be 0): ${dupSkus.length}`);
  console.log(
    `Same name+brand+strength, multiple regs: ${dupNames.length} groups`,
  );
  console.log(
    `Coded brand still used as product name (should be 0 if generic present): ${codedNameEqualsBrand.filter((p) => p.genericName).length}`,
  );

  console.log("\n=== Sample coded brands ===");
  for (const p of coded.slice(0, 8)) {
    console.log(`  brand=${p.brandName} | name=${p.name.slice(0, 70)} | reg=${p.registrationNo}`);
  }

  console.log("\n=== Sample Vermor-like strength split ===");
  for (const p of products.filter((x) => x.brandName?.includes("VERMOR")).slice(0, 6)) {
    console.log(`  brand=${p.brandName} | name=${p.name} | reg=${p.registrationNo}`);
  }

  if (regAsName.length) {
    console.log("\nWARN registration used as name:", regAsName.slice(0, 5));
  }
  if (lowerCaseLeak.length) {
    console.log("\nWARN lowercase leak:", lowerCaseLeak.slice(0, 5).map((p) => p.name));
  }
  if (dupSkus.length) {
    console.log("\nWARN dup SKUs:", dupSkus.slice(0, 5));
  }

  const formGroups = new Set(products.map((p) => p.dosageFormGroup));
  const schedules = new Set(products.map((p) => p.scheduleGroup).filter(Boolean));
  console.log("\n=== Category sources ===");
  console.log(`Form groups (${formGroups.size}):`, [...formGroups].sort().join(", "));
  console.log(`Schedules (${schedules.size}):`, [...schedules].sort().join(", "));
}

main();
