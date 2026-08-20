"use client";

import { IconCalendar } from "@/components/icons";
import { formatMoney } from "../lib/format";
import css from "../reports.module.css";

export type AgeBucket = { key: string; label: string; count: number; value: number };

export function AgeingCards({ buckets, totalValue }: { buckets: AgeBucket[]; totalValue: number }) {
  return (
    <div className={css.ageingGrid}>
      {buckets.map((b, i) => (
        <div key={b.key} className={`${css.ageingCard} ${css[`tint${Math.min(i, 2)}`]}`}>
          <div className={css.ageingLeft}>
            <IconCalendar size={14} />
            <span className={css.ageingRange}>{b.label}</span>
          </div>
          <div className={css.ageingRight}>
            <div className={css.ageingValue}>{formatMoney(b.value)}</div>
            <div className={css.ageingPct}>{totalValue > 0 ? ((b.value / totalValue) * 100).toFixed(1) : "0.0"}%</div>
          </div>
        </div>
      ))}
      <div className={css.ageingTotalCard}>
        <span className={css.ageingTotalLabel}>Total</span>
        <span className={css.ageingTotalValue}>{formatMoney(totalValue)}</span>
      </div>
    </div>
  );
}
