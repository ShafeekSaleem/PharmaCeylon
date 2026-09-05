/**
 * Is this product the kind of thing the NMRA register could possibly describe?
 *
 * The register-match queue used to be "every RANGED product not sourced from NMRA", which put
 * umbrellas, kitchen scales and nappies in a medicines worklist alongside the antibiotics —
 * thousands of rows nobody could ever action, drowning the handful that mattered. A pharmacy's
 * range is roughly half general retail, so this was not an edge case.
 *
 * A pure function over the signals already on the product row, so the rule is testable without
 * a database and the same verdict can be shown in the UI as the reason a product was excluded.
 *
 * Deliberately three-valued rather than a boolean:
 *
 * - `eligible`     — a positive medicine signal. Always queued, even when nothing matches, so
 *                    "we have a registered medicine with no register row" stays visible.
 * - `not_applicable` — a positive *retail* signal, or no medicine signal at all on a product
 *                    that does carry retail-shaped text. Never queued; recorded as a durable
 *                    NOT_APPLICABLE task so the exclusion is auditable and can be overridden.
 * - `uncertain`    — nothing says either way. Queued only when the matcher actually finds a
 *                    candidate, so an unclassifiable medicine is still caught while an
 *                    unclassifiable teapot doesn't generate a "no suggestion" row.
 */

export type NmraEligibilityVerdict = "eligible" | "not_applicable" | "uncertain";

/**
 * How strong the evidence for "this is a medicine" was.
 *
 * The distinction earns its keep in one specific place: whether a product with *no* register
 * match deserves a queue entry saying so. A product carrying a registration number or a
 * schedule and matching nothing is a real discrepancy worth surfacing. A product that merely
 * has "Gel" in its name and matches nothing is a hand sanitiser, and putting it in a medicines
 * worklist is how that worklist fills with things nobody can action.
 */
export type NmraEligibilityTier = "regulatory" | "weak" | "none";

export type NmraEligibility = {
  verdict: NmraEligibilityVerdict;
  tier: NmraEligibilityTier;
  /** Human-readable, shown verbatim in the UI — an exclusion nobody can explain is a bug report. */
  reason: string;
  /** The signal names that drove the verdict, for diagnostics and tests. */
  signals: string[];
};

export type NmraEligibilityInput = {
  name: string;
  genericName?: string | null;
  dosageForm?: string | null;
  strength?: string | null;
  registrationNo?: string | null;
  schedule?: string | null;
  regType?: string | null;
  isControlled?: boolean;
  requiresPrescription?: boolean;
  /** Canonical key of the product's primary commercial category, when it has one. */
  commercialCanonicalKey?: string | null;
};

/**
 * Dosage forms that only a medicine (or at least a regulated medicinal product) has. Matched
 * as whole words against the dosage form *and* the product name — a shop's own row often
 * carries "Tablet" only inside the name.
 */
const MEDICINE_FORMS = [
  "tablet", "tablets", "tab", "tabs", "caplet", "caplets",
  "capsule", "capsules", "cap", "caps",
  "injection", "injections", "inj", "ampoule", "ampoules", "vial", "vials", "infusion",
  "syrup", "syrups", "suspension", "suspensions", "elixir", "linctus",
  "ointment", "ointments", "cream", "creams", "gel", "gels", "lotion",
  "suppository", "suppositories", "pessary", "pessaries",
  "inhaler", "inhalers", "respirator solution",
  "eye drops", "ear drops", "nasal spray", "eye ointment", "drops",
  "granules", "sachet", "sachets", "powder for injection", "lozenge", "lozenges",
  "patch", "patches", "solution for injection", "iv fluid", "dry syrup",
];

/**
 * Words that mark a product as general retail. Only ever used to *exclude*, and only when no
 * medicine signal fired — a "Paracetamol Baby Suspension" must not be excluded for containing
 * "baby". Kept broad but literal: these are things a Sri Lankan pharmacy genuinely stocks
 * beside the dispensary, not a guess at what might not be a drug.
 */
const RETAIL_KEYWORDS = [
  "umbrella", "kitchen scale", "weighing scale", "bathroom scale",
  "diaper", "diapers", "nappy", "nappies",
  "soap", "shampoo", "conditioner", "body wash", "shower gel", "face wash",
  "toothbrush", "toothpaste", "mouthwash", "dental floss",
  "razor", "shaving", "deodorant", "perfume", "cologne", "talc", "talcum",
  "tissue", "tissues", "toilet paper", "paper towel", "napkin", "wet wipes",
  "detergent", "bleach", "dishwash", "cleaner", "air freshener", "insect repellent",
  "mosquito coil", "mosquito net", "candle", "matches", "lighter",
  "battery", "batteries", "torch", "bulb", "charger", "cable", "earphone",
  "confectionery", "chocolate", "biscuit", "biscuits", "candy", "toffee", "chewing gum",
  "milk powder", "beverage", "juice", "soft drink", "tea", "coffee", "sugar",
  "greeting card", "gift", "stationery", "pen", "pencil", "notebook",
  "toy", "toys", "sock", "socks", "slipper", "slippers", "bag", "wallet",
  "comb", "hair brush", "hair oil", "hair dye", "nail polish", "cosmetic", "lipstick",
  "sunglasses", "spectacle case", "water bottle", "flask", "lunch box",
  "sanitary napkin", "sanitary pad", "panty liner",
  "cotton bud", "cotton buds",
  // Added after running the classifier over a real seeded catalog, where each of these was
  // being read as a medicine: "Gel" and "Lotion" are dosage forms, and "100ml"/"400g" are
  // dosed strengths, so a hand sanitiser and a baby cereal both looked medicinal.
  "sanitizer", "sanitiser", "hand wash", "hand rub",
  "cereal", "baby food", "baby formula", "infant formula", "porridge",
  "thermometer", "blood pressure monitor",
  "glucometer", "weighing", "crutch", "wheelchair", "walking stick",
  "hot water bottle", "ice pack", "face mask", "gloves", "syringe box",
];

