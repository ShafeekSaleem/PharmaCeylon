/**
 * Resolves the free-text `Category` column of an uploaded product list onto the tenant's
 * COMMERCIAL category tree.
 *
 * The importer has always *collected* this column — the downloadable template ships it, its
 * example row fills it in, and the mapping step offers it as a target — but nothing ever read
 * the value, so a pharmacy's own departments were discarded silently on every import. Matching
 * here is deliberately conservative: an exact name once case, punctuation and "&"/"and" are
 * folded, then a small table of the legacy names Sri Lankan systems actually emit. Anything
 * else is reported as unmatched so the Review step can ask, rather than guessed at — filing a
 * product under the wrong department quietly corrupts every margin report that groups by it.
 */

export type CommercialCategoryRow = {
  id: string;
  name: string;
  parentCategoryId: string | null;
  canonicalKey: string | null;
  isActive: boolean;
};

export type CategoryMatchStatus = "matched" | "matched_synonym" | "unmatched";

/** One distinct value of the Category column, and where it will land. */
export type ImportCategoryPlanEntry = {
  /** The value exactly as it appears in the file — echoed back as the choice key. */
  incoming: string;
  rowCount: number;
  status: CategoryMatchStatus;
  categoryId: string | null;
  categoryName: string | null;
  /** "Personal Care › Oral Care", or just the department name for a top-level match. */
  categoryPath: string | null;
  /** Target exists but the tenant has it switched off — importing into it re-enables it. */
  willEnable: boolean;
};

export type ImportCategoryPlan = {
  entries: ImportCategoryPlanEntry[];
  /** Rows whose Category column was empty — these fall through to the classifier. */
  blankRows: number;
  /** True when a Category column was mapped at all. */
  mapped: boolean;
};

/**
 * What the user decided in the Review step for one incoming value. `skip` leaves the rows to
 * the deterministic classifier and the Unclassified floor, which is also the default for
 * anything the user never touched.
 */
export type CategoryDecision =
  | { action: "use"; categoryId: string }
  | { action: "create"; parentCategoryId: string | null }
  | { action: "skip" };

/** Keyed by the `incoming` string from the plan. */
export type ImportCategoryChoices = Record<string, CategoryDecision>;

/**
 * Fold a category name to its comparison key. "Baby & Mother Care", "baby and mother care"
 * and "BABY  AND  MOTHER-CARE" all have to reach the same row, because they are all the same
 * department typed by three different shopkeepers.
 */
