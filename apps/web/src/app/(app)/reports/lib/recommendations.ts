/**
 * Simple, transparent rule-based suggestions — same spirit as the API's existing
 * `analytics/reorder-recommendations` (threshold rules, not a model). Thresholds are
 * documented inline so the "why" is inspectable, not a black box.
 */

export type ExpiryRecommendation = "dispose" | "return_supplier" | "transfer" | "priority_dispense" | "monitor";

const EXPIRY_LABEL: Record<ExpiryRecommendation, string> = {
  dispose: "Dispose / Write-off",
  return_supplier: "Return to Supplier",
  transfer: "Transfer",
  priority_dispense: "Priority Dispense",
  monitor: "Monitor",
};

/**
 * Already past its expiry date — can't be sold, only written off. ≤15 days left is too tight to
 * safely transfer or process a supplier return, so it's flagged for priority dispensing instead —
 * sell/use this stock first (First-Expiry-First-Out), not a price markdown or promotion: medicines
 * aren't marketed or discounted for clearance the way ordinary retail stock is in Sri Lanka, so the
 * actionable response here is an internal dispensing priority, not a promotional action. Beyond
 * that: a batch traceable to a real supplier, worth enough to bother, with enough runway left to
 * actually process a return, is suggested back to that supplier first — a derived heuristic (no
 * confirmed supplier return-policy data exists in this codebase yet), so treat it as an estimate,
 * not a guarantee the supplier will accept the return. Otherwise, stock worth enough to bother
 * moving goes to another branch; everything else is just watched.
 */
export function recommendExpiryAction(
  daysLeft: number,
  valueAtRisk: number,
  hasKnownSupplier: boolean,
): { key: ExpiryRecommendation; label: string } {
  if (daysLeft < 0) return { key: "dispose", label: EXPIRY_LABEL.dispose };
  if (daysLeft <= 15) return { key: "priority_dispense", label: EXPIRY_LABEL.priority_dispense };
  if (hasKnownSupplier && daysLeft <= 45 && valueAtRisk >= 500) return { key: "return_supplier", label: EXPIRY_LABEL.return_supplier };
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