/** Strength units that only appear on a dosed medicinal product. */
const STRENGTH_UNIT_PATTERN = /\b\d+(?:\.\d+)?\s?(mg|mcg|µg|ug|g|ml|l|iu|u|%|mg\/ml|mg\/5ml|meq|mmol)\b/i;

/** NMRA schedule codes, as they appear on the register. */
const SCHEDULE_PATTERN = /^(i{1,3}|iv|v)\s?[abc]?$/i;

function haystack(input: NmraEligibilityInput): string {
  return [input.name, input.genericName, input.dosageForm, input.strength]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function containsWord(text: string, term: string): boolean {
  // Multi-word terms are matched as a phrase; single words on word boundaries, so "tab" does
  // not fire on "table" and "gel" does not fire on "gelatin".
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * Decide whether `input` belongs in the NMRA register-match queue.
 *
 * Three passes, in this order, and the order is the whole design:
 *
 * 1. **Regulatory signals** — a registration number, an NMRA schedule, a registration type, a
 *    compliance flag, or a medicines commercial category. These are statements someone already
 *    made about this product's regulatory status, so they win outright, ahead of any keyword.
 * 2. **Retail keywords** — checked *before* the weak medicine signals, because those are far
 *    too easy to trip: "Axe Deodorant Spray 150ml" has a dosed strength and "Anchor Full Cream
 *    Milk Powder" has a "cream". Reading the keyword first is what stops half a pharmacy's
 *    shelf from being classed as medicine on a units suffix.
 * 3. **Weak medicine signals** — dosage form, generic/substance name, dosed strength. Enough
 *    on their own, but only once nothing louder has spoken.
 */
export function classifyNmraEligibility(input: NmraEligibilityInput): NmraEligibility {
  const text = haystack(input);

  const strong: string[] = [];
  if (input.registrationNo?.trim()) strong.push("registration_no");
  if (input.schedule?.trim() && SCHEDULE_PATTERN.test(input.schedule.trim())) {
    strong.push("schedule");
  }
  if (input.regType?.trim()) strong.push("registration_type");
  if (input.isControlled) strong.push("controlled");
  if (input.requiresPrescription) strong.push("prescription_required");
  if (input.commercialCanonicalKey?.startsWith("MEDICINES_")) strong.push("medicine_category");

  if (strong.length > 0) {
    return {
      verdict: "eligible",
      tier: "regulatory",
      reason: describeEligible(strong),
      signals: strong,
    };
  }

  const retailHit = RETAIL_KEYWORDS.find((k) => containsWord(text, k));
  if (retailHit) {
    return {
      verdict: "not_applicable",
      tier: "none",
      reason: `Looks like general retail stock ("${retailHit}") rather than a registered medicine.`,
      signals: [`retail:${retailHit}`],
    };
  }

  const weak: string[] = [];
  const form = (input.dosageForm ?? "").toLowerCase().trim();
  const formHit = MEDICINE_FORMS.find(
    (f) => (form && containsWord(form, f)) || containsWord(input.name.toLowerCase(), f),
  );
  if (formHit) weak.push(`dosage_form:${formHit}`);
  if (input.genericName?.trim()) weak.push("generic_name");
  if (STRENGTH_UNIT_PATTERN.test(text)) weak.push("dosed_strength");

  if (weak.length > 0) {
    return { verdict: "eligible", tier: "weak", reason: describeEligible(weak), signals: weak };
  }

  return {
    verdict: "uncertain",
    tier: "none",
    reason:
      "No medicine signals (no generic name, dosage form, strength, schedule or registration number) — matched only if the register turns up a candidate.",
    signals: [],
  };
}

function describeEligible(signals: string[]): string {
  const parts: string[] = [];
  if (signals.includes("registration_no")) parts.push("carries a registration number");
  if (signals.includes("schedule")) parts.push("carries an NMRA schedule");
  if (signals.includes("controlled")) parts.push("is marked controlled");
  if (signals.includes("prescription_required")) parts.push("requires a prescription");
  const form = signals.find((s) => s.startsWith("dosage_form:"));
  if (form) parts.push(`has a medicinal dosage form (${form.slice("dosage_form:".length)})`);
  if (signals.includes("generic_name")) parts.push("has a generic/substance name");
  if (signals.includes("dosed_strength")) parts.push("has a dosed strength");
  if (signals.includes("medicine_category")) parts.push("is filed under a medicines category");
  return `Treated as a medicine: ${parts.join(", ")}.`;
}
