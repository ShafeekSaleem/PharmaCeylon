/**
 * The field-ownership policy for linking a shop's own product to an NMRA register row (see
 * "Field ownership when a product is linked" in the catalog-organisation plan). A pure function
 * so the policy — which value wins, what happens to the value it replaces — is testable without
 * a database, and so the preview the link modal shows is built from exactly the same logic the
 * link itself applies, not a hand-written approximation of it.
 *
 * Fields this policy does not touch at all: sku, reorderLevel, pricing, batches, stock. Those
 * are operational data — linking must never move history — and simply never appear below.
 * Regulatory categories, the commercial category and tags are a different shape of decision
 * (relations, not scalars) and are applied separately by the service.
 */

export type NmraLinkableFields = {
  name: string;
  brandName: string | null;
  barcode: string | null;
  genericName: string | null;
  dosageForm: string | null;
  strength: string | null;
  unit: string | null;
  packSize: string | null;
  packType: string | null;
  manufacturer: string | null;
  localAgent: string | null;
  countryOfOrigin: string | null;
  storage: string | null;
  shelfLife: string | null;
  registrationNo: string | null;
  registrationDate: Date | null;
  schedule: string | null;
  regType: string | null;
  dossierNo: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
};

export type NmraLinkFieldChange = {
  field: keyof NmraLinkableFields;
  from: string | boolean | null;
  to: string | boolean | null;
  changed: boolean;
  /** True for the ten fields the shop's value is kept for by default when non-empty — the ones a caller can force-adopt via `adoptFieldOverrides`. */
  adoptable: boolean;
};

export type NmraLinkAlias = {
  aliasText: string;
  aliasType: "shop_name" | "shop_brand" | "barcode";
};

export type NmraLinkPlan = {
  /** Scalar values to write onto the shop's product — only the fields that actually change. */
  updates: Partial<NmraLinkableFields>;
  /** Every field considered, before/after, for the preview UI and the undo snapshot. */
  changes: NmraLinkFieldChange[];
  /** Compliance-flag changes, worded — shown outside the diff table so they can't be missed. */
  complianceStatements: string[];
  /** Aliases to add for the shop's own displaced name/brand and a differing register barcode. */
  aliasesToAdd: NmraLinkAlias[];
};

/** Register wins outright — no override, no displaced-value alias beyond name/brandName. */
const REGISTER_ALWAYS_FIELDS = [
  "registrationNo",
  "registrationDate",
  "schedule",
  "regType",
  "dossierNo",
] as const;

/** Register wins outright, and the shop's differing value survives as an alias. */
const REGISTER_ALWAYS_WITH_ALIAS_FIELDS = ["name", "brandName"] as const;

/**
 * Register wins only where the shop's own value is empty; otherwise kept unless overridden.
 * Exported (not just the type) because the link DTO validates `adoptFieldOverrides` against
 * exactly this list — the only fields a caller is ever allowed to force-adopt.
 */
export const FILL_IF_EMPTY_FIELD_NAMES = [
  "genericName",
  "dosageForm",
  "strength",
  "unit",
  "packSize",
  "packType",
  "manufacturer",
  "localAgent",
  "countryOfOrigin",
  "storage",
  "shelfLife",
] as const;
const FILL_IF_EMPTY_FIELDS = FILL_IF_EMPTY_FIELD_NAMES;

/** Not overridable — the register's to state, and stated in words rather than left as a diff row. */
const COMPLIANCE_FIELDS = ["isControlled", "requiresPrescription"] as const;

function isEmpty(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function scalarsEqual(a: string | boolean | Date | null, b: string | boolean | Date | null): boolean {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : null;
    const bt = b instanceof Date ? b.getTime() : null;
    return at === bt;
  }
  if (typeof a === "string" && typeof b === "string") return a.trim() === b.trim();
  return a === b;
}

function toPlainValue(value: string | boolean | Date | null): string | boolean | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

const COMPLIANCE_STATEMENTS: Record<
  (typeof COMPLIANCE_FIELDS)[number],
  { becomesTrue: string; becomesFalse: string }
> = {
  isControlled: {
    becomesTrue: "This becomes a controlled medicine, requiring pharmacist dispense authority.",
    becomesFalse: "This is no longer a controlled medicine.",
  },
  requiresPrescription: {
    becomesTrue: "This becomes a prescription-only product.",
    becomesFalse: "This no longer requires a prescription.",
  },
};

/**
 * Build the field-level write plan for linking `shop` (the pharmacy's own product) to
 * `reference` (an NMRA register row). Does not read or write anything — the caller applies
 * `updates`/`aliasesToAdd` and separately handles the regulatory/commercial/tag relations.
 */
export function buildNmraLinkPlan(
  shop: NmraLinkableFields,
  reference: NmraLinkableFields,
  opts?: { adoptFieldOverrides?: string[] },
): NmraLinkPlan {
  const updates: Partial<NmraLinkableFields> = {};
  const changes: NmraLinkFieldChange[] = [];
  const complianceStatements: string[] = [];
  const aliasesToAdd: NmraLinkAlias[] = [];
  const overrides = new Set(opts?.adoptFieldOverrides ?? []);

  function record(
    field: keyof NmraLinkableFields,
    from: string | boolean | Date | null,
    to: string | boolean | Date | null,
    adoptable: boolean,
  ) {
    const changed = !scalarsEqual(from, to);
    changes.push({ field, from: toPlainValue(from), to: toPlainValue(to), changed, adoptable });
    if (changed) {
      (updates as Record<string, unknown>)[field] = to;
    }
  }

  for (const field of REGISTER_ALWAYS_FIELDS) {
    record(field, shop[field], reference[field], false);
  }

  for (const field of REGISTER_ALWAYS_WITH_ALIAS_FIELDS) {
    const from = shop[field];
    const to = reference[field];
    record(field, from, to, false);
    // Case-insensitive here — the point is whether the shop's own text is worth keeping as a
    // second findable name, not whether it matches the register's exact casing. The write
    // above still takes the register's casing outright either way.
    if (
      typeof from === "string" &&
      !isEmpty(from) &&
      from.trim().toLowerCase() !== (typeof to === "string" ? to.trim().toLowerCase() : "")
    ) {
      aliasesToAdd.push({
        aliasText: from,
        aliasType: field === "name" ? "shop_name" : "shop_brand",
      });
    }
  }

  for (const field of FILL_IF_EMPTY_FIELDS) {
    const shopValue = shop[field] as string | null;
    const willAdopt = isEmpty(shopValue) || overrides.has(field);
    const to = willAdopt ? reference[field] : shopValue;
    record(field, shopValue, to, true);
  }

  for (const field of COMPLIANCE_FIELDS) {
    const from = shop[field] as boolean;
    const to = reference[field] as boolean;
    record(field, from, to, false);
    if (from !== to) {
      const wording = COMPLIANCE_STATEMENTS[field];
      complianceStatements.push(to ? wording.becomesTrue : wording.becomesFalse);
    }
  }

  // Barcode: the shop's own always wins and is never overwritten. A differing, non-empty
  // register barcode survives as an alias instead of being discarded.
  changes.push({
    field: "barcode",
    from: shop.barcode,
    to: shop.barcode,
    changed: false,
    adoptable: false,
  });
  if (!isEmpty(reference.barcode) && !scalarsEqual(reference.barcode, shop.barcode)) {
    aliasesToAdd.push({ aliasText: reference.barcode!, aliasType: "barcode" });
  }

  return { updates, changes, complianceStatements, aliasesToAdd };
}
