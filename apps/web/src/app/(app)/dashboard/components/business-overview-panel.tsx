"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import {
  IconBanknote,
  IconDollarSign,
  IconShoppingCart,
} from "@/components/icons";
import { DashboardPeriodSelect } from "./dashboard-period-select";
import {
  SimpleGroupedBarChart,
  SimpleLineChart,
  type ChartPoint,
  type SeriesPoint,
} from "./simple-charts";
import { DashboardPanel } from "./dashboard-panel";
import css from "../dashboard.module.css";

type TrendDays = 7 | 14 | 30;
type MonthPeriod = "this_month" | "last_month";

type Props = {
  /** Fallback trend from main dashboard hook while panel loads. */
  fallbackTrend?: ChartPoint[];
  /** When set, charts filter to this branch; omit for tenant-wide. */
  analyticsBranchId?: string | null;
};

const TREND_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
] as const;

const MONTH_OPTIONS = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
] as const;

function withBranch(path: string, branchId: string | null | undefined): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

function pctChange(curr: number, prev: number): number | null {
  if (!Number.isFinite(curr) || !Number.isFinite(prev)) return null;
  if (prev === 0) return curr === 0 ? 0 : null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

function formatPct(n: number): string {
  return `${Math.abs(n).toFixed(1)}%`;
}

type MetricTrend = {
  pct: number | null;
  compareLabel: string;
};

function MetricCell({
  label,
  value,
  icon,
  iconTone,
  trend,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  iconTone: "revenue" | "purchases" | "profit";
  trend?: MetricTrend;
}) {
  const pct = trend?.pct ?? null;
  const up = pct != null && pct >= 0;
  const down = pct != null && pct < 0;

  return (
    <div className={css.overviewMetric}>
      <span
        className={`${css.overviewMetricIcon} ${css[`overviewMetricIcon_${iconTone}`]}`}
        aria-hidden
      >
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

export function BusinessOverviewPanel({
  fallbackTrend = [],
  analyticsBranchId = null,
}: Props) {
  const [trendDays, setTrendDays] = useState<TrendDays>(7);
  const [revPeriod, setRevPeriod] = useState<MonthPeriod>("this_month");

  const [trend, setTrend] = useState<ChartPoint[]>(fallbackTrend);
  const [revPoints, setRevPoints] = useState<SeriesPoint[]>([]);
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [totalPurchases, setTotalPurchases] = useState(0);
  const [prevRevenue, setPrevRevenue] = useState<number | null>(null);
  const [prevPurchases, setPrevPurchases] = useState<number | null>(null);
  const [loadingTrend, setLoadingTrend] = useState(false);
  const [loadingRev, setLoadingRev] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingTrend(true);
    void apiJson<{
      salesTrend?: ChartPoint[];
      salesTrend7d?: ChartPoint[];
    }>(withBranch(`/analytics/sales-pulse?days=${trendDays}`, analyticsBranchId))
      .then((res) => {
        if (cancelled) return;
        const pts = res.salesTrend ?? res.salesTrend7d ?? [];
        setTrend(pts.map((p) => ({ label: p.label, value: p.value })));
      })
      .catch(() => {
        /* keep prior / fallback */
      })
      .finally(() => {
        if (!cancelled) setLoadingTrend(false);
      });
    return () => {
      cancelled = true;
    };
  }, [trendDays, analyticsBranchId]);

  useEffect(() => {
    if (fallbackTrend.length && trend.length === 0) {
      setTrend(fallbackTrend);
    }
  }, [fallbackTrend, trend.length]);

  useEffect(() => {
    let cancelled = false;
    setLoadingRev(true);
    const comparePeriod: MonthPeriod | null =
      revPeriod === "this_month" ? "last_month" : null;

    void Promise.all([
      apiJson<{
        weeks: SeriesPoint[];
        totalRevenue: number;
        totalPurchases: number;
      }>(
        withBranch(
          `/analytics/revenue-purchase-series?period=${revPeriod}`,
          analyticsBranchId,
        ),
      ),
      comparePeriod
        ? apiJson<{
            totalRevenue: number;
            totalPurchases: number;
          }>(
            withBranch(
              `/analytics/revenue-purchase-series?period=${comparePeriod}`,
              analyticsBranchId,
            ),
          )
        : Promise.resolve(null),
    ])
      .then(([res, prev]) => {
        if (cancelled) return;
        setRevPoints(res.weeks ?? []);
        setTotalRevenue(res.totalRevenue ?? 0);
        setTotalPurchases(res.totalPurchases ?? 0);
        if (prev) {
          setPrevRevenue(prev.totalRevenue ?? 0);
          setPrevPurchases(prev.totalPurchases ?? 0);
        } else {
          setPrevRevenue(null);
          setPrevPurchases(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRevPoints([]);
          setTotalRevenue(0);
          setTotalPurchases(0);
          setPrevRevenue(null);
          setPrevPurchases(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingRev(false);
      });
    return () => {
      cancelled = true;
    };
  }, [revPeriod, analyticsBranchId]);

  /** Totals follow Revenue vs Purchases period (not Sales Trend days). */
  const totalProfit = totalRevenue - totalPurchases;
  const prevProfit =
    prevRevenue != null && prevPurchases != null
      ? prevRevenue - prevPurchases
      : null;
  const revPeriodLabel =
    MONTH_OPTIONS.find((o) => o.value === revPeriod)?.label ?? "Selected period";
  const compareLabel = "vs Last month";
  const canCompare = prevRevenue != null && prevPurchases != null;

  return (
    <DashboardPanel title="Business Overview" compact className={css.splitPanel}>
      <div className={css.overviewGrid}>
        <div className={css.overviewChartsCol}>
          <div className={css.overviewChartsPair}>
            <section className={css.overviewSubcard}>
              <div className={css.subHeadingRow}>
                <h3 className={css.subHeading}>Sales Trend</h3>
                <DashboardPeriodSelect
                  label="Duration"
                  value={String(trendDays)}
                  options={TREND_OPTIONS}
                  onChange={(v) => setTrendDays(Number(v) as TrendDays)}
                />
              </div>
              <div className={css.overviewChartGrow}>
                {loadingTrend && trend.length === 0 ? (
                  <p className={css.emptyState}>Loading trend…</p>
                ) : (
                  <SimpleLineChart
                    points={trend}
                    height={168}
                    showYAxis
                    dense
                    maxXLabels={trendDays === 30 ? 6 : undefined}
                    aLabel="Sales (LKR)"
                    formatValue={(n) => formatMoney(n)}
                  />
                )}
              </div>
            </section>

            <section className={css.overviewSubcard}>
              <div className={css.subHeadingRow}>
                <h3 className={css.subHeading}>Revenue vs Purchases</h3>
                <DashboardPeriodSelect
                  label="Period"
                  value={revPeriod}
                  options={MONTH_OPTIONS}
                  onChange={(v) => setRevPeriod(v as MonthPeriod)}
                />
              </div>
              <div className={css.overviewChartGrow}>
                {loadingRev && revPoints.length === 0 ? (
                  <p className={css.emptyState}>Loading series…</p>
                ) : (
                  <SimpleGroupedBarChart
                    points={revPoints}
                    aLabel="Revenue"
                    bLabel="Purchases"
                    height={168}
                  />
                )}
              </div>
            </section>
          </div>

          <div
            className={css.overviewChartsSummary}
            aria-label={`Revenue and purchases totals for ${revPeriodLabel}`}
          >
            <MetricCell
              label="Total Revenue"
              value={formatMoney(totalRevenue)}
              icon={<IconDollarSign size={16} strokeWidth={1.75} />}
              iconTone="revenue"
              trend={
                canCompare
                  ? {
                      pct: pctChange(totalRevenue, prevRevenue),
                      compareLabel,
                    }
                  : undefined
              }
            />
            <MetricCell
              label="Total Purchases"
              value={formatMoney(totalPurchases)}
              icon={<IconShoppingCart size={16} strokeWidth={1.75} />}
              iconTone="purchases"
              trend={
                canCompare
                  ? {
                      pct: pctChange(totalPurchases, prevPurchases),
                      compareLabel,
                    }
                  : undefined
              }
            />
            <MetricCell
              label="Total Profit"
              value={formatMoney(totalProfit)}
              icon={<IconBanknote size={16} strokeWidth={1.75} />}
              iconTone="profit"
              trend={
                canCompare && prevProfit != null
                  ? {
                      pct: pctChange(totalProfit, prevProfit),
                      compareLabel,
                    }
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </DashboardPanel>
  );
}
