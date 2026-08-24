"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconDollarSign, IconEye, IconGrid, IconSearch } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fetchCategoryComparison, fetchMarginTrendByCategory, type MarginTotals } from "../lib/fetchers";
import { formatDateShort, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { CategoryMixCard } from "../components/category-mix-card";
import { CategoryChildBreakdown } from "../components/category-child-breakdown";
import { EntityWeekHeatmap, type WeekHeatmapRow } from "../components/entity-week-heatmap";
import { categoryMixColor } from "../lib/category-mix-colors";
import { CategoryIconBadge } from "@/lib/category-icons";
import { InlineBarCell } from "../components/inline-bar-cell";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { ReportSelect } from "../components/report-select";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { CategoryChildRow, CategoryGroupBy, CategoryRow, CategoryTrendPoint, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

/** Matches `CategoryMixCard`'s own default — rows past this rank fold into the donut's "Others"
 *  slice, which has no single stable color/id, so the child-breakdown hover only ever needs to
 *  resolve a color for a row within this many top slices. */
const DONUT_MAX_SLICES = 8;

type Props = {
  scope: Scope;
  isOwner: boolean;
  days: number;
  onNavigate: (c: CategoryKey, r?: ReportKey) => void;
  onExportData: OnExportData;
  /** Classification lens to group by — owned by `ReportsWorkspace` (rendered via the filter
   *  bar's "Group By" control) so it survives the section re-mounting on other filter changes. */
  groupBy: CategoryGroupBy;
  excludeUnclassified: boolean;
};

const DIMENSION_LABELS: Record<CategoryGroupBy, string> = {
  commercial: "Category",
  dosageForm: "Dosage Form",
  schedule: "Schedule",
  registrationType: "Registration Type",
};

const DIMENSION_LABELS_PLURAL: Record<CategoryGroupBy, string> = {
  commercial: "Categories",
  dosageForm: "Dosage Forms",
  schedule: "Schedules",
  registrationType: "Registration Types",
};

// Demand composition only — no cost/margin here, that's Category Profitability's job. `revenue`
// stays denominated by revenue (the demand signal); `previousRevenueN` is kept (not just the
// derived `growthPct`) so mix-shift math can compare each category's share of total revenue
// across periods, not just its own revenue trend in isolation.
type EnrichedChildRow = CategoryChildRow & {
  revenueN: number;
  growthPct: number | null;
  previousRevenueN: number | null;
};

type EnrichedRow = Omit<CategoryRow, "children"> & {
  revenueN: number;
  growthPct: number | null;
  previousRevenueN: number | null;
  children?: EnrichedChildRow[];
};

/** Fields the Category Performance table/columns actually read — both parent rows
 *  (`EnrichedRow`) and a drilled-in parent's leaf rows (`EnrichedChildRow`) satisfy this
 *  shape, so the same `DataTable`/columns render either level without a union type. */
type PerformanceRow = {
  categoryId: string;
  name: string;
  revenueN: number;
  unitsSold: number;
  growthPct: number | null;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Buckets a category's day-level revenue points into fixed 7-day windows (same fixed-week-
 *  boundary convention `margin-by-category-section.tsx`'s own `weeklyMarginSeries` uses, so every
 *  category's row lands on the same week columns even with gaps), then expresses each week's
 *  revenue as % growth over the immediately preceding week — a growth-heatmap needs a trend, and
 *  this page has no cost data to compute margin% from, so growth-over-time is the demand-side
 *  equivalent. The first week has no prior week to compare against, so it's always `null` (no
 *  fabricated 0%), same as a week with zero revenue. */
function weeklyGrowthSeries(points: CategoryTrendPoint[], days: number): Array<{ date: string; label: string; value: number | null }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeStart = new Date(today);
  rangeStart.setDate(rangeStart.getDate() - (days - 1));
  const byDate = new Map(points.map((p) => [p.date, p]));

  const weekRevenues: Array<{ date: string; label: string; revenue: number }> = [];
  for (let i = 0; i < days; i += 7) {
    let revenue = 0;
    let weekStartKey = "";
    for (let j = i; j < Math.min(i + 7, days); j++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + j);
      const key = d.toISOString().slice(0, 10);
      if (j === i) weekStartKey = key;
      const p = byDate.get(key);
      if (p) revenue += Number(p.revenue);
    }
    weekRevenues.push({ date: weekStartKey, label: formatDateShort(weekStartKey), revenue });
  }
  return weekRevenues.map((w, i) => {
    const prevRevenue = i === 0 ? null : weekRevenues[i - 1]!.revenue;
    return {
      date: w.date,
      label: w.label,
      value: prevRevenue == null || prevRevenue === 0 ? null : ((w.revenue - prevRevenue) / prevRevenue) * 100,
    };
  });
}

