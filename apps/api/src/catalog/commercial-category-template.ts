/**
 * Standard pharmacy merchandising taxonomy (COMMERCIAL dimension), seeded per-tenant by
 * `CategoryTaxonomyService.ensureCommercialTemplate()`. Two levels — Department → Category —
 * ship out of the box; tenants may add a third Subcategory level themselves via Settings →
 * Catalog → Categories (the model is self-referential and not limited to this depth).
 *
 * `canonicalKey` is the stable SaaS-level identity for these predefined rows — never the
 * display `name`, which a tenant may rename. Custom tenant-created categories have no
 * canonicalKey.
 */
export type CommercialCategoryTemplateNode = {
  canonicalKey: string;
  name: string;
  children?: CommercialCategoryTemplateNode[];
};

export type CommercialDepartmentTemplate = CommercialCategoryTemplateNode & {
  /** Seeded active for every tenant immediately (no onboarding opt-in required). */
  enabledByDefault?: boolean;
};

export const COMMERCIAL_CATEGORY_TEMPLATE: CommercialDepartmentTemplate[] = [
  {
    canonicalKey: "MEDICINES",
    name: "Medicines",
    enabledByDefault: true,
    children: [
      { canonicalKey: "MEDICINES_PAIN_FEVER", name: "Pain & Fever" },
      { canonicalKey: "MEDICINES_COLD_COUGH_ALLERGY", name: "Cold, Cough & Allergy" },
      { canonicalKey: "MEDICINES_DIGESTIVE_HEALTH", name: "Digestive Health" },
      { canonicalKey: "MEDICINES_RESPIRATORY", name: "Respiratory" },
      { canonicalKey: "MEDICINES_DERMATOLOGY", name: "Dermatology" },
      { canonicalKey: "MEDICINES_EYE_EAR", name: "Eye & Ear" },
      { canonicalKey: "MEDICINES_WOMENS_HEALTH", name: "Women's Health" },
      { canonicalKey: "MEDICINES_MENS_HEALTH", name: "Men's Health" },
      { canonicalKey: "MEDICINES_DIABETES_CARE", name: "Diabetes Care" },
      { canonicalKey: "MEDICINES_CARDIOVASCULAR", name: "Cardiovascular" },
      { canonicalKey: "MEDICINES_ANTI_INFECTIVES", name: "Anti-infectives" },
      { canonicalKey: "MEDICINES_OTHER", name: "Other Medicines" },
      { canonicalKey: "MEDICINES_UNCLASSIFIED", name: "Unclassified Medicines" },
    ],
  },
  {
    canonicalKey: "VITAMINS_SUPPLEMENTS",
    name: "Vitamins & Supplements",
    children: [
      { canonicalKey: "VITAMINS_SUPPLEMENTS_VITAMINS", name: "Vitamins" },
      { canonicalKey: "VITAMINS_SUPPLEMENTS_MINERALS", name: "Minerals" },
      { canonicalKey: "VITAMINS_SUPPLEMENTS_MULTIVITAMINS", name: "Multivitamins" },
      { canonicalKey: "VITAMINS_SUPPLEMENTS_HERBAL", name: "Herbal Supplements" },
      { canonicalKey: "VITAMINS_SUPPLEMENTS_SPORTS", name: "Sports Supplements" },
      { canonicalKey: "VITAMINS_SUPPLEMENTS_OTHER", name: "Other Supplements" },
    ],
  },
  {
    canonicalKey: "BABY_CARE",
    name: "Baby & Mother Care",
    children: [
      { canonicalKey: "BABY_CARE_BABY_FOOD", name: "Baby Food" },
      { canonicalKey: "BABY_CARE_BABY_FORMULA", name: "Baby Formula" },
      { canonicalKey: "BABY_CARE_DIAPERS", name: "Diapers" },
      { canonicalKey: "BABY_CARE_BABY_SKIN_CARE", name: "Baby Skin Care" },
      { canonicalKey: "BABY_CARE_BABY_TOILETRIES", name: "Baby Toiletries" },
      { canonicalKey: "BABY_CARE_FEEDING", name: "Feeding" },
      { canonicalKey: "BABY_CARE_MOTHER_CARE", name: "Mother Care" },
    ],
  },
  {
    canonicalKey: "PERSONAL_CARE",
    name: "Personal Care",
    children: [
      { canonicalKey: "PERSONAL_CARE_ORAL_CARE", name: "Oral Care" },
      { canonicalKey: "PERSONAL_CARE_HAIR_CARE", name: "Hair Care" },
      { canonicalKey: "PERSONAL_CARE_BATH_BODY", name: "Bath & Body" },
      { canonicalKey: "PERSONAL_CARE_FEMININE_CARE", name: "Feminine Care" },
      { canonicalKey: "PERSONAL_CARE_MENS_GROOMING", name: "Men's Grooming" },
      { canonicalKey: "PERSONAL_CARE_DEODORANTS", name: "Deodorants" },
      { canonicalKey: "PERSONAL_CARE_HYGIENE", name: "Hygiene" },
    ],
  },
  {
    canonicalKey: "BEAUTY_SKIN_CARE",
    name: "Beauty & Skin Care",
    children: [
      { canonicalKey: "BEAUTY_SKIN_CARE_FACE_CARE", name: "Face Care" },
      { canonicalKey: "BEAUTY_SKIN_CARE_BODY_CARE", name: "Body Care" },
      { canonicalKey: "BEAUTY_SKIN_CARE_SUN_CARE", name: "Sun Care" },
      { canonicalKey: "BEAUTY_SKIN_CARE_ACNE_CARE", name: "Acne Care" },
      { canonicalKey: "BEAUTY_SKIN_CARE_COSMETICS", name: "Cosmetics" },
      { canonicalKey: "BEAUTY_SKIN_CARE_DERMOCOSMETICS", name: "Dermocosmetics" },
    ],
  },
  {
    canonicalKey: "MEDICAL_DEVICES",
    name: "Medical Devices",
    children: [
      { canonicalKey: "MEDICAL_DEVICES_BP_MONITORS", name: "Blood Pressure Monitors" },
      { canonicalKey: "MEDICAL_DEVICES_GLUCOSE_MONITORING", name: "Glucose Monitoring" },
      { canonicalKey: "MEDICAL_DEVICES_THERMOMETERS", name: "Thermometers" },
      { canonicalKey: "MEDICAL_DEVICES_NEBULIZERS", name: "Nebulizers" },
      { canonicalKey: "MEDICAL_DEVICES_MOBILITY_AIDS", name: "Mobility Aids" },
      { canonicalKey: "MEDICAL_DEVICES_OTHER", name: "Other Devices" },
    ],
  },
  {
    canonicalKey: "FIRST_AID",
    name: "First Aid",
    children: [
      { canonicalKey: "FIRST_AID_DRESSINGS", name: "Dressings" },
      { canonicalKey: "FIRST_AID_BANDAGES", name: "Bandages" },
      { canonicalKey: "FIRST_AID_ANTISEPTICS", name: "Antiseptics" },
      { canonicalKey: "FIRST_AID_SUPPORTS_BRACES", name: "Supports & Braces" },
      { canonicalKey: "FIRST_AID_KITS", name: "First Aid Kits" },
    ],
  },
  {
    canonicalKey: "NUTRITION_WELLNESS",
    name: "Nutrition & Wellness",
    children: [
      { canonicalKey: "NUTRITION_WELLNESS_MEDICAL_NUTRITION", name: "Medical Nutrition" },
      { canonicalKey: "NUTRITION_WELLNESS_PROTEIN_NUTRITION", name: "Protein & Nutrition" },
      { canonicalKey: "NUTRITION_WELLNESS_WEIGHT_MANAGEMENT", name: "Weight Management" },
      { canonicalKey: "NUTRITION_WELLNESS_HYDRATION", name: "Hydration" },
      { canonicalKey: "NUTRITION_WELLNESS_PRODUCTS", name: "Wellness Products" },
    ],
  },
  {
    canonicalKey: "FOOD_BEVERAGE",
    name: "Food & Beverages",
    children: [
      { canonicalKey: "FOOD_BEVERAGE_WATER", name: "Water" },
      { canonicalKey: "FOOD_BEVERAGE_SOFT_DRINKS", name: "Soft Drinks" },
      { canonicalKey: "FOOD_BEVERAGE_ENERGY_DRINK", name: "Energy Drinks" },
      { canonicalKey: "FOOD_BEVERAGE_JUICES", name: "Juices" },
      { canonicalKey: "FOOD_BEVERAGE_SNACKS", name: "Snacks" },
      { canonicalKey: "FOOD_BEVERAGE_CONFECTIONERY", name: "Confectionery" },
    ],
  },
  {
    canonicalKey: "HOUSEHOLD_CONVENIENCE",
    name: "Household & Convenience",
    children: [
      { canonicalKey: "HOUSEHOLD_CONVENIENCE_TISSUES", name: "Tissues" },
      { canonicalKey: "HOUSEHOLD_CONVENIENCE_SANITIZERS", name: "Sanitizers" },
      { canonicalKey: "HOUSEHOLD_CONVENIENCE_CLEANING", name: "Cleaning" },
      { canonicalKey: "HOUSEHOLD_CONVENIENCE_OTHER", name: "Other Convenience Products" },
    ],
  },
  {
    canonicalKey: "OTHER",
    name: "Other",
  },
];

