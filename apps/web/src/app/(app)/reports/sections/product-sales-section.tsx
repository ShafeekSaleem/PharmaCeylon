"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconArchive, IconBox, IconDollarSign, IconEye, IconPause, IconSearch } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  ActiveFilterBanner,
  flattenCategoryTree,
  TreeMultiSelect,
  type CategoryTreeNode,
  type FilterPill,
} from "@/components/ui";
import { fetchCommercialCategories, fetchMarginComparison, type MarginTotals } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { RankingTableCard } from "../components/ranking-table-card";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { CommercialCategoryRow, ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type RankBy = "revenue" | "unitsSold" | "growth";
const RANK_LABELS: Record<RankBy, string> = { revenue: "Revenue", unitsSold: "Units Sold", growth: "Growth" };

// Demand/volume only — no cost or margin here, that's Product Profitability's job (see the Sales
// vs Profitability duplication boundary this whole redesign enforces). `previousRevenueN` is kept
// (not just the derived `growthPct`) so the Declining Demand insight can gate on "had meaningful
// revenue last period," not just "revenue fell," the same way Fastest Growing gates on a revenue
// floor rather than flagging a product that grew from LKR 1 to LKR 2.
type EnrichedRow = MarginRow & { revenueN: number; previousRevenueN: number; growthPct: number | null };

type InsightFocus = "fast" | "declining" | "risk" | "penetration";

export function ProductSalesSection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [previousTotals, setPreviousTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousActiveSkus, setPreviousActiveSkus] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankBy, setRankBy] = useState<RankBy>("revenue");
  const [search, setSearch] = useState("");

  const [lowStockOnly, setLowStockOnly] = useState(false);
  /** Selected COMMERCIAL category/department ids — same filter as Products/Catalog. */
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [categoryRows, setCategoryRows] = useState<CommercialCategoryRow[]>([]);
  const [insightFocus, setInsightFocus] = useState<InsightFocus | null>(null);

  useEffect(() => {
    fetchCommercialCategories()
      .then(setCategoryRows)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarginComparison(days, scope, isOwner)
      .then((margin) => {
        if (cancelled) return;
        const enriched: EnrichedRow[] = margin.current.map((r) => {
          const revenueN = Number(r.revenue);
          const prev = margin.previousByProduct.get(r.productId);
          return {
            ...r,
            revenueN,
            previousRevenueN: prev?.revenue ?? 0,
            growthPct: prev ? pctChange(revenueN, prev.revenue) : null,
          };
        });
        setRows(enriched);
        setPreviousTotals(margin.previousTotals);
        setPreviousActiveSkus(margin.previousActiveSkuCount);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load product sales data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const totalRevenue = rows.reduce((s, r) => s + r.revenueN, 0);
  const totalUnits = rows.reduce((s, r) => s + r.unitsSold, 0);

  const topByRevenue = useMemo(() => (rows.length === 0 ? null : [...rows].sort((a, b) => b.revenueN - a.revenueN)[0]!), [rows]);
  const topProductSharePct = topByRevenue && totalRevenue > 0 ? (topByRevenue.revenueN / totalRevenue) * 100 : 0;
  const growingCount = useMemo(() => rows.filter((r) => r.growthPct != null && r.growthPct > 0).length, [rows]);
  const decliningCount = useMemo(() => rows.filter((r) => r.growthPct != null && r.growthPct < 0).length, [rows]);

  const concentration = useMemo(() => {
    if (totalRevenue === 0) return { top10Pct: 0, top50Pct: 0 };
    const sorted = [...rows].sort((a, b) => b.revenueN - a.revenueN);
    const top10 = sorted.slice(0, 10).reduce((s, r) => s + r.revenueN, 0);
    const top50 = sorted.slice(0, 50).reduce((s, r) => s + r.revenueN, 0);
    return { top10Pct: (top10 / totalRevenue) * 100, top50Pct: (top50 / totalRevenue) * 100 };
  }, [rows, totalRevenue]);

  const categoryTree = useMemo<CategoryTreeNode[]>(() => {
    const byParent = new Map<string | null, CommercialCategoryRow[]>();
    for (const r of categoryRows) {
      const list = byParent.get(r.parentCategoryId) ?? [];
      list.push(r);
      byParent.set(r.parentCategoryId, list);
    }
    const build = (parentId: string | null): CategoryTreeNode[] =>
      (byParent.get(parentId) ?? []).map((r) => ({
        id: r.id,
        label: r.name,
        canonicalKey: r.canonicalKey,
        count: r.productCount,
        children: build(r.id),
      }));
    return build(null);
  }, [categoryRows]);

  const categoryTreeOptions = useMemo(() => flattenCategoryTree(categoryTree), [categoryTree]);

  /** Every category name reachable under a given category id (including itself) — a sale's
   *  `category` field is always a leaf-level commercial category name, so selecting a
   *  department needs to match every name filed anywhere underneath it. */
  const namesUnderCategoryId = useMemo(() => {
    const byParent = new Map<string | null, CommercialCategoryRow[]>();
    for (const r of categoryRows) {
      const list = byParent.get(r.parentCategoryId) ?? [];
      list.push(r);
      byParent.set(r.parentCategoryId, list);
    }
    const cache = new Map<string, Set<string>>();
    const collect = (id: string, name: string): Set<string> => {
      const cached = cache.get(id);
      if (cached) return cached;
      const set = new Set<string>([name]);
      for (const child of byParent.get(id) ?? []) {
        for (const n of collect(child.id, child.name)) set.add(n);
      }
      cache.set(id, set);
      return set;
    };
    for (const r of categoryRows) collect(r.id, r.name);
    return cache;
  }, [categoryRows]);

  const rankedRows = useMemo(() => {
    const metric = (r: EnrichedRow) => (rankBy === "revenue" ? r.revenueN : rankBy === "unitsSold" ? r.unitsSold : (r.growthPct ?? -Infinity));
    return [...rows].sort((a, b) => metric(b) - metric(a)).slice(0, 50);
  }, [rows, rankBy]);

  const fastestGrowing = useMemo(() => {
    const withGrowth = rows.filter((r) => r.growthPct != null) as Array<EnrichedRow & { growthPct: number }>;
    return withGrowth.filter((r) => r.growthPct >= 25 && r.revenueN >= 500).sort((a, b) => b.growthPct - a.growthPct);
  }, [rows]);
  // Mirror of Fastest Growing — a real revenue floor last period (not just "revenue fell") so a
  // brand-new, barely-selling SKU doesn't get flagged as "declining" off a near-zero base.
  const decliningDemand = useMemo(() => {
    const withGrowth = rows.filter((r) => r.growthPct != null) as Array<EnrichedRow & { growthPct: number }>;
    return withGrowth.filter((r) => r.growthPct <= -25 && r.previousRevenueN >= 500).sort((a, b) => a.growthPct - b.growthPct);
  }, [rows]);
  const lowStockRisk = useMemo(
    () => rows.filter((r) => r.stockOnHand <= 5 && r.unitsSold > 0).sort((a, b) => a.stockOnHand - b.stockOnHand),
    [rows],
  );
  // Proxy for "opportunity to reach more transactions": high unit volume at a low average selling
  // price relative to the page — real basket/transaction-penetration data isn't available (no
  // per-transaction composition here), so this stays honestly framed as a price/bundling signal
  // rather than claiming to measure actual basket penetration.
  const highVolumeLowPrice = useMemo(() => {
    const withPrice = rows.filter((r) => r.unitsSold > 0).map((r) => ({ ...r, avgPrice: r.revenueN / r.unitsSold }));
    if (withPrice.length === 0) return [];
    const overallAvgPrice = withPrice.reduce((s, r) => s + r.avgPrice, 0) / withPrice.length;
    return withPrice
      .filter((r) => r.unitsSold >= 20 && r.avgPrice < overallAvgPrice * 0.5)
      .sort((a, b) => b.unitsSold - a.unitsSold);
  }, [rows]);

  function focusInsight(key: InsightFocus) {
    setInsightFocus((cur) => (cur === key ? null : key));
    document.getElementById("all-products-table")?.scrollIntoView({ behavior: "smooth" });
  }

  const insights: ActionPanelItem[] = useMemo(
    () => [
      ...(fastestGrowing.length > 0
        ? [{
            key: "fast",
            icon: <IconDollarSign size={16} />,
            tone: "primary" as const,
            title: "Fastest-growing products",
            description: "Products with the highest revenue growth this period.",
            count: fastestGrowing.length,
            countLabel: fastestGrowing.length === 1 ? "product" : "products",
            onClick: () => focusInsight("fast"),
            examples: fastestGrowing.slice(0, 3).map((r) => ({ label: r.name, badge: formatPctTrend(r.growthPct), tone: "positive" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
      ...(decliningDemand.length > 0
        ? [{
            key: "declining",
            icon: <IconPause size={16} />,
            tone: "warning" as const,
            title: "Declining demand",
            description: "Meaningful sales last period, sustained decline this period.",
            count: decliningDemand.length,
            countLabel: decliningDemand.length === 1 ? "product" : "products",
            onClick: () => focusInsight("declining"),
            examples: decliningDemand.slice(0, 3).map((r) => ({ label: r.name, badge: formatPctTrend(r.growthPct), tone: "negative" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
      ...(lowStockRisk.length > 0
        ? [{
            key: "risk",
            icon: <IconAlertTriangle size={16} />,
            tone: "purple" as const,
            title: "Low stock risk",
            description: "Selling well but 5 or fewer units on hand — demand constrained by availability.",
            count: lowStockRisk.length,
            countLabel: lowStockRisk.length === 1 ? "product" : "products",
            onClick: () => focusInsight("risk"),
            examples: lowStockRisk.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} left`, tone: "negative" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
      ...(highVolumeLowPrice.length > 0
        ? [{
            key: "penetration",
            icon: <IconArchive size={16} />,
            tone: "muted" as const,
            title: "High volume, low average price",
            description: "Sells in high volume at a low average price — a bundling or price/value review candidate.",
            count: highVolumeLowPrice.length,
            countLabel: highVolumeLowPrice.length === 1 ? "product" : "products",
            onClick: () => focusInsight("penetration"),
            examples: highVolumeLowPrice.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.unitsSold.toLocaleString("en-IN")} units`, tone: "neutral" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
      ...(topByRevenue
        ? [{
            key: "view-margin",
            icon: <IconEye size={16} />,
            tone: "muted" as const,
            title: "View Margin in Product Profitability",
            description: "This page is demand only — see cost, gross profit and margin % per product.",
            count: 1,
            countLabel: "report",
            onClick: () => onNavigate("profitability", "margin-by-product"),
            examples: [{ label: topByRevenue.name, badge: `${topProductSharePct.toFixed(1)}% of revenue`, tone: "neutral" as const }],
          }]
        : []),
    ],
    [fastestGrowing, decliningDemand, lowStockRisk, highVolumeLowPrice, topByRevenue, topProductSharePct, onNavigate],
  );

  const filteredRows = useMemo(() => {
    let out = rows;
    if (search) out = out.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()));
    if (categoryFilter.length > 0) {
      const allowedNames = new Set<string>();
      for (const id of categoryFilter) {
        for (const name of namesUnderCategoryId.get(id) ?? []) allowedNames.add(name);
      }
      out = out.filter((r) => allowedNames.has(r.category));
    }
    if (lowStockOnly) out = out.filter((r) => r.stockOnHand <= 5);
    if (insightFocus === "fast") {
      const ids = new Set(fastestGrowing.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    } else if (insightFocus === "declining") {
      const ids = new Set(decliningDemand.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    } else if (insightFocus === "risk") {
      const ids = new Set(lowStockRisk.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    } else if (insightFocus === "penetration") {
      const ids = new Set(highVolumeLowPrice.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    }
    return out;
  }, [rows, search, categoryFilter, namesUnderCategoryId, lowStockOnly, insightFocus, fastestGrowing, decliningDemand, lowStockRisk, highVolumeLowPrice]);

  const activeFilterCount = categoryFilter.length + (lowStockOnly ? 1 : 0);

  const activeFilterPills: FilterPill[] = [
    ...categoryFilter.map((id) => ({
      key: `cat-${id}`,
      label: `Category: ${categoryTreeOptions.find((c) => c.value === id)?.label ?? "Selected"}`,
    })),
    ...(lowStockOnly ? [{ key: "lowStock", label: "Low stock only (≤5 units)" }] : []),
  ];

  useEffect(() => {
    if (filteredRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `product-sales-${days}d.csv`,
      headers: ["Product", "SKU", "Category", "Units Sold", "Revenue", "Growth %", "Stock on Hand"],
      rows: filteredRows.map((r) => [r.name, r.sku, r.category, r.unitsSold, r.revenueN, r.growthPct == null ? "" : r.growthPct.toFixed(1), r.stockOnHand]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [filteredRows, days, onExportData]);

  const columns: Column<EnrichedRow>[] = [
    { key: "name", header: "Product" },
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
    { key: "category", header: "Category" },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "revenueN", header: "Revenue", align: "right", sortable: true, getValue: (r) => r.revenueN, render: (r) => formatMoney(r.revenueN) },
    {
      key: "growthPct",
      header: "Growth",
      align: "right",
      sortable: true,
      getValue: (r) => r.growthPct ?? 0,
      render: (r) => (r.growthPct == null ? "—" : <span className={r.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growthPct)}</span>),
    },
    { key: "stockOnHand", header: "Stock on Hand", align: "right", sortable: true, getValue: (r) => r.stockOnHand, render: (r) => r.stockOnHand.toLocaleString("en-IN") },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (r) => (
        <span className={css.rowIconGroup}>
          <Link className={css.rowIconBtn} href={`/inventory?productId=${r.productId}`} data-tooltip="View in Inventory" aria-label="View in Inventory">
            <IconBox size={15} />
          </Link>
          <Link className={css.rowIconBtn} href={`/products?q=${encodeURIComponent(r.sku)}`} data-tooltip="View in Products" aria-label="View in Products">
            <IconEye size={15} />
          </Link>
        </span>
      ),
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Products Sold"
          value={loading ? "…" : rows.length}
          subtitle={`Distinct SKUs, last ${days} days`}
          icon={<IconArchive size={16} />}
          trend={!loading && previousActiveSkus > 0 ? { value: formatPctTrend(pctChange(rows.length, previousActiveSkus)), direction: rows.length >= previousActiveSkus ? "up" : "down", tone: rows.length >= previousActiveSkus ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Units Sold"
          value={loading ? "…" : totalUnits.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="success"
          trend={!loading && previousTotals.unitsSold > 0 ? { value: formatPctTrend(pctChange(totalUnits, previousTotals.unitsSold)), direction: totalUnits >= previousTotals.unitsSold ? "up" : "down", tone: totalUnits >= previousTotals.unitsSold ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Top Product Contribution"
          value={loading ? "…" : `${topProductSharePct.toFixed(1)}%`}
          subtitle={topByRevenue ? topByRevenue.name : "Share of product revenue"}
          icon={<IconDollarSign size={16} />}
          iconTone="info"
        />
        <StatCard size="sm" showMenu={false}
          title="Products Growing"
          value={loading ? "…" : growingCount.toLocaleString("en-IN")}
          subtitle={`${decliningCount.toLocaleString("en-IN")} declining`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow}`}>
        <RankingTableCard
          title={`Top Products by ${RANK_LABELS[rankBy]}`}
          rankOptions={(Object.keys(RANK_LABELS) as RankBy[]).map((k) => ({ key: k, label: RANK_LABELS[k] }))}
          rankBy={rankBy}
          onRankByChange={(k) => setRankBy(k as RankBy)}
          rows={rankedRows}
          rowKey={(r) => r.productId}
          primaryLabel={(r) => r.name}
          barHeader="Revenue"
          barValue={(r) => r.revenueN}
          barLabel={(r) => formatMoney(r.revenueN)}
          pageSize={10}
          extraColumns={[
            { key: "unitsSold", header: "Units Sold", align: "right", render: (r) => r.unitsSold.toLocaleString("en-IN") },
            { key: "growth", header: "Growth", align: "right", render: (r) => (r.growthPct == null ? "—" : <span className={r.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growthPct)}</span>) },
          ]}
          loading={loading}
          emptyTitle="No products in this range"
          footer={
            !loading && rows.length > 0 ? (
              <span className={css.mutedcell}>
                Top 10 products = {concentration.top10Pct.toFixed(1)}% of revenue · Top 50 = {concentration.top50Pct.toFixed(1)}%
              </span>
            ) : undefined
          }
        />

        <ActionsPanel
          title="Product Insights"
          items={insights}
          variant="cards"
          onViewAll={() => document.getElementById("all-products-table")?.scrollIntoView({ behavior: "smooth" })}
        />
      </div>

      <div className={css.card} id="all-products-table">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>
            All Products
            {insightFocus ? (
              <button type="button" className={css.focusClearBtn} onClick={() => setInsightFocus(null)}>
                {insightFocus === "fast"
                  ? "Fastest-growing"
                  : insightFocus === "declining"
                    ? "Declining demand"
                    : insightFocus === "risk"
                      ? "Low stock risk"
                      : "High volume, low price"} ×
              </button>
            ) : null}
          </h3>
          <div className={css.toolbarActions}>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <TreeMultiSelect
              label="Category"
              options={categoryTreeOptions}
              selected={categoryFilter}
              onChange={setCategoryFilter}
              searchPlaceholder="Search categories…"
              className={css.categoryFilterField}
            />
            <button
              type="button"
              className={`${css.toggleChip} ${css.toggleChipAmber} ${lowStockOnly ? css.toggleChipActive : ""}`}
              onClick={() => setLowStockOnly((v) => !v)}
              aria-pressed={lowStockOnly}
            >
              <IconArchive size={14} />
              Low stock only
            </button>
          </div>
        </div>

        {activeFilterCount > 0 && (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered products · ${filteredRows.length} product${filteredRows.length === 1 ? "" : "s"}`}
              pills={activeFilterPills}
              onClear={() => {
                setCategoryFilter([]);
                setLowStockOnly(false);
              }}
              clearTooltip="Reset all product filters"
            />
          </div>
        )}

        <DataTable columns={columns} data={filteredRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No products match" compact />
      </div>
    </div>
  );
}
