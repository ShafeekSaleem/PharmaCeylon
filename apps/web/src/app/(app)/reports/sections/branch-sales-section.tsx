"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconDollarSign, IconEye, IconSparkles, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { fetchBranchSalesReportComparison, fetchBranchSalesReportTrend } from "../lib/fetchers";
import { formatDateShort, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { MultiLineChart, type MultiLineSeries } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { RankingTableCard } from "../components/ranking-table-card";
import { BranchSalesMatrix, type BranchSalesMatrixPoint } from "../components/branch-sales-matrix";
import { ReportSelect } from "../components/report-select";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { BranchSalesTrendPoint, BranchTrendPoint, ExportPayload, OnExportData } from "../lib/types";
import css from "../reports.module.css";

type Props = { days: number; cityFilter?: string; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type TrendView = "all" | "top" | "compare2";

const BRANCH_PALETTE = ["#0d9488", "#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#c2410c", "#64748b"];

type BranchEnriched = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  revenue: number;
  transactions: number;
  unitsSold: number;
  avgBasket: number;
  prevRevenue: number;
  revenueGrowthPct: number | null;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Zero-fills `branchSalesTrend`'s sparse (date, branchId, revenue) points into a full-day-range
 *  series per branch — the same day-range-fill convention `fetchNetSalesTrendComparison` uses, so
 *  a day with zero sales at a branch still gets a point instead of silently vanishing from the
 *  line. Anchored at local midnight "today" like every other client-side trend bucketing on this
 *  page (the day-boundary vs. the backend's own rolling `since` is a known, benign convention
 *  difference — see Phase B's reconciliation note). */
function buildBranchTrendSeries(points: BranchSalesTrendPoint[], days: number, branches: Array<{ branchId: string; name: string }>): Map<string, BranchTrendPoint[]> {
  const byKey = new Map<string, number>();
  for (const p of points) byKey.set(`${p.date}|${p.branchId}`, Number(p.revenue));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(todayStart);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const result = new Map<string, BranchTrendPoint[]>();
  for (const b of branches) {
    result.set(
      b.branchId,
      dates.map((date) => ({ date, label: formatDateShort(date), value: byKey.get(`${date}|${b.branchId}`) ?? 0 })),
    );
  }
  return result;
}

/** Which branches drive demand — revenue, transaction volume, and basket size, with zero cost/
 *  margin dimension (that's Branch Profitability's story). Multi-branch tenants only;
 *  `reports-workspace.tsx` hides this tab entirely for a single-branch tenant. Unlike the
 *  analytics-backed page this replaces, every KPI/table/matrix here genuinely respects the
 *  period selector (see `reports.service.ts#branchSales`'s doc comment for why the old
 *  calendar-month-only source couldn't). */
export function BranchSalesSection({ days, cityFilter, onNavigate, onExportData }: Props) {
  const [rawRows, setRawRows] = useState<BranchEnriched[]>([]);
  const [trendPointsRaw, setTrendPointsRaw] = useState<BranchSalesTrendPoint[]>([]);
  const [trendFocus, setTrendFocus] = useState<string | null>(null);
  const [trendView, setTrendView] = useState<TrendView>("all");
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchBranchSalesReportComparison(days)
      .then((res) => {
        if (cancelled) return;
        const enriched: BranchEnriched[] = res.current.map((b) => {
          const revenue = Number(b.revenue);
          const prev = res.previousByBranch.get(b.branchId);
          const prevRevenue = prev?.revenue ?? 0;
          return {
            branchId: b.branchId,
            code: b.code,
            name: b.name,
            city: b.city,
            revenue,
            transactions: b.transactions,
            unitsSold: b.unitsSold,
            avgBasket: b.transactions > 0 ? revenue / b.transactions : 0,
            prevRevenue,
            revenueGrowthPct: pctChange(revenue, prevRevenue),
          };
        });
        setRawRows(enriched.sort((a, b) => b.revenue - a.revenue));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load branch sales data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    let cancelled = false;
    setTrendLoading(true);
    fetchBranchSalesReportTrend(days)
      .then((res) => {
        if (!cancelled) setTrendPointsRaw(res.points);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const branches = useMemo(
    () => (cityFilter && cityFilter !== "all" ? rawRows.filter((b) => b.city === cityFilter) : rawRows),
    [rawRows, cityFilter],
  );

  const colorMap = useMemo(() => new Map(branches.map((b, i) => [b.branchId, BRANCH_PALETTE[i % BRANCH_PALETTE.length]!])), [branches]);

  const networkRevenue = branches.reduce((s, b) => s + b.revenue, 0);
  const networkTransactions = branches.reduce((s, b) => s + b.transactions, 0);
  const networkPrevRevenue = branches.reduce((s, b) => s + b.prevRevenue, 0);
  const networkGrowthPct = pctChange(networkRevenue, networkPrevRevenue);
  const best = branches[0] ?? null;

  const bestGrowthBranch = useMemo(
    () => [...branches].filter((b) => b.revenueGrowthPct != null).sort((a, b) => (b.revenueGrowthPct ?? -Infinity) - (a.revenueGrowthPct ?? -Infinity))[0] ?? null,
    [branches],
  );
  const highestBasketBranch = useMemo(() => (branches.length > 0 ? [...branches].sort((a, b) => b.avgBasket - a.avgBasket)[0]! : null), [branches]);
  const largestDecline = useMemo(
    () => [...branches].filter((b) => b.revenueGrowthPct != null).sort((a, b) => (a.revenueGrowthPct ?? 0) - (b.revenueGrowthPct ?? 0))[0] ?? null,
    [branches],
  );
  const medianTransactions = useMemo(() => median(branches.map((b) => b.transactions)), [branches]);
  const opportunityBranch = highestBasketBranch && highestBasketBranch.transactions < medianTransactions ? highestBasketBranch : null;

  function scrollToTable() {
    document.getElementById("branch-sales-ranking")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const insightItems: ActionPanelItem[] = useMemo(() => {
    const out: ActionPanelItem[] = [];
    if (largestDecline && (largestDecline.revenueGrowthPct ?? 0) < 0) {
      out.push({
        key: "largest-decline",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: "Largest Decline",
        description: `${largestDecline.name}'s net sales fell versus the previous ${days} days.`,
        count: 1,
        countLabel: "branch",
        onClick: scrollToTable,
        examples: [{ label: largestDecline.name, badge: formatPctTrend(largestDecline.revenueGrowthPct), tone: "negative" }],
      });
    }
    if (bestGrowthBranch && (bestGrowthBranch.revenueGrowthPct ?? 0) > 0) {
      out.push({
        key: "best-growth",
        icon: <IconTrophy size={16} />,
        tone: "primary",
        title: "Best Sales Growth",
        description: `${bestGrowthBranch.name} grew net sales the most versus the previous ${days} days.`,
        count: 1,
        countLabel: "branch",
        onClick: scrollToTable,
        examples: [{ label: bestGrowthBranch.name, badge: formatPctTrend(bestGrowthBranch.revenueGrowthPct), tone: "positive" }],
      });
    }
    if (opportunityBranch) {
      out.push({
        key: "opportunity",
        icon: <IconSparkles size={16} />,
        tone: "purple",
        title: "Opportunity",
        description: "Converts fewer transactions but has the highest basket value — footfall growth here compounds.",
        count: 1,
        countLabel: "branch",
        onClick: scrollToTable,
        examples: [{ label: opportunityBranch.name, badge: `${opportunityBranch.transactions.toLocaleString("en-IN")} txns`, tone: "neutral" }],
      });
    }
    if (best) {
      out.push({
        key: "view-margin",
        icon: <IconEye size={16} />,
        tone: "muted",
        title: "View Margin in Branch Profitability",
        description: "This page is demand only — see COGS, gross profit and margin % per branch.",
        count: 1,
        countLabel: "report",
        onClick: () => onNavigate("profitability", "branch-profitability"),
        examples: [{ label: best.name, badge: "Top by net sales", tone: "neutral" }],
      });
    }
    return out;
  }, [largestDecline, bestGrowthBranch, opportunityBranch, best, days, onNavigate]);

  const matrixPoints: BranchSalesMatrixPoint[] = useMemo(
    () => branches.map((b) => ({ id: b.branchId, label: b.name, transactions: b.transactions, avgBasket: b.avgBasket, revenue: b.revenue })),
    [branches],
  );

  const trendByBranch = useMemo(
    () => buildBranchTrendSeries(trendPointsRaw, days, branches.map((b) => ({ branchId: b.branchId, name: b.name }))),
    [trendPointsRaw, days, branches],
  );

  const effectiveCompareA = compareA ?? branches[0]?.branchId ?? null;
  const effectiveCompareB = compareB ?? branches[1]?.branchId ?? null;

  const { trendLabels, trendSeries, hiddenBranchCount } = useMemo(() => {
    if (branches.length === 0) return { trendLabels: [] as string[], trendSeries: [] as MultiLineSeries[], hiddenBranchCount: 0 };
    const rankedIds = branches.map((b) => b.branchId);
    const selectedIds =
      trendView === "top" ? rankedIds.slice(0, 1) : trendView === "compare2" ? [effectiveCompareA, effectiveCompareB].filter((id): id is string => !!id) : rankedIds.slice(0, 7);
    const selected = branches.filter((b) => selectedIds.includes(b.branchId));
    if (selected.length === 0) return { trendLabels: [] as string[], trendSeries: [] as MultiLineSeries[], hiddenBranchCount: 0 };
    const bucketedLabels = bucketTrend(trendByBranch.get(selected[0]!.branchId) ?? [], granularity).map((p) => p.label);
    const series: MultiLineSeries[] = selected.map((b) => ({
      key: b.branchId,
      label: b.name,
      color: colorMap.get(b.branchId) ?? "#64748b",
      values: bucketTrend(trendByBranch.get(b.branchId) ?? [], granularity).map((p) => p.value),
    }));
    const hidden = trendView === "all" ? Math.max(0, rankedIds.length - selected.length) : 0;
    return { trendLabels: bucketedLabels, trendSeries: series, hiddenBranchCount: hidden };
  }, [branches, trendView, effectiveCompareA, effectiveCompareB, granularity, colorMap, trendByBranch]);

  useEffect(() => {
    if (branches.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `branch-sales-${days}d.csv`,
      headers: ["Branch", "Revenue", "Transactions", "Avg Basket", "Growth %"],
      rows: branches.map((b) => [b.name, b.revenue, b.transactions, b.avgBasket.toFixed(2), b.revenueGrowthPct?.toFixed(1) ?? ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [branches, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const branchOptions = branches.map((b) => ({ value: b.branchId, label: b.name }));

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title="Network Net Sales"
          value={loading ? "…" : formatMoney(networkRevenue)}
          subtitle={`Last ${days} days, all branches`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && networkGrowthPct != null ? { value: formatPctTrend(networkGrowthPct), direction: networkGrowthPct >= 0 ? "up" : "down", tone: networkGrowthPct >= 0 ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Network Transactions"
          value={loading ? "…" : networkTransactions.toLocaleString("en-IN")}
          subtitle={best ? `Top: ${best.name}` : ""}
          icon={<IconActivity size={16} />}
          iconTone="info"
        />
        <StatCard
          size="sm" showMenu={false}
          title="Best Sales Growth"
          value={loading || !bestGrowthBranch ? "…" : bestGrowthBranch.name}
          subtitle={bestGrowthBranch ? formatPctTrend(bestGrowthBranch.revenueGrowthPct) : "No growth data yet"}
          icon={<IconTrophy size={16} />}
          iconTone="success"
        />
        <StatCard
          size="sm" showMenu={false}
          title="Highest Avg. Basket"
          value={loading || !highestBasketBranch ? "…" : highestBasketBranch.name}
          subtitle={highestBasketBranch ? formatMoney(highestBasketBranch.avgBasket) : ""}
          icon={<IconSparkles size={16} />}
          iconTone="info"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Branch Sales Matrix</h3>
              <p>Transactions × avg. basket — bubble size = net sales</p>
            </div>
          </div>
          <BranchSalesMatrix points={matrixPoints} formatValue={formatMoney} colorFor={(id) => colorMap.get(id) ?? "#64748b"} />
        </div>

        <RankingTableCard
          id="branch-sales-ranking"
          title="Branch Net Sales Ranking"
          subtitle="Ranked by net sales"
          rows={branches}
          rowKey={(r) => r.branchId}
          primaryHeader="Branch"
          primaryLabel={(r) => r.name}
          primarySub={(r) => r.code}
          barHeader="Net Sales"
          barValue={(r) => r.revenue}
          barLabel={(r) => formatMoney(r.revenue)}
          extraColumns={[
            { key: "transactions", header: "Transactions", align: "right", render: (r) => r.transactions.toLocaleString("en-IN") },
            { key: "revenueGrowthPct", header: "Growth", align: "right", render: (r) => formatPctTrend(r.revenueGrowthPct) },
          ]}
          loading={loading}
          emptyTitle="No branch activity in this range"
        />
      </div>

      <div className={`${css.grid2} ${css.gridAlignStart} ${css.branchTrendRow}`}>
        <div className={css.branchColStack}>
          <div className={css.card}>
            <div className={css.cardhead}>
              <div>
                <h3>Sales Trend by Branch</h3>
                <p>{granularity === "weekly" ? "Weekly" : "Daily"} net sales, last {days} days</p>
              </div>
              <div className={css.trendHeadControls}>
                <div className={css.segmented}>
                  <button type="button" className={trendView === "all" ? css.on : undefined} onClick={() => setTrendView("all")}>All branches</button>
                  <button type="button" className={trendView === "top" ? css.on : undefined} onClick={() => setTrendView("top")}>Top branch</button>
                  <button type="button" className={trendView === "compare2" ? css.on : undefined} onClick={() => setTrendView("compare2")}>Compare 2</button>
                </div>
                <div className={css.segmented}>
                  <button type="button" className={granularity === "daily" ? css.on : undefined} onClick={() => setGranularity("daily")}>Daily</button>
                  <button type="button" className={granularity === "weekly" ? css.on : undefined} onClick={() => setGranularity("weekly")}>Weekly</button>
                </div>
              </div>
            </div>
            {trendView === "compare2" ? (
              <div className={css.compare2Row}>
                <ReportSelect ariaLabel="Branch A" value={effectiveCompareA ?? ""} onChange={setCompareA} options={branchOptions} />
                <span>vs</span>
                <ReportSelect ariaLabel="Branch B" value={effectiveCompareB ?? ""} onChange={setCompareB} options={branchOptions} />
              </div>
            ) : null}
            {trendLoading ? (
              <p className={css.emptyNote}>Loading trend…</p>
            ) : (
              <MultiLineChart
                labels={trendLabels}
                series={trendSeries}
                tooltipFormat={formatMoney}
                focusKey={trendFocus}
                onFocusChange={setTrendFocus}
                hiddenLabel={hiddenBranchCount > 0 ? `+${hiddenBranchCount} more` : undefined}
                height={222}
              />
            )}
          </div>
        </div>

        <ActionsPanel title="Branch Insights" items={insightItems} variant="cards" />
      </div>
    </div>
  );
}
