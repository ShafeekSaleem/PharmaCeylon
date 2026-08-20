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
import { fetchCommercialCategories, fetchMarginComparison, fetchSalesComparison, type MarginTotals } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { RankingTableCard } from "../components/ranking-table-card";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CommercialCategoryRow, ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const LOW_MARGIN_THRESHOLD_PCT = 20;

type RankBy = "revenue" | "unitsSold" | "growth";
const RANK_LABELS: Record<RankBy, string> = { revenue: "Revenue", unitsSold: "Units Sold", growth: "Growth" };

type EnrichedRow = MarginRow & { revenueN: number; costN: number; marginN: number; marginPct: number; growthPct: number | null };

type InsightFocus = "fast" | "slow" | "risk";

export function ProductSalesSection({ scope, isOwner, days, onExportData }: Props) {
  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [transactions, setTransactions] = useState(0);
  const [previousTransactions, setPreviousTransactions] = useState(0);
  const [previousTotals, setPreviousTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousActiveSkus, setPreviousActiveSkus] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankBy, setRankBy] = useState<RankBy>("revenue");
  const [search, setSearch] = useState("");

  const [lowStockOnly, setLowStockOnly] = useState(false);
  const [lowMarginOnly, setLowMarginOnly] = useState(false);
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
    Promise.all([fetchMarginComparison(days, scope, isOwner), fetchSalesComparison(days, scope, isOwner)])
      .then(([margin, sales]) => {
        if (cancelled) return;
        const enriched: EnrichedRow[] = margin.current.map((r) => {
          const revenueN = Number(r.revenue);
          const costN = Number(r.cost);
          const marginN = revenueN - costN;
          const prev = margin.previousByProduct.get(r.productId);
          return {
            ...r,
            revenueN,
            costN,
            marginN,
            marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0,
            growthPct: prev ? pctChange(revenueN, prev.revenue) : null,
          };
        });
        setRows(enriched);
        setTransactions(sales.current.count);
        setPreviousTransactions(sales.previous.count);
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
  const avgUnitsPerTxn = transactions > 0 ? totalUnits / transactions : 0;
  const previousAvgUnitsPerTxn = previousTransactions > 0 ? previousTotals.unitsSold / previousTransactions : 0;

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
  // "Slow" = meaningful stock (≥10 units) that would take 20+ periods to sell through at the current pace.
  const slowMovers = useMemo(
    () => rows.filter((r) => r.stockOnHand >= 10 && r.stockOnHand / Math.max(1, r.unitsSold) >= 20).sort((a, b) => b.stockOnHand - a.stockOnHand),
    [rows],
  );
  const lowStockRisk = useMemo(
    () => rows.filter((r) => r.stockOnHand <= 5 && r.unitsSold > 0).sort((a, b) => a.stockOnHand - b.stockOnHand),
    [rows],
  );

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
      ...(slowMovers.length > 0
        ? [{
            key: "slow",
            icon: <IconPause size={16} />,
            tone: "warning" as const,
            title: "Slow movers",
            description: "Low sales velocity relative to stock on hand.",
            count: slowMovers.length,
            countLabel: slowMovers.length === 1 ? "product" : "products",
            onClick: () => focusInsight("slow"),
            examples: slowMovers.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} in stock`, tone: "neutral" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
      ...(lowStockRisk.length > 0
        ? [{
            key: "risk",
            icon: <IconAlertTriangle size={16} />,
            tone: "purple" as const,
            title: "Low stock risk",
            description: "Selling well but 5 or fewer units on hand.",
            count: lowStockRisk.length,
            countLabel: lowStockRisk.length === 1 ? "product" : "products",
            onClick: () => focusInsight("risk"),
            examples: lowStockRisk.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} left`, tone: "negative" as const, href: `/inventory?productId=${r.productId}` })),
          }]
        : []),
    ],
    [fastestGrowing, slowMovers, lowStockRisk],
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
    if (lowMarginOnly) out = out.filter((r) => r.marginPct < LOW_MARGIN_THRESHOLD_PCT);
    if (insightFocus === "fast") {
      const ids = new Set(fastestGrowing.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    } else if (insightFocus === "slow") {
      const ids = new Set(slowMovers.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    } else if (insightFocus === "risk") {
      const ids = new Set(lowStockRisk.map((r) => r.productId));
      out = out.filter((r) => ids.has(r.productId));
    }
    return out;
  }, [rows, search, categoryFilter, namesUnderCategoryId, lowStockOnly, lowMarginOnly, insightFocus, fastestGrowing, slowMovers, lowStockRisk]);

  const activeFilterCount = categoryFilter.length + (lowStockOnly ? 1 : 0) + (lowMarginOnly ? 1 : 0);

  const activeFilterPills: FilterPill[] = [
    ...categoryFilter.map((id) => ({
      key: `cat-${id}`,
      label: `Category: ${categoryTreeOptions.find((c) => c.value === id)?.label ?? "Selected"}`,
    })),
    ...(lowStockOnly ? [{ key: "lowStock", label: "Low stock only (≤5 units)" }] : []),
    ...(lowMarginOnly
      ? [{ key: "lowMargin", label: `Low margin only (<${LOW_MARGIN_THRESHOLD_PCT}%)` }]
      : []),
  ];

  useEffect(() => {
    if (filteredRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `product-sales-${days}d.csv`,
      headers: ["Product", "SKU", "Category", "Units Sold", "Revenue", "Gross Profit", "Margin %", "Stock on Hand"],
      rows: filteredRows.map((r) => [r.name, r.sku, r.category, r.unitsSold, r.revenueN, r.marginN, r.marginPct.toFixed(1), r.stockOnHand]),
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
    { key: "marginN", header: "Gross Profit", align: "right", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    { key: "marginPct", header: "Margin %", align: "right", sortable: true, getValue: (r) => r.marginPct, render: (r) => `${r.marginPct.toFixed(1)}%` },
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
          title="Product Revenue"
          value={loading ? "…" : formatMoney(totalRevenue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && previousTotals.revenue > 0 ? { value: formatPctTrend(pctChange(totalRevenue, previousTotals.revenue)), direction: totalRevenue >= previousTotals.revenue ? "up" : "down", tone: totalRevenue >= previousTotals.revenue ? "positive" : "danger" } : undefined}
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
          title="Avg. Units per Transaction"
          value={loading ? "…" : avgUnitsPerTxn.toFixed(2)}
          subtitle="Basket depth"
          icon={<IconArchive size={16} />}
          iconTone="info"
          trend={!loading && previousAvgUnitsPerTxn > 0 ? { value: formatPctTrend(pctChange(avgUnitsPerTxn, previousAvgUnitsPerTxn)), direction: avgUnitsPerTxn >= previousAvgUnitsPerTxn ? "up" : "down", tone: avgUnitsPerTxn >= previousAvgUnitsPerTxn ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Active SKUs"
          value={loading ? "…" : rows.length}
          subtitle={`Sold in the last ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && previousActiveSkus > 0 ? { value: formatPctTrend(pctChange(rows.length, previousActiveSkus)), direction: rows.length >= previousActiveSkus ? "up" : "down", tone: rows.length >= previousActiveSkus ? "positive" : "danger" } : undefined}
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
            { key: "marginPct", header: "Margin", align: "right", render: (r) => `${r.marginPct.toFixed(1)}%` },
          ]}
          loading={loading}
          emptyTitle="No products in this range"
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
                {insightFocus === "fast" ? "Fastest-growing" : insightFocus === "slow" ? "Slow movers" : "Low stock risk"} ×
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
            <button
              type="button"
              className={`${css.toggleChip} ${css.toggleChipRose} ${lowMarginOnly ? css.toggleChipActive : ""}`}
              onClick={() => setLowMarginOnly((v) => !v)}
              aria-pressed={lowMarginOnly}
            >
              <IconDollarSign size={14} />
              Low margin only (&lt;{LOW_MARGIN_THRESHOLD_PCT}%)
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
                setLowMarginOnly(false);
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
