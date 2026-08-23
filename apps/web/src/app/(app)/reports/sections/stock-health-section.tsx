"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  IconActivity,
  IconAlertTriangle,
  IconArchive,
  IconBox,
  IconCheckCircle,
  IconClipboard,
  IconTag,
  IconTruck,
} from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { CategoryIconBadge } from "@/lib/category-icons";
import { fetchDeadStock, fetchStockAgeing, fetchStockHealth } from "../lib/fetchers";
import { formatCompactMoney, formatMoney, formatPctTrend, formatPpTrend, pctChange } from "../lib/format";
import { StockHealthMatrixChart, type HealthMatrixPoint } from "../components/stock-health-matrix-chart";
import { DeadStockSeverityMatrix, type SeverityQuadrantKey } from "../components/dead-stock-severity-matrix";
import { AgeingTrendChart, type AgeingTrendPoint } from "../components/ageing-trend-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { DeadStockAction, DeadStockItem, ExportPayload, OnExportData, Scope, StockHealthItem, StockHealthZone } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; categoryId?: string; supplierId?: string; onExportData: OnExportData };

/** Mirrors the backend's own `STOCK_HEALTH_OVERSTOCK_COVER_DAYS`/`STOCK_HEALTH_LOW_VELOCITY_PER_DAY`
 *  — used only to draw the matrix's reference lines, never to re-derive a zone (that's always the
 *  server-computed `zone` field on each item). */
const OVERSTOCK_COVER_DAYS = 180;
const LOW_VELOCITY_PER_DAY = 0.15;
/** Same default inactivity window the old standalone Dead Stock tab used — Stock Health has no
 *  threshold picker of its own. */
const DEAD_STOCK_DAYS = 90;

const ZONE_LABEL: Record<StockHealthZone, string> = {
  deadSlow: "Dead / Slow",
  reorderRisk: "Reorder Risk",
  overstocked: "Overstock",
  monitor: "Monitor",
  healthy: "Healthy",
};

// Priority order for the At-Risk filter chips — most urgent (needs restocking now) to least.
const ZONE_CHIP_ORDER: Exclude<StockHealthZone, "healthy">[] = ["reorderRisk", "overstocked", "deadSlow", "monitor"];
const ZONE_CHIP_TONE: Record<Exclude<StockHealthZone, "healthy">, string> = {
  reorderRisk: css.toggleChipAmber,
  overstocked: css.toggleChipRose,
  deadSlow: css.toggleChipRose,
  monitor: css.toggleChipSky,
};

const ZONE_ACTION_LABEL: Record<Exclude<StockHealthZone, "healthy" | "deadSlow">, string> = {
  reorderRisk: "Reorder",
  overstocked: "Reduce Qty",
  monitor: "Monitor",
};

const DEAD_STOCK_ACTION_LABEL: Record<DeadStockAction, string> = {
  transfer: "Transfer",
  return_supplier: "Return",
  liquidate: "Liquidate",
  review_assortment: "Review",
  markdown: "Markdown",
  bundle: "Bundle",
  monitor: "Monitor",
};

// Mirrors `DeadStockSeverityMatrix`'s own quadrant titles — kept as a separate map here (same
// convention as every other label map in this file) since the chart component doesn't export them.
const QUADRANT_LABEL: Record<SeverityQuadrantKey, string> = {
  recoverFast: "Recover Fast",
  investigate: "Investigate",
  monitor: "Monitor",
  liquidate: "Liquidate",
};

/** Which inventory is healthy, understocked, overstocked, ageing or dead — one consolidated view
 *  replacing the old separate Dead Stock and Stock Ageing tabs. Spans every COMMERCIAL department
 *  for classification/KPIs/the health matrix (like Dead Stock did); the reused Age Profile panel
 *  stays Medicines-only, the same deliberate scope Stock Ageing always used (shelf-life-sensitive,
 *  regulated stock is where "how fresh is our stock" actually matters). */
