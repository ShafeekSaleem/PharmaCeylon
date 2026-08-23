"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCalendar,
  IconCheckCircle,
  IconRotateCcw,
  IconSparkles,
  IconShield,
  IconTruck,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { fetchNearExpiry } from "../lib/fetchers";
import { formatCompactMoney, formatDate, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { recommendExpiryAction, type ExpiryRecommendation } from "../lib/recommendations";
import { categoryMixColor, CATEGORY_MIX_OTHERS_COLOR } from "../lib/category-mix-colors";
import { ExpiryTimeBucketChart, type TimeBucket } from "../components/expiry-time-bucket-chart";
import { ExpiryCalendarHeatmap, type ExpiryCalendarRow } from "../components/expiry-calendar-heatmap";
import { ExpiryExposureBar, type ExposureSegment, type ExposureSegmentKey } from "../components/expiry-exposure-bar";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { ExportPayload, ExpiryTier, NearExpiryItem, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = {
  scope: Scope;
  isOwner: boolean;
  days: number;
  categoryId?: string;
  supplierId?: string;
  /** Hides the Transfer Opportunities panel entirely for single-branch tenants — there's no
   *  other branch to move stock to, so a disabled/empty state would just be noise. */
  isMultiBranch: boolean;
  currentBranchName?: string;
  onExportData: OnExportData;
};

type Row = NearExpiryItem & { tier: ExpiryTier; recommendation: { key: ExpiryRecommendation; label: string } };

const CRITICAL_WITHIN_DAYS = 15;
const MONTH_HORIZON = 6;
// The chart and calendar visuals only have room to read clearly with a handful of series/rows —
// beyond this, the rest are folded into a single "Others" bucket. The detail tables below still
// show every sub-category (paginated), this only caps the two visual panels.
const TOP_CATEGORIES_FOR_VISUALS = 6;
// Priority-dispense-tier stock is assumed only half-recoverable (some will still go unsold in
// time); dispose-tier is a total loss. Transfer/monitor tiers are assumed fully recoverable.
const PRIORITY_DISPENSE_WASTAGE_FACTOR = 0.5;

function tierOf(daysLeft: number): ExpiryTier {
  if (daysLeft <= 30) return "critical";
  if (daysLeft <= 60) return "watch";
  return "notice";
}

const TIER_LABEL: Record<ExpiryTier, string> = { critical: "Critical", watch: "Watch", notice: "Upcoming" };
const DAYS_LEFT_GRADIENT_MAX = 90;
/** Continuous red-orange → orange → green gradient by days left (0 or fewer = most urgent,
 *  >=90 = safest) — same 3-stop shape and red-orange hot end as the Expiry Calendar heatmap's
 *  exposure scale, just inverted (here more days left is good, not less value). Used for the
 *  Critical Batches "Days Left" column and the Sub-category Breakdown's "Avg. Days Left" column. */
function daysLeftColor(daysLeft: number): string {
  const t = 1 - Math.max(0, Math.min(1, daysLeft / DAYS_LEFT_GRADIENT_MAX));
  if (t >= 0.5) {
    const local = Math.round(((t - 0.5) / 0.5) * 100);
    return `color-mix(in srgb, #e33f19 ${local}%, #ea580c)`;
  }
  const local = Math.round((t / 0.5) * 100);
  return `color-mix(in srgb, #ea580c ${local}%, #16a34a)`;
}
const REC_BADGE: Record<ExpiryRecommendation, string> = {
  dispose: "dispose",
  return_supplier: "return",
  transfer: "transfer",
  priority_dispense: "priority",
  monitor: "monitor",
};

const BUCKET_DEFS = [
  { key: "0-30", label: "0–30 days", sublabel: "(Urgent)", min: 0, max: 30 },
  { key: "31-60", label: "31–60 days", sublabel: "(High)", min: 31, max: 60 },
  { key: "61-90", label: "61–90 days", sublabel: "(Moderate)", min: 61, max: 90 },
  { key: "91-180", label: "91–180 days", sublabel: "(Monitor)", min: 91, max: 180 },
];

function enrich(item: NearExpiryItem): Row {
  return { ...item, tier: tierOf(item.daysLeft), recommendation: recommendExpiryAction(item.daysLeft, Number(item.valueAtRisk), item.supplierId != null) };
}

/** Inventory expiry risk dashboard — value at risk, where it concentrates by category/time, and
 *  what to do about it. Overview KPIs and the detail tables both respect the "Expiry window"
 *  filter; the time-bucket chart and calendar heatmap intentionally show a fixed 180-day horizon
 *  regardless of that filter, since they exist to show the fuller risk landscape. */
export function NearExpirySection({ scope, isOwner, days, categoryId, supplierId, isMultiBranch, currentBranchName, onExportData }: Props) {
  const [allRows, setAllRows] = useState<Row[]>([]);
  const [previousRows, setPreviousRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubCategoryId, setSelectedSubCategoryId] = useState<string | null>(null);
  const [selectedExposureKey, setSelectedExposureKey] = useState<ExposureSegmentKey | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedSubCategoryId(null);
    setSelectedExposureKey(null);
    fetchNearExpiry(days, scope, isOwner, categoryId, supplierId)
      .then((res) => {
        if (cancelled) return;
        setAllRows(res.items.map(enrich));
        setPreviousRows(res.previousItems.map(enrich));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load near-expiry data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner, categoryId, supplierId]);

  // Respect the selected "Expiry window" for KPIs/tables; chart + calendar use the full horizon.
  const windowRows = useMemo(() => allRows.filter((r) => r.daysLeft <= days), [allRows, days]);
  const forwardRows = useMemo(() => allRows.filter((r) => r.daysLeft >= 0), [allRows]);

  const totalValue = windowRows.reduce((s, r) => s + Number(r.valueAtRisk), 0);
  const totalUnits = windowRows.reduce((s, r) => s + r.qtyOnHand, 0);
  const prevTotalValue = previousRows.reduce((s, r) => s + Number(r.valueAtRisk), 0);
  const prevTotalUnits = previousRows.reduce((s, r) => s + r.qtyOnHand, 0);

  function wastageRisk(rows: Row[]): number {
    return rows.reduce((s, r) => {
      if (r.recommendation.key === "dispose") return s + Number(r.valueAtRisk);
      if (r.recommendation.key === "priority_dispense") return s + Number(r.valueAtRisk) * PRIORITY_DISPENSE_WASTAGE_FACTOR;
      return s;
    }, 0);
  }
  const wastage = wastageRisk(windowRows);
  const prevWastage = wastageRisk(previousRows);

  // ── Recoverable vs Unavoidable Exposure ────────────────────────────────────────────────
  // Regroups the same per-row recommendation every other panel already uses — never a second
  // classification of the same population.
  const exposureSegments: ExposureSegment[] = useMemo(() => {
    const buckets: Record<"recoverable" | "highRisk" | "writeOff", { value: number; count: number }> = {
      recoverable: { value: 0, count: 0 },
      highRisk: { value: 0, count: 0 },
      writeOff: { value: 0, count: 0 },
    };
    for (const r of windowRows) {
      const key = r.recommendation.key === "dispose" ? "writeOff" : r.recommendation.key === "priority_dispense" ? "highRisk" : "recoverable";
      buckets[key].value += Number(r.valueAtRisk);
      buckets[key].count += 1;
    }
    return [
      { key: "recoverable", label: "Recoverable", value: buckets.recoverable.value, count: buckets.recoverable.count },
      { key: "highRisk", label: "High Risk", value: buckets.highRisk.value, count: buckets.highRisk.count },
      { key: "writeOff", label: "Likely Write-off", value: buckets.writeOff.value, count: buckets.writeOff.count },
    ];
  }, [windowRows]);

  // ── Transfer Opportunities (multi-branch only) ─────────────────────────────────────────
  const transferOpportunities = useMemo(
    () =>
      windowRows
        .filter((r) => r.transferOpportunity != null)
        .sort((a, b) => Number(b.valueAtRisk) - Number(a.valueAtRisk))
        .slice(0, 6),
    [windowRows],
  );

  // ── Category aggregates (window-scoped: KPIs, insights, and the sub-category filter) ──────
  const categoryTotalsWindow = useMemo(() => {
    const map = new Map<string, { id: string; name: string; value: number; units: number; daysSum: number; count: number }>();
    for (const r of windowRows) {
      const key = r.categoryId ?? "uncategorized";
      const cur = map.get(key) ?? { id: key, name: r.categoryName, value: 0, units: 0, daysSum: 0, count: 0 };
      cur.value += Number(r.valueAtRisk);
      cur.units += r.qtyOnHand;
      cur.daysSum += r.daysLeft;
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [windowRows]);

  const highRiskCategory = categoryTotalsWindow[0] ?? null;
  const highRiskSharePct = highRiskCategory && totalValue > 0 ? (highRiskCategory.value / totalValue) * 100 : 0;

  // ── Category aggregates (full-horizon: time-bucket chart + calendar heatmap) ───────────────
  const categoryTotalsHorizon = useMemo(() => {
    const map = new Map<string, { id: string; name: string; value: number }>();
    for (const r of forwardRows) {
      const key = r.categoryId ?? "uncategorized";
      const cur = map.get(key) ?? { id: key, name: r.categoryName, value: 0 };
      cur.value += Number(r.valueAtRisk);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value);
  }, [forwardRows]);
  const categoryNameById = useMemo(() => new Map(categoryTotalsHorizon.map((c) => [c.id, c.name])), [categoryTotalsHorizon]);
  const allCategoryIds = useMemo(() => categoryTotalsHorizon.map((c) => c.id), [categoryTotalsHorizon]);
  // Top N by full-horizon value — already sorted since categoryTotalsHorizon is — everything else
  // folds into "Others" in the chart and calendar so those stay readable at a glance.
  const topCategoryIdsForVisuals = useMemo(() => allCategoryIds.slice(0, TOP_CATEGORIES_FOR_VISUALS), [allCategoryIds]);

  const timeBuckets: TimeBucket[] = useMemo(
    () =>
      BUCKET_DEFS.map((def) => {
        const inBucket = forwardRows.filter((r) => r.daysLeft >= def.min && r.daysLeft <= def.max);
        const byCat = new Map<string, number>();
        let othersValue = 0;
        for (const r of inBucket) {
          const catKey = r.categoryId ?? "uncategorized";
          if (topCategoryIdsForVisuals.includes(catKey)) byCat.set(catKey, (byCat.get(catKey) ?? 0) + Number(r.valueAtRisk));
          else othersValue += Number(r.valueAtRisk);
        }
        const series = topCategoryIdsForVisuals.map((catId, i) => ({
          id: catId,
          label: categoryNameById.get(catId) ?? "Uncategorized",
          color: categoryMixColor(i),
          value: byCat.get(catId) ?? 0,
        }));
        if (othersValue > 0) series.push({ id: "others", label: "Others", color: CATEGORY_MIX_OTHERS_COLOR, value: othersValue });
        return { key: def.key, label: def.label, sublabel: def.sublabel, series };
      }),
    [forwardRows, topCategoryIdsForVisuals, categoryNameById],
  );

  const monthDefs = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return Array.from({ length: MONTH_HORIZON }, (_, i) => {
      const d = new Date(start);
      d.setMonth(d.getMonth() + i);
      return { year: d.getFullYear(), month: d.getMonth(), key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString("en-US", { month: "short", year: "numeric" }) };
    });
  }, []);

  const calendarRows: ExpiryCalendarRow[] = useMemo(() => {
    const topRows = topCategoryIdsForVisuals.map((catId) => ({
      id: catId,
      label: categoryNameById.get(catId) ?? "Uncategorized",
      months: monthDefs.map((m) => ({
        key: m.key,
        label: m.label,
        value: forwardRows
          .filter((r) => (r.categoryId ?? "uncategorized") === catId)
          .filter((r) => {
            const d = new Date(r.expiryDate);
            return d.getFullYear() === m.year && d.getMonth() === m.month;
          })
          .reduce((s, r) => s + Number(r.valueAtRisk), 0),
      })),
    }));
    if (allCategoryIds.length <= TOP_CATEGORIES_FOR_VISUALS) return topRows;
    const topSet = new Set(topCategoryIdsForVisuals);
    const othersRow: ExpiryCalendarRow = {
      id: "others",
      label: "Others",
      months: monthDefs.map((m) => ({
        key: m.key,
        label: m.label,
        value: forwardRows
          .filter((r) => !topSet.has(r.categoryId ?? "uncategorized"))
          .filter((r) => {
            const d = new Date(r.expiryDate);
            return d.getFullYear() === m.year && d.getMonth() === m.month;
          })
          .reduce((s, r) => s + Number(r.valueAtRisk), 0),
      })),
    };
    return [...topRows, othersRow];
  }, [topCategoryIdsForVisuals, allCategoryIds, monthDefs, forwardRows, categoryNameById]);

  // ── Insights ────────────────────────────────────────────────────────────────────────────
  const criticalRows = useMemo(() => windowRows.filter((r) => r.daysLeft <= CRITICAL_WITHIN_DAYS), [windowRows]);
  const criticalValue = criticalRows.reduce((s, r) => s + Number(r.valueAtRisk), 0);
  const returnRows = useMemo(() => windowRows.filter((r) => r.recommendation.key === "return_supplier"), [windowRows]);
  const returnValue = returnRows.reduce((s, r) => s + Number(r.valueAtRisk), 0);
  const actionCoveragePct =
    totalValue > 0 ? (windowRows.filter((r) => r.recommendation.key !== "monitor").reduce((s, r) => s + Number(r.valueAtRisk), 0) / totalValue) * 100 : 0;

  function scrollToCritical() {
    document.getElementById("critical-batches-table")?.scrollIntoView({ behavior: "smooth" });
  }

  // "Others" is a synthetic rollup of everything past the top categories shown in the chart and
  // calendar — filtering by it expands to the union of every sub-category folded into it.
  const othersCategoryIds = useMemo(() => new Set(allCategoryIds.slice(TOP_CATEGORIES_FOR_VISUALS)), [allCategoryIds]);
  function toggleSubCategoryFilter(id: string) {
    setSelectedSubCategoryId((cur) => (cur === id ? null : id));
  }
  function exposureKeyOf(r: Row): ExposureSegmentKey {
    return r.recommendation.key === "dispose" ? "writeOff" : r.recommendation.key === "priority_dispense" ? "highRisk" : "recoverable";
  }
  function toggleExposureFilter(key: ExposureSegmentKey) {
    setSelectedExposureKey((cur) => (cur === key ? null : key));
  }

  useEffect(() => {
    if (!selectedSubCategoryId && !selectedExposureKey) return;
    tableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedSubCategoryId, selectedExposureKey]);

  const insightItems: ActionPanelItem[] = [
    ...(criticalRows.length > 0
      ? [{
          key: "critical",
          icon: <IconAlertTriangle size={16} />,
          tone: "danger" as const,
          title: "Critical batches",
          description: `${criticalRows.length} batch${criticalRows.length === 1 ? "" : "es"} expire within ${CRITICAL_WITHIN_DAYS} days.`,
          count: criticalRows.length,
          countLabel: "batches",
          countText: formatMoney(criticalValue),
          onClick: scrollToCritical,
          examples: [{ label: "Value at risk", badge: formatMoney(criticalValue), tone: "negative" as const }],
        }]
      : []),
    ...(returnRows.length > 0
      ? [{
          key: "return",
          icon: <IconRotateCcw size={16} />,
          tone: "purple" as const,
          title: "Supplier return opportunity",
          description: `${returnRows.length} batch${returnRows.length === 1 ? "" : "es"} estimated eligible for return (not a confirmed policy).`,
          count: returnRows.length,
          countLabel: "batches",
          countText: formatMoney(returnValue),
          onClick: scrollToCritical,
          examples: [{ label: "Return-eligible value", badge: formatMoney(returnValue), tone: "positive" as const }],
        }]
      : []),
    ...(highRiskCategory
      ? [{
          key: "high-risk-category",
          icon: <IconSparkles size={16} />,
          tone: "warning" as const,
          title: "High-risk sub-category",
          description: `${highRiskCategory.name} contributes ${highRiskSharePct.toFixed(0)}% of expiring value.`,
          count: Math.round(highRiskSharePct),
          countLabel: "% of value",
          countText: `${highRiskSharePct.toFixed(0)}%`,
          onClick: () => {
            toggleSubCategoryFilter(highRiskCategory.id);
            scrollToCritical();
          },
          examples: [{ label: highRiskCategory.name, badge: `${highRiskSharePct.toFixed(0)}% of value`, tone: "negative" as const }],
        }]
      : []),
    ...(windowRows.length > 0
      ? [{
          key: "coverage",
          icon: <IconCheckCircle size={16} />,
          tone: "primary" as const,
          title: "Action coverage",
          description: `${actionCoveragePct.toFixed(0)}% of expiring value has an assigned action.`,
          count: Math.round(actionCoveragePct),
          countLabel: "%",
          countText: `${actionCoveragePct.toFixed(0)}%`,
          onClick: scrollToCritical,
          examples: [{ label: "Actioned value share", badge: `${actionCoveragePct.toFixed(0)}%`, tone: "positive" as const }],
        }]
      : []),
  ];

  // ── Critical Batches Requiring Action table ────────────────────────────────────────────
  const criticalTableRows = useMemo(() => [...windowRows].sort((a, b) => a.daysLeft - b.daysLeft), [windowRows]);

  // Selecting a sub-category (from the Expiry Calendar) or an exposure segment (from the
  // Recoverable vs Unavoidable bar) filters the table below — both facets combine when set,
  // same cross-panel filtering pattern as Margin by Category's toggleCategoryFilter.
  const selectedSubCategory =
    selectedSubCategoryId == null
      ? null
      : selectedSubCategoryId === "others"
        ? { id: "others", name: "Other sub-categories" }
        : (categoryTotalsWindow.find((c) => c.id === selectedSubCategoryId) ?? null);
  const EXPOSURE_LABEL: Record<ExposureSegmentKey, string> = { recoverable: "Recoverable", highRisk: "High Risk", writeOff: "Likely Write-off" };
  const visibleCriticalRows = useMemo(
    () =>
      criticalTableRows.filter((r) => {
        if (selectedSubCategoryId) {
          const catKey = r.categoryId ?? "uncategorized";
          const matches = selectedSubCategoryId === "others" ? othersCategoryIds.has(catKey) : catKey === selectedSubCategoryId;
          if (!matches) return false;
        }
        if (selectedExposureKey && exposureKeyOf(r) !== selectedExposureKey) return false;
        return true;
      }),
    [criticalTableRows, selectedSubCategoryId, othersCategoryIds, selectedExposureKey],
  );
  const activeFilterPills: FilterPill[] = [
    ...(selectedSubCategory ? [{ key: "subcat", label: selectedSubCategory.name }] : []),
    ...(selectedExposureKey ? [{ key: "exposure", label: EXPOSURE_LABEL[selectedExposureKey] }] : []),
  ];

  const criticalColumns: Column<Row>[] = [
    { key: "batchNo", header: "Batch No.", width: "6rem", render: (r) => (
      <span className={`${css.skucode} ${css.batchNoCell}`} data-tooltip={r.batchNo}>
        {r.batchNo}
      </span>
    ) },
    { key: "product", header: "Product", width: "11rem", render: (r) => (
      <>
        {r.product.name}
        <div className={css.mutedcell}>{r.categoryName}</div>
      </>
    ) },
    { key: "expiryDate", header: "Expiry Date", width: "5rem", sortable: true, getValue: (r) => r.expiryDate, render: (r) => formatDate(r.expiryDate) },
    {
      key: "daysLeft",
      header: "Days Left",
      width: "4.6rem",
      align: "right",
      sortable: true,
      getValue: (r) => r.daysLeft,
      render: (r) => (
        <span className={css.nowrapCell} style={{ color: daysLeftColor(r.daysLeft) }}>
          {r.daysLeft < 0 ? `Expired ${Math.abs(r.daysLeft)}d ago` : r.daysLeft === 0 ? "Today" : String(r.daysLeft)}
        </span>
      ),
    },
    { key: "qtyOnHand", header: "Qty", width: "2.2rem", align: "right", sortable: true, getValue: (r) => r.qtyOnHand },
    { key: "valueAtRisk", header: "Value (LKR)", width: "5rem", align: "right", sortable: true, getValue: (r) => Number(r.valueAtRisk), render: (r) => formatMoney(r.valueAtRisk) },
    {
      key: "action",
      header: "Suggested Action",
      width: "6.8rem",
      render: (r) => (
        <span className={css.actionCell}>
          <span
            className={`${css.badge2} ${css[REC_BADGE[r.recommendation.key]]}`}
            data-tooltip={r.recommendation.key === "priority_dispense" ? "Sell/dispense this stock first (First-Expiry-First-Out)" : undefined}
          >
            {r.recommendation.label}
          </span>
          <span className={css.actionIconGroup}>
            <Link className={css.rowIconBtn} href={`/transfers?productId=${r.product.id}`} data-tooltip="Transfer stock" aria-label="Transfer stock">
              <IconTruck size={12} />
            </Link>
            <Link className={css.rowIconBtn} href={`/returns?productId=${r.product.id}`} data-tooltip="Create return" aria-label="Create return">
              <IconRotateCcw size={12} />
            </Link>
            <Link className={css.rowIconBtn} href={`/inventory?productId=${r.product.id}`} data-tooltip="View in inventory" aria-label="View in inventory">
              <IconBox size={12} />
            </Link>
          </span>
        </span>
      ),
    },
  ];

  useEffect(() => {
    if (windowRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `near-expiry-${days}d.csv`,
      headers: ["Batch", "SKU", "Product", "Sub-category", "Supplier", "Expiry date", "Days left", "Qty on hand", "Value at risk", "Suggested action", "Status"],
      rows: windowRows.map((r) => [
        r.batchNo,
        r.product.sku,
        r.product.name,
        r.categoryName,
        r.supplierName,
        formatDate(r.expiryDate),
        r.daysLeft,
        r.qtyOnHand,
        r.valueAtRisk,
        r.recommendation.label,
        TIER_LABEL[r.tier],
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [windowRows, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title={`Expiring Stock Value (Next ${days} days)`}
          value={loading ? "…" : formatMoney(totalValue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconCalendar size={16} />}
          trend={!loading && prevTotalValue > 0 ? { value: formatPctTrend(pctChange(totalValue, prevTotalValue)), direction: totalValue >= prevTotalValue ? "up" : "down", tone: totalValue > prevTotalValue ? "danger" : "positive" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Batches at Risk"
          value={loading ? "…" : windowRows.length}
          subtitle={`vs previous ${days} days`}
          icon={<IconShield size={16} />}
          iconTone="warning"
          trend={!loading && previousRows.length > 0 ? { value: formatPctTrend(pctChange(windowRows.length, previousRows.length)), direction: windowRows.length >= previousRows.length ? "up" : "down", tone: windowRows.length > previousRows.length ? "danger" : "positive" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Units Expiring Soon"
          value={loading ? "…" : totalUnits.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="info"
          trend={!loading && prevTotalUnits > 0 ? { value: formatPctTrend(pctChange(totalUnits, prevTotalUnits)), direction: totalUnits >= prevTotalUnits ? "up" : "down", tone: totalUnits > prevTotalUnits ? "danger" : "positive" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Estimated Wastage Risk"
          value={loading ? "…" : formatMoney(wastage)}
          subtitle="Expired stock + 50% of priority-dispense value"
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          trend={!loading && prevWastage > 0 ? { value: formatPctTrend(pctChange(wastage, prevWastage)), direction: wastage >= prevWastage ? "up" : "down", tone: wastage > prevWastage ? "danger" : "positive" } : undefined}
        />
      </StatGrid>

      <div className={isMultiBranch ? `${css.grid2} ${css.firstRow} ${css.snugFirstRow}` : undefined}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Recoverable vs Unavoidable Exposure</h3>
              <p>Where expiring value can still be recovered</p>
            </div>
          </div>
          <ExpiryExposureBar segments={exposureSegments} formatValue={formatMoney} onSegmentClick={toggleExposureFilter} activeKey={selectedExposureKey} />
        </div>

        {isMultiBranch ? (
          <div className={css.card}>
            <div className={css.cardhead}>
              <div>
                <h3>Transfer Opportunities</h3>
                <p>Move expiring stock to a branch that can sell it in time</p>
              </div>
            </div>
            {transferOpportunities.length === 0 ? (
              <p className={css.emptyNote}>No cross-branch transfer opportunities in this window.</p>
            ) : (
              <div className={css.transferOppList}>
                {transferOpportunities.map((r) => (
                  <div key={r.batchId} className={css.transferOppRow}>
                    <span className={css.transferOppText}>
                      {currentBranchName ? <><b>{currentBranchName}</b> has </> : "Has "}
                      <b>{r.qtyOnHand.toLocaleString("en-IN")} units</b> of {r.product.name} expiring in {r.daysLeft}d, while{" "}
                      <b>{r.transferOpportunity!.toBranchName}</b> sells ~{Math.round(r.transferOpportunity!.toBranchAvgDailySales * 7)} units/week.
                    </span>
                    <Link
                      className={css.transferOppAction}
                      href={`/transfers?productId=${r.product.id}&toBranchId=${r.transferOpportunity!.toBranchId}&qty=${r.transferOpportunity!.suggestedUnits}`}
                    >
                      <IconTruck size={13} /> Transfer {r.transferOpportunity!.suggestedUnits}
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className={`${css.grid2} ${css.expiryTopRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Expiry Exposure by Time Bucket</h3>
              <p>Value at risk by how soon it expires</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <ExpiryTimeBucketChart buckets={timeBuckets} formatValue={formatCompactMoney} />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Expiry Calendar by Sub-category</h3>
              <p>Value at risk by sub-category and month</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <ExpiryCalendarHeatmap rows={calendarRows} formatValue={formatCompactMoney} onRowClick={toggleSubCategoryFilter} activeId={selectedSubCategoryId} />
          </div>
        </div>
      </div>

      <div className={`${css.grid2} ${css.expiryBottomRow} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="critical-batches-table" ref={tableRef}>
          <div className={css.cardhead}>
            <div>
              <h3>Critical Batches Requiring Action</h3>
              <p>Sorted by urgency, soonest expiry first</p>
            </div>
          </div>
          {(selectedSubCategory || selectedExposureKey) && (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered · ${visibleCriticalRows.length} batch${visibleCriticalRows.length === 1 ? "" : "es"}`}
                pills={activeFilterPills}
                onClear={() => {
                  setSelectedSubCategoryId(null);
                  setSelectedExposureKey(null);
                }}
                clearTooltip="Clear filters"
              />
            </div>
          )}
          <DataTable columns={criticalColumns} data={visibleCriticalRows} rowKey={(r) => r.batchId} loading={loading} pageSize={6} emptyTitle="No batches expiring in this window" compact className={css.fixedLayoutTable} />
        </div>

        <ActionsPanel title="Expiry Insights" items={insightItems} variant="cards" pageSize={3} />
      </div>
    </div>
  );
}
