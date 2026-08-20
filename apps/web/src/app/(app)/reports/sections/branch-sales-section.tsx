"use client";

import { useEffect, useMemo, useState } from "react";
import {
  IconActivity,
  IconAlertTriangle,
  IconDollarSign,
  IconSparkles,
  IconTarget,
  IconTrophy,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchBranchPerformance, fetchBranchSalesTrend } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { MultiLineChart, type MultiLineSeries } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { BranchPerformanceMap } from "../components/branch-performance-map";
import { ReportSelect } from "../components/report-select";
import type { BranchPerformanceRow, ExportPayload, OnExportData } from "../lib/types";
import css from "../reports.module.css";

type Props = { days: number; cityFilter?: string; onExportData: OnExportData };

type TrendView = "all" | "top" | "compare2";

const BRANCH_PALETTE = ["#0d9488", "#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#c2410c", "#64748b"];

function branchStatus(row: BranchPerformanceRow): { label: string; variant: "success" | "primary" | "warning" | "danger" } {
  if (row.achievementPct == null) return { label: "No target", variant: "primary" };
  if (row.achievementPct >= 100) return { label: "Over Target", variant: "primary" };
  if (row.achievementPct >= 75) return { label: "On Track", variant: "success" };
  if (row.achievementPct >= 50) return { label: "Needs Attention", variant: "warning" };
  return { label: "Critical", variant: "danger" };
}