export function CategorySalesSection({ scope, isOwner, days, onNavigate, onExportData, groupBy, excludeUnclassified }: Props) {
  const dimensionLabel = DIMENSION_LABELS[groupBy];

  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [previousTotals, setPreviousTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousContributingCount, setPreviousContributingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFocus, setCategoryFocus] = useState<string | null>(null);
  const [hoveredParentId, setHoveredParentId] = useState<string | null>(null);
  // Drills the Category Performance table down into one parent department's own leaf
  // categories — "" means the table shows department-level rows (the default).
  const [categoryParentFilter, setCategoryParentFilter] = useState<string>("");
  const [trendPoints, setTrendPoints] = useState<CategoryTrendPoint[]>([]);

  // A stale hovered/drilled-into id from a previous dimension would otherwise suppress the
  // default top-row breakdown, or point the table's drill-down at an id that no longer exists —
  // reset explicitly so switching dimensions always lands on a clean default.
  useEffect(() => {
    setHoveredParentId(null);
    setCategoryParentFilter("");
  }, [groupBy]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCategoryComparison(days, scope, isOwner, groupBy)
      .then((catRes) => {
        if (cancelled) return;
        const enriched: EnrichedRow[] = catRes.current.map((r) => {
          const revenueN = Number(r.revenue);
          const prev = catRes.previousByCategory.get(r.categoryId);
          const children: EnrichedChildRow[] | undefined = r.children?.map((c) => {
            const cRevenueN = Number(c.revenue);
            const cPrev = catRes.previousByChildCategory.get(c.categoryId);
            return {
              ...c,
              revenueN: cRevenueN,
              growthPct: cPrev ? pctChange(cRevenueN, cPrev.revenue) : null,
              previousRevenueN: cPrev ? Number(cPrev.revenue) : null,
            };
          });
          return {
            ...r,
            revenueN,
            growthPct: prev ? pctChange(revenueN, prev.revenue) : null,
            previousRevenueN: prev ? Number(prev.revenue) : null,
            children,
          };
        });
        setRows(enriched);
        setPreviousTotals(catRes.previousTotals);
        setPreviousContributingCount([...catRes.previousByCategory.values()].filter((v) => v.revenue > 0).length);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load category sales data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner, groupBy]);

  // Growth heatmap trend source — `marginTrendByCategory` only ever rolls up to top-level
  // COMMERCIAL departments (mirrors `salesByCategory`'s own "commercial" grouping), so it's the
  // only lens with real day-level history to bucket into weeks; the other 3 lenses (Dosage Form/
  // Schedule/Registration Type) have no matching trend endpoint and skip the heatmap entirely
  // below rather than fabricating one from a mismatched category id space.
  useEffect(() => {
    if (groupBy !== "commercial") {
      setTrendPoints([]);
      return;
    }
    let cancelled = false;
    fetchMarginTrendByCategory(days, scope, isOwner)
      .then((r) => {
        if (!cancelled) setTrendPoints(r.points);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner, groupBy]);

  const visibleRows = useMemo(() => {
    if (!excludeUnclassified) return rows;
    return rows
      .filter((r) => !r.isUnclassified)
      .map((r) => (r.children ? { ...r, children: r.children.filter((c) => !c.isUnclassified) } : r));
  }, [rows, excludeUnclassified]);

  const totalRevenue = visibleRows.reduce((s, r) => s + r.revenueN, 0);
  const contributingCount = visibleRows.length;
  const contributingDelta = contributingCount - previousContributingCount;

  const medianRevenue = useMemo(() => median(visibleRows.map((r) => r.revenueN)), [visibleRows]);
  // "Established" = at/above median revenue — keeps a single fast-growing long-tail category
  // from winning "Fastest Growing"/"At Risk" over categories that actually move the business.
  const establishedRows = useMemo(() => visibleRows.filter((r) => r.revenueN >= medianRevenue), [visibleRows, medianRevenue]);

  const topPerformer = useMemo(() => [...visibleRows].sort((a, b) => b.revenueN - a.revenueN)[0] ?? null, [visibleRows]);
  const fastestGrowingCategory = useMemo(() => {
    const withGrowth = establishedRows.filter((r): r is EnrichedRow & { growthPct: number } => r.growthPct != null);
    return withGrowth.sort((a, b) => b.growthPct - a.growthPct)[0] ?? null;
  }, [establishedRows]);
  const atRisk = useMemo(() => {
    const declining = establishedRows.filter((r): r is EnrichedRow & { growthPct: number } => r.growthPct != null && r.growthPct < 0);
    return declining.sort((a, b) => a.growthPct - b.growthPct)[0] ?? null;
  }, [establishedRows]);
  // "Is the business becoming more dependent on particular categories?" — the category whose
  // share of total revenue moved the most between periods, not just its raw revenue growth (a
  // small category can post huge % growth off a tiny base without actually shifting the mix).
  const mixShift = useMemo(() => {
    if (previousTotals.revenue <= 0 || totalRevenue <= 0) return null;
    const withShift = visibleRows
      .filter((r) => r.previousRevenueN != null)
      .map((r) => {
        const shareNow = (r.revenueN / totalRevenue) * 100;
        const sharePrev = (r.previousRevenueN! / previousTotals.revenue) * 100;
        return { row: r, shareDelta: shareNow - sharePrev };
      });
    return withShift.sort((a, b) => Math.abs(b.shareDelta) - Math.abs(a.shareDelta))[0] ?? null;
  }, [visibleRows, totalRevenue, previousTotals.revenue]);

  const heatmapRows: WeekHeatmapRow[] = useMemo(() => {
    if (groupBy !== "commercial" || trendPoints.length === 0) return [];
    const byCategory = new Map<string, CategoryTrendPoint[]>();
    for (const p of trendPoints) {
      const list = byCategory.get(p.categoryId) ?? [];
      list.push(p);
      byCategory.set(p.categoryId, list);
    }
    return [...visibleRows]
      .sort((a, b) => b.revenueN - a.revenueN)
      .map((r) => ({ id: r.categoryId, label: r.name, weeks: weeklyGrowthSeries(byCategory.get(r.categoryId) ?? [], days) }));
  }, [groupBy, trendPoints, visibleRows, days]);

  function focusRow(categoryId: string) {
    // Insight cards always point at a department-level row — drop any active drill-down so the
    // highlighted row is actually visible in the table.
    setCategoryParentFilter("");
    setCategoryFocus((cur) => (cur === categoryId ? null : categoryId));
    document.getElementById("category-details-table")?.scrollIntoView({ behavior: "smooth" });
  }

  const insightItems: ActionPanelItem[] = [
    ...(topPerformer
      ? [{
          key: "top-performer",
          icon: <IconDollarSign size={16} />,
          tone: "primary" as const,
          title: "Top Performer",
          description: `Highest revenue ${dimensionLabel.toLowerCase()} this period`,
          count: totalRevenue > 0 ? Number(((topPerformer.revenueN / totalRevenue) * 100).toFixed(1)) : 0,
          countLabel: "% of sales",
          onClick: () => focusRow(topPerformer.categoryId),
          examples: [{
            label: topPerformer.name,
            badge: topPerformer.growthPct != null ? formatPctTrend(topPerformer.growthPct) : undefined,
            tone: (topPerformer.growthPct != null && topPerformer.growthPct >= 0 ? "positive" : "neutral") as
              | "positive"
              | "neutral",
          }],
        }]
      : []),
    ...(fastestGrowingCategory
      ? [{
          key: "fastest-growing",
          icon: <IconActivity size={16} />,
          tone: "purple" as const,
          title: "Fastest Growing",
          description: `Strongest revenue growth among established ${DIMENSION_LABELS_PLURAL[groupBy].toLowerCase()}`,
          count: Number(fastestGrowingCategory.growthPct.toFixed(1)),
          countLabel: "% growth",
          onClick: () => focusRow(fastestGrowingCategory.categoryId),
          examples: [{ label: fastestGrowingCategory.name, badge: formatPctTrend(fastestGrowingCategory.growthPct), tone: "positive" as const }],
        }]
      : []),
    ...(atRisk
      ? [{
          key: "at-risk",
          icon: <IconAlertTriangle size={16} />,
          tone: "danger" as const,
          title: "At Risk",
          description: "Largest revenue decline vs the previous period",
          count: Number(Math.abs(atRisk.growthPct).toFixed(1)),
          countLabel: "% down",
          onClick: () => focusRow(atRisk.categoryId),
          examples: [{ label: atRisk.name, badge: formatPctTrend(atRisk.growthPct), tone: "negative" as const }],
        }]
      : []),
    ...(mixShift
      ? [{
          key: "mix-shift",
          icon: <IconGrid size={16} />,
          tone: "warning" as const,
          title: mixShift.shareDelta >= 0 ? "Growing Its Share" : "Losing Its Share",
          description: `Biggest change in share of total revenue vs the previous period`,
          count: Number(Math.abs(mixShift.shareDelta).toFixed(1)),
          countLabel: "pp share shift",
          onClick: () => focusRow(mixShift.row.categoryId),
          examples: [{
            label: mixShift.row.name,
            badge: `${mixShift.shareDelta >= 0 ? "+" : ""}${mixShift.shareDelta.toFixed(1)}pp`,
            tone: (mixShift.shareDelta >= 0 ? "positive" : "negative") as "positive" | "negative",
          }],
        }]
      : []),
    // Commercial-only — the other 3 classification lenses (Dosage Form/Schedule/Registration Type)
    // have no Profitability-side counterpart page to link to.
    ...(groupBy === "commercial" && topPerformer
      ? [{
          key: "view-margin",
          icon: <IconEye size={16} />,
          tone: "muted" as const,
          title: "View Margin in Category Profitability",
          description: "This page is demand only — see cost, gross profit and margin % per category.",
          count: 1,
          countLabel: "report",
          onClick: () => onNavigate("profitability", "margin-by-category"),
          examples: [{ label: topPerformer.name, badge: "Top by revenue", tone: "neutral" as const }],
        }]
      : []),
  ];

  // The Category Performance table's own drill-down: picking a department in its "Category"
  // filter swaps the table's row set from departments to that department's own leaf categories
  // (a detailed parent → child breakdown), independent of the donut's hover-driven preview above.
  const drilledParent =
    groupBy === "commercial" && categoryParentFilter
      ? (visibleRows.find((r) => r.categoryId === categoryParentFilter) ?? null)
      : null;
  const tableSourceRows: PerformanceRow[] = useMemo(
    () => (drilledParent ? (drilledParent.children ?? []) : visibleRows),
    [drilledParent, visibleRows],
  );
  const tableTotalRevenue = drilledParent ? drilledParent.revenueN : totalRevenue;

  const filteredRows = useMemo(() => {
    let out = tableSourceRows;
    if (search) out = out.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
    if (!drilledParent && categoryFocus) out = out.filter((r) => r.categoryId === categoryFocus);
    return out;
  }, [tableSourceRows, search, categoryFocus, drilledParent]);

  const focusedRow =
    !drilledParent && categoryFocus ? (visibleRows.find((r) => r.categoryId === categoryFocus) ?? null) : null;
  const maxRevenue = Math.max(1, ...tableSourceRows.map((r) => r.revenueN));

  const parentFilterOptions = useMemo(
    () => [
      { value: "", label: "All departments" },
      ...visibleRows.map((r) => ({ value: r.categoryId, label: r.name })),
    ],
    [visibleRows],
  );

  // Same "Filtered X · N results" banner + pill convention as every other report/list page
  // (see Product Sales' "All Products" table) instead of a page-local clear affordance — the
  // department drill-down and the donut/heatmap row-focus are mutually exclusive (`filteredRows`
  // only applies `categoryFocus` when there's no `drilledParent`), so exactly one of these two
  // pills is ever shown at once.
  const activeFilterPills: FilterPill[] = drilledParent
    ? [{ key: "dept", label: `Department: ${drilledParent.name}` }]
    : focusedRow
      ? [{ key: "cat", label: focusedRow.name }]
      : [];
  const activeFilterSummary = drilledParent
    ? `Filtered by department · ${filteredRows.length} sub-categor${filteredRows.length === 1 ? "y" : "ies"}`
    : `Filtered by ${dimensionLabel.toLowerCase()} · ${filteredRows.length} row${filteredRows.length === 1 ? "" : "s"}`;
  function clearTableFilter() {
    if (drilledParent) setCategoryParentFilter("");
    else setCategoryFocus(null);
  }

  // Child-breakdown-on-hover only applies to the commercial dimension — that's the only lens
  // with a parent/child department hierarchy; the others are flat.
  const activeParentId = hoveredParentId ?? visibleRows[0]?.categoryId ?? null;
  const activeParentIndex = activeParentId ? visibleRows.findIndex((r) => r.categoryId === activeParentId) : -1;
  const activeParent =
    groupBy === "commercial" && activeParentIndex >= 0 && activeParentIndex < DONUT_MAX_SLICES
      ? visibleRows[activeParentIndex]
      : null;
  const activeParentColor = activeParentIndex >= 0 ? categoryMixColor(activeParentIndex) : categoryMixColor(0);

  const tableNameLabel = drilledParent ? "Sub-category" : dimensionLabel;

  useEffect(() => {
    if (filteredRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `${groupBy}-sales-${days}d${drilledParent ? `-${drilledParent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}.csv`,
      headers: [tableNameLabel, "Net Sales", "% of Total", "Units Sold", "Growth %"],
      rows: filteredRows.map((r) => [
        r.name,
        r.revenueN,
        tableTotalRevenue > 0 ? ((r.revenueN / tableTotalRevenue) * 100).toFixed(1) : "0",
        r.unitsSold,
        r.growthPct?.toFixed(1) ?? "",
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [filteredRows, tableTotalRevenue, days, onExportData, groupBy, tableNameLabel, drilledParent]);

  // Icons only make sense for the commercial-department dimension's top-level rows — a drilled-in
  // department's own sub-categories, and the other lenses (Dosage Form/Schedule/Registration
  // Type), aren't Commercial Categories and have no icon in that set.
  const showCategoryIcon = groupBy === "commercial" && !drilledParent;

  const columns: Column<PerformanceRow>[] = [
    { key: "name", header: tableNameLabel, render: (r) => (
      showCategoryIcon ? (
        <span className={css.categoryCell}>
          <CategoryIconBadge name={r.name} size={19} />
          <span>{r.name}</span>
        </span>
      ) : r.name
    ) },
    {
      key: "revenueN",
      header: "Net Sales",
      align: "right",
      sortable: true,
      getValue: (r) => r.revenueN,
      render: (r) => <InlineBarCell valueLabel={formatMoney(r.revenueN)} pct={(r.revenueN / maxRevenue) * 100} />,
    },
    { key: "share", header: "% of Total", align: "right", sortable: true, getValue: (r) => (tableTotalRevenue > 0 ? (r.revenueN / tableTotalRevenue) * 100 : 0), render: (r) => `${tableTotalRevenue > 0 ? ((r.revenueN / tableTotalRevenue) * 100).toFixed(1) : "0.0"}%` },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "growthPct", header: "Growth", align: "right", sortable: true, getValue: (r) => r.growthPct ?? 0, render: (r) => (r.growthPct == null ? "—" : <span className={r.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growthPct)}</span>) },
  ];

  const topCategorySharePct = topPerformer && totalRevenue > 0 ? (topPerformer.revenueN / totalRevenue) * 100 : 0;
  const decliningCount = visibleRows.filter((r) => r.growthPct != null && r.growthPct < 0).length;
  const growingCount = visibleRows.filter((r) => r.growthPct != null && r.growthPct > 0).length;

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title={`${DIMENSION_LABELS_PLURAL[groupBy]} Contributing`}
          value={loading ? "…" : contributingCount}
          subtitle={`vs previous ${days} days`}
          icon={<IconGrid size={16} />}
          trend={!loading && previousContributingCount > 0 ? { value: `${contributingDelta >= 0 ? "+" : ""}${contributingDelta}`, direction: contributingDelta >= 0 ? "up" : "down", tone: contributingDelta >= 0 ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Top Category Share"
          value={loading ? "…" : `${topCategorySharePct.toFixed(1)}%`}
          subtitle={topPerformer ? topPerformer.name : "Share of net sales"}
          icon={<IconDollarSign size={16} />}
          iconTone="info"
        />
        <StatCard
          size="sm" showMenu={false}
          title="Fastest Growing"
          value={loading || !fastestGrowingCategory ? "…" : fastestGrowingCategory.name}
          subtitle={fastestGrowingCategory ? formatPctTrend(fastestGrowingCategory.growthPct) : "No comparable growth yet"}
          icon={<IconActivity size={16} />}
          iconTone="success"
        />
        <StatCard
          size="sm" showMenu={false}
          title={`${DIMENSION_LABELS_PLURAL[groupBy]} Declining`}
          value={loading ? "…" : decliningCount}
          subtitle={`${growingCount} growing`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={`${css.card} ${css.categoryMixWrap}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Sales by {dimensionLabel}</h3>
              <p>
                {scope === "tenant" ? "All branches" : "This branch"}
                {groupBy === "commercial" ? " · hover a slice to see its breakdown, click to filter the table below" : " · click a slice to filter the table below"}
              </p>
            </div>
          </div>
          <CategoryMixCard
            rows={visibleRows.map((r) => ({ id: r.categoryId, label: r.name, value: r.revenueN }))}
            totalRevenue={totalRevenue}
            maxSlices={DONUT_MAX_SLICES}
            onHoverRow={groupBy === "commercial" ? setHoveredParentId : undefined}
            onSelectRow={focusRow}
            activeId={categoryFocus}
          />
          {activeParent && activeParent.children?.length ? (
            <CategoryChildBreakdown
              parentName={activeParent.name}
              parentColor={activeParentColor}
              childRows={activeParent.children}
              formatValue={formatMoney}
            />
          ) : null}
        </div>

        <ActionsPanel title="Category Insights" items={insightItems} variant="cards" onViewAll={() => document.getElementById("category-details-table")?.scrollIntoView({ behavior: "smooth" })} />
      </div>

      {groupBy === "commercial" ? (
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Category Growth Trend</h3>
              <p>Week-over-week revenue growth by category — is demand becoming more concentrated?</p>
            </div>
          </div>
          <EntityWeekHeatmap
            rows={heatmapRows}
            onRowClick={focusRow}
            activeId={categoryFocus}
            rowHeader="Category"
            formatValue={(n) => formatPctTrend(n)}
            legendLowLabel="Declining"
            legendHighLabel="Growing"
          />
        </div>
      ) : null}

      <div className={css.card} id="category-details-table">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>{dimensionLabel} Performance</h3>
          <div className={css.toolbarActions}>
            {groupBy === "commercial" ? (
              <ReportSelect
                ariaLabel="Filter by department"
                value={categoryParentFilter}
                onChange={setCategoryParentFilter}
                options={parentFilterOptions}
              />
            ) : null}
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input
                placeholder={`Search ${tableNameLabel.toLowerCase()}`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {activeFilterPills.length > 0 && (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={activeFilterSummary}
              pills={activeFilterPills}
              onClear={clearTableFilter}
              clearTooltip={drilledParent ? "Show all departments" : `Show all ${DIMENSION_LABELS_PLURAL[groupBy].toLowerCase()}`}
            />
          </div>
        )}

        <DataTable columns={columns} data={filteredRows} rowKey={(r) => r.categoryId} loading={loading} pageSize={10} emptyTitle="No categories match" compact />
      </div>
    </div>
  );
}
