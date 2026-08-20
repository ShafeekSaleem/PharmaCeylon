"use client";

import css from "../reports.module.css";

type Props = { valueLabel: string; pct: number; danger?: boolean };

/** A thin bar beside a table-cell value — used where a row's magnitude relative to the page's max is worth a glance (Margin's Gross Profit, Dead Stock's Value Tied Up). */
export function InlineBarCell({ valueLabel, pct, danger = false }: Props) {
  return (
    <div className={css.inlineBarCell}>
      <div className={css.inlineBarTrack}>
        <div className={`${css.inlineBarFill}${danger ? ` ${css.inlineBarFillDanger}` : ""}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span>{valueLabel}</span>
    </div>
  );
}