/** Matches the Performance Map's attainment-tier legend colors (Critical/Needs Attention/On Track/Over Target). */
function attainmentColor(pct: number | null): string {
  if (pct == null) return "var(--pc-muted-fg)";
  if (pct < 50) return "#dc2626";
  if (pct < 75) return "#ea580c";
  if (pct < 100) return "#16a34a";
  return "var(--pc-primary)";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function BranchSalesSection({ days, cityFilter, onExportData }: Props) {
  const [rawBranches, setRawBranches] = useState<BranchPerformanceRow[]>([]);
  const [trendResponse, setTrendResponse] = useState<Awaited<ReturnType<typeof fetchBranchSalesTrend>> | null>(null);
  const [trendFocus, setTrendFocus] = useState<string | null>(null);
  const [trendView, setTrendView] = useState<TrendView>("all");
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchBranchPerformance(), fetchBranchSalesTrend(days)])
      .then(([perf, trend]) => {
        if (cancelled) return;
        setRawBranches(perf.branches);
        setTrendResponse(trend);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load branch performance");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const branches = useMemo(() => {
    const scoped = cityFilter && cityFilter !== "all" ? rawBranches.filter((b) => b.city === cityFilter) : rawBranches;
    return [...scoped].sort((a, b) => b.monthSales - a.monthSales);
  }, [rawBranches, cityFilter]);

  const colorMap = useMemo(() => new Map(branches.map((b, i) => [b.branchId, BRANCH_PALETTE[i % BRANCH_PALETTE.length]!])), [branches]);

  const totalRevenue = branches.reduce((s, b) => s + b.monthSales, 0);
  const avgRevenuePerBranch = branches.length > 0 ? totalRevenue / branches.length : 0;
  const best = branches[0] ?? null;

  // Back-derived from each branch's own real vsPrevMonthPct (the server already computed that ratio
  // from real previous-month revenue) — only over branches where that comparison is available, so the
  // aggregate ratio stays honest rather than silently treating missing data as zero growth.
  const { overallGrowthPct } = useMemo(() => {
    let curSum = 0;
    let prevSum = 0;
    for (const b of branches) {
      if (b.vsPrevMonthPct == null || b.vsPrevMonthPct <= -100) continue;
      curSum += b.monthSales;
      prevSum += b.monthSales / (1 + b.vsPrevMonthPct / 100);
    }
    return { overallGrowthPct: prevSum > 0 ? pctChange(curSum, prevSum) : null };
  }, [branches]);

  const avgBasketByBranch = useMemo(
    () => new Map(branches.map((b) => [b.branchId, b.monthTxnCount > 0 ? b.monthSales / b.monthTxnCount : 0])),
    [branches],
  );
  const tenantAvgBasket = branches.length > 0 ? [...avgBasketByBranch.values()].reduce((s, v) => s + v, 0) / branches.length : 0;

  const targetedBranches = branches.filter((b) => b.targetAmount != null);
  const totalTarget = targetedBranches.reduce((s, b) => s + b.targetAmount!, 0);
  const blendedAttainmentPct = totalTarget > 0 ? (targetedBranches.reduce((s, b) => s + b.monthSales, 0) / totalTarget) * 100 : null;
  const belowTargetCount = branches.filter((b) => b.achievementPct != null && b.achievementPct < 100).length;

  const belowTarget80 = branches.filter((b) => b.achievementPct != null && b.achievementPct < 80);
  const revenueGap80 = belowTarget80.reduce((s, b) => s + Math.max(0, (b.targetAmount ?? 0) - b.monthSales), 0);

  const largestDecline = [...branches].filter((b) => b.vsPrevMonthPct != null).sort((a, b) => a.vsPrevMonthPct! - b.vsPrevMonthPct!)[0] ?? null;

  const bestBasketBranch = branches.length > 0 ? [...branches].sort((a, b) => (avgBasketByBranch.get(b.branchId) ?? 0) - (avgBasketByBranch.get(a.branchId) ?? 0))[0]! : null;
  const bestBasketPctAboveAvg = bestBasketBranch && tenantAvgBasket > 0 ? ((avgBasketByBranch.get(bestBasketBranch.branchId)! / tenantAvgBasket) - 1) * 100 : null;

  const medianTxn = median(branches.map((b) => b.monthTxnCount));
  const opportunityBranch = bestBasketBranch && bestBasketBranch.monthTxnCount < medianTxn ? bestBasketBranch : null;

  function scrollToBranchPerformance() {
    document.getElementById("branch-performance-table")?.scrollIntoView({ behavior: "smooth" });
  }

  const actionItems: ActionPanelItem[] = [
    ...(belowTarget80.length > 0
      ? [{
          key: "critical-target",
          icon: <IconAlertTriangle size={16} />,
          tone: "danger" as const,
          title: belowTarget80.length === branches.length ? `All ${branches.length} branches below 80% of monthly target` : `${belowTarget80.length} of ${branches.length} branches below 80% of monthly target`,
          description: `Total revenue gap: ${formatMoney(revenueGap80)}`,
          count: belowTarget80.length,
          countLabel: belowTarget80.length === 1 ? "branch" : "branches",
          onClick: scrollToBranchPerformance,
          examples: belowTarget80.slice(0, 3).map((b) => ({ label: b.name, badge: `${b.achievementPct?.toFixed(0)}% of target`, tone: "negative" as const })),
        }]
      : []),
    ...(largestDecline && largestDecline.vsPrevMonthPct! < 0
      ? [{
          key: "largest-decline",
          icon: <IconActivity size={16} />,
          tone: "danger" as const,
          title: "Largest Decline",
          description: `${largestDecline.name} vs previous month`,
          count: 1,
          countLabel: "branch",
          onClick: scrollToBranchPerformance,
          examples: [{ label: largestDecline.name, badge: formatPctTrend(largestDecline.vsPrevMonthPct), tone: "negative" as const }],
        }]
      : []),
    ...(bestBasketBranch && bestBasketPctAboveAvg != null && bestBasketPctAboveAvg > 0
      ? [{
          key: "best-basket",
          icon: <IconTrophy size={16} />,
          tone: "primary" as const,
          title: "Best Basket Value",
          description: `${bestBasketPctAboveAvg.toFixed(0)}% above network average`,
          count: 1,
          countLabel: "branch",
          onClick: scrollToBranchPerformance,
          examples: [{ label: bestBasketBranch.name, badge: formatMoney(avgBasketByBranch.get(bestBasketBranch.branchId) ?? 0), tone: "positive" as const }],
        }]
      : []),
    ...(opportunityBranch
      ? [{
          key: "opportunity",
          icon: <IconSparkles size={16} />,
          tone: "purple" as const,
          title: "Opportunity",
          description: "Converts fewer transactions but has the highest basket value.",
          count: 1,
          countLabel: "branch",
          onClick: scrollToBranchPerformance,
          examples: [{ label: opportunityBranch.name, badge: `${opportunityBranch.monthTxnCount.toLocaleString("en-IN")} txns`, tone: "neutral" as const }],
        }]
      : []),
  ];

  const mapRows = useMemo(
    () => branches.map((b) => ({
      branchId: b.branchId,
      name: b.name,
      color: colorMap.get(b.branchId) ?? "#64748b",
      revenue: b.monthSales,
      growthPct: b.vsPrevMonthPct,
      transactions: b.monthTxnCount,
    })),
    [branches, colorMap],
  );

  const effectiveCompareA = compareA ?? branches[0]?.branchId ?? null;
  const effectiveCompareB = compareB ?? branches[1]?.branchId ?? null;

  const { trendLabels, trendSeries, hiddenBranchCount } = useMemo(() => {
    if (!trendResponse) return { trendLabels: [] as string[], trendSeries: [] as MultiLineSeries[], hiddenBranchCount: 0 };
    const byId = new Map(trendResponse.branches.map((b) => [b.branchId, b]));
    const rankedIds = branches.map((b) => b.branchId);
    const selectedIds =
      trendView === "top" ? rankedIds.slice(0, 1) : trendView === "compare2" ? [effectiveCompareA, effectiveCompareB].filter((id): id is string => !!id) : rankedIds.slice(0, 7);
    const selected = selectedIds.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
    if (selected.length === 0) return { trendLabels: [] as string[], trendSeries: [] as MultiLineSeries[], hiddenBranchCount: 0 };
    const bucketedLabels = bucketTrend(selected[0]!.points, granularity).map((p) => p.label);
    const series: MultiLineSeries[] = selected.map((b) => ({
      key: b.branchId,
      label: b.name,
      color: colorMap.get(b.branchId) ?? "#64748b",
      values: bucketTrend(b.points, granularity).map((p) => p.value),
    }));
    const hidden = trendView === "all" ? Math.max(0, rankedIds.length - selected.length) : 0;
    return { trendLabels: bucketedLabels, trendSeries: series, hiddenBranchCount: hidden };
  }, [trendResponse, trendView, branches, effectiveCompareA, effectiveCompareB, granularity, colorMap]);

  useEffect(() => {
    if (branches.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `branch-sales-${days}d.csv`,
      headers: ["Branch", "Revenue", "Transactions", "Avg Basket", "Target", "Attainment %", "Growth %", "Status"],
      rows: branches.map((b) => [
        b.name,
        b.monthSales,
        b.monthTxnCount,
        (avgBasketByBranch.get(b.branchId) ?? 0).toFixed(2),
        b.targetAmount ?? "",
        b.achievementPct?.toFixed(1) ?? "",
        b.vsPrevMonthPct?.toFixed(1) ?? "",
        branchStatus(b).label,
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [branches, avgBasketByBranch, days, onExportData]);

  const maxRevenue = Math.max(...branches.map((b) => b.monthSales), 1);

  const columns: Column<BranchPerformanceRow>[] = useMemo(
    () => [
      {
        key: "rank",
        header: "#",
        render: (r, i) => (
          <span className={css.rankCircle} style={{ background: colorMap.get(r.branchId) ?? "#64748b" }}>
            {i + 1}
          </span>
        ),
      },
      { key: "name", header: "Branch" },
      {
        key: "monthSales",
        header: "Revenue",
        align: "right",
        sortable: true,
        getValue: (r) => r.monthSales,
        render: (r) => (
          <div className={css.rankBarCell}>
            <div className={css.rankBarTrack}>
              <div className={css.rankBarFill} style={{ width: `${(r.monthSales / maxRevenue) * 100}%`, background: colorMap.get(r.branchId) ?? "#64748b" }} />
            </div>
            <div className={css.rankBarValue}>
              {formatMoney(r.monthSales)}
              <small>{totalRevenue > 0 ? `${((r.monthSales / totalRevenue) * 100).toFixed(1)}% share` : "—"}</small>
            </div>
          </div>
        ),
      },
      { key: "monthTxnCount", header: "Transactions", align: "right", sortable: true, getValue: (r) => r.monthTxnCount, render: (r) => r.monthTxnCount.toLocaleString("en-IN") },
      { key: "avgBasket", header: "Avg. Basket", align: "right", sortable: true, getValue: (r) => avgBasketByBranch.get(r.branchId) ?? 0, render: (r) => formatMoney(avgBasketByBranch.get(r.branchId) ?? 0) },
      { key: "target", header: "Target", align: "right", sortable: true, getValue: (r) => r.targetAmount ?? 0, render: (r) => (r.targetAmount == null ? "—" : formatMoney(r.targetAmount)) },
      {
        key: "attainment",
        header: "Attainment",
        align: "right",
        sortable: true,
        getValue: (r) => r.achievementPct ?? 0,
        render: (r) =>
          r.achievementPct == null ? (
            "—"
          ) : (
            <div className={css.rankTargetCell}>
              <span className={css.rankTargetPill}>{r.achievementPct.toFixed(0)}%</span>
              <div className={css.rankTargetBar}>
                <span style={{ width: `${Math.min(100, Math.max(0, r.achievementPct))}%`, background: attainmentColor(r.achievementPct) }} />
              </div>
            </div>
          ),
      },
      {
        key: "vsPrevMonthPct",
        header: "Growth",
        align: "right",
        sortable: true,
        getValue: (r) => r.vsPrevMonthPct ?? 0,
        render: (r) => (r.vsPrevMonthPct == null ? "—" : <span className={r.vsPrevMonthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.vsPrevMonthPct)}</span>),
      },
      {
        key: "status",
        header: "Status",
        render: (r) => {
          const s = branchStatus(r);
          return <StatusBadge status={s.variant} variant={s.variant} label={s.label} />;
        },
      },
    ],
    [avgBasketByBranch, colorMap, maxRevenue, totalRevenue],
  );

  if (error) return <div className={css.errorState}>{error}</div>;

  const attainmentStatus =
    blendedAttainmentPct == null ? null : blendedAttainmentPct < 50 ? "Critical" : blendedAttainmentPct < 75 ? "Needs Attention" : blendedAttainmentPct < 100 ? "On Track" : "Over Target";
  const attainmentTone: "primary" | "warning" | "danger" =
    blendedAttainmentPct == null ? "primary" : blendedAttainmentPct < 50 ? "danger" : blendedAttainmentPct < 100 ? "warning" : "primary";

  const branchOptions = branches.map((b) => ({ value: b.branchId, label: b.name }));

  return (
    <div>
      {!loading && (overallGrowthPct != null || belowTargetCount > 0) ? (
        <div className={`${css.networkAlert} ${overallGrowthPct != null && overallGrowthPct >= 0 ? css.networkAlertPositive : ""}`}>
          <span className={css.networkAlertIcon}>
            <IconAlertTriangle size={17} />
          </span>
          <span className={css.networkAlertBody}>
            {overallGrowthPct != null
              ? overallGrowthPct >= 0
                ? `Network sales are up ${overallGrowthPct.toFixed(1)}% vs the previous month. `
                : `Network sales are ${Math.abs(overallGrowthPct).toFixed(1)}% below the previous month. `
              : ""}
            {belowTargetCount > 0 ? `${belowTargetCount === branches.length ? `All ${branches.length}` : belowTargetCount} branch${belowTargetCount === 1 ? "" : "es"} currently below monthly target.` : ""}
          </span>
          <button
            type="button"
            className={css.networkAlertCta}
            onClick={() => document.getElementById("branch-performance-table")?.scrollIntoView({ behavior: "smooth" })}
          >
            {overallGrowthPct != null && overallGrowthPct < 0 ? "Analyse decline" : "View performance"}
          </button>
        </div>
      ) : null}

      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title="Total Revenue"
          value={loading ? "…" : formatMoney(totalRevenue)}
          subtitle="This month, all branches"
          icon={<IconDollarSign size={16} />}
          trend={!loading && overallGrowthPct != null ? { value: formatPctTrend(overallGrowthPct), direction: overallGrowthPct >= 0 ? "up" : "down", tone: overallGrowthPct >= 0 ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Top Revenue Branch"
          value={loading || !best ? "…" : best.name}
          subtitle={best && totalRevenue > 0 ? `${formatMoney(best.monthSales)} · ${((best.monthSales / totalRevenue) * 100).toFixed(1)}% contribution` : ""}
          icon={<IconTrophy size={16} />}
          iconTone="success"
          trend={!loading && best ? { value: "Top revenue", direction: "flat", tone: "positive" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Avg. Revenue per Branch"
          value={loading ? "…" : formatMoney(avgRevenuePerBranch)}
          subtitle={`${branches.length} branches`}
          icon={<IconActivity size={16} />}
          iconTone="info"
          trend={!loading && branches.length > 0 ? { value: "Network average", direction: "flat", tone: "neutral" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Target Attainment"
          value={loading || blendedAttainmentPct == null ? "…" : `${blendedAttainmentPct.toFixed(0)}%`}
          subtitle={belowTargetCount === 0 ? "All branches on track" : belowTargetCount === branches.length ? `All ${branches.length} branches below target` : `${belowTargetCount} of ${branches.length} branches below target`}
          icon={<IconTarget size={16} />}
          iconTone={attainmentTone}
          trend={!loading && attainmentStatus ? { value: attainmentStatus, direction: "flat", tone: attainmentStatus === "Critical" ? "danger" : attainmentStatus === "Needs Attention" ? "warning" : "positive" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.gridAlignStart} ${css.branchTrendRow}`}>
        <div className={css.branchColStack}>
          <div className={css.card}>
            <div className={css.cardhead}>
              <div>
                <h3>Sales Trend by Branch</h3>
                <p>{granularity === "weekly" ? "Weekly" : "Daily"} revenue, last {days} days</p>
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
            <MultiLineChart
              labels={trendLabels}
              series={trendSeries}
              tooltipFormat={formatMoney}
              focusKey={trendFocus}
              onFocusChange={setTrendFocus}
              hiddenLabel={hiddenBranchCount > 0 ? `+${hiddenBranchCount} more` : undefined}
              height={222}
            />
          </div>

          <div className={css.card} id="branch-performance-table">
            <div className={css.cardhead}>
              <div>
                <h3>Branch Performance</h3>
                <p>Ranked by revenue — click a column to re-sort.</p>
              </div>
            </div>
            <DataTable columns={columns} data={branches} rowKey={(r) => r.branchId} loading={loading} pageSize={10} emptyTitle="No branch data" compact />
          </div>
        </div>

        <div className={css.branchColStack}>
          {actionItems.length > 0 ? <ActionsPanel title="Branch Alerts & Opportunities" items={actionItems} variant="cards" /> : null}

          <div className={css.card}>
            <div className={css.cardhead}>
              <div>
                <h3>Performance Map</h3>
                <p>Revenue vs. growth, this month</p>
              </div>
            </div>
            <BranchPerformanceMap rows={mapRows} />
          </div>
        </div>
      </div>
    </div>
  );
}
