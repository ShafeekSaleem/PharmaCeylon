"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconCheckCircle, IconDollarSign, IconPill, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { fetchCategoryComparison } from "../lib/fetchers";
import { formatCompactMoney, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { categoryMixColor } from "../lib/category-mix-colors";
import { CategoryTreemap, type TreemapTile } from "../components/category-treemap";
import { RevenueMarginBubbleChart, type BubblePoint } from "../components/revenue-margin-bubble-chart";
import { CategoryHierarchyTable, type HierarchyParentRow } from "../components/category-hierarchy-table";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryChildRow, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

type ChildEnriched = { categoryId: string; name: string; revenueN: number; costN: number; marginN: number; marginPct: number };
type CategoryEnriched = ChildEnriched & { contributionPct: number; growthPct: number | null; children: ChildEnriched[] };

function enrichChild(c: CategoryChildRow): ChildEnriched {
  const revenueN = Number(c.revenue);
  const costN = Number(c.cost);
  const marginN = revenueN - costN;
  return { categoryId: c.categoryId, name: c.name, revenueN, costN, marginN, marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0 };
}

/** Category-level profitability, COMMERCIAL dimension only — "which parts of the business
 *  generate profit?". Product-level detail lives on Margin by Product instead. */
export function MarginByCategorySection({ scope, isOwner, days, onExportData }: Props) {
  const [rows, setRows] = useState<CategoryEnriched[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
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

  const totalRevenue = rows.reduce((s, r) => s + r.revenueN, 0);
  const totalMargin = rows.reduce((s, r) => s + r.marginN, 0);
  // Blended (revenue-weighted) margin, not a naive average of each category's own margin % —
  // averaging percentages directly would let a tiny long-tail category with a freak 90% margin
  // skew the headline number even though it barely moves actual profit.
  const blendedMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;

  const medianRevenue = useMemo(() => {
    if (rows.length === 0) return 0;
    const sorted = rows.map((r) => r.revenueN).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  }, [rows]);
  // "Established" = at/above median revenue, so a single high-margin sale on a tiny long-tail
  // category doesn't win "Highest Margin" over categories that actually matter.
  const establishedRows = useMemo(() => rows.filter((r) => r.revenueN >= medianRevenue), [rows, medianRevenue]);
  const avgCategoryMarginPct = rows.length > 0 ? rows.reduce((s, r) => s + r.marginPct, 0) / rows.length : 0;
  const avgCategoryRevenue = rows.length > 0 ? totalRevenue / rows.length : 0;

  const topContributor = rows[0] ?? null;
  const highestMargin = [...establishedRows].sort((a, b) => b.marginPct - a.marginPct)[0] ?? null;
  const biggestOpportunity = [...establishedRows].sort((a, b) => a.marginPct - b.marginPct)[0] ?? null;

  const treemapTiles: TreemapTile[] = useMemo(
    () =>
      rows.map((r, i) => ({
        id: r.categoryId,
        label: r.name,
        color: categoryMixColor(i),
        revenue: r.revenueN,
        cost: r.costN,
        margin: r.marginN,
        marginPct: r.marginPct,
        contributionPct: r.contributionPct,
        growthPct: r.growthPct,
      })),
    [rows],
  );

  const bubblePoints: BubblePoint[] = useMemo(
    () =>
      rows.map((r, i) => ({
        id: r.categoryId,
        label: r.name,
        x: r.revenueN,
        y: r.marginPct,
        size: r.marginN,
        color: categoryMixColor(i),
        labeled: true,
        tooltip: `${r.name} — Revenue ${formatMoney(r.revenueN)} · Gross Profit ${formatMoney(r.marginN)} · Margin ${r.marginPct.toFixed(1)}% · Contribution ${r.contributionPct.toFixed(1)}%${r.growthPct != null ? ` · Growth ${formatPctTrend(r.growthPct)}` : ""}`,
      })),
    [rows],
  );

  const highlightItems: ActionPanelItem[] = [
    ...(topContributor
      ? [{
          key: "best-contributor",
          icon: <IconTrophy size={16} />,
          tone: "primary" as const,
          title: "Best Contributor",
          description: `${topContributor.name} contributed ${formatMoney(topContributor.marginN)} (${topContributor.contributionPct.toFixed(1)}% of total gross profit).`,
          count: Number(topContributor.contributionPct.toFixed(1)),
          countLabel: "% of profit",
          examples: [{ label: topContributor.name, badge: formatMoney(topContributor.marginN), tone: "positive" as const }],
        }]
      : []),
    ...(highestMargin
      ? [{
          key: "highest-margin",
          icon: <IconCheckCircle size={16} />,
          tone: "primary" as const,
          title: "Highest Margin",
          description: `${highestMargin.name} achieved ${highestMargin.marginPct.toFixed(1)}% average margin.`,
          count: Number(highestMargin.marginPct.toFixed(1)),
          countLabel: "% margin",
          examples: [{ label: highestMargin.name, badge: `${highestMargin.marginPct.toFixed(1)}%`, tone: "positive" as const }],
        }]
      : []),
    ...(biggestOpportunity
      ? [{
          key: "biggest-opportunity",
          icon: <IconAlertTriangle size={16} />,
          tone: "warning" as const,
          title: "Biggest Opportunity",
          description: `${biggestOpportunity.name} has the lowest margin (${biggestOpportunity.marginPct.toFixed(1)}%) among categories with meaningful revenue.`,
          count: Number(biggestOpportunity.marginPct.toFixed(1)),
          countLabel: "% margin",
          examples: [{ label: biggestOpportunity.name, badge: `${biggestOpportunity.marginPct.toFixed(1)}%`, tone: "negative" as const }],
        }]
      : []),
  ];

  const hierarchyRows: HierarchyParentRow[] = rows;

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
        <StatCard size="sm" showMenu={false} title="Category Gross Profit" value={loading ? "…" : formatMoney(totalMargin)} subtitle={`vs previous ${days} days`} icon={<IconDollarSign size={16} />} />
        <StatCard size="sm" showMenu={false} title="Average Category Margin" value={loading ? "…" : `${blendedMarginPct.toFixed(1)}%`} subtitle="Blended — weighted by revenue" icon={<IconPill size={16} />} iconTone="info" />
        <StatCard size="sm" showMenu={false}
          title="Highest Margin Category"
          value={loading || !highestMargin ? "…" : highestMargin.name}
          subtitle={highestMargin ? `${highestMargin.marginPct.toFixed(1)}% margin` : ""}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && highestMargin?.growthPct != null ? { value: formatPctTrend(highestMargin.growthPct), direction: highestMargin.growthPct >= 0 ? "up" : "down", tone: highestMargin.growthPct >= 0 ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Top Gross-Profit Contributor"
          value={loading || !topContributor ? "…" : topContributor.name}
          subtitle={topContributor && totalMargin > 0 ? `${formatMoney(topContributor.marginN)} (${topContributor.contributionPct.toFixed(1)}%)` : ""}
          icon={<IconTrophy size={16} />}
          trend={!loading && topContributor?.growthPct != null ? { value: formatPctTrend(topContributor.growthPct), direction: topContributor.growthPct >= 0 ? "up" : "down", tone: topContributor.growthPct >= 0 ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Gross Profit Mix by Commercial Category</h3>
              <p>Each tile&apos;s area is its share of gross profit</p>
            </div>
          </div>
          <CategoryTreemap tiles={treemapTiles} />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Category Revenue vs Margin</h3>
              <p>Bubble size represents gross profit</p>
            </div>
          </div>
          <RevenueMarginBubbleChart
            points={bubblePoints}
            xLabel="Revenue"
            yLabel="Margin %"
            formatX={formatCompactMoney}
            xRef={{ value: avgCategoryRevenue, label: "Avg Revenue" }}
            yRef={{ value: avgCategoryMarginPct, label: "Avg Margin" }}
            quadrantLabels={["Low Revenue · High Margin", "High Revenue · High Margin", "Low Revenue · Low Margin", "High Revenue · Low Margin"]}
            sizeLegendLabel="Bubble size = Gross Profit"
            formatSize={formatMoney}
          />
        </div>
      </div>

      <ActionsPanel title="Category Insights" items={highlightItems} variant="cards" pageSize={3} />

      <div className={css.card}>
        <div className={css.cardhead}>
          <div>
            <h3>Category Profitability Breakdown</h3>
            <p>Top-level departments — click a row to expand its sub-categories.</p>
          </div>
        </div>
        <CategoryHierarchyTable rows={hierarchyRows} loading={loading} emptyTitle="No categorized sales in this range" />
      </div>
    </div>
  );
}