/** Canonical key of the safe landing spot for NMRA medicines with no commercial mapping yet. */
export const UNCLASSIFIED_MEDICINES_CANONICAL_KEY = "MEDICINES_UNCLASSIFIED";

/**
 * Onboarding "what does your pharmacy sell" toggles. Most map 1:1 to a department, but
 * Medical Devices and First Aid share a single toggle even though they're separate
 * departments in the full taxonomy above.
 */
export const ONBOARDING_DEPARTMENT_GROUPS: Array<{
  label: string;
  departmentKeys: string[];
}> = [
  { label: "Medicines", departmentKeys: ["MEDICINES"] },
  { label: "Vitamins & Supplements", departmentKeys: ["VITAMINS_SUPPLEMENTS"] },
  { label: "Baby & Mother Care", departmentKeys: ["BABY_CARE"] },
  { label: "Personal Care", departmentKeys: ["PERSONAL_CARE"] },
  { label: "Beauty & Skin Care", departmentKeys: ["BEAUTY_SKIN_CARE"] },
  { label: "Medical Devices & First Aid", departmentKeys: ["MEDICAL_DEVICES", "FIRST_AID"] },
  { label: "Nutrition & Wellness", departmentKeys: ["NUTRITION_WELLNESS"] },
  { label: "Food & Beverages", departmentKeys: ["FOOD_BEVERAGE"] },
  { label: "Household & Convenience", departmentKeys: ["HOUSEHOLD_CONVENIENCE"] },
];
