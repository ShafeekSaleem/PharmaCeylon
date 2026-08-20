"use client";

import { useEffect, useState } from "react";
import { IconActivity, IconPackage, IconTruck } from "@/components/icons";
import { apiJson } from "@/lib/auth-client";
import { DashboardPanel } from "./dashboard-panel";
import { MetricCell } from "./metric-cell";
import { PeriodToggle } from "./period-toggle";
import { SimpleGroupedBarChart } from "./simple-charts";
import css from "../dashboard.module.css";

type Period = "today" | "week" | "month";

const PERIOD_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
] as const;

const PERIOD_META: Record<Period, string> = {
  today: "Received vs issued · today",
  week: "Received vs issued · this week",
  month: "Received vs issued · this month",
};

type TrendResponse = {
  period: Period;
  points: Array<{ label: string; received: number; issued: number }>;
  receivedTotal: number;
  issuedTotal: number;
  netTotal: number;
};

function withBranch(path: string, branchId: string | null | undefined): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

type Props = { branchId?: string | null };

/** Received vs issued stock-ledger movement — Inventory clerk dashboard. */
export function StockMovementTrendPanel({ branchId }: Props) {
  const [period, setPeriod] = useState<Period>("week");
  const [data, setData] = useState<TrendResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<TrendResponse>(
      withBranch(`/analytics/stock-movement-trend?period=${period}`, branchId),
    )
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, period]);

  const isEmpty = !data || data.points.every((p) => p.received === 0 && p.issued === 0);

  return (
    <DashboardPanel
      title="Stock Movements"
      subtitle={PERIOD_META[period]}
      compact
      headerRight={
        <PeriodToggle
          aria-label="Stock movement period"
          value={period}
          options={PERIOD_OPTIONS}
          onChange={(v) => setPeriod(v as Period)}
        />
      }
      footerHref="/inventory/movements"
      footerLabel="View all movements →"
    >
      {loading && !data ? (
        <p className={css.emptyState}>Loading movements…</p>
      ) : isEmpty ? (
        <p className={css.emptyState}>No stock movements in this period.</p>
      ) : (
        <>
          {/* SimpleGroupedBarChart floors its own viewBox height at 168, but its
              SVG stretches to fill this wrapper via flex (height:100%) — so a
              fixed-height flex column here is what actually shrinks it. */}
          <div style={{ height: 140, display: "flex", flexDirection: "column" }}>
            <SimpleGroupedBarChart
              points={data.points.map((p) => ({ label: p.label, a: p.received, b: p.issued }))}
              aLabel="Received"
              bLabel="Issued"
            />
          </div>
          <div className={css.overviewChartsSummary} style={{ marginTop: "0.5rem" }}>
            <MetricCell
              label="Received"
              value={`+${data.receivedTotal.toLocaleString()} units`}
              icon={<IconPackage size={16} strokeWidth={1.75} />}
              iconTone="bills"
            />
            <MetricCell
              label="Issued"
              value={`−${data.issuedTotal.toLocaleString()} units`}
              icon={<IconTruck size={16} strokeWidth={1.75} />}
              iconTone="avg"
            />
            <MetricCell
              label="Net"
              value={`${data.netTotal >= 0 ? "+" : "−"}${Math.abs(data.netTotal).toLocaleString()} units`}
              icon={<IconActivity size={16} strokeWidth={1.75} />}
              iconTone="peak"
            />
          </div>
        </>
      )}
    </DashboardPanel>
  );
}
