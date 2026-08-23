"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconDollarSign, IconGrid, IconSearch } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fetchCategoryComparison, type MarginTotals } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { CategoryMixCard } from "../components/category-mix-card";
import { CategoryChildBreakdown } from "../components/category-child-breakdown";
import { categoryMixColor } from "../lib/category-mix-colors";
import { CategoryIconBadge } from "@/lib/category-icons";
import { InlineBarCell } from "../components/inline-bar-cell";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { ReportSelect } from "../components/report-select";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import type { CategoryChildRow, CategoryGroupBy, CategoryRow, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

/** Matches `CategoryMixCard`'s own default — rows past this rank fold into the donut's "Others"
 *  slice, which has no single stable color/id, so the child-breakdown hover only ever needs to
 *  resolve a color for a row within this many top slices. */
const DONUT_MAX_SLICES = 8;

type Props = {
  scope: Scope;
  isOwner: boolean;
  days: number;
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

type EnrichedChildRow = CategoryChildRow & {
  revenueN: number;
  costN: number;
  marginN: number;
  marginPct: number;
  growthPct: number | null;
  previousRevenueN: number | null;
};

type EnrichedRow = Omit<CategoryRow, "children"> & {
  revenueN: number;
  costN: number;
  marginN: number;
  marginPct: number;
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
  marginN: number;
  marginPct: number;
  unitsSold: number;
  growthPct: number | null;
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function CategorySalesSection({ scope, isOwner, days, onExportData, groupBy, excludeUnclassified }: Props) {
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
          const costN = Number(r.cost);
          const marginN = revenueN - costN;
          const prev = catRes.previousByCategory.get(r.categoryId);
          const children: EnrichedChildRow[] | undefined = r.children?.map((c) => {
            const cRevenueN = Number(c.revenue);
            const cCostN = Number(c.cost);
            const cMarginN = cRevenueN - cCostN;
            const cPrev = catRes.previousByChildCategory.get(c.categoryId);
            return {
              ...c,
              revenueN: cRevenueN,
              costN: cCostN,
              marginN: cMarginN,
              marginPct: cRevenueN > 0 ? (cMarginN / cRevenueN) * 100 : 0,
              growthPct: cPrev ? pctChange(cRevenueN, cPrev.revenue) : null,
              previousRevenueN: cPrev ? Number(cPrev.revenue) : null,
            };
          });
          return {
            ...r,
            revenueN,
            costN,
            marginN,
            marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0,
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

  const visibleRows = useMemo(() => {
    if (!excludeUnclassified) return rows;
    return rows
      .filter((r) => !r.isUnclassified)
      .map((r) => (r.children ? { ...r, children: r.children.filter((c) => !c.isUnclassified) } : r));
  }, [rows, excludeUnclassified]);

  const totalRevenue = visibleRows.reduce((s, r) => s + r.revenueN, 0);
  const totalMargin = visibleRows.reduce((s, r) => s + r.marginN, 0);
  const grossMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
  const previousGrossMarginPct = previousTotals.revenue > 0 ? (previousTotals.margin / previousTotals.revenue) * 100 : 0;
  const contributingCount = visibleRows.length;
  const contributingDelta = contributingCount - previousContributingCount;

  const medianRevenue = useMemo(() => median(visibleRows.map((r) => r.revenueN)), [visibleRows]);
  const avgMarginPct = visibleRows.length > 0 ? visibleRows.reduce((s, r) => s + r.marginPct, 0) / visibleRows.length : 0;
  const avgRevenuePerCategory = visibleRows.length > 0 ? totalRevenue / visibleRows.length : 0;
  // "Established" = at/above median revenue — keeps a single high-margin sale on a tiny
  // long-tail category from winning "Highest Margin"/"At Risk" over categories that actually matter.
  const establishedRows = useMemo(() => visibleRows.filter((r) => r.revenueN >= medianRevenue), [visibleRows, medianRevenue]);

  const topPerformer = useMemo(() => [...visibleRows].sort((a, b) => b.revenueN - a.revenueN)[0] ?? null, [visibleRows]);
  const highestMargin = useMemo(
    () => [...establishedRows].sort((a, b) => b.marginPct - a.marginPct)[0] ?? null,
    [establishedRows],
  );
  const atRisk = useMemo(() => {
    const declining = establishedRows.filter((r): r is EnrichedRow & { growthPct: number } => r.growthPct != null && r.growthPct < 0);
    return declining.sort((a, b) => a.growthPct - b.growthPct)[0] ?? null;
  }, [establishedRows]);
  const opportunity = useMemo(() => {
    const pool = visibleRows.filter((r) => r.marginPct > avgMarginPct && r.revenueN < avgRevenuePerCategory);
    return [...pool].sort((a, b) => b.marginPct - a.marginPct)[0] ?? null;
  }, [visibleRows, avgMarginPct, avgRevenuePerCategory]);

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
    ...(highestMargin
      ? [{
          key: "highest-margin",
          icon: <IconActivity size={16} />,
          tone: "purple" as const,
          title: "Highest Margin",
          description: `Best gross margin among established ${dimensionLabel.toLowerCase()}s`,
          count: Number(highestMargin.marginPct.toFixed(1)),
          countLabel: "% margin",
          onClick: () => focusRow(highestMargin.categoryId),
          examples: [{ label: highestMargin.name }],
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
    ...(opportunity
      ? [{
          key: "opportunity",
          icon: <IconGrid size={16} />,
          tone: "warning" as const,
          title: "Opportunity",
          description: "Strong margins with room to grow revenue share",
          count: Number(opportunity.marginPct.toFixed(1)),
          countLabel: "% margin",
          onClick: () => focusRow(opportunity.categoryId),
          examples: [{ label: opportunity.name }],
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
  // (see Product Sales' "All Products" table) instead of a page-local clear affordance.
  const activeFilterPills: FilterPill[] = drilledParent
    ? [{ key: "dept", label: `Department: ${drilledParent.name}` }]
    : [];

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
      headers: [tableNameLabel, "Net Sales", "% of Total", "Gross Profit", "Gross Margin %", "Units Sold", "Growth %"],
      rows: filteredRows.map((r) => [
        r.name,
        r.revenueN,
        tableTotalRevenue > 0 ? ((r.revenueN / tableTotalRevenue) * 100).toFixed(1) : "0",
        r.marginN,
        r.marginPct.toFixed(1),
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
    { key: "marginN", header: "Gross Profit", align: "right", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    { key: "marginPct", header: "Gross Margin", align: "right", sortable: true, getValue: (r) => r.marginPct, render: (r) => `${r.marginPct.toFixed(1)}%` },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "growthPct", header: "Growth", align: "right", sortable: true, getValue: (r) => r.growthPct ?? 0, render: (r) => (r.growthPct == null ? "—" : <span className={r.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growthPct)}</span>) },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title="Net Sales"
          value={loading ? "…" : formatMoney(totalRevenue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && previousTotals.revenue > 0 ? { value: formatPctTrend(pctChange(totalRevenue, previousTotals.revenue)), direction: totalRevenue >= previousTotals.revenue ? "up" : "down", tone: totalRevenue >= previousTotals.revenue ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Gross Profit"
          value={loading ? "…" : formatMoney(totalMargin)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && previousTotals.margin > 0 ? { value: formatPctTrend(pctChange(totalMargin, previousTotals.margin)), direction: totalMargin >= previousTotals.margin ? "up" : "down", tone: totalMargin >= previousTotals.margin ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Gross Margin"
          value={loading ? "…" : `${grossMarginPct.toFixed(1)}%`}
          subtitle={`vs previous ${days} days`}
          icon={<IconActivity size={16} />}
          iconTone="success"
          trend={!loading && previousTotals.revenue > 0 ? { value: `${grossMarginPct >= previousGrossMarginPct ? "+" : ""}${(grossMarginPct - previousGrossMarginPct).toFixed(1)}pp`, direction: grossMarginPct >= previousGrossMarginPct ? "up" : "down", tone: grossMarginPct >= previousGrossMarginPct ? "positive" : "danger" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title={`${dimensionLabel}s Contributing`}
          value={loading ? "…" : contributingCount}
          subtitle={`vs previous ${days} days`}
          icon={<IconGrid size={16} />}
          iconTone="warning"
          trend={!loading && previousContributingCount > 0 ? { value: `${contributingDelta >= 0 ? "+" : ""}${contributingDelta}`, direction: contributingDelta >= 0 ? "up" : "down", tone: contributingDelta >= 0 ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={`${css.card} ${css.categoryMixWrap}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Sales by {dimensionLabel}</h3>
              <p>
                {scope === "tenant" ? "All branches" : "This branch"}
                {groupBy === "commercial" ? " · hover a slice to see its breakdown" : ""}
              </p>
            </div>
          </div>
          <CategoryMixCard
            rows={visibleRows.map((r) => ({ id: r.categoryId, label: r.name, value: r.revenueN }))}
            totalRevenue={totalRevenue}
            maxSlices={DONUT_MAX_SLICES}
            onHoverRow={groupBy === "commercial" ? setHoveredParentId : undefined}
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

      <div className={css.card} id="category-details-table">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>
            {dimensionLabel} Performance
            {focusedRow ? (
              <button type="button" className={css.focusClearBtn} onClick={() => setCategoryFocus(null)}>
                {focusedRow.name} ×
              </button>
            ) : null}
          </h3>
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
              summary={`Filtered by department · ${filteredRows.length} sub-categor${filteredRows.length === 1 ? "y" : "ies"}`}
              pills={activeFilterPills}
              onClear={() => setCategoryParentFilter("")}
              clearTooltip="Show all departments"
            />
          </div>
        )}

        <DataTable columns={columns} data={filteredRows} rowKey={(r) => r.categoryId} loading={loading} pageSize={10} emptyTitle="No categories match" compact />
      </div>
    </div>
  );
}
