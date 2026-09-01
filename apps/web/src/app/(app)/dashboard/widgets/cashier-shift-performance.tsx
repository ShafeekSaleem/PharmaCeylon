"use client";

import { IconActivity, IconReceipt, IconShoppingCart } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { MetricCell, pctChange } from "../components/metric-cell";
import { SimpleLineChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function CashierShiftPerformanceWidget({ data }: { data: DashboardData }) {
  const { loading, hourlyToday, todaySalesCount, todaySalesTotal, yesterdaySalesCount, yesterdaySalesTotal } = data;

  const peakHour = hourlyToday.reduce(
    (best, p) => (p.value > best.value ? p : best),
    hourlyToday[0] ?? { label: "—", value: 0 },
  );
  const avgBillValue = todaySalesCount > 0 ? todaySalesTotal / todaySalesCount : 0;
  const avgBillValueYesterday = yesterdaySalesCount > 0 ? yesterdaySalesTotal / yesterdaySalesCount : 0;
  const avgBillTrendPct =
    yesterdaySalesCount > 0 ? pctChange(avgBillValue, avgBillValueYesterday) : null;
  const billsTrendPct = yesterdaySalesCount > 0 ? pctChange(todaySalesCount, yesterdaySalesCount) : null;

  return (
    <DashboardPanel
      title="Shift Performance (Today)"
      compact
      footerMeta={peakHour.value > 0 ? `Peak: ${peakHour.label}` : "No sales hours yet"}
    >
      <SimpleLineChart
        points={hourlyToday}
        height={140}
        formatValue={(n) => formatMoney(n)}
        aLabel="Sales (LKR)"
        showYAxis
        dense
      />
      <div className={css.overviewChartsSummary} style={{ marginTop: "0.5rem" }}>
        <MetricCell
          label="Bills"
          value={loading ? "…" : String(todaySalesCount)}
          icon={<IconShoppingCart size={16} strokeWidth={1.75} />}
          iconTone="bills"
          trend={billsTrendPct != null ? { pct: billsTrendPct, compareLabel: "vs Yesterday" } : undefined}
        />
        <MetricCell
          label="Avg bill value"
          value={loading ? "…" : formatMoney(avgBillValue)}
          icon={<IconReceipt size={16} strokeWidth={1.75} />}
          iconTone="avg"
          trend={avgBillTrendPct != null ? { pct: avgBillTrendPct, compareLabel: "vs Yesterday" } : undefined}
        />
        <MetricCell
          label="Peak hour sales"
          value={loading ? "…" : peakHour.value > 0 ? formatMoney(peakHour.value) : "—"}
          icon={<IconActivity size={16} strokeWidth={1.75} />}
          iconTone="peak"
        />
      </div>
    </DashboardPanel>
  );
}
