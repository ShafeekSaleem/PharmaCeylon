"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconDollarSign, IconEye, IconHome, IconPill, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, type BadgeVariant } from "@/components/ui/status-badge";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { fetchBranchMarginComparison, fetchBranchMarginTrend } from "../lib/fetchers";
import { useProfitabilityTarget } from "../lib/use-profitability-target";
import { formatDateShort, formatMoney, formatPctTrend, formatPpTrend, pctChange } from "../lib/format";
import { BranchProfitabilityMatrix, type BranchMatrixPoint, type BranchMatrixQuadrant } from "../components/branch-profitability-matrix";
import { RankingTableCard } from "../components/ranking-table-card";
import { EntityWeekHeatmap, type WeekHeatmapRow } from "../components/entity-week-heatmap";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { BranchMarginTrendPoint, ExportPayload, OnExportData } from "../lib/types";
import css from "../reports.module.css";

type Props = { days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

/** Same fallback every other Profitability page uses when no tenant target is configured. */
const DEFAULT_MARGIN_TARGET_PCT = 20;

type BranchStatus = "Top Performer" | "Healthy" | "Margin Attention" | "Growth Opportunity" | "Review";
const STATUS_VARIANT: Record<BranchStatus, BadgeVariant> = {
  "Top Performer": "success",
  Healthy: "success",
  "Margin Attention": "danger",
  "Growth Opportunity": "info",
  Review: "muted",
};

type BranchEnriched = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  revenueN: number;
  costN: number;
  marginN: number;
  marginPct: number;
  unitsSold: number;
  contributionPct: number;
  revenueGrowthPct: number | null;
  gpGrowthPct: number | null;
  marginPctChange: number | null;
  quadrant: BranchMatrixQuadrant;
  status: BranchStatus;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function classifyBranchQuadrant(marginPct: number, revenueN: number, marginSplitPct: number, revenueSplitN: number): BranchMatrixQuadrant {
  const highMargin = marginPct >= marginSplitPct;
  const highRevenue = revenueN >= revenueSplitN;
  if (highMargin && highRevenue) return "topPerformers";
  if (highMargin) return "growthOpportunity";
  if (highRevenue) return "marginAttention";
  return "review";
}

/** Buckets a sparse (date, branchId, revenue, cost) point list into fixed calendar-week margin %
 *  values — identical convention to Category Profitability's own `weeklyMarginSeries` (fixed week
 *  boundaries, not "every 7 returned points", so every branch's row lands on the same week
 *  columns even with gaps in its raw point list). */
function weeklyMarginSeries(points: BranchMarginTrendPoint[], days: number): Array<{ date: string; label: string; marginPct: number | null }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  const byDate = new Map(points.map((p) => [p.date, p]));

  const weeks: Array<{ date: string; label: string; marginPct: number | null }> = [];
  for (let i = 0; i < days; i += 7) {
    let revenue = 0;
    let cost = 0;
    let weekStartKey = "";
    for (let j = i; j < Math.min(i + 7, days); j++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + j);
      const key = d.toISOString().slice(0, 10);
      if (j === i) weekStartKey = key;
      const p = byDate.get(key);
      if (p) {
        revenue += Number(p.revenue);
        cost += Number(p.cost);
      }
    }
    weeks.push({ date: weekStartKey, label: formatDateShort(weekStartKey), marginPct: revenue > 0 ? ((revenue - cost) / revenue) * 100 : null });
  }
  return weeks;
}

/** Which locations convert sales into gross profit most effectively — the Profitability-owned
 *  counterpart to Sales → Branch Sales (revenue/attainment only, no cost/margin dimension).
 *  Multi-branch tenants only; `reports-workspace.tsx` hides this tab entirely for a single-branch
 *  tenant rather than rendering an empty comparison here. */
