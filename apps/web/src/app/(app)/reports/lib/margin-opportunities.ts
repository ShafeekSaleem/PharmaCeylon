/** Shared "why is this product/SKU low margin, and what should the pharmacy do about it" logic —
 *  used by both Margin by Product's "Margin Opportunities" panel and Low-Margin Products' own
 *  "Recommended Actions" panel + table, so the two pages never silently diverge on what counts as
 *  a pricing problem vs. a supplier-cost problem vs. a slow-moving-stock problem. */

export type MarginOpportunityRow = {
  productId: string;
  categoryId: string | null;
  revenueN: number;
  costN: number;
  marginPct: number;
  unitsSold: number;
  stockOnHand: number;
};

/** Meaningful stock (≥10 units) that would take 20+ periods to sell through at the current pace
 *  — the same signal Product Sales already uses for its own "slow movers" insight. */
export function isSlowMover(r: { stockOnHand: number; unitsSold: number }): boolean {
  return r.stockOnHand >= 10 && r.stockOnHand / Math.max(1, r.unitsSold) >= 20;
}

/** Healthy-margin band colors — this codebase's existing convention (see `marginTier()`), not a
 *  screenshot value. */
export function marginBandColor(pct: number, healthyPct = 35, watchPct = 20): string {
  if (pct >= healthyPct) return "#16a34a";
  if (pct >= watchPct) return "var(--pc-primary)";
  return "#dc2626";
}

/**
 * Splits every product below `thresholdPct` margin into one of three action buckets:
 * - `stockReview`: also a slow mover — capital tied up regardless of pricing.
 * - `supplierNegotiation`: its own COGS ratio sits notably above its category's blended COGS
 *   ratio (`supplierGap`, default 8pp) — the likely lever is purchase price, not selling price.
 * - `pricingReview`: everything else below threshold — COGS is in line with category peers, so
 *   the selling price itself is the likely lever.
 *
 * The category benchmark is computed from `allRows` (the full product set), not just the
 * below-threshold subset, so a category with only low-margin products doesn't get a benchmark
 * dragged down to match them.
 */
export function classifyMarginOpportunities<T extends MarginOpportunityRow>(
  allRows: T[],
  thresholdPct: number,
  supplierGap = 0.08,
): { pricingReview: T[]; supplierNegotiation: T[]; stockReview: T[] } {
  const byCategory = new Map<string, { revenue: number; cost: number }>();
  for (const r of allRows) {
    const key = r.categoryId ?? "uncategorized";
    const cur = byCategory.get(key) ?? { revenue: 0, cost: 0 };
    cur.revenue += r.revenueN;
    cur.cost += r.costN;
    byCategory.set(key, cur);
  }
  const categoryCostRatio = new Map<string, number>();
  for (const [key, v] of byCategory) categoryCostRatio.set(key, v.revenue > 0 ? v.cost / v.revenue : 0);

  const belowThreshold = allRows.filter((r) => r.marginPct < thresholdPct && r.revenueN > 0);
  const stockReview = belowThreshold.filter(isSlowMover).sort((a, b) => b.stockOnHand - a.stockOnHand);
  const nonStock = belowThreshold.filter((r) => !isSlowMover(r));

  const supplierNegotiation: T[] = [];
  const pricingReview: T[] = [];
  for (const r of nonStock) {
    const ratio = r.revenueN > 0 ? r.costN / r.revenueN : 0;
    const benchmark = categoryCostRatio.get(r.categoryId ?? "uncategorized") ?? ratio;
    if (ratio - benchmark > supplierGap) supplierNegotiation.push(r);
    else pricingReview.push(r);
  }
  supplierNegotiation.sort((a, b) => b.revenueN - a.revenueN);
  pricingReview.sort((a, b) => b.revenueN * (thresholdPct - b.marginPct) - a.revenueN * (thresholdPct - a.marginPct));

  return { pricingReview, supplierNegotiation, stockReview };
}
