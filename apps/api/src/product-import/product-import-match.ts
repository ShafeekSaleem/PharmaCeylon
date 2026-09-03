import type { MatchConfidence } from "./product-import.types";

/**
 * A candidate the importer can link an uploaded row to: everything already in this tenant's
 * catalog, ranged or reference. Matching against a REFERENCE row is the valuable case — it is
 * how a plain "Panadol 500mg" line in a spreadsheet picks up its registration number, schedule
 * and compliance flags without anyone typing them 2,000 times.
 */
export type MatchCandidate = {
  id: string;
  name: string;
  barcode: string | null;
  registrationNo: string | null;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
  isControlled: boolean;
  requiresPrescription: boolean;
};

export type ImportRowKeys = {
  name: string;
  barcode: string | null;
  registrationNo: string | null;
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
};

export type MatchOutcome = {
  candidate: MatchCandidate;
  confidence: MatchConfidence;
};

/**
 * Normalise a product name for comparison: case, punctuation and the dosage-form abbreviations
 * that differ between every system ("PARACETAMOL TAB 500MG" vs "Paracetamol Tablets 500 mg").
 * Deliberately conservative — it folds spelling variants, not meaning.
 */
export function normalizeName(value: string): string {
  let text = ` ${value.toLowerCase()} `;
  text = text.replace(/[^a-z0-9]+/g, " ");
  for (const [pattern, canonical] of FORM_SYNONYMS) {
    text = text.replace(pattern, ` ${canonical} `);
  }
  // "500 mg" and "500mg" are the same strength written two ways.
  text = text.replace(/(\d)\s+(mg|ml|mcg|g|iu|l)\b/g, "$1$2");
  return text.replace(/\s+/g, " ").trim();
}

const FORM_SYNONYMS: Array<[RegExp, string]> = [
  [/\b(tabs?|tablets?|tblt)\b/g, "tablet"],
  [/\b(caps?|capsules?)\b/g, "capsule"],
  [/\b(inj|injection|injections)\b/g, "injection"],
  [/\b(susp|suspension)\b/g, "suspension"],
  [/\b(soln?|solution)\b/g, "solution"],
  [/\b(oint|ointment)\b/g, "ointment"],
  [/\b(crm|cream)\b/g, "cream"],
  [/\b(syr|syrup)\b/g, "syrup"],
  [/\b(supp|suppository|suppositories)\b/g, "suppository"],
];

function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toLowerCase();
}

/** Generic + strength + form, the fuzzy tier's key. Empty when the row can't form one. */
export function clinicalKey(row: {
  genericName: string | null;
  strength: string | null;
  dosageForm: string | null;
}): string {
  const generic = normalizeName(row.genericName ?? "");
  const strength = normalizeName(row.strength ?? "");
  const form = normalizeName(row.dosageForm ?? "");
  if (!generic || !strength) return "";
  return [generic, strength, form].filter(Boolean).join("|");
}

/**
 * Indexes over the tenant's catalog, built once per import rather than per row — a 2,000-row
 * file against a 15,000-product registry is 30M comparisons if you do it the naive way.
 */
export class CatalogIndex {
  private readonly byBarcode = new Map<string, MatchCandidate>();
  private readonly byRegistration = new Map<string, MatchCandidate>();
  private readonly byExactName = new Map<string, MatchCandidate>();
  private readonly byNormalizedName = new Map<string, MatchCandidate[]>();
  private readonly byClinicalKey = new Map<string, MatchCandidate[]>();

  constructor(candidates: MatchCandidate[]) {
    for (const c of candidates) {
      const barcode = normalizeCode(c.barcode);
      if (barcode && !this.byBarcode.has(barcode)) this.byBarcode.set(barcode, c);

      const reg = normalizeCode(c.registrationNo);
      if (reg && !this.byRegistration.has(reg)) this.byRegistration.set(reg, c);

      const exact = c.name.trim().toLowerCase();
      if (exact && !this.byExactName.has(exact)) this.byExactName.set(exact, c);

      const norm = normalizeName(c.name);
      if (norm) push(this.byNormalizedName, norm, c);

      const key = clinicalKey(c);
      if (key) push(this.byClinicalKey, key, c);
    }
  }

  /**
   * The matching cascade, strongest evidence first. Each tier only fires when it identifies
   * exactly one product — an ambiguous tier falls through rather than picking arbitrarily,
   * because a wrong link here silently mis-sets the controlled and prescription flags.
   */
  match(row: ImportRowKeys): MatchOutcome | null {
    const barcode = normalizeCode(row.barcode);
    if (barcode) {
      const hit = this.byBarcode.get(barcode);
      if (hit) return { candidate: hit, confidence: "barcode" };
    }

    const reg = normalizeCode(row.registrationNo);
    if (reg) {
      const hit = this.byRegistration.get(reg);
      if (hit) return { candidate: hit, confidence: "registration" };
    }

    const exact = row.name.trim().toLowerCase();
    if (exact) {
      const hit = this.byExactName.get(exact);
      if (hit) return { candidate: hit, confidence: "name" };
    }

    const norm = normalizeName(row.name);
    if (norm) {
      const hits = this.byNormalizedName.get(norm);
      if (hits?.length === 1) return { candidate: hits[0], confidence: "normalized" };
    }

    const key = clinicalKey(row);
    if (key) {
      const hits = this.byClinicalKey.get(key);
      if (hits?.length === 1) return { candidate: hits[0], confidence: "fuzzy" };
    }

    return null;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Whether a match needs the user to confirm it before it is applied.
 *
 * Exact evidence — barcode, registration number, an identical name — is trusted. A fuzzy match
 * is trusted too, right up until it would turn a product into a controlled or prescription-only
 * line: getting that wrong either blocks a legitimate sale or, worse, lets a restricted one
 * through. Those rows are held and listed for explicit confirmation instead of being guessed.
 */
export function needsComplianceConfirmation(outcome: MatchOutcome): boolean {
  if (outcome.confidence !== "fuzzy") return false;
  return outcome.candidate.isControlled || outcome.candidate.requiresPrescription;
}
