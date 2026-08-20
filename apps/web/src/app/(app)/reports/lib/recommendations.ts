/**
 * Simple, transparent rule-based suggestions — same spirit as the API's existing
 * `analytics/reorder-recommendations` (threshold rules, not a model). Thresholds are
 * documented inline so the "why" is inspectable, not a black box.
 */

export type ExpiryRecommendation = "dispose" | "transfer" | "discount" | "monitor";

const EXPIRY_LABEL: Record<ExpiryRecommendation, string> = {
  dispose: "Dispose / Write-off",
  transfer: "Transfer",
  discount: "Discount / Promote",
  monitor: "Monitor",
};

/** Already past its expiry date — can't be sold or promoted, only written off. ≤15 days left
 * is too tight to safely transfer — clear it locally. Beyond that, stock worth enough to bother
 * moving goes to another branch; everything else is just watched. */
export function recommendExpiryAction(daysLeft: number, valueAtRisk: number): { key: ExpiryRecommendation; label: string } {
  if (daysLeft < 0) return { key: "dispose", label: EXPIRY_LABEL.dispose };
  if (daysLeft <= 15) return { key: "discount", label: EXPIRY_LABEL.discount };
  if (daysLeft <= 45 && valueAtRisk >= 300) return { key: "transfer", label: EXPIRY_LABEL.transfer };
  return { key: "monitor", label: EXPIRY_LABEL.monitor };
}

export type DeadStockAction = "transfer" | "markdown" | "discontinue";

const DEAD_LABEL: Record<DeadStockAction, string> = {
  transfer: "Transfer",
  markdown: "Markdown",
  discontinue: "Discontinue",
};

/** Never sold at all → question whether to keep reordering it. Very long idle → clear it
 * where it sits. Everything else still has a shot at selling somewhere else first. */
export function recommendDeadStockAction(
  daysSinceLastSale: number | null,
  window: number,
): { key: DeadStockAction; label: string } {
  if (daysSinceLastSale == null) return { key: "discontinue", label: DEAD_LABEL.discontinue };
  if (daysSinceLastSale >= window * 2) return { key: "markdown", label: DEAD_LABEL.markdown };
  return { key: "transfer", label: DEAD_LABEL.transfer };
}
