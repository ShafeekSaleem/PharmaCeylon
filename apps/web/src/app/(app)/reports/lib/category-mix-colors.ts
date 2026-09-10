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
  "var(--pc-tone-violet)", // purple — matches the "Highest Margin" insight tone
  "var(--pc-tone-orange)", // orange — matches the "Opportunity"/warning insight tone
  "var(--pc-tone-danger)", // red — matches the "At Risk"/danger insight tone
  "color-mix(in srgb, var(--pc-secondary-cyan) 55%, var(--pc-muted-fg))",
  "color-mix(in srgb, var(--pc-accent-navy) 50%, var(--pc-primary))",
  // Extra blends so a 13-way breakdown (e.g. Near Expiry's Medicines sub-categories) still gets
  // a distinct color per entry instead of repeating from index 8 onward.
  "color-mix(in srgb, var(--pc-tone-violet) 55%, var(--pc-primary))",
  "color-mix(in srgb, var(--pc-tone-orange) 55%, var(--pc-accent-navy))",
  "color-mix(in srgb, var(--pc-tone-danger) 45%, var(--pc-secondary-cyan))",
  "color-mix(in srgb, var(--pc-primary) 45%, var(--pc-tone-violet))",
  "color-mix(in srgb, var(--pc-accent-navy) 45%, var(--pc-tone-danger))",
];

export const CATEGORY_MIX_OTHERS_COLOR = "var(--pc-muted-fg)";

export function categoryMixColor(index: number): string {
  return CATEGORY_MIX_PALETTE[index % CATEGORY_MIX_PALETTE.length]!;
}

/**
 * Deliberately narrow, theme-aligned palette for the Stock Value treemap — unlike
 * `categoryMixColor`'s full categorical rainbow (used where every slice needs a maximally
 * distinct hue, e.g. a donut legend), a treemap's tiles are large filled areas, so a "calmer"
 * single-family progression (teal → cyan → green) reads as one cohesive surface instead of a
 * loud multi-color chart. Deliberately excludes red/navy-blue/dark-orange (this app's
 * warning/danger/alert hues elsewhere) so a big teal or cyan tile is never mistaken for a risk
 * signal. Kept dark enough (not tinted all the way to pastel) for white tile text to stay
 * legible — see `.treemapTileContent` — mixing further toward white drops contrast below a
 * readable level for these particular hues (they're lighter than e.g. navy or red to begin with).
 */
const TREEMAP_TONE_PALETTE = [
  "color-mix(in srgb, var(--pc-primary) 92%, #fff)",
  "color-mix(in srgb, var(--pc-secondary-cyan) 88%, #fff)",
  "color-mix(in srgb, var(--pc-tone-success) 85%, #fff)",
  "color-mix(in srgb, var(--pc-primary) 70%, #fff)",
  "color-mix(in srgb, var(--pc-secondary-cyan) 68%, #fff)",
  "color-mix(in srgb, var(--pc-tone-success) 65%, #fff)",
];

export function categoryMixColorLight(index: number): string {
  return TREEMAP_TONE_PALETTE[index % TREEMAP_TONE_PALETTE.length]!;
}

export const CATEGORY_MIX_OTHERS_COLOR_LIGHT = "color-mix(in srgb, var(--pc-muted-fg) 78%, #fff)";

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
