import type { CatalogTaskStatus, CatalogTaskType } from "@prisma/client";

/**
 * Which catalog tasks may be applied in bulk without a person reading them.
 *
 * The button this feeds used to say "Accept all top matches", which did exactly that — it took
 * whatever the matcher ranked first, including matches resting on a fuzzy substance-and-strength
 * guess, and including matches that would flip a product to controlled or prescription-only.
 * One click could silently make forty products dispensable without a prescription, or block
 * forty legitimate sales. The replacement is "Apply safe changes", and this is the definition
 * of safe: a small, explicit, testable set of conditions, every one of which must hold.
 *
 * Pure and dependency-free so the count on the button and the set the endpoint actually applies
 * come from the same rule rather than two implementations that drift.
 */

/** Evidence tiers that identify a product outright rather than resembling one. */
const EXACT_IDENTIFIER_EVIDENCE = ["barcode", "registration", "name"];

/**
 * A category suggestion has to be at least this confident to apply unattended.
 *
 * Set above the classifier's keyword tiers (0.7 for a product-type keyword, 0.6 for a
 * display-name match) and below its strongest (0.85, a substance keyword on the generic name).
 * Running it over a real catalog is what settled the number: at 0.7, "Gaviscon Double Action"
 * would have been auto-filed under Vitamins & Supplements › Minerals, because its generic name
 * contains "calcium". It is an antacid. The suggestion is still worth showing — it is just not
 * worth applying to forty products without anyone reading it.
 */
export const SAFE_CATEGORY_CONFIDENCE = 0.8;

export type TaskSafetyInput = {
  type: CatalogTaskType;
  /** Matcher tier for NMRA tasks, rule name for category tasks. Null when nothing was found. */
  evidence: string | null;
  confidence: number | null;
  /** Applying this would change `isControlled` or `requiresPrescription`. */
  complianceImpact: boolean;
  /** The identifier that produced the match points at more than one register row. */
  identifierAmbiguous: boolean;
  /** How many candidates the match resolved to. Anything but exactly one is a decision. */
  candidateCount: number;
  /** The product already carries a register link — re-linking is never automatic. */
  alreadyLinked: boolean;
  /** The proposed register row is already claimed by a different shop product. */
  referenceClaimed: boolean;
};

export type TaskSafety = {
  safeToApply: boolean;
  status: Extract<CatalogTaskStatus, "OPEN" | "NEEDS_REVIEW">;
  /** Why it is not safe, in the order the conditions were checked. Empty when it is. */
  blockers: string[];
};

/**
 * Classify one task. `NEEDS_REVIEW` is reserved for tasks a person must look at individually —
 * compliance changes and ambiguity — rather than merely "not safe enough for bulk": a
 * low-confidence category suggestion is ordinary `OPEN` work, not a review.
 */
export function classifyTaskSafety(input: TaskSafetyInput): TaskSafety {
  const blockers: string[] = [];
  let needsReview = false;

  if (input.identifierAmbiguous || input.type === "NMRA_AMBIGUOUS") {
    blockers.push("The identifier matches more than one register entry.");
    needsReview = true;
  }
  if (input.complianceImpact) {
    blockers.push(
      "Would change a compliance flag (controlled or prescription-only).",
    );
    needsReview = true;
  }
  if (input.type === "IMPORT_DUPLICATE") {
    blockers.push("An imported row collided with an existing product.");
    needsReview = true;
  }

  if (input.candidateCount === 0 && input.type !== "MISSING_CATEGORY") {
    blockers.push("No candidate found.");
  }
  if (input.candidateCount > 1) {
    blockers.push(
      "More than one candidate — the right one is a judgement call.",
    );
  }
  if (input.alreadyLinked) {
    blockers.push("Already linked to a register entry.");
  }
  if (input.referenceClaimed) {
    blockers.push("That register entry is already linked to another product.");
  }

  if (input.type === "NMRA_MATCH") {
    if (!input.evidence) {
      blockers.push("No evidence recorded.");
    } else if (!EXACT_IDENTIFIER_EVIDENCE.includes(input.evidence)) {
      blockers.push(
        "Evidence is a resemblance (similar name or substance), not an exact identifier.",
      );
    }
  }

  if (input.type === "MISSING_CATEGORY") {
    if (!input.evidence) {
      blockers.push("No category could be suggested.");
    } else if ((input.confidence ?? 0) < SAFE_CATEGORY_CONFIDENCE) {
      blockers.push(
        `Suggestion confidence ${Math.round((input.confidence ?? 0) * 100)}% is below the ${Math.round(
          SAFE_CATEGORY_CONFIDENCE * 100,
        )}% bar for applying unattended.`,
      );
    }
  }

  return {
    safeToApply: blockers.length === 0,
    status: needsReview ? "NEEDS_REVIEW" : "OPEN",
    blockers,
  };
}
