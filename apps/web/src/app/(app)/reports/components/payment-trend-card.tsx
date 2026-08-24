"use client";

import { IconInfo } from "@/components/icons";
import { MultiLineChart, type MultiLineSeries } from "./multi-line-chart";
import type { ChartGranularity } from "../lib/chart-bucketing";
import { formatMoney } from "../lib/format";
import css from "../reports.module.css";

type Props = {
  labels: string[];
  series: MultiLineSeries[];
  granularity: ChartGranularity;
  onGranularityChange: (g: ChartGranularity) => void;
};

const GRANULARITY_LABEL: Record<ChartGranularity, string> = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** Payment Trend answers "how is usage of each method changing over time" — the page's one primary
 * mix visualization (a revenue-distribution donut was removed as redundant with this trend chart
 * plus the KPI row's own Cash/Card/Digital Share tiles); operational health lives in the
 * comparison table below. */
export function PaymentTrendCard({ labels, series, granularity, onGranularityChange }: Props) {
  return (
    <div className={css.card}>
      <div className={css.cardhead}>
        <div>
          <h3>
            Payment Trend{" "}
            <span className={css.oppInfoIcon} data-tooltip="How usage of each payment method is changing over time.">
              <IconInfo size={13} />
            </span>
          </h3>
        </div>
        <div className={css.segmented}>
          {(Object.keys(GRANULARITY_LABEL) as ChartGranularity[]).map((g) => (
            <button key={g} type="button" className={granularity === g ? css.on : undefined} onClick={() => onGranularityChange(g)}>
              {GRANULARITY_LABEL[g]}
            </button>
          ))}
        </div>
      </div>
      <div className={css.chartTopOffset}>
        <MultiLineChart labels={labels} series={series} tooltipFormat={formatMoney} />
      </div>
    </div>
  );
}
