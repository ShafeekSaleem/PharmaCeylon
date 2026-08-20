"use client";

import type { ReactNode } from "react";
import { formatMoney } from "../lib/format";
import css from "../reports.module.css";

export type ShiftMetric = "revenue" | "transactions" | "avgBasket" | "revenuePerCashier";

export type ShiftIconTone = "amber" | "green" | "indigo";

export type ShiftDatum = {
  key: string;
  label: string;
  icon: ReactNode;
  iconTone: ShiftIconTone;
  sharePct: number;
  revenue: number;
  transactions: number;
  avgBasket: number;
  revenuePerCashier: number;
  isBest?: boolean;
};

const METRIC_OPTIONS: { key: ShiftMetric; label: string }[] = [
  { key: "revenue", label: "Revenue" },
  { key: "transactions", label: "Transactions" },
  { key: "avgBasket", label: "Avg Basket" },
  { key: "revenuePerCashier", label: "Revenue / Cashier" },
];

function metricValue(s: ShiftDatum, metric: ShiftMetric): number {
  switch (metric) {
    case "revenue":
      return s.revenue;
    case "transactions":
      return s.transactions;
    case "avgBasket":
      return s.avgBasket;
    case "revenuePerCashier":
      return s.revenuePerCashier;
  }
}

type Props = {
  id?: string;
  shifts: ShiftDatum[];
  metric: ShiftMetric;
  onMetricChange: (m: ShiftMetric) => void;
  footer?: ReactNode;
};

function ShiftMetricCell({ label, value, isPrimary, barPct }: { label: string; value: string; isPrimary: boolean; barPct: number }) {
  return (
    <div className={css.shiftMetricCell}>
      <span className={css.shiftMetricLabel}>{label}</span>
      <span className={isPrimary ? css.shiftMetricValuePrimary : css.shiftMetricValue}>{value}</span>
      {isPrimary ? (
        <div className={css.shiftMetricBarTrack}>
          <div className={css.shiftMetricBarFill} style={{ width: `${Math.min(100, Math.max(0, barPct))}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Cashier productivity by shift, one bordered row per shift (not a plain table) — a "View by"
 * toggle picks which of the four metrics drives the comparison bar; all four stay visible as text
 * regardless, only the emphasized/bar column changes. */
export function ShiftPerformanceCard({ id, shifts, metric, onMetricChange, footer }: Props) {
  const maxValue = Math.max(...shifts.map((s) => metricValue(s, metric)), 1);

  return (
    <div className={css.card} id={id}>
      <div className={css.cardhead}>
        <div>
          <h3>Shift Performance</h3>
          <p>Compare cashier productivity by shift</p>
        </div>
        <div className={css.shiftViewBy}>
          <span>View by</span>
          <div className={css.segmented}>
            {METRIC_OPTIONS.map((o) => (
              <button key={o.key} type="button" className={metric === o.key ? css.on : undefined} onClick={() => onMetricChange(o.key)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={css.shiftList}>
        {shifts.map((s) => (
          <div key={s.key} className={`${css.shiftRow} ${s.isBest ? css.shiftRowBest : ""}`}>
            <div className={css.shiftInfo}>
              <span className={`${css.shiftIconWrap} ${css[s.iconTone]}`}>{s.icon}</span>
              <div className={css.shiftInfoText}>
                <div className={css.shiftLabelRow}>
                  <span className={css.shiftLabel}>{s.label}</span>
                  {s.isBest ? <span className={css.shiftBestBadge}>★ Best shift</span> : null}
                </div>
                <span className={css.shiftShare}>{s.sharePct.toFixed(0)}% of sales</span>
              </div>
            </div>

            <div className={css.shiftMetrics}>
              <ShiftMetricCell label="Revenue" value={formatMoney(s.revenue)} isPrimary={metric === "revenue"} barPct={(s.revenue / maxValue) * 100} />
              <ShiftMetricCell label="Transactions" value={s.transactions.toLocaleString("en-IN")} isPrimary={metric === "transactions"} barPct={(s.transactions / maxValue) * 100} />
              <ShiftMetricCell label="Avg Basket" value={formatMoney(s.avgBasket)} isPrimary={metric === "avgBasket"} barPct={(s.avgBasket / maxValue) * 100} />
              <ShiftMetricCell label="Revenue / Cashier" value={formatMoney(s.revenuePerCashier)} isPrimary={metric === "revenuePerCashier"} barPct={(s.revenuePerCashier / maxValue) * 100} />
            </div>
          </div>
        ))}
      </div>

      {footer}
    </div>
  );
}
