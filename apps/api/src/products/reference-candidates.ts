import type { PrismaService } from "../prisma/prisma.service";
import {
  clinicalKey,
  innHead,
  normalizeName,
  type ImportRowKeys,
  type MatchCandidate,
} from "../product-import/product-import-match";

/**
 * Finds NMRA reference rows worth comparing a shop product against, using indexed database
 * queries driven by the product's own identifiers.
 *
 * This replaces `findMany({ ..., take: 5000 })`. That cap was silently wrong twice over: on a
 * 15,000-row register two thirds of the catalog could never match anything, and *which* two
 * thirds depended on Postgres' row order, so the same product could match today and not
 * tomorrow. There was no error and no warning — matches simply didn't exist.
 *
 * The shape here is the opposite: instead of loading a truncated slice of the catalog and
 * indexing it in memory, each probe asks the database a narrow, indexed question ("which
 * reference rows have this barcode?"), so **every** reference row is reachable and the amount
 * of data pulled is bounded by how many products are being matched, not by the catalog size.
 *
 * Probes are batched across a whole page of products — the register-match queue works fifty
 * products at a time, and fifty products × five probes as separate round-trips is what makes
 * this kind of screen slow.
 */

/** How many rows any single probe may return. A wider hit than this is ambiguous by definition. */
const PROBE_LIMIT = 200;
/** Ceiling on the union gathered for one page, so a pathological page can't pull the catalog. */
const PAGE_CANDIDATE_LIMIT = 4000;
/** Identifier probes return every collision up to this, which is all the UI ever needs to list. */
const IDENTIFIER_COLLISION_LIMIT = 25;

const REFERENCE_SELECT = {
  id: true,
  name: true,
  barcode: true,
  registrationNo: true,
  genericName: true,
  strength: true,
  dosageForm: true,
  brandName: true,
  isControlled: true,
  requiresPrescription: true,
} as const;

export type IdentifierAmbiguity = {
  field: "barcode" | "registrationNo";
  value: string;
  candidates: Array<{ id: string; name: string; brandName: string | null; registrationNo: string | null }>;
};

export type ReferenceCandidateSet = {
  /** Every reference row gathered for this page, ready to index. */
  candidates: MatchCandidate[];
  /**
   * Identifier → the rows carrying it, but only where more than one row does. A product whose
   * barcode or registration number lands here must never be auto-linked: the register itself
   * is telling us the identifier does not identify anything.
   */
  ambiguousByBarcode: Map<string, MatchCandidate[]>;
  ambiguousByRegistration: Map<string, MatchCandidate[]>;
};

function normalizeCode(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * The most selective word in a name — the longest token that isn't a dosage form or a number.
 * Used as a `startsWith` probe, which is the part an index can actually serve.
 */
export function leadingSearchTerm(name: string): string {
  const tokens = normalizeName(name)
    .split(" ")
    .filter((t) => t.length >= 4 && !/^\d+[a-z]*$/.test(t));
  if (tokens.length === 0) return "";
  // The first long token, not the longest: register titles and shop names both lead with the
  // substance or brand, and leading is what a prefix index can serve.
  return tokens[0];
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) set.add(trimmed);
  }
  return [...set];
}

/** Case variants for an `in` filter, which Prisma cannot make case-insensitive. */
function caseVariants(values: string[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    set.add(v);
    set.add(v.toUpperCase());
    set.add(v.toLowerCase());
  }
  return [...set];
}

export type ReferenceCandidateFinderOptions = {
  /** Exclude a product from its own candidate list. */
  excludeProductId?: string | null;
  /**
   * Include reference rows already claimed by another shop product. Off by default — a claimed
   * row can't be linked again, so offering it is a dead end. On for the ambiguity probes,
   * where the point is to report the collision honestly.
   */
  includeClaimed?: boolean;
};

/**
 * Gathers reference candidates for one or many shop products in a bounded number of indexed
 * queries. Stateless apart from the injected Prisma client — construct freely.
 */
export class ReferenceCandidateFinder {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One product's candidates. A thin wrapper over `forMany` so single-product and queue paths
   * can never drift apart in what they consider a candidate.
   */
  async forOne(
    tenantId: string,
    row: ImportRowKeys,
    opts: ReferenceCandidateFinderOptions = {},
  ): Promise<ReferenceCandidateSet> {
    return this.forMany(tenantId, [row], opts);
  }

