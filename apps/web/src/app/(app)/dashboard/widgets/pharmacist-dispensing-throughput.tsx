"use client";

import { IconPackage, IconPill, IconStethoscope } from "@/components/icons";
import { DashboardPanel } from "../components/dashboard-panel";
import { MetricCell, pctChange } from "../components/metric-cell";
import { SimpleBarChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function PharmacistDispensingThroughputWidget({ data }: { data: DashboardData }) {
  const {
    loading,
    hourlyUnitsToday,
    dispensedToday,
    dispensedYesterday,
    dispensedTrendPct,
    todaySalesCount,
    yesterdaySalesCount,
  } = data;

  const peakHour = hourlyUnitsToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyUnitsToday[0] ?? { label: "—", value: 0 },
  );
  const avgUnitsPerRx = todaySalesCount > 0 ? dispensedToday / todaySalesCount : 0;
  const avgUnitsPerRxYesterday =
    yesterdaySalesCount > 0 ? dispensedYesterday / yesterdaySalesCount : 0;
  const avgPerRxTrendPct =
    yesterdaySalesCount > 0 ? pctChange(avgUnitsPerRx, avgUnitsPerRxYesterday) : null;

  return (
    <DashboardPanel
      title="Dispensing Throughput (Today)"
      compact
      footerHref="/pos"
      footerLabel="Open POS →"
      footerMeta={peakHour.value > 0 ? `Peak hour: ${peakHour.label}` : undefined}
    >
      <SimpleBarChart points={hourlyUnitsToday} height={140} />
      <div className={css.overviewChartsSummary} style={{ marginTop: "0.5rem" }}>
        <MetricCell
          label="Total dispensed"
          value={loading ? "…" : `${dispensedToday.toLocaleString()} units`}
          icon={<IconPackage size={16} strokeWidth={1.75} />}
          iconTone="bills"
          trend={dispensedTrendPct != null ? { pct: dispensedTrendPct, compareLabel: "vs Yesterday" } : undefined}
        />
        <MetricCell
          label="Avg per Rx"
          value={loading ? "…" : `${avgUnitsPerRx.toFixed(1)} units`}
          icon={<IconPill size={16} strokeWidth={1.75} />}
          iconTone="avg"
          trend={avgPerRxTrendPct != null ? { pct: avgPerRxTrendPct, compareLabel: "vs Yesterday" } : undefined}
        />
        <MetricCell
          label="Peak hour"
          value={loading ? "…" : peakHour.value > 0 ? `${peakHour.label} · ${peakHour.value} units` : "—"}
          icon={<IconStethoscope size={16} strokeWidth={1.75} />}
          iconTone="peak"
        />
      </div>
    </DashboardPanel>
  );
}
