/**
 * Cycling donut palette for the Category Sales mix chart. Unlike payment methods (a fixed,
 * small set of known keys — see `dashboard/lib/payment-mix-colors.ts`), categories are
 * tenant-defined and effectively unbounded, so slices are colored by *position* (already
 * sorted by revenue, so the biggest slices get the most distinct hues) rather than by name.
 *
 * Every color here is either a theme variable or one of this app's own established semantic
 * tones (the same purple/warning/danger hex `reports.module.css`'s `.actionIconSq` tone
 * classes use for "Category Insights"), so the chart reads as part of the same design system
 * instead of an arbitrary rainbow — same principle as `branch-colors.ts`.
 */
const CATEGORY_MIX_PALETTE = [
  "var(--pc-primary)",
  "var(--pc-secondary-cyan)",
  "var(--pc-accent-navy)",
  "#7c3aed", // purple — matches the "Highest Margin" insight tone
  "#ea580c", // orange — matches the "Opportunity"/warning insight tone
  "#dc2626", // red — matches the "At Risk"/danger insight tone
  "color-mix(in srgb, var(--pc-secondary-cyan) 55%, var(--pc-muted-fg))",
  "color-mix(in srgb, var(--pc-accent-navy) 50%, var(--pc-primary))",
];

export const CATEGORY_MIX_OTHERS_COLOR = "var(--pc-muted-fg)";

export function categoryMixColor(index: number): string {
  return CATEGORY_MIX_PALETTE[index % CATEGORY_MIX_PALETTE.length]!;
}

/**
 * Tints a parent department's own donut color for its child-breakdown bar, so the breakdown
 * visually reads as "part of that slice" instead of introducing an unrelated second palette.
 * Mixes toward `--pc-card-bg` (not a fixed white/black) so the tints stay correctly contrasted
 * in both light and dark themes — the first child stays close to the full parent color, later
 * ones recede toward the card surface.
 */
export function categoryChildColor(baseColor: string, indexAmongSiblings: number, totalSiblings: number): string {
  if (totalSiblings <= 1) return baseColor;
  const t = indexAmongSiblings / (totalSiblings - 1);
  const mixPct = Math.round(92 - t * 52); // 92% → 40% of the base color
  return `color-mix(in srgb, ${baseColor} ${mixPct}%, var(--pc-card-bg))`;
}
