"use client";

import type { ReactNode } from "react";
import css from "../dashboard.module.css";

export function pctChange(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

export function formatPct(n: number): string {
  return `${Math.abs(n).toFixed(1)}%`;
}

export type MetricTrend = {
  pct: number | null;
  compareLabel: string;
};

export type MetricIconTone = "revenue" | "purchases" | "profit" | "bills" | "avg" | "peak";

/** Icon + label + value + optional up/down trend pill — the summary-row cell
 * shared by Business Overview and Shift Performance so both panels read the
 * same visual language, not just the same panel height. */
export function MetricCell({
  label,
  value,
  icon,
  iconTone,
  trend,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  iconTone: MetricIconTone;
  trend?: MetricTrend;
}) {
  const pct = trend?.pct ?? null;
  const up = pct != null && pct >= 0;
  const down = pct != null && pct < 0;

  return (
    <div className={css.overviewMetric}>
      <span className={`${css.overviewMetricIcon} ${css[`overviewMetricIcon_${iconTone}`]}`} aria-hidden>
        {icon}
      </span>
      <div className={css.overviewMetricCopy}>
        <span className={css.overviewMetricLabel}>{label}</span>
        <span className={css.overviewMetricValue}>{value}</span>
        {pct != null && trend ? (
          <span
            className={`${css.overviewMetricTrend} ${
              up ? css.overviewMetricTrend_up : css.overviewMetricTrend_down
            }`}
          >
            <span aria-hidden>{up ? "↑" : down ? "↓" : ""}</span>
            {formatPct(pct)}
            <span className={css.overviewMetricTrendVs}>{trend.compareLabel}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}