export function normalizeCategoryName(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Legacy category names that don't exist in our tree but map cleanly onto it. Keyed by the
 * normalized form, valued by `canonicalKey` so a tenant renaming the display name never breaks
 * the mapping. Kept small on purpose — a wrong entry here is worse than an unmatched value,
 * because unmatched gets asked about and a wrong synonym does not.
 */
const CATEGORY_SYNONYMS: ReadonlyMap<string, string> = new Map([
  // Medicines, by the names a counter book actually uses
  ["painkillers", "MEDICINES_PAIN_FEVER"],
  ["painkiller", "MEDICINES_PAIN_FEVER"],
  ["pain killers", "MEDICINES_PAIN_FEVER"],
  ["analgesics", "MEDICINES_PAIN_FEVER"],
  ["analgesic", "MEDICINES_PAIN_FEVER"],
  ["pain and fever", "MEDICINES_PAIN_FEVER"],
  ["antibiotics", "MEDICINES_ANTI_INFECTIVES"],
  ["antibiotic", "MEDICINES_ANTI_INFECTIVES"],
  ["anti infectives", "MEDICINES_ANTI_INFECTIVES"],
  ["antacids", "MEDICINES_DIGESTIVE_HEALTH"],
  ["gastric", "MEDICINES_DIGESTIVE_HEALTH"],
  ["digestive", "MEDICINES_DIGESTIVE_HEALTH"],
  ["cough and cold", "MEDICINES_COLD_COUGH_ALLERGY"],
  ["cough syrup", "MEDICINES_COLD_COUGH_ALLERGY"],
  ["cold and flu", "MEDICINES_COLD_COUGH_ALLERGY"],
  ["antihistamines", "MEDICINES_COLD_COUGH_ALLERGY"],
  ["skin", "MEDICINES_DERMATOLOGY"],
  ["skin care medicines", "MEDICINES_DERMATOLOGY"],
  ["eye drops", "MEDICINES_EYE_EAR"],
  ["eye and ear", "MEDICINES_EYE_EAR"],
  ["diabetic", "MEDICINES_DIABETES_CARE"],
  ["diabetes", "MEDICINES_DIABETES_CARE"],
  ["cardiac", "MEDICINES_CARDIOVASCULAR"],
  ["heart", "MEDICINES_CARDIOVASCULAR"],
  ["otc", "MEDICINES_OTHER"],
  ["over the counter", "MEDICINES_OTHER"],
  ["general medicine", "MEDICINES_OTHER"],
  ["drugs", "MEDICINES"],
  ["pharmaceuticals", "MEDICINES"],
  ["ethical", "MEDICINES"],

  // Non-medicine departments
  ["supplements", "VITAMINS_SUPPLEMENTS"],
  ["food supplements", "VITAMINS_SUPPLEMENTS"],
  ["milk powder", "BABY_CARE_BABY_FORMULA"],
  ["milk food", "BABY_CARE_BABY_FORMULA"],
  ["infant formula", "BABY_CARE_BABY_FORMULA"],
  ["baby", "BABY_CARE"],
  ["baby items", "BABY_CARE"],
  ["baby products", "BABY_CARE"],
  ["nappies", "BABY_CARE_DIAPERS"],
  ["toiletries", "PERSONAL_CARE"],
  ["toothpaste", "PERSONAL_CARE_ORAL_CARE"],
  ["dental", "PERSONAL_CARE_ORAL_CARE"],
  ["shampoo", "PERSONAL_CARE_HAIR_CARE"],
  ["hair", "PERSONAL_CARE_HAIR_CARE"],
  ["soap", "PERSONAL_CARE_BATH_BODY"],
  ["soaps", "PERSONAL_CARE_BATH_BODY"],
  ["sanitary", "PERSONAL_CARE_FEMININE_CARE"],
  ["sanitary napkins", "PERSONAL_CARE_FEMININE_CARE"],
  ["cosmetics", "BEAUTY_SKIN_CARE_COSMETICS"],
  ["cosmetic", "BEAUTY_SKIN_CARE_COSMETICS"],
  ["sunscreen", "BEAUTY_SKIN_CARE_SUN_CARE"],
  ["surgical", "FIRST_AID_DRESSINGS"],
  ["surgical items", "FIRST_AID_DRESSINGS"],
  ["dressings", "FIRST_AID_DRESSINGS"],
  ["equipment", "MEDICAL_DEVICES"],
  ["instruments", "MEDICAL_DEVICES"],
  ["devices", "MEDICAL_DEVICES"],
  ["beverages", "FOOD_BEVERAGE"],
  ["drinks", "FOOD_BEVERAGE"],
  ["confectionery", "FOOD_BEVERAGE_CONFECTIONERY"],
  ["stationery", "HOUSEHOLD_CONVENIENCE_OTHER"],
  ["household", "HOUSEHOLD_CONVENIENCE"],
  ["sundries", "OTHER"],
  ["miscellaneous", "OTHER"],
  ["misc", "OTHER"],
]);

export type CategoryResolution = {
  row: CommercialCategoryRow;
  via: "name" | "synonym";
};

/**
 * Name/canonical-key lookups over one tenant's COMMERCIAL tree, built once per import rather
 * than queried per distinct value.
 */
export class CommercialCategoryIndex {
  private readonly byName = new Map<string, CommercialCategoryRow>();
  private readonly byCanonicalKey = new Map<string, CommercialCategoryRow>();
  private readonly byId = new Map<string, CommercialCategoryRow>();
  private readonly nameById = new Map<string, string>();

  constructor(rows: readonly CommercialCategoryRow[]) {
    for (const row of rows) {
      this.byId.set(row.id, row);
      this.nameById.set(row.id, row.name);
      if (row.canonicalKey) this.byCanonicalKey.set(row.canonicalKey, row);
    }

    // Children are indexed first and departments only claim a name no child took. A file
    // saying "Vitamins" means the child under Vitamins & Supplements, not the department —
    // the more specific row is always the better answer.
    for (const row of rows) {
      if (!row.parentCategoryId) continue;
      const key = normalizeCategoryName(row.name);
      if (key && !this.byName.has(key)) this.byName.set(key, row);
    }
    for (const row of rows) {
      if (row.parentCategoryId) continue;
      const key = normalizeCategoryName(row.name);
      if (key && !this.byName.has(key)) this.byName.set(key, row);
    }
  }

  get(id: string): CommercialCategoryRow | undefined {
    return this.byId.get(id);
  }

  /** "Personal Care › Oral Care" for a child, or just the name for a department. */
  path(row: CommercialCategoryRow): string {
    if (!row.parentCategoryId) return row.name;
    const parent = this.nameById.get(row.parentCategoryId);
    return parent ? `${parent} › ${row.name}` : row.name;
  }

  resolve(incoming: string): CategoryResolution | null {
    const key = normalizeCategoryName(incoming);
    if (!key) return null;

    const byName = this.byName.get(key);
    if (byName) return { row: byName, via: "name" };

    const canonicalKey = CATEGORY_SYNONYMS.get(key);
    if (canonicalKey) {
      const row = this.byCanonicalKey.get(canonicalKey);
      if (row) return { row, via: "synonym" };
    }
    return null;
  }
}

/**
 * Group the rows' Category values into the plan the Review step renders. Ordered by row count
 * so the values that affect the most products are the ones the user sees first, with unmatched
 * values lifted above matched ones because those are the only ones needing a decision.
 */
export function buildCategoryPlan(
  index: CommercialCategoryIndex,
  incomingValues: ReadonlyArray<string | null>,
  mapped: boolean,
): ImportCategoryPlan {
  const counts = new Map<string, { incoming: string; rowCount: number }>();
  let blankRows = 0;

  for (const raw of incomingValues) {
    const value = raw?.trim();
    if (!value) {
      blankRows += 1;
      continue;
    }
    const key = normalizeCategoryName(value);
    if (!key) {
      blankRows += 1;
      continue;
    }
    const existing = counts.get(key);
    if (existing) existing.rowCount += 1;
    else counts.set(key, { incoming: value, rowCount: 1 });
  }

  const entries: ImportCategoryPlanEntry[] = [...counts.values()].map(
    ({ incoming, rowCount }) => {
      const hit = index.resolve(incoming);
      if (!hit) {
        return {
          incoming,
          rowCount,
          status: "unmatched" as const,
          categoryId: null,
          categoryName: null,
          categoryPath: null,
          willEnable: false,
        };
      }
      return {
        incoming,
        rowCount,
        status: hit.via === "name" ? ("matched" as const) : ("matched_synonym" as const),
        categoryId: hit.row.id,
        categoryName: hit.row.name,
        categoryPath: index.path(hit.row),
        willEnable: !hit.row.isActive,
      };
    },
  );

  entries.sort((a, b) => {
    const aNeedsInput = a.status === "unmatched" ? 0 : 1;
    const bNeedsInput = b.status === "unmatched" ? 0 : 1;
    if (aNeedsInput !== bNeedsInput) return aNeedsInput - bNeedsInput;
    if (a.rowCount !== b.rowCount) return b.rowCount - a.rowCount;
    return a.incoming.localeCompare(b.incoming);
  });

  return { entries, blankRows, mapped };
}

/**
 * Fold the user's Review-step choices over the plan's own resolutions, producing the map the
 * write path consults. A value the user never touched keeps whatever the plan resolved it to,
 * so confirming an import without opening the Categories block still applies every automatic
 * match — the choices only ever override.
 *
 * `create` decisions are resolved by the caller before this runs (they need a DB write), and
 * arrive here as plain `use` entries.
 */
export function resolveCategoryAssignments(
  plan: ImportCategoryPlan,
  choices: ImportCategoryChoices,
): Map<string, string> {
  const byNormalized = new Map<string, string>();
  for (const entry of plan.entries) {
    const decision = choices[entry.incoming];
    if (decision?.action === "skip") continue;
    const categoryId =
      decision?.action === "use" ? decision.categoryId : entry.categoryId;
    if (categoryId) byNormalized.set(normalizeCategoryName(entry.incoming), categoryId);
  }
  return byNormalized;
}
