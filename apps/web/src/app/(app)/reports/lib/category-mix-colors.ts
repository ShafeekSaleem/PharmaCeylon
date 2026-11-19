/**
 * Cycling donut palette for the Category Sales mix chart. Unlike payment methods (a fixed,
 * small set of known keys — see `dashboard/lib/payment-mix-colors.ts`), categories are
 * tenant-defined and effectively unbounded, so slices are colored by *position* (already
 * sorted by revenue, so the biggest slices get the most distinct hues) rather than by name.
 *
 * The first six are the pharmacy's chart series (UI1 #205: accent family or the distinct set,
 * as the owner chose), then blends of them, so the chart follows the brand like
 * `branch-colors.ts`.
 */
const CATEGORY_MIX_PALETTE = [
  "var(--pc-chart-1)",
  "var(--pc-chart-2)",
  "var(--pc-chart-3)",
  "var(--pc-chart-4)",
  "var(--pc-chart-5)",
  "var(--pc-chart-6)",
  // Blends of the series so a 13-way breakdown (e.g. Near Expiry's Medicines sub-categories)
  // still gets a distinct colour per entry instead of repeating from index 7 onward.
  "color-mix(in srgb, var(--pc-chart-1) 50%, var(--pc-chart-3))",
  "color-mix(in srgb, var(--pc-chart-2) 50%, var(--pc-chart-4))",
  "color-mix(in srgb, var(--pc-chart-3) 50%, var(--pc-chart-5))",
  "color-mix(in srgb, var(--pc-chart-4) 50%, var(--pc-chart-1))",
  "color-mix(in srgb, var(--pc-chart-5) 50%, var(--pc-chart-2))",
  "color-mix(in srgb, var(--pc-chart-2) 50%, var(--pc-chart-6))",
  "color-mix(in srgb, var(--pc-chart-1) 50%, var(--pc-chart-6))",
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
  "color-mix(in srgb, var(--pc-chart-1) 92%, #fff)",
  "color-mix(in srgb, var(--pc-chart-2) 88%, #fff)",
  "color-mix(in srgb, var(--pc-chart-3) 85%, #fff)",
  "color-mix(in srgb, var(--pc-chart-1) 70%, #fff)",
  "color-mix(in srgb, var(--pc-chart-2) 68%, #fff)",
  "color-mix(in srgb, var(--pc-chart-3) 65%, #fff)",
];

export function categoryMixColorLight(index: number): string {
  return TREEMAP_TONE_PALETTE[index % TREEMAP_TONE_PALETTE.length]!;
}

export const CATEGORY_MIX_OTHERS_COLOR_LIGHT =
  "color-mix(in srgb, var(--pc-muted-fg) 78%, #fff)";

/**
 * Tints a parent department's own donut color for its child-breakdown bar, so the breakdown
 * visually reads as "part of that slice" instead of introducing an unrelated second palette.
 * Mixes toward `--pc-card-bg` (not a fixed white/black) so the tints stay correctly contrasted
 * in both light and dark themes — the first child stays close to the full parent color, later
 * ones recede toward the card surface.
 */
export function categoryChildColor(
  baseColor: string,
  indexAmongSiblings: number,
  totalSiblings: number,
): string {
  if (totalSiblings <= 1) return baseColor;
  const t = indexAmongSiblings / (totalSiblings - 1);
  const mixPct = Math.round(92 - t * 52); // 92% → 40% of the base color
  return `color-mix(in srgb, ${baseColor} ${mixPct}%, var(--pc-card-bg))`;
}
