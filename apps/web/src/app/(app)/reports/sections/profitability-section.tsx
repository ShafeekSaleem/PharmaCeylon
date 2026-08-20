"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconArchive, IconDollarSign, IconFilter, IconGrid, IconPause, IconPill, IconSearch, IconTag, IconTruck } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchMarginByProduct, fetchProfitabilityTarget, type MarginTotals } from "../lib/fetchers";
import { formatCompactMoney, formatMoney } from "../lib/format";
import { classifyMarginOpportunities, marginBandColor } from "../lib/margin-opportunities";
import { RankingTableCard } from "../components/ranking-table-card";
import { RevenueMarginBubbleChart, type BubblePoint } from "../components/revenue-margin-bubble-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { RowActionMenu } from "../components/row-action-menu";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

type RankBy = "margin" | "marginPct" | "revenue";
const RANK_LABELS: Record<RankBy, string> = { margin: "Gross Profit", marginPct: "Margin %", revenue: "Revenue" };

type MarginTier = "all" | "healthy" | "watch" | "low";
const TIER_LABELS: Record<MarginTier, string> = { all: "All margins", healthy: "Healthy (≥35%)", watch: "Watch (20–35%)", low: "Low (<20%)" };

/** Matches this file's own `marginTier()` bands — this codebase's established "healthy margin"
 *  convention, not a screenshot value. */
const HIGH_MARGIN_THRESHOLD_PCT = 35;
/** Fallback when no tenant target is configured — same fallback convention Product Sales' own
 *  low-margin toggle already uses (`LOW_MARGIN_THRESHOLD_PCT` there). */
const DEFAULT_MARGIN_TARGET_PCT = 20;
const TOP_GP_CONCENTRATION_N = 20;
const BUBBLE_MAX_PRODUCTS = 60;

function marginTier(pct: number): "success" | "primary" | "warning" {
  if (pct >= 35) return "success";
  if (pct >= 20) return "primary";
  return "warning";
}

type EnrichedRow = MarginRow & { revenueN: number; costN: number; marginN: number; marginPct: number };

