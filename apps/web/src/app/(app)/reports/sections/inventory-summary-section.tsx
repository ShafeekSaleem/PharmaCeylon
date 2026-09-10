"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconBox,
  IconCalendar,
  IconCheckCircle,
  IconClipboard,
  IconClipboardList,
  IconDollarSign,
  IconEye,
  IconGrid,
  IconSplit,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { fetchInventorySummary } from "../lib/fetchers";
import { formatMoney, formatCompactMoney, formatPctTrend, pctChange } from "../lib/format";
import { categoryMixColorLight, categoryChildColor, CATEGORY_MIX_OTHERS_COLOR_LIGHT } from "../lib/category-mix-colors";
import { CategoryIconBadge } from "@/lib/category-icons";
import { StockValueTreemap, type TreemapNode } from "../components/stock-value-treemap";
import { InventorySalesDumbbellChart, type DumbbellRow } from "../components/inventory-sales-dumbbell-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { ExportPayload, OnExportData, Scope, StockValueItem, StockValueSnapshotItem, StockValueTrendPoint } from "../lib/types";
import css from "../reports.module.css";

export type ValuationBasis = "cost" | "retail";

type Props = {
  scope: Scope;
  isOwner: boolean;
  categoryId?: string;
  supplierId?: string;
  valuationBasis: ValuationBasis;
  onExportData: OnExportData;
};

const MAX_TREEMAP_DEPARTMENTS = 6;
const OTHER_ID = "__other__";
const OVERSTOCK_COVER_DAYS = 180;
/** Department-level Health badge on the Category Breakdown table: share of a department's own
 *  stock value sitting in an at-risk (overstock/slow-moving/dead) SKU — thresholds are somewhat
 *  arbitrary but documented and applied identically to every department. */
const DEPT_HEALTH_AT_RISK_PCT = 30;
const DEPT_HEALTH_WATCH_PCT = 10;

type DeptAgg = {
  id: string;
  name: string;
  value: number;
  retailValue: number;
  qty: number;
  velocitySum: number;
  productIds: Set<string>;
  atRiskValue: { cost: number; retail: number };
  lowStockCount: number;
};

function basisOf(basis: ValuationBasis, cost: number, retail: number): number {
  return basis === "cost" ? cost : retail;
}

/** A product counts toward Capital at Risk if it's slow-moving-but-selling (isAtRisk, from the
 *  API) OR if it has zero sales velocity while still holding stock (dead weight) — the union of
 *  "overstock/slow-moving" and "dead stock" the KPI's name promises, without a second heavy query:
 *  both signals are already present on every `StockValueItem`. */
function isCapitalAtRisk(it: Pick<StockValueItem, "isAtRisk" | "avgDailySales" | "qtyOnHand">): boolean {
  return it.isAtRisk || (it.avgDailySales === 0 && it.qtyOnHand > 0);
}

/** Tiny inline trend line for the Category Value Breakdown table — colored by direction (green
 *  rising / red falling / muted flat) with a soft area fill and an end-point dot, so the shape
 *  and the direction both read at a glance without needing axes or a separate arrow icon. */
function Sparkline({ points, direction }: { points: number[]; direction: "up" | "down" | "flat" }) {
  if (points.length < 2) return <span className={css.mutedcell}>—</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 60;
  const h = 24;
  const padY = 3;
  const step = w / (points.length - 1);
  const color = direction === "up" ? "var(--pc-tone-success)" : direction === "down" ? "var(--pc-tone-danger)" : "var(--pc-muted-fg)";
  const coords = points.map((p, i) => [i * step, h - padY - ((p - min) / range) * (h - padY * 2)] as const);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1]!;
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={css.sparkline} aria-hidden>
      <path d={areaPath} fill={color} opacity={0.14} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.3} fill={color} stroke="var(--pc-card-bg)" strokeWidth={1} />
    </svg>
  );
}

type HealthKey = "healthy" | "watch" | "atRisk";
const DEPT_HEALTH_LABEL: Record<HealthKey, string> = { healthy: "Healthy", watch: "Watch", atRisk: "At Risk" };

/** Where our inventory capital currently sits, and whether that allocation is healthy — not
 *  expiry, dead-stock/ageing, or movement (those own their own reports). This one owns total
 *  capital, category allocation vs where revenue actually comes from, product-value ranking, and
 *  capital exposure. */