export function BranchProfitabilitySection({ days, onNavigate, onExportData }: Props) {
  const [rows, setRows] = useState<BranchEnriched[]>([]);
  const [trendPoints, setTrendPoints] = useState<BranchMarginTrendPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const { targetPct } = useProfitabilityTarget();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedBranchId(null);
    fetchBranchMarginComparison(days)
      .then((res) => {
        if (cancelled) return;
        const totalMargin = res.currentTotals.margin;
        const marginSplitPct = targetPct ?? (res.currentTotals.revenue > 0 ? (totalMargin / res.currentTotals.revenue) * 100 : 0);
        const revenueSplitN = median(res.current.map((b) => Number(b.revenue)));

        const enriched: BranchEnriched[] = res.current.map((b) => {
          const revenueN = Number(b.revenue);
          const costN = Number(b.cost);
          const marginN = revenueN - costN;
          const marginPct = revenueN > 0 ? (marginN / revenueN) * 100 : 0;
          const prev = res.previousByBranch.get(b.branchId);
          const prevMarginPct = prev && prev.revenue > 0 ? ((prev.revenue - prev.cost) / prev.revenue) * 100 : null;
          const quadrant = classifyBranchQuadrant(marginPct, revenueN, marginSplitPct, revenueSplitN);
          return {
            branchId: b.branchId,
            code: b.code,
            name: b.name,
            city: b.city,
            revenueN,
            costN,
            marginN,
            marginPct,
            unitsSold: b.unitsSold,
            contributionPct: totalMargin > 0 ? (marginN / totalMargin) * 100 : 0,
            revenueGrowthPct: prev ? pctChange(revenueN, prev.revenue) : null,
            gpGrowthPct: prev ? pctChange(marginN, prev.margin) : null,
            marginPctChange: prevMarginPct != null ? marginPct - prevMarginPct : null,
            quadrant,
            status: quadrant === "marginAttention" ? "Margin Attention" : quadrant === "growthOpportunity" ? "Growth Opportunity" : quadrant === "review" ? "Review" : "Healthy",
          };
        });
        // The single highest-GP branch in the "topPerformers" quadrant is the headline "Top
        // Performer" — every other branch there is merely "Healthy" (still good, just not the
        // standout), matching the 5-state status set (Top Performer/Healthy/Margin Attention/
        // Growth Opportunity/Review) rather than only 4 quadrant-derived states.
        const bestInQuadrant = [...enriched].filter((b) => b.quadrant === "topPerformers").sort((a, b) => b.marginN - a.marginN)[0];
        if (bestInQuadrant) bestInQuadrant.status = "Top Performer";

        setRows(enriched.sort((a, b) => b.marginN - a.marginN));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load branch profitability data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, targetPct]);

  useEffect(() => {
    let cancelled = false;
    setTrendLoading(true);
    fetchBranchMarginTrend(days)
      .then((res) => {
        if (!cancelled) setTrendPoints(res.points);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const networkRevenue = rows.reduce((s, r) => s + r.revenueN, 0);
  const networkMargin = rows.reduce((s, r) => s + r.marginN, 0);
  const networkMarginPct = networkRevenue > 0 ? (networkMargin / networkRevenue) * 100 : 0;
  const effectiveTargetPct = targetPct ?? DEFAULT_MARGIN_TARGET_PCT;
  const belowTargetCount = rows.filter((r) => r.marginPct < effectiveTargetPct).length;
  const medianRevenue = useMemo(() => median(rows.map((r) => r.revenueN)), [rows]);
  const bestMarginBranch = useMemo(() => [...rows].filter((r) => r.revenueN >= medianRevenue).sort((a, b) => b.marginPct - a.marginPct)[0] ?? null, [rows, medianRevenue]);

  function toggleBranchFilter(branchId: string) {
    setSelectedBranchId((cur) => (cur === branchId ? null : branchId));
  }
  function scrollToTable() {
    document.getElementById("branch-profitability-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  const matrixPoints: BranchMatrixPoint[] = useMemo(
    () => rows.map((r) => ({ id: r.branchId, label: r.name, revenue: r.revenueN, marginPct: r.marginPct, grossProfit: r.marginN, quadrant: r.quadrant })),
    [rows],
  );

  const heatmapRows: WeekHeatmapRow[] = useMemo(() => {
    const byBranch = new Map<string, BranchMarginTrendPoint[]>();
    for (const p of trendPoints) {
      const list = byBranch.get(p.branchId) ?? [];
      list.push(p);
      byBranch.set(p.branchId, list);
    }
    return rows.map((r) => ({
      id: r.branchId,
      label: r.name,
      weeks: weeklyMarginSeries(byBranch.get(r.branchId) ?? [], days).map((w) => ({ date: w.date, label: w.label, value: w.marginPct })),
    }));
  }, [rows, trendPoints, days]);

  const insightItems: ActionPanelItem[] = useMemo(() => {
    const out: ActionPanelItem[] = [];
    const marginAttention = [...rows].filter((r) => r.quadrant === "marginAttention").sort((a, b) => b.revenueN - a.revenueN)[0];
    if (marginAttention) {
      const revSharePct = networkRevenue > 0 ? (marginAttention.revenueN / networkRevenue) * 100 : 0;
      out.push({
        key: "high-revenue-low-margin",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: "High Revenue, Low Margin",
        description: `${marginAttention.name} contributes ${revSharePct.toFixed(0)}% of network revenue but operates at ${marginAttention.marginPct.toFixed(1)}% margin — ${(networkMarginPct - marginAttention.marginPct).toFixed(1)}pp below the network average.`,
        count: 1,
        countLabel: "branch",
        onClick: () => { toggleBranchFilter(marginAttention.branchId); scrollToTable(); },
        examples: [{ label: marginAttention.name, badge: `${marginAttention.marginPct.toFixed(1)}%`, tone: "negative" }],
      });
    }
    const worstDecline = [...rows].filter((r) => r.marginPctChange != null).sort((a, b) => (a.marginPctChange ?? 0) - (b.marginPctChange ?? 0))[0];
    if (worstDecline && (worstDecline.marginPctChange ?? 0) < -1) {
      out.push({
        key: "margin-deterioration",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: "Margin Deterioration",
        description: `${worstDecline.name}'s margin declined ${Math.abs(worstDecline.marginPctChange ?? 0).toFixed(1)}pp versus the comparison period, now at ${worstDecline.marginPct.toFixed(1)}%.`,
        count: 1,
        countLabel: "branch",
        onClick: () => { toggleBranchFilter(worstDecline.branchId); scrollToTable(); },
        examples: [{ label: worstDecline.name, badge: `${(worstDecline.marginPctChange ?? 0).toFixed(1)}pp`, tone: "negative" }],
      });
    }
    const bestImprovement = [...rows].filter((r) => r.gpGrowthPct != null && r.gpGrowthPct > 0 && (r.marginPctChange ?? 0) >= 0).sort((a, b) => (b.gpGrowthPct ?? 0) - (a.gpGrowthPct ?? 0))[0];
    if (bestImprovement) {
      out.push({
        key: "strong-improvement",
        icon: <IconTrophy size={16} />,
        tone: "primary",
        title: "Strong Improvement",
        description: `${bestImprovement.name} grew gross profit ${formatPctTrend(bestImprovement.gpGrowthPct)} while ${(bestImprovement.marginPctChange ?? 0) > 0 ? "improving" : "holding"} its margin — scale without sacrificing profitability.`,
        count: 1,
        countLabel: "branch",
        onClick: () => { toggleBranchFilter(bestImprovement.branchId); scrollToTable(); },
        examples: [{ label: bestImprovement.name, badge: formatPctTrend(bestImprovement.gpGrowthPct), tone: "positive" }],
      });
    }
    const growthOpp = [...rows].filter((r) => r.quadrant === "growthOpportunity").sort((a, b) => b.marginPct - a.marginPct)[0];
    if (growthOpp) {
      out.push({
        key: "growth-opportunity",
        icon: <IconHome size={16} />,
        tone: "purple",
        title: "Growth Opportunity",
        description: `${growthOpp.name} runs the strongest margin (${growthOpp.marginPct.toFixed(1)}%) among branches with relatively low sales volume — capacity to grow without diluting profitability.`,
        count: 1,
        countLabel: "branch",
        onClick: () => { toggleBranchFilter(growthOpp.branchId); scrollToTable(); },
        examples: [{ label: growthOpp.name, badge: `${growthOpp.marginPct.toFixed(1)}%`, tone: "positive" }],
      });
    }
    if (rows.length > 0) {
      const topByMargin = [...rows].sort((a, b) => b.marginN - a.marginN)[0]!;
      out.push({
        key: "view-demand",
        icon: <IconEye size={16} />,
        tone: "muted",
        title: "View Demand in Branch Sales",
        description: "This page is margin only — see revenue, transactions and basket value per branch.",
        count: 1,
        countLabel: "report",
        onClick: () => onNavigate("sales", "branch-sales"),
        examples: [{ label: topByMargin.name, badge: "Top by gross profit", tone: "neutral" }],
      });
    }
    return out.slice(0, 5);
  }, [rows, networkRevenue, networkMarginPct, onNavigate]);

  const filteredRows = selectedBranchId ? rows.filter((r) => r.branchId === selectedBranchId) : rows;
  const selectedBranchName = selectedBranchId ? rows.find((r) => r.branchId === selectedBranchId)?.name : undefined;
  const filterPills: FilterPill[] = selectedBranchName ? [{ key: "branch", label: selectedBranchName }] : [];

  const columns: Column<BranchEnriched>[] = [
    { key: "name", header: "Branch", width: "8rem", render: (r) => (
      <>
        {r.name}
        <div className={css.mutedcell}>{r.code}{r.city ? ` · ${r.city}` : ""}</div>
      </>
    ) },
    { key: "revenueN", header: "Revenue", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.revenueN, render: (r) => formatMoney(r.revenueN) },
    { key: "costN", header: "COGS", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.costN, render: (r) => <span className={css.mutedcell}>{formatMoney(r.costN)}</span> },
    { key: "marginN", header: "Gross Profit", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    { key: "marginPct", header: "Margin %", align: "right", width: "4rem", sortable: true, getValue: (r) => r.marginPct, render: (r) => `${r.marginPct.toFixed(1)}%` },
    { key: "contributionPct", header: "GP Contrib.", align: "right", width: "5rem", sortable: true, getValue: (r) => r.contributionPct, render: (r) => `${r.contributionPct.toFixed(1)}%` },
    { key: "revenueGrowthPct", header: "Rev. Growth", align: "right", width: "5rem", sortable: true, getValue: (r) => r.revenueGrowthPct ?? -Infinity, render: (r) => formatPctTrend(r.revenueGrowthPct) },
    { key: "gpGrowthPct", header: "GP Growth", align: "right", width: "5rem", sortable: true, getValue: (r) => r.gpGrowthPct ?? -Infinity, render: (r) => formatPctTrend(r.gpGrowthPct) },
    { key: "marginPctChange", header: "Margin Chg.", align: "right", width: "5rem", sortable: true, getValue: (r) => r.marginPctChange ?? -Infinity, render: (r) => formatPpTrend(r.marginPctChange) },
    { key: "targetVariance", header: "Target Var.", align: "right", width: "5rem", sortable: true, getValue: (r) => r.marginPct - effectiveTargetPct, render: (r) => formatPpTrend(r.marginPct - effectiveTargetPct) },
    { key: "status", header: "Status", width: "5.5rem", render: (r) => <span className={css.actionCell}><StatusBadge status={r.status} label={r.status} variant={STATUS_VARIANT[r.status]} /></span> },
  ];

  useEffect(() => {
    if (rows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `branch-profitability-${days}d.csv`,
      headers: ["Branch", "Revenue", "COGS", "Gross Profit", "Margin %", "GP Contribution %", "Revenue Growth %", "GP Growth %", "Margin Change (pp)", "Target Variance (pp)", "Status"],
      rows: rows.map((r) => [
        r.name, r.revenueN, r.costN, r.marginN, r.marginPct.toFixed(1), r.contributionPct.toFixed(1),
        r.revenueGrowthPct?.toFixed(1) ?? "", r.gpGrowthPct?.toFixed(1) ?? "", r.marginPctChange?.toFixed(1) ?? "",
        (r.marginPct - effectiveTargetPct).toFixed(1), r.status,
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [rows, days, effectiveTargetPct, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Network Gross Profit" value={loading ? "…" : formatMoney(networkMargin)} subtitle={`vs previous ${days} days`} icon={<IconDollarSign size={16} />} iconTone="success" />
        <StatCard size="sm" showMenu={false} title="Network Gross Margin" value={loading ? "…" : `${networkMarginPct.toFixed(1)}%`} subtitle="Blended — revenue-weighted" icon={<IconPill size={16} />} iconTone="info" />
        <StatCard size="sm" showMenu={false}
          title="Best Margin Branch"
          value={loading || !bestMarginBranch ? "…" : bestMarginBranch.name}
          subtitle={bestMarginBranch ? `${bestMarginBranch.marginPct.toFixed(1)}% margin` : ""}
          icon={<IconTrophy size={16} />}
        />
        <StatCard size="sm" showMenu={false}
          title="Branches Below Target"
          value={loading ? "…" : `${belowTargetCount} of ${rows.length}`}
          subtitle={`Below ${effectiveTargetPct.toFixed(0)}% target${targetPct == null ? " (default)" : ""}`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Branch Profitability Matrix</h3>
              <p>Revenue × gross margin — bubble size = gross profit contribution</p>
            </div>
          </div>
          <BranchProfitabilityMatrix
            points={matrixPoints}
            formatValue={formatMoney}
            revenueReference={medianRevenue}
            marginReference={effectiveTargetPct}
            onBubbleClick={toggleBranchFilter}
            activeId={selectedBranchId}
          />
        </div>

        <RankingTableCard
          title="Branch Gross Profit Ranking"
          subtitle="Ranked by gross profit — margin shown alongside, since the highest-margin branch isn't always the highest-profit one"
          rows={rows}
          rowKey={(r) => r.branchId}
          primaryHeader="Branch"
          primaryLabel={(r) => r.name}
          primarySub={(r) => r.code}
          barHeader="Gross Profit"
          barValue={(r) => r.marginN}
          barLabel={(r) => formatMoney(r.marginN)}
          extraColumns={[
            { key: "marginPct", header: "Margin %", align: "right", render: (r) => `${r.marginPct.toFixed(1)}%` },
            { key: "gpGrowthPct", header: "GP Growth", align: "right", render: (r) => formatPctTrend(r.gpGrowthPct) },
          ]}
          loading={loading}
          emptyTitle="No branch activity in this range"
        />
      </div>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Branch Margin Trend</h3>
              <p>Weekly margin % by branch</p>
            </div>
          </div>
          {loading || trendLoading ? (
            <p className={css.emptyNote}>Loading trend…</p>
          ) : (
            <EntityWeekHeatmap rows={heatmapRows} onRowClick={toggleBranchFilter} activeId={selectedBranchId} rowHeader="Branch" />
          )}
        </div>

        <ActionsPanel title="Branch Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>

      <div className={css.card} id="branch-profitability-table">
        <div className={css.cardhead}>
          <div>
            <h3>Branch Profitability Detail</h3>
            <p>Every branch this period, ranked by gross profit</p>
          </div>
        </div>
        {selectedBranchName ? (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by branch · ${filteredRows.length} row${filteredRows.length === 1 ? "" : "s"}`}
              pills={filterPills}
              onClear={() => setSelectedBranchId(null)}
              clearTooltip="Show every branch"
            />
          </div>
        ) : null}
        <DataTable columns={columns} data={filteredRows} rowKey={(r) => r.branchId} loading={loading} pageSize={10} emptyTitle="No branch activity in this range" compact className={css.fixedLayoutTable} />
      </div>
    </div>
  );
}
