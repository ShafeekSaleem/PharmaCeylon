"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconCheckCircle, IconEye, IconPill, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { fetchCategoryComparison, fetchMarginTrendByCategory } from "../lib/fetchers";
import { useProfitabilityTarget } from "../lib/use-profitability-target";
import { formatCompactMoney, formatDateShort, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { CategoryBenchmarkChart } from "../components/category-benchmark-chart";
import { CategoryOpportunityMatrix, type OpportunityTag, type QuadrantKey } from "../components/category-opportunity-matrix";
import { EntityWeekHeatmap, type WeekHeatmapRow } from "../components/entity-week-heatmap";
import { CategoryHierarchyTable, type HierarchyParentRow } from "../components/category-hierarchy-table";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { CategoryChildRow, CategoryTrendPoint, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

/** Same fallback Product Profitability's low-margin toggle uses when no tenant target is set. */
const DEFAULT_MARGIN_TARGET_PCT = 20;

type ChildEnriched = { categoryId: string; name: string; revenueN: number; costN: number; marginN: number; marginPct: number };
type CategoryEnriched = ChildEnriched & { contributionPct: number; growthPct: number | null; children: ChildEnriched[] };

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function enrichChild(c: CategoryChildRow): ChildEnriched {
  const revenueN = Number(c.revenue);
  const costN = Number(c.cost);
  const marginN = revenueN - costN;
  return { categoryId: c.categoryId, name: c.name, revenueN, costN, marginN, marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0 };
}

/** Split at the configured margin TARGET (or the blended average when none is set) rather than
 *  the categories' own average — a category being below the portfolio's own average doesn't
 *  necessarily mean it's unhealthy, but being below the business's actual target does. Revenue
 *  splits at the MEDIAN, not the average, so one very large category can't single-handedly drag
 *  every smaller-but-solid category into the "low revenue" half. */
function classifyQuadrant(marginPct: number, revenueN: number, marginSplitPct: number, revenueSplitN: number): QuadrantKey {
  const highMargin = marginPct >= marginSplitPct;
  const highRevenue = revenueN >= revenueSplitN;
  if (highMargin && highRevenue) return "highMarginHighRevenue";
  if (highMargin) return "highMarginLowRevenue";
  if (highRevenue) return "lowMarginHighRevenue";
  return "lowMarginLowRevenue";
}

/** Buckets a sparse (date, revenue, cost) point list into fixed calendar-week margin % values —
 *  fixed week boundaries (not "every 7 returned points") so every category's row lands on the
 *  same week columns even though a slow-selling category has gaps in its raw point list.
 *  `marginPct: null` marks a week with zero revenue (no sales), never a real 0% margin. */
function weeklyMarginSeries(points: CategoryTrendPoint[], days: number): Array<{ date: string; label: string; marginPct: number | null }> {
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

/** Category-level profitability, COMMERCIAL dimension only — "which parts of the business
 *  generate profit?". Product-level detail lives on Margin by Product instead. */
export function MarginByCategorySection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [rows, setRows] = useState<CategoryEnriched[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendPoints, setTrendPoints] = useState<CategoryTrendPoint[]>([]);
  const [trendLoading, setTrendLoading] = useState(true);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const { targetPct } = useProfitabilityTarget();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedCategoryId(null);
    fetchCategoryComparison(days, scope, isOwner, "commercial")
      .then((res) => {
        if (cancelled) return;
        const totalMargin = res.current.reduce((s, r) => s + (Number(r.revenue) - Number(r.cost)), 0);
        const enriched: CategoryEnriched[] = res.current
          .map((r) => {
            const child = enrichChild(r);
            const prev = res.previousByCategory.get(r.categoryId);
            return {
              ...child,
              contributionPct: totalMargin > 0 ? (child.marginN / totalMargin) * 100 : 0,
              growthPct: prev ? pctChange(child.revenueN, prev.revenue) : null,
              children: (r.children ?? []).map(enrichChild),
            };
          })
          .sort((a, b) => b.marginN - a.marginN);
        setRows(enriched);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load category margin data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  useEffect(() => {
    let cancelled = false;
    setTrendLoading(true);
    fetchMarginTrendByCategory(days, scope, isOwner)
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
  }, [days, scope, isOwner]);

  const totalRevenue = rows.reduce((s, r) => s + r.revenueN, 0);
  const totalMargin = rows.reduce((s, r) => s + r.marginN, 0);
  // Blended (revenue-weighted) margin, not a naive average of each category's own margin % —
  // averaging percentages directly would let a tiny long-tail category with a freak 90% margin
  // skew the headline number even though it barely moves actual profit.
  const blendedMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;

  const medianRevenue = useMemo(() => median(rows.map((r) => r.revenueN)), [rows]);
  // "Established" = at/above median revenue, so a single high-margin sale on a tiny long-tail
  // category doesn't win "Highest Margin" over categories that actually matter.
  const establishedRows = useMemo(() => rows.filter((r) => r.revenueN >= medianRevenue), [rows, medianRevenue]);
  // The typical category's own margin — distinct from `blendedMarginPct` above (revenue-weighted
  // portfolio figure), same "median vs. blended" distinction Product Profitability makes.
  const medianCategoryMarginPct = useMemo(() => median(rows.map((r) => r.marginPct)), [rows]);
  const effectiveTargetPct = targetPct ?? DEFAULT_MARGIN_TARGET_PCT;
  const belowTargetCount = rows.filter((r) => r.marginPct < effectiveTargetPct).length;

  const topContributor = rows[0] ?? null;
  const highestMargin = [...establishedRows].sort((a, b) => b.marginPct - a.marginPct)[0] ?? null;
  // Only genuinely below-target categories qualify — ranking "lowest margin among established
  // categories" without that filter could surface a perfectly healthy category just because
  // everything else happens to be even stronger this period.
  const biggestOpportunity = [...establishedRows]
    .filter((r) => r.marginPct < effectiveTargetPct)
    .sort((a, b) => a.marginPct - b.marginPct)[0] ?? null;

  function toggleCategoryFilter(categoryId: string) {
    setSelectedCategoryId((cur) => (cur === categoryId ? null : categoryId));
  }

  useEffect(() => {
    if (!selectedCategoryId) return;
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedCategoryId]);

  // ── Category Margin vs Benchmark — sorted by margin % (not gross profit) descending ────────
  const benchmarkRows = useMemo(
    () => [...rows].sort((a, b) => b.marginPct - a.marginPct).map((r) => ({ id: r.categoryId, label: r.name, marginPct: r.marginPct })),
    [rows],
  );

  // ── Category Margin Opportunity Matrix — split at the target margin (blended average when no
  //    target is set) and median revenue across categories ──────────────────────────────────
  const quadrants = useMemo(() => {
    const base: Record<QuadrantKey, OpportunityTag[]> = {
      highMarginHighRevenue: [],
      highMarginLowRevenue: [],
      lowMarginHighRevenue: [],
      lowMarginLowRevenue: [],
    };
    for (const r of rows) {
      base[classifyQuadrant(r.marginPct, r.revenueN, targetPct ?? blendedMarginPct, medianRevenue)].push({ id: r.categoryId, label: r.name });
    }
    return base;
  }, [rows, targetPct, blendedMarginPct, medianRevenue]);

  // ── Category Margin Trend — weekly margin %, every category (a heatmap scales to more rows
  //    than a multi-line chart could stay readable with) ──────────────────────────────────────
  const heatmapRows: WeekHeatmapRow[] = useMemo(() => {
    const byCategory = new Map<string, CategoryTrendPoint[]>();
    for (const p of trendPoints) {
      const list = byCategory.get(p.categoryId) ?? [];
      list.push(p);
      byCategory.set(p.categoryId, list);
    }
    return [...rows]
      .sort((a, b) => b.marginPct - a.marginPct)
      .map((r) => ({
        id: r.categoryId,
        label: r.name,
        weeks: weeklyMarginSeries(byCategory.get(r.categoryId) ?? [], days).map((w) => ({ date: w.date, label: w.label, value: w.marginPct })),
      }));
  }, [rows, trendPoints, days]);

  const highlightItems: ActionPanelItem[] = [
    ...(topContributor
      ? [{
          key: "best-contributor",
          icon: <IconTrophy size={16} />,
          tone: "primary" as const,
          title: "Best Contributor",
          description: `${topContributor.name} contributed ${formatMoney(topContributor.marginN)} (${topContributor.contributionPct.toFixed(1)}% of total gross profit) at a ${topContributor.marginPct.toFixed(1)}% margin — ${topContributor.marginPct >= blendedMarginPct ? "efficient scale, not just volume" : "worth watching since its own margin trails the portfolio average"}.`,
          count: Number(topContributor.contributionPct.toFixed(1)),
          countLabel: "% of profit",
          onClick: () => toggleCategoryFilter(topContributor.categoryId),
          examples: [{ label: topContributor.name, badge: formatMoney(topContributor.marginN), tone: "positive" as const }],
        }]
      : []),
    ...(highestMargin
      ? (() => {
          const gapPp = highestMargin.marginPct - effectiveTargetPct;
          return [{
            key: "highest-margin",
            icon: <IconCheckCircle size={16} />,
            tone: "primary" as const,
            title: "Highest Margin",
            description: `${highestMargin.name} leads at a ${highestMargin.marginPct.toFixed(1)}% margin — ${Math.abs(gapPp).toFixed(1)}pp ${gapPp >= 0 ? "above" : "still below"} the ${effectiveTargetPct.toFixed(0)}% target, contributing ${formatMoney(highestMargin.marginN)} in gross profit.`,
            count: Number(highestMargin.marginPct.toFixed(1)),
            countLabel: "% margin",
            onClick: () => toggleCategoryFilter(highestMargin.categoryId),
            examples: [{ label: highestMargin.name, badge: `${highestMargin.marginPct.toFixed(1)}%`, tone: "positive" as const }],
          }];
        })()
      : []),
    ...(biggestOpportunity
      ? [{
          key: "biggest-opportunity",
          icon: <IconAlertTriangle size={16} />,
          tone: "warning" as const,
          title: "Biggest Opportunity",
          description: `${biggestOpportunity.name} sits ${(effectiveTargetPct - biggestOpportunity.marginPct).toFixed(1)}pp below the ${effectiveTargetPct.toFixed(0)}% target on ${formatMoney(biggestOpportunity.revenueN)} of revenue — closing that gap is worth roughly ${formatMoney(biggestOpportunity.revenueN * ((effectiveTargetPct - biggestOpportunity.marginPct) / 100))} in additional gross profit.`,
          count: Number(biggestOpportunity.marginPct.toFixed(1)),
          countLabel: "% margin",
          onClick: () => toggleCategoryFilter(biggestOpportunity.categoryId),
          examples: [{ label: biggestOpportunity.name, badge: `${biggestOpportunity.marginPct.toFixed(1)}%`, tone: "negative" as const }],
        }]
      : []),
    ...(topContributor
      ? [{
          key: "view-demand",
          icon: <IconEye size={16} />,
          tone: "muted" as const,
          title: "View Demand in Category Sales",
          description: "This page is margin only — see revenue, units sold and growth per category.",
          count: 1,
          countLabel: "report",
          onClick: () => onNavigate("sales", "category-sales"),
          examples: [{ label: topContributor.name, badge: "Top by gross profit", tone: "neutral" as const }],
        }]
      : []),
  ];

  const hierarchyRows: HierarchyParentRow[] = rows;
  const selectedCategory = selectedCategoryId ? (hierarchyRows.find((r) => r.categoryId === selectedCategoryId) ?? null) : null;
  const tableRows = selectedCategory ? [selectedCategory] : hierarchyRows;
  const activeFilterPills: FilterPill[] = selectedCategory ? [{ key: "cat", label: selectedCategory.name }] : [];

  useEffect(() => {
    if (rows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `margin-by-category-${days}d.csv`,
      headers: ["Category", "Revenue", "COGS", "Gross Profit", "Margin %", "Contribution %", "Growth %"],
      rows: rows.map((r) => [r.name, r.revenueN, r.costN, r.marginN, r.marginPct.toFixed(1), r.contributionPct.toFixed(1), r.growthPct?.toFixed(1) ?? ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [rows, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Median Category Margin"
          value={loading ? "…" : `${medianCategoryMarginPct.toFixed(1)}%`}
          subtitle="Typical category, not revenue-weighted"
          icon={<IconPill size={16} />}
          iconTone="info"
        />
        <StatCard size="sm" showMenu={false}
          title="Categories Below Target"
          value={loading ? "…" : `${belowTargetCount} of ${rows.length}`}
          subtitle={`Below ${effectiveTargetPct.toFixed(0)}% target${targetPct == null ? " (default)" : ""}`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
        />
        <StatCard size="sm" showMenu={false}
          title="Highest Margin Category"
          value={loading || !highestMargin ? "…" : highestMargin.name}
          subtitle={highestMargin ? `${highestMargin.marginPct.toFixed(1)}% margin` : ""}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && highestMargin?.growthPct != null ? { value: formatPctTrend(highestMargin.growthPct), direction: highestMargin.growthPct >= 0 ? "up" : "down", tone: highestMargin.growthPct >= 0 ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Biggest Margin Opportunity"
          value={loading ? "…" : biggestOpportunity ? biggestOpportunity.name : "None"}
          subtitle={biggestOpportunity ? `${biggestOpportunity.marginPct.toFixed(1)}% margin, ${(effectiveTargetPct - biggestOpportunity.marginPct).toFixed(1)}pp below target` : "All categories at/above target"}
          icon={<IconTrophy size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Category Margin vs Benchmark</h3>
              <p>Each category&apos;s margin % against {targetPct != null ? "the configured target" : "the blended portfolio average"}</p>
            </div>
          </div>
          <CategoryBenchmarkChart
            rows={benchmarkRows}
            benchmarkPct={targetPct ?? blendedMarginPct}
            benchmarkLabel={`${(targetPct ?? blendedMarginPct).toFixed(1)}%`}
            onRowClick={toggleCategoryFilter}
            activeId={selectedCategoryId}
          />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Category Margin Opportunity Matrix</h3>
              <p>Protect, grow, fix or review — based on target margin and revenue scale</p>
            </div>
          </div>
          <CategoryOpportunityMatrix
            quadrants={quadrants}
            marginSplitLabel={targetPct != null ? `${targetPct.toFixed(1)}% target margin` : `${blendedMarginPct.toFixed(1)}% portfolio average`}
            revenueSplitLabel={`${formatCompactMoney(medianRevenue)} median revenue`}
            onTagClick={toggleCategoryFilter}
            activeId={selectedCategoryId}
          />
        </div>
      </div>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Category Margin Trend</h3>
              <p>Weekly margin % by category</p>
            </div>
          </div>
          {loading || trendLoading ? (
            <p className={css.emptyNote}>Loading trend…</p>
          ) : (
            <EntityWeekHeatmap rows={heatmapRows} onRowClick={toggleCategoryFilter} activeId={selectedCategoryId} />
          )}
        </div>

        <ActionsPanel title="Category Insights" items={highlightItems} variant="cards" pageSize={3} />
      </div>

      <div className={css.card} ref={tableRef}>
        <div className={css.cardhead}>
          <div>
            <h3>Category Profitability Breakdown</h3>
            <p>Top-level departments — click a row to expand its sub-categories.</p>
          </div>
        </div>
        {selectedCategory && activeFilterPills.length > 0 && (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by category · ${selectedCategory.children.length} sub-categor${selectedCategory.children.length === 1 ? "y" : "ies"}`}
              pills={activeFilterPills}
              onClear={() => setSelectedCategoryId(null)}
              clearTooltip="Show all categories"
            />
          </div>
        )}
        <CategoryHierarchyTable rows={tableRows} loading={loading} focusId={selectedCategoryId} emptyTitle="No categorized sales in this range" />
      </div>
    </div>
  );
}
