"use client";

import css from "../reports.module.css";

/** `value: null` means no sales in that entity's week — distinct from an actual 0-valued week,
 *  and must never be colored as if it were the worst cell in the grid. */
export type WeekHeatmapRow = { id: string; label: string; weeks: Array<{ date: string; label: string; value: number | null }> };

type Props = {
  /** Already sorted (e.g. descending by overall revenue/margin) — the caller owns ranking. */
  rows: WeekHeatmapRow[];
  onRowClick?: (id: string) => void;
  activeId?: string | null;
  /** Header for the row-label column — this component is generic enough to be reused for any
   *  entity × week grid (Category Profitability, Branch Profitability, Category Sales' growth
   *  heatmap), not just categories or margin specifically. */
  rowHeader?: string;
  /** How to render a cell's raw value — defaults to a 1-decimal percentage (margin %, growth %). */
  formatValue?: (n: number) => string;
  legendLowLabel?: string;
  legendHighLabel?: string;
};

/** Theme-consistent 3-stop heat color (teal → orange → red-orange) for a 0..1 position, reusing
 *  the same accent pair (`#ea580c`/`#e33f19`) this report suite already uses for its danger
 *  gradient, anchored at the primary teal for the strong end instead of an arbitrary green/red
 *  scale. The hot end is a red-orange blend rather than pure red, matching Near Expiry's gradients. */
function heatColor(t: number): string {
  if (t >= 0.5) {
    const local = Math.round(((t - 0.5) / 0.5) * 100);
    return `color-mix(in srgb, var(--pc-primary) ${local}%, #ea580c)`;
  }
  const local = Math.round((t / 0.5) * 100);
  return `color-mix(in srgb, #ea580c ${local}%, #e33f19)`;
}

/** Blends the hue with the card surface — intensity scales with distance from the midpoint so
 *  outlier weeks (well above or below the pack) pop, while near-average cells stay a calmer
 *  tint instead of the whole grid reading as one flat wash of color. */
function heatCellBackground(t: number): string {
  const intensity = 34 + Math.abs(t - 0.5) * 2 * 38; // 34%..72%
  return `color-mix(in srgb, ${heatColor(t)} ${Math.round(intensity)}%, var(--pc-card-bg))`;
}

/** Week-by-entity value grid (margin %, growth %, ...), each cell tinted by its value relative to
 *  the data's own min/max — a heatmap scales to many more rows at once than a multi-line chart can
 *  read. Generic over what the value actually represents; callers own the metric and its labels. */
export function EntityWeekHeatmap({
  rows,
  onRowClick,
  activeId,
  rowHeader = "Category",
  formatValue = (n) => `${n.toFixed(1)}%`,
  legendLowLabel = "Lower",
  legendHighLabel = "Higher",
}: Props) {
  const nonEmpty = rows.filter((r) => r.weeks.length > 0);
  if (nonEmpty.length === 0) {
    return <p className={css.emptyNote}>No trend data for this range yet.</p>;
  }

  const allValues = nonEmpty.flatMap((r) => r.weeks.map((w) => w.value)).filter((v): v is number => v != null);
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 1);
  const span = max - min || 1;
  const weekLabels = nonEmpty.reduce((longest, r) => (r.weeks.length > longest.length ? r.weeks.map((w) => w.label) : longest), [] as string[]);

  return (
    <div>
      <div className={css.catHeatWrap}>
        <table className={css.catHeatTable}>
          <thead>
            <tr>
              <th>{rowHeader}</th>
              {weekLabels.map((label, i) => (
                <th key={i}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nonEmpty.map((r) => (
              <tr key={r.id}>
                <td className={css.catHeatRowLabel}>
                  {onRowClick ? (
                    <button type="button" className={activeId === r.id ? css.benchmarkLabelActive : undefined} onClick={() => onRowClick(r.id)}>
                      {r.label}
                    </button>
                  ) : (
                    r.label
                  )}
                </td>
                {r.weeks.map((w, i) => {
                  if (w.value == null) {
                    return (
                      <td key={i} className={`${css.catHeatCell} ${css.catHeatCellEmpty}`}>
                        No sales
                      </td>
                    );
                  }
                  const t = (w.value - min) / span;
                  return (
                    <td key={i} className={css.catHeatCell} style={{ background: heatCellBackground(t) }}>
                      {formatValue(w.value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={css.catHeatLegend}>
        <span>{legendLowLabel}</span>
        <span className={css.catHeatLegendBar} />
        <span>{legendHighLabel}</span>
      </div>
    </div>
  );
}
