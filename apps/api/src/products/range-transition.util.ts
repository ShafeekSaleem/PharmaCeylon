/**
 * When a product may leave the pharmacy's range, and what happens to it if it can't.
 *
 * "Move to reference" was previously a plain `rangeStatus = REFERENCE` write on anything
 * selected. That quietly conflated two different things:
 *
 *  - An NMRA row the shop had promoted and no longer stocks. Sending that back to REFERENCE is
 *    right — the register row exists independently of whether this shop sells it.
 *  - A product the shop typed in itself, or imported from its own spreadsheet. Sending *that*
 *    to REFERENCE files a local, unregistered record into the authoritative NMRA reference
 *    catalog, where it then shows up as if the regulator had listed it. The Reference tab is
 *    supposed to answer "what is registered in Sri Lanka"; one careless bulk action and it
 *    starts answering "…plus whatever this shop typed".
 *
 * So range status is no longer a free-form toggle. Only register-derived products can go back
 * to REFERENCE; everything else is deactivated instead, which is the state that actually means
 * "we stopped selling this" — and neither happens at all while the product still has stock,
 * sales or purchasing history that would be orphaned by hiding it.
 *
 * Pure and dependency-free: the service supplies the history counts, this decides.
 */

export type RangeTransitionInput = {
  productId: string;
  name: string;
  /** `Product.source` — NMRA means the row came from the register. */
  source: string;
  rangeStatus: string;
  /** Set when the shop's own product has been linked to a register row. */
  nmraReferenceId: string | null;
  /** On-hand units across every branch. */
  stockOnHand: number;
  /** Any sale line, ever. */
  saleCount: number;
  /** Any purchase-order or goods-receipt line, ever. */
  purchasingCount: number;
};

export type RangeTransitionDecision =
  | { action: "unrange"; reason: string }
  | { action: "deactivate"; reason: string }
  | { action: "blocked"; reason: string };

/**
 * Decide what "stop selling this" should do to one product.
 *
 * Order matters: history is checked first, because a product with stock on the shelf must not
 * vanish from the list the person counting the shelf is looking at, regardless of where it
 * came from.
 */
export function decideRangeExit(input: RangeTransitionInput): RangeTransitionDecision {
  if (input.rangeStatus !== "RANGED") {
    return {
      action: "blocked",
      reason: `"${input.name}" is not in your range, so there is nothing to remove.`,
    };
  }

  if (input.stockOnHand > 0) {
    return {
      action: "blocked",
      reason: `"${input.name}" still has ${input.stockOnHand.toLocaleString()} unit${
        input.stockOnHand === 1 ? "" : "s"
      } on hand. Clear or write off the stock first — hiding it would leave units nobody can find.`,
    };
  }

  // Sales and purchasing history don't block deactivation — a discontinued line keeps its
  // history and that is the point of `isActive`. They block only the move to REFERENCE, where
  // the product leaves the shop's own list entirely.
  const hasHistory = input.saleCount > 0 || input.purchasingCount > 0;

  const isRegisterDerived = input.source === "NMRA" || input.nmraReferenceId !== null;

  if (!isRegisterDerived) {
    return {
      action: "deactivate",
      reason:
        `"${input.name}" was created here rather than taken from the NMRA register, so it is ` +
        "marked inactive instead of moved to the reference catalog — the reference catalog is " +
        "the register, and local records don't belong in it.",
    };
  }

  if (hasHistory) {
    return {
      action: "deactivate",
      reason:
        `"${input.name}" has sales or purchasing history, so it is marked inactive rather than ` +
        "moved to the reference catalog — reporting needs the record to stay in your range.",
    };
  }

  return {
    action: "unrange",
    reason: `"${input.name}" came from the NMRA register and has no history — moved back to the reference catalog.`,
  };
}

/**
 * Whether an NMRA reference row can be promoted into the shop's range, and what the operator
 * should be shown first.
 *
 * The lightweight review exists because promotion is not always additive: if the shop already
 * has a product carrying the same barcode or registration number, adding the register row
 * creates a second record for one real product, and every stock count from then on is split
 * across the two.
 */
export type ReferencePromotionInput = {
  referenceProductId: string;
  name: string;
  rangeStatus: string;
  source: string;
  /** A shop product already claiming this register row. */
  claimedByProductId: string | null;
  /** Shop products sharing this row's barcode or registration number. */
  duplicateCandidates: Array<{ id: string; name: string; matchedOn: "barcode" | "registrationNo" }>;
  /** Applying would change a compliance flag on an existing product it would merge with. */
  complianceChange: boolean;
};

export type ReferencePromotionDecision = {
  allowed: boolean;
  /** True when the operator should confirm before this is applied. */
  needsReview: boolean;
  reason: string | null;
  warnings: string[];
};

export function decideReferencePromotion(
  input: ReferencePromotionInput,
): ReferencePromotionDecision {
  if (input.rangeStatus === "RANGED") {
    return {
      allowed: false,
      needsReview: false,
      reason: `"${input.name}" is already in your products.`,
      warnings: [],
    };
  }
  if (input.source !== "NMRA") {
    return {
      allowed: false,
      needsReview: false,
      reason: `"${input.name}" is not an NMRA register entry.`,
      warnings: [],
    };
  }
  if (input.claimedByProductId) {
    return {
      allowed: false,
      needsReview: false,
      reason: `"${input.name}" is already linked to one of your products.`,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  for (const dup of input.duplicateCandidates) {
    const on = dup.matchedOn === "barcode" ? "barcode" : "registration number";
    warnings.push(
      `You already sell "${dup.name}", which has the same ${on}. Adding this would create a ` +
        "second record for one product — link them instead if they are the same thing.",
    );
  }
  if (input.complianceChange) {
    warnings.push(
      "This entry's controlled or prescription-only status differs from the product it would " +
        "merge with. Check which is right before applying.",
    );
  }

  return {
    allowed: true,
    needsReview: warnings.length > 0,
    reason: null,
    warnings,
  };
}
