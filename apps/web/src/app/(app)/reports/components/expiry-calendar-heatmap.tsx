"use client";

import css from "../reports.module.css";

export type ExpiryCalendarRow = { id: string; label: string; months: Array<{ key: string; label: string; value: number }> };

type Props = {
  /** Already sorted (e.g. descending by total exposure) — the caller owns ranking. */
  rows: ExpiryCalendarRow[];
  formatValue: (n: number) => string;
  onRowClick?: (id: string) => void;
  activeId?: string | null;
};

/** Green → amber → red-orange for a 0..1 exposure position — "low is good" here (unlike the
 *  margin heatmap's teal-is-good scale), so this deliberately uses the app's success green
 *  instead. The hot end is a red-orange blend (#e33f19) rather than pure red, matching the same
 *  endpoint used across the Near Expiry page's other gradients (days-left color, this legend). */
function exposureColor(t: number): string {
  if (t >= 0.5) {
    const local = Math.round(((t - 0.5) / 0.5) * 100);
    return `color-mix(in srgb, #e33f19 ${local}%, #ea580c)`;
  }
  const local = Math.round((t / 0.5) * 100);
  return `color-mix(in srgb, #ea580c ${local}%, #16a34a)`;
}

function exposureBackground(t: number): string {
  const intensity = 32 + Math.abs(t - 0.5) * 2 * 40;
  return `color-mix(in srgb, ${exposureColor(t)} ${Math.round(intensity)}%, var(--pc-card-bg))`;
}

/** Category × month grid of expiring stock value — a heatmap reads "where and when" exposure
 *  concentrates far faster than scanning a flat table across a 6-month horizon. */
export function ExpiryCalendarHeatmap({ rows, formatValue, onRowClick, activeId }: Props) {
  const nonEmpty = rows.filter((r) => r.months.length > 0);
  if (nonEmpty.length === 0) {
    return <p className={css.emptyNote}>No expiring stock in this range yet.</p>;
  }

  const allValues = nonEmpty.flatMap((r) => r.months.map((m) => m.value));
  const min = Math.min(...allValues, 0);
  const max = Math.max(...allValues, 1);
  const span = max - min || 1;
  const monthLabels = nonEmpty.reduce((longest, r) => (r.months.length > longest.length ? r.months.map((m) => m.label) : longest), [] as string[]);

  return (
    <div>
      <div className={css.catHeatWrap}>
        <table className={css.catHeatTable}>
          <thead>
            <tr>
              <th>Category</th>
              {monthLabels.map((label, i) => (
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
                {r.months.map((m, i) => {
                  if (m.value <= 0) {
                    return (
                      <td key={i} className={`${css.catHeatCell} ${css.catHeatCellEmpty}`}>
                        —
                      </td>
                    );
                  }
                  const t = (m.value - min) / span;
                  return (
                    <td key={i} className={css.catHeatCell} style={{ background: exposureBackground(t) }}>
                      {formatValue(m.value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={css.catHeatLegend}>
        <span>Lower exposure</span>
        <span className={css.expCalLegendBar} />
        <span>Higher exposure</span>
      </div>
    </div>
  );
}