export function StockHealthSection({ scope, isOwner, categoryId, supplierId, onExportData }: Props) {
  const [items, setItems] = useState<StockHealthItem[]>([]);
  const [previousItems, setPreviousItems] = useState<Array<{ productId: string; value: number; qtyOnHand: number; zone: StockHealthZone; departmentId: string | null; departmentName: string }>>([]);
  const [skuUniverseCount, setSkuUniverseCount] = useState(0);
  const [deadStockItems, setDeadStockItems] = useState<DeadStockItem[]>([]);
  const [ageingTrend, setAgeingTrend] = useState<AgeingTrendPoint[]>([]);
  const [freshPct30, setFreshPct30] = useState(0);
  const [prevFreshPct30, setPrevFreshPct30] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState<StockHealthZone | null>(null);
  // The Excess & Dead Stock Action Matrix's own selection — a sub-split of the "deadSlow" zone
  // (recover-fast/investigate/monitor/liquidate), independent of but coordinated with `tableFilter`.
  const [selectedQuadrant, setSelectedQuadrant] = useState<SeverityQuadrantKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTableFilter(null);
    setSelectedQuadrant(null);
    Promise.all([
      fetchStockHealth(scope, isOwner, categoryId, supplierId),
      fetchDeadStock(DEAD_STOCK_DAYS, scope, isOwner, categoryId, supplierId),
      // Age Profile is always the whole-Medicines view, independent of this page's (whole-catalog)
      // department filter — a department other than Medicines would otherwise always show empty.
      fetchStockAgeing(scope, isOwner),
    ])
      .then(([health, dead, ageing]) => {
        if (cancelled) return;
        setItems(health.items);
        setPreviousItems(health.previousItems);
        setSkuUniverseCount(health.skuUniverseCount);
        setDeadStockItems(dead.items);
        setAgeingTrend(ageing.trend);
        const totalValue = ageing.items.reduce((s: number, it: { value: string }) => s + Number(it.value), 0);
        const fresh = ageing.items.filter((it: { ageBucket: string }) => it.ageBucket === "0-30").reduce((s: number, it: { value: string }) => s + Number(it.value), 0);
        const prevTotalValue = ageing.previousItems.reduce((s: number, it: { value: number }) => s + it.value, 0);
        const prevFresh = ageing.previousItems.filter((it: { ageBucket: string }) => it.ageBucket === "0-30").reduce((s: number, it: { value: number }) => s + it.value, 0);
        setFreshPct30(totalValue > 0 ? (fresh / totalValue) * 100 : 0);
        setPrevFreshPct30(prevTotalValue > 0 ? (prevFresh / prevTotalValue) * 100 : 0);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stock health data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, isOwner, categoryId, supplierId]);

  // ── KPIs ────────────────────────────────────────────────────────────────────────────────
  const stockAvailabilityPct = skuUniverseCount > 0 ? (items.length / skuUniverseCount) * 100 : 0;
  const prevStockAvailabilityPct = skuUniverseCount > 0 ? (previousItems.length / skuUniverseCount) * 100 : 0;
  const healthyPct = items.length > 0 ? (items.filter((it) => it.zone === "healthy").length / items.length) * 100 : 0;

  const outOfStockCount = Math.max(0, skuUniverseCount - items.length);
  const reorderRiskItems = useMemo(() => items.filter((it) => it.zone === "reorderRisk"), [items]);
  const lowOrOutCount = outOfStockCount + reorderRiskItems.length;
  const prevOutOfStockCount = Math.max(0, skuUniverseCount - previousItems.length);
  const prevReorderRiskCount = previousItems.filter((it) => it.zone === "reorderRisk").length;
  const prevLowOrOutCount = prevOutOfStockCount + prevReorderRiskCount;

  const overstockedItems = useMemo(() => items.filter((it) => it.zone === "overstocked"), [items]);
  const excessValue = overstockedItems.reduce((s, it) => s + Number(it.value), 0);
  const excessPct = items.length > 0 ? (excessValue / items.reduce((s, it) => s + Number(it.value), 0 || 1)) * 100 : 0;
  const prevExcessValue = previousItems.filter((it) => it.zone === "overstocked").reduce((s, it) => s + it.value, 0);

  const deadItems = useMemo(() => items.filter((it) => it.zone === "deadSlow"), [items]);
  const deadValue = deadItems.reduce((s, it) => s + Number(it.value), 0);
  const prevDeadValue = previousItems.filter((it) => it.zone === "deadSlow").reduce((s, it) => s + it.value, 0);

  // ── Inventory Health Matrix ─────────────────────────────────────────────────────────────
  const matrixPoints: HealthMatrixPoint[] = useMemo(
    () =>
      items.map((it) => ({
        id: it.productId,
        label: it.product.name ?? it.product.sku ?? it.productId,
        categoryName: it.departmentName,
        velocity: it.avgDailySales,
        daysOfCover: it.daysOfCover,
        value: Number(it.value),
        units: it.qtyOnHand,
        daysSinceLastSale: it.daysSinceLastSale,
        zone: it.zone,
      })),
    [items],
  );

  // ── Excess & Dead Stock Action Matrix (reuses Dead Stock's own quadrant classification) ──
  const quadrantTotals = useMemo(() => {
    const base: Record<SeverityQuadrantKey, { skuCount: number; value: number }> = {
      recoverFast: { skuCount: 0, value: 0 },
      investigate: { skuCount: 0, value: 0 },
      monitor: { skuCount: 0, value: 0 },
      liquidate: { skuCount: 0, value: 0 },
    };
    for (const it of deadStockItems) {
      base[it.quadrant].skuCount += 1;
      base[it.quadrant].value += Number(it.value);
    }
    return base;
  }, [deadStockItems]);

  const deadStockActionByProduct = useMemo(() => new Map(deadStockItems.map((it) => [it.productId, it.suggestedAction])), [deadStockItems]);
  const quadrantByProduct = useMemo(() => new Map(deadStockItems.map((it) => [it.productId, it.quadrant])), [deadStockItems]);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }

  // Zone chips and the action matrix both drive `tableFilter`, but only the matrix has a second
  // dimension (quadrant) — switching to a zone other than "deadSlow" (or clearing the zone filter
  // entirely) makes any quadrant selection meaningless, so it's cleared along with it.
  function selectZone(zone: StockHealthZone | null) {
    setTableFilter(zone);
    if (zone !== "deadSlow") setSelectedQuadrant(null);
  }
  function selectQuadrant(key: SeverityQuadrantKey) {
    setSelectedQuadrant((cur) => (cur === key ? null : key));
    setTableFilter("deadSlow");
    scrollTo("at-risk-inventory");
  }

  // ── Health Insights ─────────────────────────────────────────────────────────────────────
  const departmentOverstock = useMemo(() => {
    const map = new Map<string, { name: string; value: number }>();
    for (const it of overstockedItems) {
      const key = it.departmentId ?? "unclassified";
      const cur = map.get(key) ?? { name: it.departmentName, value: 0 };
      cur.value += Number(it.value);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value)[0];
  }, [overstockedItems]);

  const departmentDead = useMemo(() => {
    const map = new Map<string, { name: string; value: number }>();
    for (const it of deadItems) {
      const key = it.departmentId ?? "unclassified";
      const cur = map.get(key) ?? { name: it.departmentName, value: 0 };
      cur.value += Number(it.value);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.value - a.value)[0];
  }, [deadItems]);

  const freshnessImproved = freshPct30 >= prevFreshPct30;
  const freshnessDeltaPp = freshPct30 - prevFreshPct30;

  const insightItems: ActionPanelItem[] = [
    ...(reorderRiskItems.length > 0
      ? [{
          key: "reorder-risk",
          icon: <IconClipboard size={16} />,
          tone: "danger" as const,
          title: "Reorder risk",
          description: `${reorderRiskItems.length} SKU${reorderRiskItems.length === 1 ? "" : "s"} at or below reorder level, still selling.`,
          count: reorderRiskItems.length,
          countLabel: "SKUs",
          onClick: () => setTableFilter("reorderRisk"),
          examples: [{ label: "Below reorder level", badge: `${reorderRiskItems.length} SKUs`, tone: "negative" as const }],
        }]
      : []),
    ...(departmentOverstock
      ? [{
          key: "overstock-concentration",
          icon: <IconArchive size={16} />,
          tone: "warning" as const,
          title: "Overstock concentration",
          description: `${departmentOverstock.name} holds the largest share of excess stock value.`,
          count: overstockedItems.length,
          countLabel: "SKUs",
          countText: formatMoney(departmentOverstock.value),
          onClick: () => setTableFilter("overstocked"),
          examples: [{ label: departmentOverstock.name, badge: formatMoney(departmentOverstock.value), tone: "negative" as const }],
        }]
      : []),
    ...(departmentDead
      ? [{
          key: "dead-concentration",
          icon: <IconTag size={16} />,
          tone: "danger" as const,
          title: "Dead stock concentration",
          description: `${departmentDead.name} accounts for the largest share of dead stock value.`,
          count: deadItems.length,
          countLabel: "SKUs",
          countText: formatMoney(departmentDead.value),
          onClick: () => setTableFilter("deadSlow"),
          examples: [{ label: departmentDead.name, badge: formatMoney(departmentDead.value), tone: "negative" as const }],
        }]
      : []),
    ...(prevFreshPct30 > 0
      ? [{
          key: "freshness-trend",
          icon: <IconActivity size={16} />,
          tone: freshnessImproved ? ("primary" as const) : ("warning" as const),
          title: freshnessImproved ? "Improving freshness" : "Worsening freshness",
          description: `Medicines' fresh stock mix (0-30d) ${freshnessImproved ? "improved" : "declined"} by ${Math.abs(freshnessDeltaPp).toFixed(1)}pp vs previous period.`,
          count: Math.round(Math.abs(freshnessDeltaPp)),
          countLabel: "pp",
          onClick: () => scrollTo("age-profile"),
          examples: [{ label: "Fresh mix (0-30d)", badge: formatPpTrend(freshnessDeltaPp), tone: freshnessImproved ? ("positive" as const) : ("negative" as const) }],
        }]
      : []),
  ];

  // ── At-Risk Inventory ───────────────────────────────────────────────────────────────────
  const atRiskAll = useMemo(() => [...items].filter((it) => it.zone !== "healthy").sort((a, b) => Number(b.value) - Number(a.value)), [items]);
  const atRiskByZone = useMemo(() => (tableFilter ? atRiskAll.filter((it) => it.zone === tableFilter) : atRiskAll), [atRiskAll, tableFilter]);
  const atRiskRows = useMemo(
    () => (selectedQuadrant ? atRiskByZone.filter((it) => quadrantByProduct.get(it.productId) === selectedQuadrant) : atRiskByZone),
    [atRiskByZone, selectedQuadrant, quadrantByProduct],
  );
  const quadrantFilterPills: FilterPill[] = selectedQuadrant ? [{ key: "quadrant", label: QUADRANT_LABEL[selectedQuadrant] }] : [];

  function suggestedActionFor(it: StockHealthItem): string {
    if (it.zone === "deadSlow") {
      const action = deadStockActionByProduct.get(it.productId);
      return action ? DEAD_STOCK_ACTION_LABEL[action] : "Investigate";
    }
    return ZONE_ACTION_LABEL[it.zone as Exclude<StockHealthZone, "healthy" | "deadSlow">] ?? "Monitor";
  }

  const atRiskColumns: Column<StockHealthItem>[] = [
    { key: "idx", header: "#", width: "1.4rem", render: (_r, i) => <span className={css.rowNum}>{i + 1}</span> },
    { key: "product", header: "Product", width: "9rem", render: (r) => (
      <>
        <span className={css.skucode}>{r.product.sku ?? r.productId}</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`} title={r.product.name ?? ""}>{r.product.name ?? ""}</div>
      </>
    ) },
    { key: "category", header: "Category", width: "6.5rem", render: (r) => (
      <span className={css.categoryCell}>
        <CategoryIconBadge name={r.departmentName} size={17} />
        <span className={`${css.mutedcell} ${css.productNameCell}`} title={r.departmentName}>{r.departmentName}</span>
      </span>
    ) },
    { key: "issue", header: "Health Issue", width: "5.5rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[r.zone]}`}>{ZONE_LABEL[r.zone]}</span> },
    { key: "units", header: "Units", width: "3.5rem", align: "right", sortable: true, getValue: (r) => r.qtyOnHand, render: (r) => r.qtyOnHand.toLocaleString("en-IN") },
    { key: "value", header: "Value", width: "5.5rem", align: "right", sortable: true, getValue: (r) => Number(r.value), render: (r) => formatMoney(Number(r.value)) },
    { key: "cover", header: "Cover", width: "3.8rem", align: "right", sortable: true, getValue: (r) => r.daysOfCover ?? -1, render: (r) => (r.daysOfCover == null ? "—" : `${r.daysOfCover}d`) },
    { key: "lastSale", header: "Last Sale", width: "4.5rem", align: "right", sortable: true, getValue: (r) => r.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER, render: (r) => (r.daysSinceLastSale == null ? "Never" : `${r.daysSinceLastSale}d ago`) },
    {
      key: "action",
      header: "Action",
      width: "6.5rem",
      render: (r) => (
        <span className={css.actionCell}>
          <span className={css.mutedcell}>{suggestedActionFor(r)}</span>
          <span className={css.actionIconGroup}>
            <Link className={css.rowIconBtn} href={`/transfers?productId=${r.productId}`} data-tooltip="Transfer stock" aria-label="Transfer stock">
              <IconTruck size={12} />
            </Link>
            <Link className={css.rowIconBtn} href={`/inventory?productId=${r.productId}`} data-tooltip="View in inventory" aria-label="View in inventory">
              <IconBox size={12} />
            </Link>
          </span>
        </span>
      ),
    },
  ];

  useEffect(() => {
    if (items.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: "stock-health.csv",
      headers: ["SKU", "Product", "Commercial Category", "Health Issue", "Units", "Value (LKR)", "Days of Cover", "Days Since Last Sale", "Suggested Action"],
      rows: atRiskAll.map((r) => [
        r.product.sku ?? "",
        r.product.name ?? r.productId,
        r.departmentName,
        ZONE_LABEL[r.zone],
        r.qtyOnHand,
        Number(r.value),
        r.daysOfCover ?? "",
        r.daysSinceLastSale ?? "Never",
        suggestedActionFor(r),
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atRiskAll, items.length, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Stock Availability"
          value={loading ? "…" : `${stockAvailabilityPct.toFixed(1)}%`}
          subtitle={loading ? "" : `${healthyPct.toFixed(1)}% fully healthy`}
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && prevStockAvailabilityPct > 0 ? { value: formatPctTrend(pctChange(stockAvailabilityPct, prevStockAvailabilityPct)), direction: stockAvailabilityPct >= prevStockAvailabilityPct ? "up" : "down", tone: stockAvailabilityPct >= prevStockAvailabilityPct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Low / Out-of-Stock SKUs"
          value={loading ? "…" : lowOrOutCount.toLocaleString("en-IN")}
          subtitle={loading ? "" : `${outOfStockCount} out of stock, ${reorderRiskItems.length} below reorder`}
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          trend={!loading && prevLowOrOutCount > 0 ? { value: formatPctTrend(pctChange(lowOrOutCount, prevLowOrOutCount)), direction: lowOrOutCount >= prevLowOrOutCount ? "up" : "down", tone: lowOrOutCount <= prevLowOrOutCount ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Excess Stock Value"
          value={loading ? "…" : formatMoney(excessValue)}
          subtitle={`${overstockedItems.length} SKUs over ${OVERSTOCK_COVER_DAYS}d cover`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && prevExcessValue > 0 ? { value: formatPctTrend(pctChange(excessValue, prevExcessValue)), direction: excessValue >= prevExcessValue ? "up" : "down", tone: excessValue <= prevExcessValue ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Dead Stock Value"
          value={loading ? "…" : formatMoney(deadValue)}
          subtitle={`No sale in ${DEAD_STOCK_DAYS}+ days`}
          icon={<IconTag size={16} />}
          iconTone="danger"
          trend={!loading && prevDeadValue > 0 ? { value: formatPctTrend(pctChange(deadValue, prevDeadValue)), direction: deadValue >= prevDeadValue ? "up" : "down", tone: deadValue <= prevDeadValue ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Inventory Health Matrix</h3>
              <p>Demand velocity × days of cover — bubble size = stock value</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <StockHealthMatrixChart points={matrixPoints} formatValue={formatMoney} velocityReference={LOW_VELOCITY_PER_DAY} coverReferenceDays={OVERSTOCK_COVER_DAYS} />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Excess & Dead Stock Action Matrix</h3>
              <p>Stock value vs. days since last sale</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <DeadStockSeverityMatrix
              quadrants={quadrantTotals}
              formatValue={formatMoney}
              onQuadrantClick={selectQuadrant}
              activeQuadrant={selectedQuadrant}
            />
          </div>
        </div>
      </div>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`} id="age-profile">
          <div className={css.cardhead}>
            <div>
              <h3>Inventory Age Profile</h3>
              <p>Medicines only — shelf-life-sensitive stock, by age since received</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <AgeingTrendChart points={ageingTrend} formatValue={formatCompactMoney} height={220} />
          </div>
        </div>

        <ActionsPanel title="Health Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>

      <div className={css.card} id="at-risk-inventory">
        <div className={css.cardhead}>
          <div>
            <h3>At-Risk Inventory</h3>
            <p>Every non-healthy SKU, ranked by value tied up</p>
          </div>
        </div>
        <div className={css.toggleChipRow} role="group" aria-label="Filter by health issue">
          <button type="button" className={`${css.toggleChip} ${css.toggleChipSlate}${!tableFilter ? ` ${css.toggleChipActive}` : ""}`} aria-pressed={!tableFilter} onClick={() => selectZone(null)}>
            All <span className={css.filterCount}>{atRiskAll.length}</span>
          </button>
          {ZONE_CHIP_ORDER.map((zone) => {
            const count = atRiskAll.filter((it) => it.zone === zone).length;
            if (count === 0) return null;
            return (
              <button
                key={zone}
                type="button"
                className={`${css.toggleChip} ${ZONE_CHIP_TONE[zone]}${tableFilter === zone ? ` ${css.toggleChipActive}` : ""}`}
                aria-pressed={tableFilter === zone}
                onClick={() => selectZone(tableFilter === zone ? null : zone)}
              >
                {ZONE_LABEL[zone]} <span className={css.filterCount}>{count}</span>
              </button>
            );
          })}
        </div>
        {selectedQuadrant ? (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by dead-stock action · ${atRiskRows.length} row${atRiskRows.length === 1 ? "" : "s"}`}
              pills={quadrantFilterPills}
              onClear={() => setSelectedQuadrant(null)}
              clearTooltip="Show every Dead / Slow SKU"
            />
          </div>
        ) : null}
        <DataTable columns={atRiskColumns} data={atRiskRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No at-risk inventory in this range" compact className={css.fixedLayoutTable} />
      </div>
    </div>
  );
}
