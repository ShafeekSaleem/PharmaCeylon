"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconArchive,
  IconChevronRight,
  IconDollarSign,
  IconGrid,
  IconPause,
  IconPill,
  IconSearch,
  IconTag,
  IconTruck,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, type BadgeVariant } from "@/components/ui/status-badge";
import {
  ActiveFilterBanner,
  flattenCategoryTree,
  TreeMultiSelect,
  type CategoryTreeNode,
  type FilterPill,
} from "@/components/ui";
import { fetchCommercialCategories, fetchMarginComparison } from "../lib/fetchers";
import { useProfitabilityTarget } from "../lib/use-profitability-target";
import { formatCompactMoney, formatMoney, formatPpTrend, ppChange } from "../lib/format";
import { classifyMarginOpportunities } from "../lib/margin-opportunities";
import { MarginDistributionChart, type MarginBand } from "../components/margin-distribution-chart";
import { RankingTableCard } from "../components/ranking-table-card";
import { InlineBarCell } from "../components/inline-bar-cell";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { ReportSelect } from "../components/report-select";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { CommercialCategoryRow, ExportPayload, MarginRow, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

/** This codebase's established "healthy margin" convention (see Low-Margin Products' own default),
 *  not a screenshot value. */
const HIGH_MARGIN_THRESHOLD_PCT = 35;
/** Fallback when no tenant target is configured — same fallback Product Sales' low-margin toggle uses. */
const DEFAULT_MARGIN_TARGET_PCT = 20;
const TOP_GP_CONCENTRATION_N = 20;
/** A borderline product (just under target, not a supplier/stock issue) is worth watching rather
 *  than an urgent pricing action — same buffer idea Low-Margin Products uses for its own split. */
const MONITOR_BUFFER_PP = 3;

type BandDef = { key: string; label: string; min: number; max: number };
const MARGIN_BANDS: BandDef[] = [
  { key: "neg", label: "< 0%", min: -Infinity, max: 0 },
  { key: "0-10", label: "0–10%", min: 0, max: 10 },
  { key: "10-20", label: "10–20%", min: 10, max: 20 },
  { key: "20-30", label: "20–30%", min: 20, max: 30 },
  { key: "30-40", label: "30–40%", min: 30, max: 40 },
  { key: "40+", label: "≥ 40%", min: 40, max: Infinity },
];

function bandFor(marginPct: number): BandDef {
  return MARGIN_BANDS.find((b) => marginPct >= b.min && marginPct < b.max) ?? MARGIN_BANDS[0]!;
}

/** Fractional band-index for the target-margin reference line — interpolated within whichever
 *  band the target falls in (open-ended first/last bands use a 20pp effective span so the line
 *  still lands somewhere sensible instead of at an edge). */
function targetBandPosition(target: number): number | null {
  for (let i = 0; i < MARGIN_BANDS.length; i++) {
    const b = MARGIN_BANDS[i]!;
    if (target >= b.min && target < b.max) {
      const effMin = b.min === -Infinity ? b.max - 20 : b.min;
      const effMax = b.max === Infinity ? b.min + 20 : b.max;
      return i + Math.min(1, Math.max(0, (target - effMin) / (effMax - effMin)));
    }
  }
  return null;
}

const GP_TIER_DEFS = [
  { key: "top10", label: "Top 10 Products", from: 0, to: 10 },
  { key: "next20", label: "Next 20 Products (11–30)", from: 10, to: 30 },
  { key: "next50", label: "Next 50 Products (31–80)", from: 30, to: 80 },
  { key: "rest", label: "Remaining Products (81+)", from: 80, to: Infinity },
];

type EnrichedRow = MarginRow & { revenueN: number; costN: number; marginN: number; marginPct: number };

type SuggestedAction = "Maintain Price" | "Monitor Pricing" | "Review Pricing" | "Negotiate Cost" | "Clear Stock";
const ACTION_VARIANT: Record<SuggestedAction, BadgeVariant> = {
  "Maintain Price": "success",
  "Monitor Pricing": "info",
  "Review Pricing": "warning",
  "Negotiate Cost": "primary",
  "Clear Stock": "danger",
};

type OpportunityFocus = "pricing" | "supplier" | "stock" | null;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function enrich(r: MarginRow): EnrichedRow {
  const revenueN = Number(r.revenue);
  const costN = Number(r.cost);
  const marginN = revenueN - costN;
  return { ...r, revenueN, costN, marginN, marginPct: revenueN > 0 ? (marginN / revenueN) * 100 : 0 };
}

/** Product-level profitability analysis — which SKUs drive gross profit, how concentrated that
 *  profit is, where the margin opportunities are, and which SKUs need action. Overview totals live
 *  on Gross Profit and category-level detail lives on Margin by Category; this page intentionally
 *  doesn't repeat either. */
export function ProfitabilitySection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [previousRows, setPreviousRows] = useState<EnrichedRow[]>([]);
  const [currentTotals, setCurrentTotals] = useState({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const [previousTotals, setPreviousTotals] = useState({ revenue: 0, cost: 0, margin: 0, unitsSold: 0 });
  const { targetPct } = useProfitabilityTarget();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [categoryRows, setCategoryRows] = useState<CommercialCategoryRow[]>([]);
  const [marginBandFilter, setMarginBandFilter] = useState<string>("all");
  const [brandFilter, setBrandFilter] = useState<string>("all");
  const [lowMarginOnly, setLowMarginOnly] = useState(false);
  const [highRevenueOnly, setHighRevenueOnly] = useState(false);
  const [opportunityFocus, setOpportunityFocus] = useState<OpportunityFocus>(null);
  const [topConcentrationOnly, setTopConcentrationOnly] = useState(false);
  const [highMarginOnly, setHighMarginOnly] = useState(false);
  const [marginGroupFocus, setMarginGroupFocus] = useState<"below10" | "mid1020" | "above20" | null>(null);

  function scrollToTable() {
    document.getElementById("all-products-table")?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleTopConcentrationOnly() {
    setTopConcentrationOnly((v) => !v);
    scrollToTable();
  }
  function toggleHighMarginOnly() {
    setHighMarginOnly((v) => !v);
    scrollToTable();
  }
  function toggleLowMarginOnly() {
    setLowMarginOnly((v) => !v);
    scrollToTable();
  }
  function toggleMarginGroup(key: "below10" | "mid1020" | "above20") {
    setMarginGroupFocus((cur) => (cur === key ? null : key));
    scrollToTable();
  }

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
      .then((res) => {
        if (cancelled) return;
        setRows(res.current.map(enrich));
        setPreviousRows(res.previousRows.map((r) => ({ ...r })));
        setCurrentTotals(res.currentTotals);
        setPreviousTotals(res.previousTotals);
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


  const effectiveTargetPct = targetPct ?? DEFAULT_MARGIN_TARGET_PCT;
  const soldRows = useMemo(() => rows.filter((r) => r.revenueN > 0), [rows]);
  const previousSoldRows = useMemo(() => previousRows.filter((r) => r.revenueN > 0), [previousRows]);

  // ── KPI row (current vs previous period) ──────────────────────────────────────────────
  function concentrationPct(set: EnrichedRow[], totalMargin: number): number {
    if (set.length === 0 || totalMargin <= 0) return 0;
    const topN = [...set].sort((a, b) => b.marginN - a.marginN).slice(0, TOP_GP_CONCENTRATION_N).reduce((s, r) => s + r.marginN, 0);
    return (topN / totalMargin) * 100;
  }
  const gpConcentrationPct = concentrationPct(soldRows, currentTotals.margin);
  const previousGpConcentrationPct = concentrationPct(previousSoldRows, previousTotals.margin);

  function highMarginShare(set: EnrichedRow[], totalRevenue: number): number {
    if (totalRevenue <= 0) return 0;
    const highMarginRevenue = set.filter((r) => r.marginPct >= HIGH_MARGIN_THRESHOLD_PCT).reduce((s, r) => s + r.revenueN, 0);
    return (highMarginRevenue / totalRevenue) * 100;
  }
  const highMarginSharePct = highMarginShare(soldRows, currentTotals.revenue);
  const previousHighMarginSharePct = highMarginShare(previousSoldRows, previousTotals.revenue);

  const belowTargetCount = soldRows.filter((r) => r.marginPct < effectiveTargetPct).length;
  const previousBelowTargetCount = previousSoldRows.filter((r) => r.marginPct < effectiveTargetPct).length;
  const belowTargetDelta = previousBelowTargetCount - belowTargetCount;

  // ── Distribution by margin band ────────────────────────────────────────────────────────
  const bands: MarginBand[] = useMemo(
    () =>
      MARGIN_BANDS.map((b) => {
        const inBand = soldRows.filter((r) => r.marginPct >= b.min && r.marginPct < b.max);
        return { key: b.key, label: b.label, count: inBand.length, revenue: inBand.reduce((s, r) => s + r.revenueN, 0) };
      }),
    [soldRows],
  );
  const belowTenCount = soldRows.filter((r) => r.marginPct < 10).length;
  const tenToTwentyCount = soldRows.filter((r) => r.marginPct >= 10 && r.marginPct < 20).length;
  const aboveTwentyCount = soldRows.filter((r) => r.marginPct >= 20).length;

  // ── Gross profit contribution by product tier ──────────────────────────────────────────
  const rankedByMargin = useMemo(() => [...soldRows].sort((a, b) => b.marginN - a.marginN), [soldRows]);
  const gpTiers = useMemo(
    () =>
      GP_TIER_DEFS.map((t) => {
        const set = rankedByMargin.slice(t.from, t.to === Infinity ? undefined : t.to);
        const marginSum = set.reduce((s, r) => s + r.marginN, 0);
        return { ...t, marginSum, sharePct: currentTotals.margin > 0 ? (marginSum / currentTotals.margin) * 100 : 0 };
      }),
    [rankedByMargin, currentTotals.margin],
  );
  const topConcentrationIds = useMemo(
    () => new Set(rankedByMargin.slice(0, TOP_GP_CONCENTRATION_N).map((r) => r.productId)),
    [rankedByMargin],
  );

  // ── Margin opportunity segments (shared with Low-Margin Products' own logic) ───────────
  const { pricingReview, supplierNegotiation, stockReview } = useMemo(
    () => classifyMarginOpportunities(soldRows, effectiveTargetPct),
    [soldRows, effectiveTargetPct],
  );

  const actionByProductId = useMemo(() => {
    const map = new Map<string, SuggestedAction>();
    for (const r of stockReview) map.set(r.productId, "Clear Stock");
    for (const r of supplierNegotiation) map.set(r.productId, "Negotiate Cost");
    for (const r of pricingReview) map.set(r.productId, effectiveTargetPct - r.marginPct <= MONITOR_BUFFER_PP ? "Monitor Pricing" : "Review Pricing");
    return map;
  }, [stockReview, supplierNegotiation, pricingReview, effectiveTargetPct]);

  function suggestedActionFor(r: EnrichedRow): SuggestedAction {
    return actionByProductId.get(r.productId) ?? "Maintain Price";
  }

  function focusOpportunity(key: Exclude<OpportunityFocus, null>) {
    setOpportunityFocus((cur) => (cur === key ? null : key));
    document.getElementById("all-products-table")?.scrollIntoView({ behavior: "smooth" });
  }

  const opportunityItems: ActionPanelItem[] = [
    ...(pricingReview.length > 0
      ? [{
          key: "pricing",
          icon: <IconTag size={16} />,
          tone: "warning" as const,
          title: "Pricing Review Needed",
          description: `Margin below the ${effectiveTargetPct.toFixed(0)}% target, priced in line with category peers — the lever here is likely the selling price.`,
          count: pricingReview.length,
          countLabel: pricingReview.length === 1 ? "product" : "products",
          onClick: () => focusOpportunity("pricing"),
          examples: pricingReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}% · ${formatCompactMoney(r.revenueN)}`, tone: "negative" as const })),
        }]
      : []),
    ...(supplierNegotiation.length > 0
      ? [{
          key: "supplier",
          icon: <IconTruck size={16} />,
          tone: "purple" as const,
          title: "Supplier Negotiation",
          description: "COGS sits notably above the category's blended cost ratio — cost pressure, not pricing, looks like the driver.",
          count: supplierNegotiation.length,
          countLabel: supplierNegotiation.length === 1 ? "product" : "products",
          onClick: () => focusOpportunity("supplier"),
          examples: supplierNegotiation.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.marginPct.toFixed(1)}% · ${formatCompactMoney(r.revenueN)}`, tone: "negative" as const })),
        }]
      : []),
    ...(stockReview.length > 0
      ? [{
          key: "stock",
          icon: <IconPause size={16} />,
          tone: "muted" as const,
          title: "Stock Review",
          description: "Low margin and slow-moving relative to stock on hand — capital tied up in sellers that aren't earning it back.",
          count: stockReview.length,
          countLabel: stockReview.length === 1 ? "product" : "products",
          onClick: () => focusOpportunity("stock"),
          examples: stockReview.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.stockOnHand} units · ${formatCompactMoney(r.revenueN)}`, tone: "neutral" as const })),
        }]
      : []),
  ];

  const medianRevenue = useMemo(() => median(soldRows.map((r) => r.revenueN)), [soldRows]);
  // The typical SKU's margin, not the revenue-weighted portfolio figure "Blended Margin %" used to
  // show (that's now Profit Summary's Gross Margin KPI) — a handful of high-volume products can
  // make the blended number look healthy while most of the catalog sits well below it.
  const medianMarginPct = useMemo(() => median(soldRows.map((r) => r.marginPct)), [soldRows]);
  const previousMedianMarginPct = useMemo(() => median(previousSoldRows.map((r) => r.marginPct)), [previousSoldRows]);

  // ── Category / brand filter setup ──────────────────────────────────────────────────────
  const categoryTree = useMemo<CategoryTreeNode[]>(() => {
    const byParent = new Map<string | null, CommercialCategoryRow[]>();
    for (const r of categoryRows) {
      const list = byParent.get(r.parentCategoryId) ?? [];
      list.push(r);
      byParent.set(r.parentCategoryId, list);
    }
    const build = (parentId: string | null): CategoryTreeNode[] =>
      (byParent.get(parentId) ?? []).map((r) => ({ id: r.id, label: r.name, canonicalKey: r.canonicalKey, count: r.productCount, children: build(r.id) }));
    return build(null);
  }, [categoryRows]);
  const categoryTreeOptions = useMemo(() => flattenCategoryTree(categoryTree), [categoryTree]);
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
      for (const child of byParent.get(id) ?? []) for (const n of collect(child.id, child.name)) set.add(n);
      cache.set(id, set);
      return set;
    };
    for (const r of categoryRows) collect(r.id, r.name);
    return cache;
  }, [categoryRows]);

  const brandOptions = useMemo(() => {
    const names = [...new Set(soldRows.map((r) => r.brandName).filter((b): b is string => !!b))].sort();
    return [{ value: "all", label: "All brands" }, ...names.map((n) => ({ value: n, label: n }))];
  }, [soldRows]);
  const marginBandOptions = [{ value: "all", label: "All margins" }, ...MARGIN_BANDS.map((b) => ({ value: b.key, label: b.label }))];

  // ── All Products Profitability table ───────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    let out = soldRows;
    if (search) out = out.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()));
    if (categoryFilter.length > 0) {
      const allowedNames = new Set<string>();
      for (const id of categoryFilter) for (const name of namesUnderCategoryId.get(id) ?? []) allowedNames.add(name);
      out = out.filter((r) => allowedNames.has(r.category));
    }
    if (marginBandFilter !== "all") out = out.filter((r) => bandFor(r.marginPct).key === marginBandFilter);
    if (brandFilter !== "all") out = out.filter((r) => r.brandName === brandFilter);
    if (lowMarginOnly) out = out.filter((r) => r.marginPct < effectiveTargetPct);
    if (highRevenueOnly) out = out.filter((r) => r.revenueN >= medianRevenue);
    if (topConcentrationOnly) out = out.filter((r) => topConcentrationIds.has(r.productId));
    if (highMarginOnly) out = out.filter((r) => r.marginPct >= HIGH_MARGIN_THRESHOLD_PCT);
    if (marginGroupFocus === "below10") out = out.filter((r) => r.marginPct < 10);
    else if (marginGroupFocus === "mid1020") out = out.filter((r) => r.marginPct >= 10 && r.marginPct < 20);
    else if (marginGroupFocus === "above20") out = out.filter((r) => r.marginPct >= 20);
    if (opportunityFocus === "pricing") out = out.filter((r) => pricingReview.includes(r));
    else if (opportunityFocus === "supplier") out = out.filter((r) => supplierNegotiation.includes(r));
    else if (opportunityFocus === "stock") out = out.filter((r) => stockReview.includes(r));
    return out;
  }, [
    soldRows, search, categoryFilter, namesUnderCategoryId, marginBandFilter, brandFilter, lowMarginOnly, highRevenueOnly,
    topConcentrationOnly, topConcentrationIds, highMarginOnly, marginGroupFocus,
    effectiveTargetPct, medianRevenue, opportunityFocus, pricingReview, supplierNegotiation, stockReview,
  ]);

  const activeFilterPills: FilterPill[] = [
    ...categoryFilter.map((id) => ({ key: `cat-${id}`, label: `Category: ${categoryTreeOptions.find((c) => c.value === id)?.label ?? "Selected"}` })),
    ...(marginBandFilter !== "all" ? [{ key: "band", label: `Margin: ${MARGIN_BANDS.find((b) => b.key === marginBandFilter)?.label ?? marginBandFilter}` }] : []),
    ...(brandFilter !== "all" ? [{ key: "brand", label: `Brand: ${brandFilter}` }] : []),
    ...(lowMarginOnly ? [{ key: "lowMargin", label: `Low margin only (<${effectiveTargetPct.toFixed(0)}%)` }] : []),
    ...(highRevenueOnly ? [{ key: "highRevenue", label: "High revenue only (≥ median)" }] : []),
    ...(topConcentrationOnly ? [{ key: "topConcentration", label: `Top ${TOP_GP_CONCENTRATION_N} by gross profit` }] : []),
    ...(highMarginOnly ? [{ key: "highMargin", label: `High margin only (≥${HIGH_MARGIN_THRESHOLD_PCT}%)` }] : []),
    ...(marginGroupFocus ? [{ key: "marginGroup", label: `Margin group: ${marginGroupFocus === "below10" ? "Below 10%" : marginGroupFocus === "mid1020" ? "10–20%" : "Above 20%"}` }] : []),
    ...(opportunityFocus ? [{ key: "opportunity", label: `Segment: ${opportunityFocus === "pricing" ? "Pricing Review" : opportunityFocus === "supplier" ? "Supplier Negotiation" : "Stock Review"}` }] : []),
  ];
  const activeFilterCount = activeFilterPills.length;

  useEffect(() => {
    if (filteredRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `margin-by-product-${days}d.csv`,
      headers: ["SKU", "Product", "Brand", "Commercial Category", "Revenue", "COGS", "Gross Profit", "Margin %", "Units Sold", "Stock On Hand", "Suggested Action"],
      rows: filteredRows.map((r) => [
        r.sku, r.name, r.brandName ?? "", r.category, r.revenueN, r.costN, r.marginN, r.marginPct.toFixed(1), r.unitsSold, r.stockOnHand, suggestedActionFor(r),
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [filteredRows, days, onExportData, actionByProductId]);

  const columns: Column<EnrichedRow>[] = [
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
    { key: "name", header: "Product" },
    { key: "category", header: "Commercial Category", render: (r) => <span className={css.mutedcell}>{r.category}</span> },
    { key: "revenueN", header: "Revenue (LKR)", align: "right", sortable: true, getValue: (r) => r.revenueN, render: (r) => formatMoney(r.revenueN) },
    { key: "costN", header: "COGS (LKR)", align: "right", sortable: true, getValue: (r) => r.costN, render: (r) => <span className={css.mutedcell}>{formatMoney(r.costN)}</span> },
    { key: "marginN", header: "Gross Profit (LKR)", align: "right", sortable: true, getValue: (r) => r.marginN, render: (r) => formatMoney(r.marginN) },
    { key: "marginPct", header: "Margin %", align: "right", sortable: true, getValue: (r) => r.marginPct, render: (r) => `${r.marginPct.toFixed(1)}%` },
    { key: "unitsSold", header: "Units Sold", align: "right", sortable: true, getValue: (r) => r.unitsSold, render: (r) => r.unitsSold.toLocaleString("en-IN") },
    { key: "stockOnHand", header: "Stock On Hand", align: "right", sortable: true, getValue: (r) => r.stockOnHand, render: (r) => r.stockOnHand.toLocaleString("en-IN") },
    {
      key: "suggestedAction",
      header: "Suggested Action",
      render: (r) => {
        const action = suggestedActionFor(r);
        return (
          <Link href={`/products/${r.productId}?tab=pricing`} className={css.suggestedActionLink} data-tooltip="View pricing">
            <StatusBadge status={action} label={action} variant={ACTION_VARIANT[action]} />
          </Link>
        );
      },
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Median Product Margin"
          value={loading ? "…" : `${medianMarginPct.toFixed(1)}%`}
          subtitle={`Typical SKU — vs previous ${days} days`}
          icon={<IconPill size={16} />}
          trend={!loading && previousSoldRows.length > 0 ? { value: formatPpTrend(ppChange(medianMarginPct, previousMedianMarginPct)), direction: medianMarginPct >= previousMedianMarginPct ? "up" : "down", tone: medianMarginPct >= previousMedianMarginPct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Product Gross Profit Concentration"
          value={loading ? "…" : `${gpConcentrationPct.toFixed(1)}%`}
          subtitle={`Top ${TOP_GP_CONCENTRATION_N} products contribute`}
          icon={<IconGrid size={16} />}
          iconTone="info"
          trend={!loading && previousTotals.margin > 0 ? { value: formatPpTrend(ppChange(gpConcentrationPct, previousGpConcentrationPct)), direction: gpConcentrationPct >= previousGpConcentrationPct ? "up" : "down", tone: gpConcentrationPct >= previousGpConcentrationPct ? "warning" : "positive" } : undefined}
          onClick={toggleTopConcentrationOnly}
          active={topConcentrationOnly}
        />
        <StatCard size="sm" showMenu={false}
          title={`High-Margin Sales Share (≥ ${HIGH_MARGIN_THRESHOLD_PCT}%)`}
          value={loading ? "…" : `${highMarginSharePct.toFixed(1)}%`}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="success"
          trend={!loading && previousTotals.revenue > 0 ? { value: formatPpTrend(ppChange(highMarginSharePct, previousHighMarginSharePct)), direction: highMarginSharePct >= previousHighMarginSharePct ? "up" : "down", tone: highMarginSharePct >= previousHighMarginSharePct ? "positive" : "danger" } : undefined}
          onClick={toggleHighMarginOnly}
          active={highMarginOnly}
        />
        <StatCard size="sm" showMenu={false}
          title="Products Below Target Margin"
          value={loading ? "…" : belowTargetCount}
          subtitle={`Target margin: ${effectiveTargetPct.toFixed(0)}%${targetPct == null ? " (default)" : ""}`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          trend={!loading && previousSoldRows.length > 0 && belowTargetDelta !== 0 ? { value: `${Math.abs(belowTargetDelta)}`, direction: belowTargetDelta > 0 ? "down" : "up", tone: belowTargetDelta > 0 ? "positive" : "danger" } : undefined}
          onClick={toggleLowMarginOnly}
          active={lowMarginOnly}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow} ${css.gridAlignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Product Profitability Distribution</h3>
              <p>Number of products and revenue exposure by margin band</p>
            </div>
            <Link href="/settings/profitability" className={css.cardLink}>
              Adjust target margin <IconChevronRight size={13} />
            </Link>
          </div>
          <MarginDistributionChart
            bands={bands}
            formatRevenue={formatCompactMoney}
            targetPosition={targetBandPosition(effectiveTargetPct)}
            targetLabel={`Target ${effectiveTargetPct.toFixed(0)}%`}
            height={146}
          />
          <div className={css.chipRow2}>
            <button
              type="button"
              className={`${css.chip2} ${css.chip2Link} ${marginGroupFocus === "below10" ? css.chip2Active : ""}`}
              onClick={() => toggleMarginGroup("below10")}
              aria-pressed={marginGroupFocus === "below10"}
            >
              <span className={css.chip2Label}>Below 10% margin</span>
              <b className={css.deltaDown}>{belowTenCount}</b>
            </button>
            <button
              type="button"
              className={`${css.chip2} ${css.chip2Link} ${marginGroupFocus === "mid1020" ? css.chip2Active : ""}`}
              onClick={() => toggleMarginGroup("mid1020")}
              aria-pressed={marginGroupFocus === "mid1020"}
            >
              <span className={css.chip2Label}>10–20% margin</span>
              <b className={css.chip2Neutral}>{tenToTwentyCount}</b>
            </button>
            <button
              type="button"
              className={`${css.chip2} ${css.chip2Link} ${marginGroupFocus === "above20" ? css.chip2Active : ""}`}
              onClick={() => toggleMarginGroup("above20")}
              aria-pressed={marginGroupFocus === "above20"}
            >
              <span className={css.chip2Label}>Above 20% margin</span>
              <b className={css.deltaUp}>{aboveTwentyCount}</b>
            </button>
          </div>
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Gross Profit Contribution by Product Tiers</h3>
              <p>How much of total profitability the top products drive vs. the long tail</p>
            </div>
          </div>
          <div className={css.hierTableWrap}>
            <table className={css.hierTable}>
              <thead>
                <tr>
                  <th>Tier</th>
                  <th style={{ textAlign: "right" }}>Share of Gross Profit</th>
                  <th style={{ textAlign: "right" }}>Gross Profit (LKR)</th>
                </tr>
              </thead>
              <tbody>
                {gpTiers.map((t) => (
                  <tr key={t.key}>
                    <td>{t.label}</td>
                    <td style={{ textAlign: "right" }}>
                      <InlineBarCell valueLabel={`${t.sharePct.toFixed(1)}%`} pct={t.sharePct} />
                    </td>
                    <td style={{ textAlign: "right" }}>{formatMoney(t.marginSum)}</td>
                  </tr>
                ))}
                <tr className={css.hierParentRow}>
                  <td>All Products</td>
                  <td style={{ textAlign: "right" }}>100%</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(currentTotals.margin)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className={`${css.grid2} ${css.firstRow}`}>
        <RankingTableCard
          title="Top Products by Gross Profit"
          rows={rankedByMargin.slice(0, 5)}
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
          footer={
            <div className={css.cardFooterLink}>
              <button type="button" className={css.cardLink} onClick={() => document.getElementById("all-products-table")?.scrollIntoView({ behavior: "smooth" })}>
                View full ranking
              </button>
            </div>
          }
        />

        <ActionsPanel
          title="Margin Opportunity Segments"
          items={opportunityItems}
          variant="cards"
          onViewAll={toggleLowMarginOnly}
        />
      </div>

      <div className={css.card} id="all-products-table">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>
            All Products Profitability
            {opportunityFocus ? (
              <button type="button" className={css.focusClearBtn} onClick={() => setOpportunityFocus(null)}>
                {opportunityFocus === "pricing" ? "Pricing Review" : opportunityFocus === "supplier" ? "Supplier Negotiation" : "Stock Review"} ×
              </button>
            ) : null}
          </h3>
          <div className={css.toolbarActions}>
            <div className={css.filterfield}>
              <label>Category</label>
              <TreeMultiSelect
                label="Category"
                options={categoryTreeOptions}
                selected={categoryFilter}
                onChange={setCategoryFilter}
                searchPlaceholder="Search categories…"
                className={css.categoryFilterField}
              />
            </div>
            <div className={css.filterfield}>
              <label>Margin Band</label>
              <ReportSelect ariaLabel="Margin Band" value={marginBandFilter} onChange={setMarginBandFilter} options={marginBandOptions} />
            </div>
            <div className={css.filterfield}>
              <label>Brand</label>
              <ReportSelect ariaLabel="Brand" value={brandFilter} onChange={setBrandFilter} options={brandOptions} />
            </div>
            <button type="button" className={`${css.toggleChip} ${css.toggleChipRose} ${lowMarginOnly ? css.toggleChipActive : ""}`} onClick={() => setLowMarginOnly((v) => !v)} aria-pressed={lowMarginOnly}>
              <IconDollarSign size={14} />
              Only low margins
            </button>
            <button type="button" className={`${css.toggleChip} ${css.toggleChipAmber} ${highRevenueOnly ? css.toggleChipActive : ""}`} onClick={() => setHighRevenueOnly((v) => !v)} aria-pressed={highRevenueOnly}>
              <IconArchive size={14} />
              Only high revenue
            </button>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
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
                setMarginBandFilter("all");
                setBrandFilter("all");
                setLowMarginOnly(false);
                setHighRevenueOnly(false);
                setTopConcentrationOnly(false);
                setHighMarginOnly(false);
                setMarginGroupFocus(null);
                setOpportunityFocus(null);
              }}
              clearTooltip="Reset all product filters"
            />
          </div>
        )}

        <DataTable columns={columns} data={filteredRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No products match these filters" compact />
      </div>
    </div>
  );
}