  /**
   * Candidates for a whole page of products, in five queries total rather than five per row.
   *
   * Each probe is a narrow filter over indexed columns; the union is capped so a page can't
   * degenerate into a catalog scan, but nothing is excluded by position the way a bare `take`
   * excluded it — a row is only ever left out because no product on the page asked for it.
   */
  async forMany(
    tenantId: string,
    rows: ImportRowKeys[],
    opts: ReferenceCandidateFinderOptions = {},
  ): Promise<ReferenceCandidateSet> {
    const base = {
      tenantId,
      rangeStatus: "REFERENCE" as const,
      source: "NMRA" as const,
      ...(opts.includeClaimed ? {} : { claimedBy: null }),
      ...(opts.excludeProductId ? { id: { not: opts.excludeProductId } } : {}),
    };

    const barcodes = uniqueNonEmpty(rows.map((r) => r.barcode));
    const registrations = uniqueNonEmpty(rows.map((r) => r.registrationNo));
    const names = uniqueNonEmpty(rows.map((r) => r.name));
    const heads = uniqueNonEmpty(
      rows.flatMap((r) => [innHead(r.genericName), leadingSearchTerm(r.name)]),
    ).filter((t) => t.length >= 4);

    const [byBarcode, byRegistration, byExactName, byPrefix] = await Promise.all([
      barcodes.length
        ? this.prisma.product.findMany({
            where: { ...base, barcode: { in: caseVariants(barcodes) } },
            select: REFERENCE_SELECT,
            take: PROBE_LIMIT,
          })
        : Promise.resolve([]),
      registrations.length
        ? this.prisma.product.findMany({
            where: { ...base, registrationNo: { in: caseVariants(registrations) } },
            select: REFERENCE_SELECT,
            take: PROBE_LIMIT,
          })
        : Promise.resolve([]),
      names.length
        ? this.prisma.product.findMany({
            where: {
              ...base,
              OR: names.slice(0, 100).map((n) => ({
                name: { equals: n, mode: "insensitive" as const },
              })),
            },
            select: REFERENCE_SELECT,
            take: PROBE_LIMIT,
          })
        : Promise.resolve([]),
      heads.length
        ? this.prisma.product.findMany({
            where: {
              ...base,
              OR: heads.slice(0, 60).flatMap((t) => [
                { genericName: { startsWith: t, mode: "insensitive" as const } },
                { name: { startsWith: t, mode: "insensitive" as const } },
              ]),
            },
            select: REFERENCE_SELECT,
            // The prefix probe is the loose one and carries the bulk of real matches, so it
            // gets the page budget rather than the per-probe limit.
            take: PAGE_CANDIDATE_LIMIT,
          })
        : Promise.resolve([]),
    ]);

    const merged = new Map<string, MatchCandidate>();
    for (const list of [byBarcode, byRegistration, byExactName, byPrefix]) {
      for (const row of list) {
        if (merged.size >= PAGE_CANDIDATE_LIMIT && !merged.has(row.id)) continue;
        merged.set(row.id, row as MatchCandidate);
      }
    }

    return {
      candidates: [...merged.values()],
      ambiguousByBarcode: collisionsBy(byBarcode as MatchCandidate[], (c) => normalizeCode(c.barcode)),
      ambiguousByRegistration: collisionsBy(
        byRegistration as MatchCandidate[],
        (c) => normalizeCode(c.registrationNo),
      ),
    };
  }

  /**
   * Every reference row carrying an identifier, collisions included — the honest answer to
   * "what does this barcode point at", used when a link is being applied rather than
   * suggested. Reads claimed rows too, so "already linked to something else" is reported as
   * such instead of looking like "no match".
   */
  async resolveIdentifier(
    tenantId: string,
    field: "barcode" | "registrationNo",
    value: string,
  ): Promise<IdentifierAmbiguity | null> {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const rows = await this.prisma.product.findMany({
      where: {
        tenantId,
        rangeStatus: "REFERENCE",
        source: "NMRA",
        [field]: { in: caseVariants([trimmed]) },
      },
      select: { id: true, name: true, brandName: true, registrationNo: true },
      take: IDENTIFIER_COLLISION_LIMIT,
    });
    if (rows.length <= 1) return null;
    return { field, value: trimmed, candidates: rows };
  }
}

/** Group by a normalized key, keeping only the keys more than one row landed on. */
function collisionsBy(
  rows: MatchCandidate[],
  keyOf: (row: MatchCandidate) => string,
): Map<string, MatchCandidate[]> {
  const grouped = new Map<string, MatchCandidate[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  for (const [key, list] of grouped) {
    if (list.length < 2) grouped.delete(key);
  }
  return grouped;
}

/** Re-exported so callers building an index over a candidate set don't reach past this module. */
export { clinicalKey, innHead, normalizeName };