export function ProfitabilitySection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [rows, setRows] = useState<MarginRow[]>([]);
  const [currentTotals, setCurrentTotals] = useState<MarginTotals>({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [targetPct, setTargetPct] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rankBy, setRankBy] = useState<RankBy>("margin");
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<MarginTier>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!filterOpen) return;
    function onClick(e: MouseEvent) {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [filterOpen]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMarginByProduct(days, scope, isOwner)
      .then((res) => {
        if (cancelled) return;
        setRows(res);
        const totals = res.reduce(
          (acc, r) => ({ revenue: acc.revenue + Number(r.revenue), cost: acc.cost + Number(r.cost), margin: acc.margin + Number(r.margin), unitsSold: acc.unitsSold + r.unitsSold }),
          { revenue: 0, cost: 0, margin: 0, unitsSold: 0 },
        );
        setCurrentTotals(totals);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load margin data");
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
    fetchProfitabilityTarget()
      .then((res) => {
        if (!cancelled) setTargetPct(res.targetGrossMarginPercent);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const effectiveTargetPct = targetPct ?? DEFAULT_MARGIN_TARGET_PCT;

  const enriched: EnrichedRow[] = useMemo(
    () =>
      rows.map((r) => {
        const revenue = Number(r.revenue);
        const cost = Number(r.cost);
        const margin = Number(r.margin);
        return { ...r, revenueN: revenue, costN: cost, marginN: margin, marginPct: revenue > 0 ? (margin / revenue) * 100 : 0 };
      }),
    [rows],
  );

  const blendedMarginPct = currentTotals.revenue > 0 ? (currentTotals.margin / currentTotals.revenue) * 100 : 0;

  const gpConcentrationPct = useMemo(() => {
    if (enriched.length === 0 || currentTotals.margin <= 0) return 0;
    const top20Margin = [...enriched].sort((a, b) => b.marginN - a.marginN).slice(0, TOP_GP_CONCENTRATION_N).reduce((s, r) => s + r.marginN, 0);
    return (top20Margin / currentTotals.margin) * 100;
  }, [enriched, currentTotals.margin]);

  const highMarginSharePct = useMemo(() => {
    if (currentTotals.revenue <= 0) return 0;
    const highMarginRevenue = enriched.filter((r) => r.marginPct >= HIGH_MARGIN_THRESHOLD_PCT).reduce((s, r) => s + r.revenueN, 0);
    return (highMarginRevenue / currentTotals.revenue) * 100;
  }, [enriched, currentTotals.revenue]);

  const belowTargetCount = useMemo(() => enriched.filter((r) => r.marginPct < effectiveTargetPct && r.revenueN > 0).length, [enriched, effectiveTargetPct]);

  const { pricingReview, supplierNegotiation, stockReview } = useMemo(
    () => classifyMarginOpportunities(enriched, effectiveTargetPct),
    [enriched, effectiveTargetPct],
  );

  const opportunityItems: ActionPanelItem[] = [
    ...(pricingReview.length > 0
      ? [{
          key: "pricing",
          icon: <IconTag size={16} />,
          tone: "warning" as const,
          title: "Pricing Review Needed",
          description: `Margin below ${effectiveTargetPct.toFixed(0)}% target due to low pricing relative to category peers.`,
          count: pricingReview.length,
          countLabel: pricingReview.length === 1 ? "product" : "products",
          onClick: () => onNavigate("profitability", "low-margin-products"),
          examples: pricingReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
    ...(supplierNegotiation.length > 0
      ? [{
          key: "supplier",
          icon: <IconTruck size={16} />,
          tone: "purple" as const,
          title: "Supplier Negotiation",
          description: "COGS is high compared to the category benchmark.",
          count: supplierNegotiation.length,
          countLabel: supplierNegotiation.length === 1 ? "product" : "products",
          onClick: () => onNavigate("profitability", "low-margin-products"),
          examples: supplierNegotiation.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
    ...(stockReview.length > 0
      ? [{
          key: "stock",
          icon: <IconPause size={16} />,
          tone: "muted" as const,
          title: "Stock Review",
          description: "Low margin and slow-moving relative to stock on hand.",
          count: stockReview.length,
          countLabel: stockReview.length === 1 ? "product" : "products",
          onClick: () => onNavigate("profitability", "low-margin-products"),
          examples: stockReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} in stock`, tone: "neutral" as const })),
        }]
      : []),
  ];

  const bubblePoints: BubblePoint[] = useMemo(() => {
    const top = [...enriched].sort((a, b) => b.revenueN - a.revenueN).slice(0, BUBBLE_MAX_PRODUCTS);
    if (top.length === 0) return [];
    const byMarginAsc = [...top].sort((a, b) => a.marginPct - b.marginPct);
    const labeledIds = new Set<string>([
      ...top.slice(0, 5).map((r) => r.productId),
      byMarginAsc[0]!.productId,
      byMarginAsc[byMarginAsc.length - 1]!.productId,
    ]);
    return top.map((r) => ({
      id: r.productId,
      label: r.name,
      x: r.revenueN,
      y: r.marginPct,
      size: r.revenueN,
      color: marginBandColor(r.marginPct),
      labeled: labeledIds.has(r.productId),
      tooltip: `${r.name} (${r.sku}) — ${r.category} · Revenue ${formatMoney(r.revenueN)} · COGS ${formatMoney(r.costN)} · Gross Profit ${formatMoney(r.marginN)} · Margin ${r.marginPct.toFixed(1)}% · ${r.unitsSold} units`,
    }));
  }, [enriched]);

  const rankedRows = useMemo(() => {
    const metric = (r: EnrichedRow) => (rankBy === "margin" ? r.marginN : rankBy === "marginPct" ? r.marginPct : r.revenueN);
    return [...enriched].sort((a, b) => metric(b) - metric(a)).slice(0, 10);
  }, [enriched, rankBy]);

  const tableRows = useMemo(() => {
    let out = enriched.filter((r) => {
      if (tier === "healthy") return r.marginPct >= 35;
      if (tier === "watch") return r.marginPct >= 20 && r.marginPct < 35;
      if (tier === "low") return r.marginPct < 20;
      return true;
    });
    if (search) out = out.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()));
    return out;
  }, [enriched, tier, search]);

  useEffect(() => {
    if (tableRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `margin-by-product-${days}d.csv`,
      headers: ["SKU", "Product", "Category", "Units Sold", "Revenue", "COGS", "Gross Profit", "Margin %", "Avg Selling Price"],
      rows: tableRows.map((r) => [r.sku, r.name, r.category, r.unitsSold, r.revenueN, r.costN, r.marginN, r.marginPct.toFixed(1), r.unitsSold > 0 ? (r.revenueN / r.unitsSold).toFixed(2) : ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [tableRows, days, onExportData]);

  const columns: Column<EnrichedRow>[] = [
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
    { key: "name", header: "Product" },
    { key: "category", header: "Category", render: (r) => <span className={css.mutedcell}>{r.category}</span> },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "revenueN", header: "Revenue", align: "right", sortable: true, getValue: (r) => r.revenueN, render: (r) => formatMoney(r.revenueN) },
    { key: "costN", header: "COGS", align: "right", sortable: true, getValue: (r) => r.costN, render: (r) => <span className={css.mutedcell}>{formatMoney(r.costN)}</span> },
    { key: "marginN", header: "Gross Profit", align: "right", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    {
      key: "marginPct",
      header: "Margin %",
      align: "right",
      sortable: true,
      getValue: (r) => r.marginPct,
      render: (r) => <StatusBadge status={marginTier(r.marginPct)} variant={marginTier(r.marginPct)} label={`${r.marginPct.toFixed(1)}%`} />,
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <RowActionMenu actions={[{ label: "View in inventory", href: `/inventory?productId=${r.productId}` }]} />
      ),
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Blended Margin %"
          value={loading ? "…" : `${blendedMarginPct.toFixed(1)}%`}
          subtitle={`${rows.length} SKUs sold, last ${days} days`}
          icon={<IconPill size={16} />}
        />
        <StatCard size="sm" showMenu={false}
          title="Product Gross Profit Concentration"
          value={loading ? "…" : `${gpConcentrationPct.toFixed(1)}%`}
          subtitle={`Top ${TOP_GP_CONCENTRATION_N} products`}
          icon={<IconGrid size={16} />}
          iconTone="info"
        />
        <StatCard size="sm" showMenu={false}
          title="High-Margin Sales Share"
          value={loading ? "…" : `${highMarginSharePct.toFixed(1)}%`}
          subtitle={`Margin ≥ ${HIGH_MARGIN_THRESHOLD_PCT}%`}
          icon={<IconArchive size={16} />}
          iconTone="success"
        />
        <StatCard size="sm" showMenu={false}
          title="Products Below Target Margin"
          value={loading ? "…" : belowTargetCount}
          subtitle={`Target ${effectiveTargetPct.toFixed(0)}%${targetPct == null ? " (default)" : ""}`}
          icon={<IconDollarSign size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Revenue vs Margin by Product</h3>
              <p>Each bubble is a product. Size and position both track revenue.</p>
            </div>
          </div>
          <RevenueMarginBubbleChart
            points={bubblePoints}
            xLabel="Revenue"
            yLabel="Margin %"
            formatX={formatCompactMoney}
            sizeLegendLabel="Bubble size = Revenue"
            formatSize={formatMoney}
          />
        </div>

        <ActionsPanel title="Margin Opportunities" items={opportunityItems} variant="cards" />
      </div>

      <RankingTableCard
        title={`Top Products by ${RANK_LABELS[rankBy]}`}
        rankOptions={(Object.keys(RANK_LABELS) as RankBy[]).map((k) => ({ key: k, label: RANK_LABELS[k] }))}
        rankBy={rankBy}
        onRankByChange={(k) => setRankBy(k as RankBy)}
        rows={rankedRows}
        rowKey={(r) => r.productId}
        primaryLabel={(r) => r.name}
        primarySub={(r) => r.sku}
        barHeader="Gross Profit"
        barValue={(r) => r.marginN}
        barLabel={(r) => formatMoney(r.marginN)}
        extraColumns={[
          { key: "revenueN", header: "Revenue", align: "right", render: (r) => formatMoney(r.revenueN) },
          { key: "marginPct", header: "Margin %", align: "right", render: (r) => `${r.marginPct.toFixed(1)}%` },
          { key: "unitsSold", header: "Units Sold", align: "right", render: (r) => r.unitsSold.toLocaleString("en-IN") },
        ]}
        loading={loading}
        emptyTitle="No products in this range"
      />

      <div className={css.card}>
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>All products</h3>
          <div className={css.toolbarActions}>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className={css.filterPopoverWrap} ref={filterRef}>
              <button type="button" className={css.filterBtn} onClick={() => setFilterOpen((v) => !v)}>
                <IconFilter size={14} />
                Filters
                {tier !== "all" ? <span className={css.filterCount}>1</span> : null}
              </button>
              {filterOpen ? (
                <div className={css.filterPopover}>
                  {(Object.keys(TIER_LABELS) as MarginTier[]).map((t) => (
                    <label key={t}>
                      <input type="radio" name="marginTier" checked={tier === t} onChange={() => setTier(t)} />
                      {TIER_LABELS[t]}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <DataTable columns={columns} data={tableRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No products match these filters" compact />
      </div>
    </div>
  );
}