export function InventorySummarySection({ scope, isOwner, categoryId, supplierId, valuationBasis, onExportData }: Props) {
  const [items, setItems] = useState<StockValueItem[]>([]);
  const [previousItems, setPreviousItems] = useState<StockValueSnapshotItem[]>([]);
  const [trend, setTrend] = useState<StockValueTrendPoint[]>([]);
  const [skuUniverseCount, setSkuUniverseCount] = useState(0);
  const [salesByDepartment, setSalesByDepartment] = useState<Array<{ departmentId: string | null; departmentName: string; revenue: number }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drilldownDeptId, setDrilldownDeptId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDrilldownDeptId(null);
    fetchInventorySummary(scope, isOwner, categoryId, supplierId)
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setPreviousItems(res.previousItems);
        setTrend(res.trend);
        setSkuUniverseCount(res.skuUniverseCount);
        setSalesByDepartment(res.salesByDepartment);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load inventory summary data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, isOwner, categoryId, supplierId]);

  const val = (costV: string | number, retailV: string | number) => basisOf(valuationBasis, Number(costV), Number(retailV));

  // ── KPIs ────────────────────────────────────────────────────────────────────────────────
  const totalValue = items.reduce((s, it) => s + val(it.value, it.retailValue), 0);
  const prevTotalValue = previousItems.reduce((s, it) => s + val(it.value, it.retailValue), 0);

  const stockAvailabilityPct = skuUniverseCount > 0 ? (items.length / skuUniverseCount) * 100 : 0;
  const prevStockAvailabilityPct = skuUniverseCount > 0 ? (previousItems.length / skuUniverseCount) * 100 : 0;
  const outOfStockCount = Math.max(0, skuUniverseCount - items.length);

  const avgDailySalesByProduct = useMemo(() => new Map(items.map((it) => [it.productId, it.avgDailySales])), [items]);

  const avgDaysCover = useMemo(() => {
    const coverable = items.filter((it) => it.daysOfCover != null);
    const weight = coverable.reduce((s, it) => s + val(it.value, it.retailValue), 0);
    if (weight <= 0) return null;
    return coverable.reduce((s, it) => s + it.daysOfCover! * val(it.value, it.retailValue), 0) / weight;
  }, [items, valuationBasis]);

  // Approximated using CURRENT velocity applied to the 30-days-ago quantity — recomputing
  // historical velocity isn't worth a second heavy query for a single trend arrow, and this
  // mirrors the same "today's classification, yesterday's quantity" approach Capital at Risk's
  // own trend already uses below.
  const prevAvgDaysCover = useMemo(() => {
    const rows = previousItems
      .map((pi) => {
        const velocity = avgDailySalesByProduct.get(pi.productId) ?? 0;
        const cover = velocity > 0 ? pi.qtyOnHand / velocity : null;
        return cover == null ? null : { weight: val(pi.value, pi.retailValue), cover };
      })
      .filter((x): x is { weight: number; cover: number } => x != null);
    const weight = rows.reduce((s, r) => s + r.weight, 0);
    if (weight <= 0) return null;
    return rows.reduce((s, r) => s + r.cover * r.weight, 0) / weight;
  }, [previousItems, avgDailySalesByProduct, valuationBasis]);

  const atRiskItems = useMemo(() => items.filter(isCapitalAtRisk), [items]);
  const atRiskValue = atRiskItems.reduce((s, it) => s + val(it.value, it.retailValue), 0);
  const atRiskPct = totalValue > 0 ? (atRiskValue / totalValue) * 100 : 0;
  // Same basket (today's at-risk classification), valued 30 days ago — a defensible trend signal
  // without re-deriving who-was-at-risk-then from a different velocity window.
  const atRiskProductIds = useMemo(() => new Set(atRiskItems.map((it) => it.productId)), [atRiskItems]);
  const prevAtRiskValue = previousItems.filter((it) => atRiskProductIds.has(it.productId)).reduce((s, it) => s + val(it.value, it.retailValue), 0);

  // ── Department rollups (every panel below groups at this level) ────────────────────────────
  const departmentTotals = useMemo(() => {
    const map = new Map<string, DeptAgg>();
    for (const it of items) {
      const key = it.departmentId ?? "unclassified";
      const cur =
        map.get(key) ??
        { id: key, name: it.departmentName, value: 0, retailValue: 0, qty: 0, velocitySum: 0, productIds: new Set<string>(), atRiskValue: { cost: 0, retail: 0 }, lowStockCount: 0 };
      cur.value += Number(it.value);
      cur.retailValue += Number(it.retailValue);
      cur.qty += it.qtyOnHand;
      if (!cur.productIds.has(it.productId)) {
        cur.productIds.add(it.productId);
        cur.velocitySum += it.avgDailySales;
      }
      if (isCapitalAtRisk(it)) {
        cur.atRiskValue.cost += Number(it.value);
        cur.atRiskValue.retail += Number(it.retailValue);
      }
      if (it.isLowStock) cur.lowStockCount += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => basisOf(valuationBasis, b.value, b.retailValue) - basisOf(valuationBasis, a.value, a.retailValue));
  }, [items, valuationBasis]);

  const prevValueByDept = useMemo(() => {
    const map = new Map<string, number>();
    for (const pi of previousItems) {
      const key = pi.departmentId ?? "unclassified";
      map.set(key, (map.get(key) ?? 0) + val(pi.value, pi.retailValue));
    }
    return map;
  }, [previousItems, valuationBasis]);

  // Folds every department beyond the top N into a single "Other" bucket — keeps the treemap and
  // concentration chart readable regardless of how many departments a tenant has enabled, while
  // every panel that isn't space-constrained (the breakdown table) still shows every real one.
  const groupedDepartments = useMemo(() => {
    if (departmentTotals.length <= MAX_TREEMAP_DEPARTMENTS) return departmentTotals;
    const head = departmentTotals.slice(0, MAX_TREEMAP_DEPARTMENTS);
    const tail = departmentTotals.slice(MAX_TREEMAP_DEPARTMENTS);
    const other: DeptAgg = tail.reduce(
      (acc, d) => {
        acc.value += d.value;
        acc.retailValue += d.retailValue;
        acc.qty += d.qty;
        acc.velocitySum += d.velocitySum;
        return acc;
      },
      { id: OTHER_ID, name: "Other", value: 0, retailValue: 0, qty: 0, velocitySum: 0, productIds: new Set<string>(), atRiskValue: { cost: 0, retail: 0 }, lowStockCount: 0 },
    );
    return [...head, other];
  }, [departmentTotals]);

  // The departments folded into the treemap's "Other" tile — selecting "Other" filters
  // downstream panels to the union of these, same as selecting a single real department does.
  const otherDeptIds = useMemo(() => new Set(departmentTotals.slice(MAX_TREEMAP_DEPARTMENTS).map((d) => d.id)), [departmentTotals]);
  const isOtherDrilldown = drilldownDeptId === OTHER_ID;
  const isDeptDrilldown = drilldownDeptId != null && !isOtherDrilldown;
  // The department id(s) that should filter Top Items / Category Breakdown right now — null means
  // "no filter, show everything" (same convention as every other drill-to-filter report page).
  const activeDeptIds = useMemo<Set<string> | null>(() => {
    if (isDeptDrilldown) return new Set([drilldownDeptId!]);
    if (isOtherDrilldown) return otherDeptIds;
    return null;
  }, [isDeptDrilldown, isOtherDrilldown, drilldownDeptId, otherDeptIds]);

  const leafTotalsForDrilldown = useMemo(() => {
    if (!isDeptDrilldown) return [];
    const map = new Map<string, DeptAgg>();
    for (const it of items) {
      if ((it.departmentId ?? "unclassified") !== drilldownDeptId) continue;
      const key = it.categoryId ?? "unclassified-leaf";
      const cur =
        map.get(key) ??
        { id: key, name: it.categoryName, value: 0, retailValue: 0, qty: 0, velocitySum: 0, productIds: new Set<string>(), atRiskValue: { cost: 0, retail: 0 }, lowStockCount: 0 };
      cur.value += Number(it.value);
      cur.retailValue += Number(it.retailValue);
      cur.qty += it.qtyOnHand;
      if (!cur.productIds.has(it.productId)) {
        cur.productIds.add(it.productId);
        cur.velocitySum += it.avgDailySales;
      }
      if (isCapitalAtRisk(it)) {
        cur.atRiskValue.cost += Number(it.value);
        cur.atRiskValue.retail += Number(it.retailValue);
      }
      if (it.isLowStock) cur.lowStockCount += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => basisOf(valuationBasis, b.value, b.retailValue) - basisOf(valuationBasis, a.value, a.retailValue));
  }, [items, drilldownDeptId, isDeptDrilldown, valuationBasis]);

  const drilldownDeptName = isDeptDrilldown ? (departmentTotals.find((d) => d.id === drilldownDeptId)?.name ?? "") : "";
  // Light breadcrumb: a department reached FROM the "Other" view backs up into Other, not all
  // the way out — otherwise "Other" would be a dead end you can only ever enter, never revisit.
  const cameFromOther = isDeptDrilldown && otherDeptIds.has(drilldownDeptId!);

  const treemapSource = isDeptDrilldown ? leafTotalsForDrilldown : isOtherDrilldown ? departmentTotals.slice(MAX_TREEMAP_DEPARTMENTS) : groupedDepartments;
  const treemapTotal = treemapSource.reduce((s, d) => s + basisOf(valuationBasis, d.value, d.retailValue), 0);
  const treemapNodes: TreemapNode[] = treemapSource.map((d) => ({
    id: d.id,
    label: d.name,
    value: basisOf(valuationBasis, d.value, d.retailValue),
    share: treemapTotal > 0 ? (basisOf(valuationBasis, d.value, d.retailValue) / treemapTotal) * 100 : 0,
    units: d.qty,
    daysOfCover: d.velocitySum > 0 ? Math.round(d.qty / d.velocitySum) : null,
  }));

  function treemapColorOf(id: string, index: number): string {
    if (id === OTHER_ID) return CATEGORY_MIX_OTHERS_COLOR_LIGHT;
    if (isDeptDrilldown) {
      const baseIndex = departmentTotals.findIndex((d) => d.id === drilldownDeptId);
      return categoryChildColor(categoryMixColorLight(baseIndex >= 0 ? baseIndex : 0), index, treemapSource.length);
    }
    return categoryMixColorLight(index);
  }

  const top3Share = useMemo(() => {
    const total = departmentTotals.reduce((s, d) => s + basisOf(valuationBasis, d.value, d.retailValue), 0);
    const top3 = departmentTotals.slice(0, 3).reduce((s, d) => s + basisOf(valuationBasis, d.value, d.retailValue), 0);
    return total > 0 ? (top3 / total) * 100 : 0;
  }, [departmentTotals, valuationBasis]);

  // ── Inventory Share vs Sales Share ──────────────────────────────────────────────────────
  const totalSalesRevenue = salesByDepartment.reduce((s, d) => s + d.revenue, 0);
  const salesRevenueByDeptId = useMemo(
    () => new Map(salesByDepartment.map((d) => [d.departmentId ?? "unclassified", d.revenue])),
    [salesByDepartment],
  );

  const shareRows: DumbbellRow[] = useMemo(
    () =>
      departmentTotals.map((d) => {
        const inventoryValue = basisOf(valuationBasis, d.value, d.retailValue);
        const inventoryPct = totalValue > 0 ? (inventoryValue / totalValue) * 100 : 0;
        const salesValue = salesRevenueByDeptId.get(d.id) ?? 0;
        const salesPct = totalSalesRevenue > 0 ? (salesValue / totalSalesRevenue) * 100 : 0;
        return { id: d.id, label: d.name, inventoryPct, inventoryValue, salesPct, salesValue };
      }),
    [departmentTotals, salesRevenueByDeptId, totalSalesRevenue, totalValue, valuationBasis],
  );

  const biggestImbalance = useMemo(
    () => (shareRows.length > 0 ? [...shareRows].sort((a, b) => b.inventoryPct - b.salesPct - (a.inventoryPct - a.salesPct))[0] : undefined),
    [shareRows],
  );

  // ── Insights ────────────────────────────────────────────────────────────────────────────
  const topDept = departmentTotals[0];
  const topDeptShare = topDept && totalValue > 0 ? (basisOf(valuationBasis, topDept.value, topDept.retailValue) / totalValue) * 100 : 0;

  const overstockDepts = useMemo(
    () => departmentTotals.filter((d) => d.velocitySum > 0 && d.qty / d.velocitySum > OVERSTOCK_COVER_DAYS),
    [departmentTotals],
  );
  const overstockValue = overstockDepts.reduce((s, d) => s + val(d.atRiskValue.cost, d.atRiskValue.retail), 0);

  const lowStockItems = useMemo(() => items.filter((it) => it.isLowStock), [items]);
  const lowStockDeptCount = new Set(lowStockItems.map((it) => it.departmentId ?? "unclassified")).size;

  function scrollToBreakdown() {
    document.getElementById("category-value-breakdown")?.scrollIntoView({ behavior: "smooth" });
  }
  function scrollToTopItems() {
    document.getElementById("top-items-by-value")?.scrollIntoView({ behavior: "smooth" });
  }
  function scrollToShareChart() {
    document.getElementById("inventory-sales-share")?.scrollIntoView({ behavior: "smooth" });
  }

  const imbalanceGapPct = biggestImbalance ? biggestImbalance.inventoryPct - biggestImbalance.salesPct : 0;
  const imbalanceGapValue = totalValue > 0 ? (imbalanceGapPct / 100) * totalValue : 0;

  const insightItems: ActionPanelItem[] = [
    ...(topDept
      ? [{
          key: "high-value",
          icon: <IconGrid size={16} />,
          tone: "primary" as const,
          title: "High-value categories",
          description: `${topDept.name} account${topDept.name.endsWith("s") ? "" : "s"} for ${topDeptShare.toFixed(1)}% of total stock value.`,
          count: Math.round(topDeptShare),
          countLabel: "%",
          countText: formatMoney(basisOf(valuationBasis, topDept.value, topDept.retailValue)),
          onClick: scrollToBreakdown,
          examples: [{ label: topDept.name, badge: `${topDeptShare.toFixed(1)}%`, tone: "neutral" as const }],
        }]
      : []),
    ...(biggestImbalance && imbalanceGapPct > 5
      ? [{
          key: "inventory-sales-imbalance",
          icon: <IconSplit size={16} />,
          tone: "warning" as const,
          title: "Inventory / sales imbalance",
          description: `${biggestImbalance.label} holds ${biggestImbalance.inventoryPct.toFixed(1)}% of inventory value but drives only ${biggestImbalance.salesPct.toFixed(1)}% of sales — approximately ${formatMoney(imbalanceGapValue)} may be over-allocated relative to its revenue contribution.`,
          count: Math.round(imbalanceGapPct),
          countLabel: "pt gap",
          onClick: scrollToShareChart,
          examples: [{ label: biggestImbalance.label, badge: `${formatMoney(imbalanceGapValue)} excess`, tone: "negative" as const }],
        }]
      : []),
    ...(overstockDepts.length > 0
      ? [{
          key: "overstock-risk",
          icon: <IconAlertTriangle size={16} />,
          tone: "warning" as const,
          title: "Overstock risk",
          description: `${overstockDepts.length} categor${overstockDepts.length === 1 ? "y has" : "ies have"} average days of cover > ${OVERSTOCK_COVER_DAYS} days.`,
          count: overstockDepts.length,
          countLabel: "cats",
          countText: formatMoney(overstockValue),
          onClick: scrollToBreakdown,
          examples: [{ label: "Exposed value", badge: formatMoney(overstockValue), tone: "negative" as const }],
        }]
      : []),
    ...(lowStockItems.length > 0
      ? [{
          key: "reorder-watch",
          icon: <IconClipboard size={16} />,
          tone: "danger" as const,
          title: "Reorder watch",
          description: `${lowStockItems.length} SKU${lowStockItems.length === 1 ? "" : "s"} across ${lowStockDeptCount} categor${lowStockDeptCount === 1 ? "y" : "ies"} are below minimum stock.`,
          count: lowStockItems.length,
          countLabel: "SKUs",
          onClick: scrollToTopItems,
          examples: [{ label: "Below minimum", badge: `${lowStockItems.length} SKUs`, tone: "negative" as const }],
        }]
      : []),
    ...(departmentTotals.length >= 2
      ? [{
          key: "value-concentration",
          icon: <IconClipboardList size={16} />,
          tone: "purple" as const,
          title: "Value concentration",
          description: `Top 3 categories represent ${top3Share.toFixed(1)}% of inventory value.`,
          count: Math.round(top3Share),
          countLabel: "%",
          onClick: scrollToBreakdown,
          examples: [{ label: "Top 3 categories", badge: `${top3Share.toFixed(1)}%`, tone: "neutral" as const }],
        }]
      : []),
  ];

  // ── Top Items by Stock Value ────────────────────────────────────────────────────────────
  type StatusKey = "healthy" | "lowCover" | "overstocked" | "slowMoving";
  const STATUS_LABEL: Record<StatusKey, string> = { healthy: "Healthy", lowCover: "Low Cover", overstocked: "Overstocked", slowMoving: "Slow Moving" };
  function statusOf(it: StockValueItem): StatusKey {
    if (it.isLowStock) return "lowCover";
    if (it.isAtRisk) return it.daysOfCover != null && it.daysOfCover > 365 ? "overstocked" : "slowMoving";
    return "healthy";
  }

  const topItemsRows = useMemo(() => {
    const base = activeDeptIds ? items.filter((it) => activeDeptIds.has(it.departmentId ?? "unclassified")) : items;
    return [...base].sort((a, b) => val(b.value, b.retailValue) - val(a.value, a.retailValue));
  }, [items, valuationBasis, activeDeptIds]);

  const topItemsColumns: Column<StockValueItem>[] = [
    { key: "idx", header: "#", width: "1.4rem", render: (_r, i) => <span className={css.rowNum}>{i + 1}</span> },
    { key: "product", header: "Product", width: "9.5rem", render: (r) => (
      <>
        <span className={css.skucode}>{r.product.sku ?? r.productId}</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`} data-tooltip={r.product.name ?? ""}>{r.product.name ?? ""}</div>
      </>
    ) },
    { key: "category", header: "Category", width: "7rem", render: (r) => (
      <span className={css.categoryCell}>
        <CategoryIconBadge name={r.departmentName} size={19} />
        <span className={css.mutedcell}>{r.departmentName}</span>
      </span>
    ) },
    { key: "value", header: "Stock Value", width: "6.5rem", align: "right", sortable: true, getValue: (r) => val(r.value, r.retailValue), render: (r) => formatMoney(val(r.value, r.retailValue)) },
    { key: "qty", header: "Units", width: "3.5rem", align: "right", sortable: true, getValue: (r) => r.qtyOnHand, render: (r) => r.qtyOnHand.toLocaleString("en-IN") },
    { key: "cover", header: "Cover", width: "4rem", align: "right", sortable: true, getValue: (r) => r.daysOfCover ?? -1, render: (r) => (r.daysOfCover == null ? "—" : `${r.daysOfCover}d`) },
    {
      key: "status",
      header: "Status",
      width: "6.5rem",
      render: (r) => (
        <span className={css.actionCell}>
          <span className={`${css.badge2} ${css[statusOf(r)]}`}>{STATUS_LABEL[statusOf(r)]}</span>
          <span className={css.actionIconGroup}>
            <Link className={css.rowIconBtn} href={`/products/${r.productId}`} data-tooltip="View product" aria-label="View product">
              <IconEye size={12} />
            </Link>
            <Link className={css.rowIconBtn} href={`/inventory?productId=${r.productId}`} data-tooltip="View in inventory" aria-label="View in inventory">
              <IconBox size={12} />
            </Link>
          </span>
        </span>
      ),
    },
  ];

  // ── Category Breakdown ──────────────────────────────────────────────────────────────────
  // Department-level rows — always computed in full; filtering (below) narrows which of these
  // are shown rather than re-deriving a different shape, so every column stays populated.
  const allBreakdownRows = useMemo(
    () =>
      departmentTotals.map((d) => {
        const value = basisOf(valuationBasis, d.value, d.retailValue);
        const share = totalValue > 0 ? (value / totalValue) * 100 : 0;
        const salesValue = salesRevenueByDeptId.get(d.id) ?? 0;
        const salesShare: number | null = totalSalesRevenue > 0 ? (salesValue / totalSalesRevenue) * 100 : 0;
        const daysOfCover = d.velocitySum > 0 ? Math.round(d.qty / d.velocitySum) : null;
        const growthPct = pctChange(value, prevValueByDept.get(d.id) ?? 0);
        const turnover = value > 0 ? salesValue / value : null;
        const atRiskValueDept = basisOf(valuationBasis, d.atRiskValue.cost, d.atRiskValue.retail);
        const atRiskSharePct = value > 0 ? (atRiskValueDept / value) * 100 : 0;
        const health: HealthKey = atRiskSharePct > DEPT_HEALTH_AT_RISK_PCT ? "atRisk" : atRiskSharePct > DEPT_HEALTH_WATCH_PCT ? "watch" : "healthy";
        const sparkPoints = trend.map((p) => {
          const dept = p.departments.find((td) => (td.departmentId === "unclassified" ? d.id === "unclassified" : td.departmentId === d.id));
          return dept ? basisOf(valuationBasis, dept.value, dept.retailValue) : 0;
        });
        return { id: d.id, name: d.name, value, units: d.qty, share, salesShare, daysOfCover, turnover, health, growthPct, sparkPoints };
      }),
    [departmentTotals, prevValueByDept, salesRevenueByDeptId, totalSalesRevenue, totalValue, trend, valuationBasis],
  );

  // Sub-category rows for a single drilled-into department — sales-derived columns (turnover,
  // sales share, trend) aren't available at this granularity, so they render as "—" rather than
  // a misleading 0%.
  const leafBreakdownRows = useMemo(
    () =>
      leafTotalsForDrilldown.map((d) => {
        const value = basisOf(valuationBasis, d.value, d.retailValue);
        const share = totalValue > 0 ? (value / totalValue) * 100 : 0;
        const daysOfCover = d.velocitySum > 0 ? Math.round(d.qty / d.velocitySum) : null;
        const atRiskValueLeaf = basisOf(valuationBasis, d.atRiskValue.cost, d.atRiskValue.retail);
        const atRiskSharePct = value > 0 ? (atRiskValueLeaf / value) * 100 : 0;
        const health: HealthKey = atRiskSharePct > DEPT_HEALTH_AT_RISK_PCT ? "atRisk" : atRiskSharePct > DEPT_HEALTH_WATCH_PCT ? "watch" : "healthy";
        return { id: d.id, name: d.name, value, units: d.qty, share, salesShare: null as number | null, daysOfCover, turnover: null as number | null, health, growthPct: null as number | null, sparkPoints: [] as number[] };
      }),
    [leafTotalsForDrilldown, valuationBasis, totalValue],
  );

  const breakdownRows = isDeptDrilldown ? leafBreakdownRows : isOtherDrilldown ? allBreakdownRows.filter((r) => otherDeptIds.has(r.id)) : allBreakdownRows;

  const breakdownColumns: Column<(typeof breakdownRows)[number]>[] = [
    { key: "name", header: "Commercial Category", width: "11rem", render: (r) => (
      <span className={css.categoryCell}>
        <CategoryIconBadge name={r.name} size={22} />
        <span>{r.name}</span>
      </span>
    ) },
    { key: "value", header: "Stock Value", width: "6.5rem", align: "right", sortable: true, getValue: (r) => r.value, render: (r) => formatMoney(r.value) },
    { key: "share", header: "Inv Share", width: "4.5rem", align: "right", sortable: true, getValue: (r) => r.share, render: (r) => `${r.share.toFixed(1)}%` },
    { key: "salesShare", header: "Sales Share", width: "4.8rem", align: "right", sortable: true, getValue: (r) => r.salesShare ?? -1, render: (r) => (r.salesShare == null ? "—" : `${r.salesShare.toFixed(1)}%`) },
    { key: "units", header: "Units", width: "4rem", align: "right", sortable: true, getValue: (r) => r.units },
    { key: "cover", header: "Days Cover", width: "4.5rem", align: "right", sortable: true, getValue: (r) => r.daysOfCover ?? -1, render: (r) => (r.daysOfCover == null ? "—" : `${r.daysOfCover}d`) },
    {
      key: "turnover",
      header: "Turnover",
      width: "4.5rem",
      align: "right",
      sortable: true,
      getValue: (r) => r.turnover ?? -1,
      render: (r) => (r.turnover == null ? "—" : <span data-tooltip="Trailing-30-day sales revenue ÷ current stock value">{`${r.turnover.toFixed(2)}×/mo`}</span>),
    },
    {
      key: "trend",
      header: "Trend (30D)",
      width: "7rem",
      align: "right",
      render: (r) => {
        const direction: "up" | "down" | "flat" = r.growthPct == null || Math.abs(r.growthPct) < 0.05 ? "flat" : r.growthPct > 0 ? "up" : "down";
        return (
          <span className={css.sparklineCell}>
            <Sparkline points={r.sparkPoints} direction={direction} />
            {r.growthPct == null ? (
              <span className={css.mutedcell}>—</span>
            ) : (
              <span className={direction === "up" ? css.deltaUp : direction === "down" ? css.deltaDown : css.mutedcell}>{formatPctTrend(r.growthPct)}</span>
            )}
          </span>
        );
      },
    },
    { key: "health", header: "Health", width: "5rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[r.health]}`}>{DEPT_HEALTH_LABEL[r.health]}</span> },
  ];

  useEffect(() => {
    if (items.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: "inventory-summary.csv",
      headers: ["SKU", "Product", "Commercial Category", "Qty on hand", "Stock value (cost)", "Stock value (retail)", "Days of cover", "Status"],
      rows: items.map((r) => [
        r.product.sku ?? "",
        r.product.name ?? r.productId,
        r.departmentName,
        r.qtyOnHand,
        r.value,
        r.retailValue,
        r.daysOfCover ?? "",
        STATUS_LABEL[statusOf(r)],
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, onExportData]);

  // Same "Filtered by X" banner + pill convention as every other drill-to-filter report page.
  const activeFilterLabel = isDeptDrilldown ? drilldownDeptName : isOtherDrilldown ? "Other categories" : null;
  const activeFilterPills: FilterPill[] = activeFilterLabel ? [{ key: "cat", label: activeFilterLabel }] : [];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Total Stock Value"
          value={loading ? "…" : formatMoney(totalValue)}
          subtitle="vs previous 30 days"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && prevTotalValue > 0 ? { value: formatPctTrend(pctChange(totalValue, prevTotalValue)), direction: totalValue >= prevTotalValue ? "up" : "down", tone: totalValue >= prevTotalValue ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Stock Availability"
          value={loading ? "…" : `${stockAvailabilityPct.toFixed(1)}%`}
          subtitle={loading ? "" : `${outOfStockCount.toLocaleString("en-IN")} SKU${outOfStockCount === 1 ? "" : "s"} out of stock`}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && prevStockAvailabilityPct > 0 ? { value: formatPctTrend(pctChange(stockAvailabilityPct, prevStockAvailabilityPct)), direction: stockAvailabilityPct >= prevStockAvailabilityPct ? "up" : "down", tone: stockAvailabilityPct >= prevStockAvailabilityPct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Average Days of Cover"
          value={loading ? "…" : avgDaysCover == null ? "—" : `${Math.round(avgDaysCover)}d`}
          subtitle="value-weighted, vs previous 30 days"
          icon={<IconCalendar size={16} />}
          iconTone="primary"
          trend={!loading && avgDaysCover != null && prevAvgDaysCover != null && prevAvgDaysCover > 0 ? { value: formatPctTrend(pctChange(avgDaysCover, prevAvgDaysCover)), direction: avgDaysCover >= prevAvgDaysCover ? "up" : "down", tone: avgDaysCover <= prevAvgDaysCover ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Capital at Risk"
          value={loading ? "…" : formatMoney(atRiskValue)}
          subtitle={`${atRiskPct.toFixed(1)}% of total value`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          trend={!loading && prevAtRiskValue > 0 ? { value: formatPctTrend(pctChange(atRiskValue, prevAtRiskValue)), direction: atRiskValue >= prevAtRiskValue ? "up" : "down", tone: atRiskValue > prevAtRiskValue ? "danger" : "positive" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Stock Value by Commercial Category</h3>
              <p>{isDeptDrilldown ? `${drilldownDeptName} sub-categories` : isOtherDrilldown ? "Other categories" : "Tile size = stock value"}</p>
            </div>
            {drilldownDeptId ? (
              <button type="button" className={css.cardLink} onClick={() => setDrilldownDeptId(cameFromOther ? OTHER_ID : null)}>
                ← {cameFromOther ? "Back to Other" : "All departments"}
              </button>
            ) : (
              <span className={css.cardLink} style={{ cursor: "default", color: "var(--pc-muted-fg)" }}>
                Total: {formatMoney(totalValue)}
              </span>
            )}
          </div>
          <div className={css.heatmapGrow}>
            <StockValueTreemap
              nodes={treemapNodes}
              formatValue={formatMoney}
              formatTileValue={formatCompactMoney}
              colorOf={treemapColorOf}
              onTileClick={!isDeptDrilldown ? (id) => setDrilldownDeptId(id) : undefined}
            />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`} id="inventory-sales-share">
          <div className={css.cardhead}>
            <div>
              <h3>Inventory Share vs Sales Share</h3>
              <p>Where capital sits vs where revenue comes from, by category</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <InventorySalesDumbbellChart
              rows={shareRows}
              formatValue={formatMoney}
              onRowClick={(id) => setDrilldownDeptId(drilldownDeptId === id ? null : id)}
              activeId={drilldownDeptId}
            />
          </div>
        </div>
      </div>

      <div className={`${css.grid2} ${css.stockValueItemsRow} ${css.firstRow}`}>
        <div className={css.card} id="top-items-by-value">
          <div className={css.cardhead}>
            <div>
              <h3>Top Items by Stock Value</h3>
              <p>Ranked by current stock value, highest first</p>
            </div>
          </div>
          {activeFilterLabel ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by category · ${topItemsRows.length.toLocaleString("en-IN")} item${topItemsRows.length === 1 ? "" : "s"}`}
                pills={activeFilterPills}
                onClear={() => setDrilldownDeptId(null)}
                clearTooltip="Show all categories"
              />
            </div>
          ) : null}
          <DataTable columns={topItemsColumns} data={topItemsRows} rowKey={(r) => r.productId} loading={loading} pageSize={7} emptyTitle="No stock on hand in this range" compact className={css.fixedLayoutTable} />
        </div>

        <ActionsPanel title="Inventory Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>

      <div className={css.firstRow}>
        <div className={css.card} id="category-value-breakdown">
          <div className={css.cardhead}>
            <div>
              <h3>Category Breakdown</h3>
              <p>{isDeptDrilldown ? `${drilldownDeptName} sub-categories — value, share and health` : "Value, share, turnover and health by Commercial Category"}</p>
            </div>
          </div>
          {activeFilterLabel ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by category · ${breakdownRows.length.toLocaleString("en-IN")} categor${breakdownRows.length === 1 ? "y" : "ies"}`}
                pills={activeFilterPills}
                onClear={() => setDrilldownDeptId(null)}
                clearTooltip="Show all categories"
              />
            </div>
          ) : null}
          <DataTable columns={breakdownColumns} data={breakdownRows} rowKey={(r) => r.id} loading={loading} pageSize={8} emptyTitle="No categorized stock in this range" compact className={css.fixedLayoutTable} />
        </div>
      </div>
    </div>
  );
}
