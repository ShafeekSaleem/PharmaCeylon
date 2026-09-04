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
  /** Not read by the import cascade itself — carried through for the NMRA-link candidate
   *  list, where the brand is the thing a person actually recognises. */
  brandName: string | null;
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

/** Same tiers as `MatchConfidence`, plus the INN-head tier that only the ranked-candidate path uses. */
export type RankedMatchEvidence = MatchConfidence | "inn_head";

export type RankedCandidate = {
  candidate: MatchCandidate;
  evidence: RankedMatchEvidence;
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

/**
 * Words that end an INN head in a register monograph title: the dosage form, then the
 * pharmacopoeia standard that follows it (BP/USP/IP/Ph.Eur./BAN). Everything from the first
 * of these onward is form/strength/standard noise, not part of the substance name.
 */
const INN_HEAD_STOP_WORDS =
  "TABLETS?|CAPSULES?|INJECTIONS?|SUSPENSIONS?|SOLUTIONS?|OINTMENTS?|CREAMS?|SYRUPS?|" +
  "SUPPOSITOR(?:Y|IES)|GELS?|LOTIONS?|DROPS|SPRAYS?|POWDERS?|PATCHES?|LOZENGES?|EMULSIONS?|" +
  "GRANULES?|ELIXIRS?|INHALERS?|PESSAR(?:Y|IES)|LINCTUS(?:ES)?|" +
  "BP|USP|IP|PH\\.?\\s?EUR\\.?|BAN|BPC";
const INN_HEAD_STOP_PATTERN = new RegExp(`\\b(?:${INN_HEAD_STOP_WORDS})\\b`, "i");

/**
 * The INN head of a register monograph title: everything before the first dosage-form or
 * pharmacopoeia word, normalized the same way a name is. Tier 1 of F5's fix — a register
 * genericName is the full monograph title ("PARACETAMOL TABLETS BP 500MG"), not an INN
 * ("Paracetamol"), so nothing a shop types ever meets it without stripping that tail first.
 *
 * Deliberately conservative: it does not strip salt suffixes (sulphate, hydrochloride,
 * maleate, …), so "Salbutamol Sulphate Tablets BP" yields "salbutamol sulphate", which still
 * won't meet a shop's plain "Salbutamol" — a known gap pinned in the tests, not silently
 * papered over, since guessing which suffix is a salt and which is part of the name risks a
 * wrong compliance-flag match more than it's worth for this tier.
 */
export function innHead(value: string | null): string {
  if (!value) return "";
  const stop = INN_HEAD_STOP_PATTERN.exec(value);
  const head = stop ? value.slice(0, stop.index) : value;
  return normalizeName(head);
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
  private readonly byInnHead = new Map<string, MatchCandidate[]>();

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

      const inn = innHead(c.genericName);
      if (inn) push(this.byInnHead, inn, c);
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

  /**
   * Ranked, non-unique candidates for a person to pick from — used to link a shop's own
   * product to a register row, where "twenty registered paracetamols" is the normal case and
   * the right brand is a judgement call, not something the cascade should resolve alone.
   *
   * Unlike `match()`, every tier that fires contributes its candidates rather than stopping at
   * the first tier resolving to exactly one hit — an ambiguous fuzzy tier is exactly the
   * useful case here. Strongest evidence first; a candidate already added by a stronger tier
   * keeps that tier's evidence rather than being re-added by a weaker one.
   */
  rankedCandidates(row: ImportRowKeys, take = 20): RankedCandidate[] {
    const seen = new Map<string, RankedCandidate>();
    const add = (list: MatchCandidate[] | undefined, evidence: RankedMatchEvidence) => {
      for (const c of list ?? []) {
        if (!seen.has(c.id)) seen.set(c.id, { candidate: c, evidence });
      }
    };

    const barcode = normalizeCode(row.barcode);
    if (barcode) {
      const hit = this.byBarcode.get(barcode);
      if (hit) add([hit], "barcode");
    }

    const reg = normalizeCode(row.registrationNo);
    if (reg) {
      const hit = this.byRegistration.get(reg);
      if (hit) add([hit], "registration");
    }

    const exact = row.name.trim().toLowerCase();
    if (exact) {
      const hit = this.byExactName.get(exact);
      if (hit) add([hit], "name");
    }

    add(this.byNormalizedName.get(normalizeName(row.name)), "normalized");
    add(this.byClinicalKey.get(clinicalKey(row)), "fuzzy");
    add(this.byInnHead.get(innHead(row.genericName)), "inn_head");

    return [...seen.values()].slice(0, take);
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

/**
 * Same rule as `needsComplianceConfirmation`, generalized across the ranked-candidate tiers
 * used for linking: barcode, registration number and an identical name are exact identifiers
 * and are trusted outright; everything looser (normalized name, fuzzy clinical key, or the new
 * INN-head tier) is held for individual confirmation whenever accepting it would make a
 * product controlled or prescription-only.
 */
export function rankedCandidateNeedsComplianceConfirmation(candidate: RankedCandidate): boolean {
  const exact: RankedMatchEvidence[] = ["barcode", "registration", "name"];
  if (exact.includes(candidate.evidence)) return false;
  return candidate.candidate.isControlled || candidate.candidate.requiresPrescription;
}
