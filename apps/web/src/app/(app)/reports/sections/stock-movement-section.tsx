"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { IconActivity, IconAlertTriangle, IconClipboardList, IconDownload, IconRefresh, IconTarget, IconTrophy, IconTruck, IconUpload } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner } from "@/components/ui";
import { CategoryIconBadge } from "@/lib/category-icons";
import { fetchStockMovement } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { MovementDivergingBarChart } from "../components/movement-diverging-bar-chart";
import { WaterfallChart } from "../components/waterfall-chart";
import { MovementCompositionBars } from "../components/movement-composition-bars";
import { MovementMirrorChart } from "../components/movement-mirror-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { ReportSelect } from "../components/report-select";
import type {
  MovementGranularity,
  MovementReorderStatus,
  MovementTypeFilterKey,
  StockMovementTopMoverItem,
  ExportPayload,
  OnExportData,
  Scope,
} from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; categoryId?: string; supplierId?: string; movementType?: MovementTypeFilterKey; onExportData: OnExportData };

type TopMoversSort = "total" | "outbound" | "net";

const REORDER_STATUS_LABEL: Record<MovementReorderStatus, string> = { healthy: "Healthy", reorder: "Reorder", watch: "Watch", overstocking: "Overstock" };
const REORDER_STATUS_TONE: Record<MovementReorderStatus, string> = { healthy: "healthy", reorder: "lowCover", watch: "slowMoving", overstocking: "overstocked" };

// Mirrors the API's own `MOVEMENT_REPLENISHMENT_INSIGHT_COVER_DAYS` / `_SHARE_THRESHOLD_PCT` /
// `_VARIANCE_PCT_THRESHOLD` constants — display-only labels for the insight example chips below,
// not re-derived logic (the actual threshold decisions are made server-side).
const MOVEMENT_REPLENISHMENT_COVER_DAYS = 7;
const MOVEMENT_TRANSFER_SHARE_THRESHOLD = 15;
const MOVEMENT_SHRINKAGE_THRESHOLD = 2;

const GRANULARITY_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];
const TOP_MOVERS_SORT_OPTIONS: { value: TopMoversSort; label: string }[] = [
  { value: "total", label: "Total Movement" },
  { value: "outbound", label: "Outbound Units" },
  { value: "net", label: "Net Change" },
];

/** Net-units sparkline, colored by overall direction — accumulating (teal, same hue as this
 *  page's own Inbound series) vs depleting (coral, same hue as Outbound) — deliberately NOT a
 *  green/red good-bad judgment, since a positive net isn't inherently "good" on this page. */
function NetSparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <span className={css.sparklineCell}><span className={css.mutedcell}>—</span></span>;
  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;
  const w = 60;
  const h = 24;
  const padY = 3;
  const step = w / (points.length - 1);
  const overallDirection = points[points.length - 1]! - points[0]!;
  const color = overallDirection > 0 ? "var(--pc-primary)" : overallDirection < 0 ? "#f0653e" : "var(--pc-muted-fg)";
  const coords = points.map((p, i) => [i * step, h - padY - ((p - min) / range) * (h - padY * 2)] as const);
  const linePath = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = coords[coords.length - 1]!;
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <span className={css.sparklineCell}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={css.sparkline} aria-hidden>
        <path d={areaPath} fill={color} opacity={0.14} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={lastX} cy={lastY} r={2.3} fill={color} stroke="var(--pc-card-bg)" strokeWidth={1} />
      </svg>
    </span>
  );
}

const INSIGHT_ICON: Record<string, ReactNode> = {
  fastMovingCategory: <IconTrophy size={16} />,
  replenishmentWatch: <IconAlertTriangle size={16} />,
  highTransfersAdjustments: <IconTruck size={16} />,
  shrinkageVariance: <IconClipboardList size={16} />,
};
const INSIGHT_TONE: Record<string, ActionPanelItem["tone"]> = {
  fastMovingCategory: "primary",
  replenishmentWatch: "warning",
  highTransfersAdjustments: "purple",
  shrinkageVariance: "danger",
};

/** Inventory-flow dashboard — "how is stock flowing in and out, which products/categories churn
 *  fastest, where is flow becoming imbalanced, and what needs replenishment or investigation?"
 *  Owns pure inbound/outbound flow and velocity — never reproduces Stock Value (capital),
 *  Stock Ageing (batch age), Dead Stock (non-moving), or Near Expiry (expiry exposure)'s own
 *  tables. See the API's `ReportsService.stockMovement` for the classification/reorder/insight
 *  methodology this page only ever displays. */
export function StockMovementSection({ scope, isOwner, days, categoryId, supplierId, movementType, onExportData }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchStockMovement>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularityChoice, setGranularityChoice] = useState<"auto" | MovementGranularity>("auto");
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [topMoversSort, setTopMoversSort] = useState<TopMoversSort>("total");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStockMovement(days, scope, isOwner, categoryId, supplierId, movementType, granularityChoice === "auto" ? undefined : granularityChoice)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stock movement data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner, categoryId, supplierId, movementType, granularityChoice]);

  useEffect(() => {
    setSelectedDeptId(null);
  }, [days, scope, isOwner, categoryId, supplierId, movementType]);

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }
  function focusDepartment(deptId: string) {
    setSelectedDeptId((cur) => (cur === deptId ? null : deptId));
    scrollTo("movement-breakdown-by-category");
  }

  const mirrorRows = useMemo(
    () => (data?.categoryMovement ?? []).slice(0, 8).map((c) => ({ id: c.departmentId ?? "unclassified", label: c.departmentName, inbound: c.inboundUnits, outbound: c.outboundUnits })),
    [data],
  );

  const topMoversAll: StockMovementTopMoverItem[] = data?.topMovers ?? [];
  const topMoversFiltered = useMemo(
    () => (selectedDeptId ? topMoversAll.filter((t) => (t.departmentId ?? "unclassified") === selectedDeptId) : topMoversAll),
    [topMoversAll, selectedDeptId],
  );
  const topMoversSorted = useMemo(() => {
    const rows = [...topMoversFiltered];
    if (topMoversSort === "outbound") return rows.sort((a, b) => b.unitsOut - a.unitsOut);
    if (topMoversSort === "net") return rows.sort((a, b) => b.netChange - a.netChange);
    return rows.sort((a, b) => b.unitsOut + b.unitsIn - (a.unitsOut + a.unitsIn));
  }, [topMoversFiltered, topMoversSort]);

  const breakdownRows = data?.categoryBreakdown ?? [];
  const breakdownTableRows = selectedDeptId ? breakdownRows.filter((r) => (r.departmentId ?? "unclassified") === selectedDeptId) : breakdownRows;
  const selectedDeptName = selectedDeptId ? (data?.categoryMovement ?? []).find((c) => (c.departmentId ?? "unclassified") === selectedDeptId)?.departmentName : undefined;

  const insightItems: ActionPanelItem[] = useMemo(() => {
    const topDept = data?.categoryMovement?.[0];
    const examplesByKey: Record<string, ActionPanelItem["examples"]> = {
      fastMovingCategory: topDept ? [{ label: topDept.departmentName, badge: `${topDept.inboundUnits.toLocaleString("en-IN")} in / ${topDept.outboundUnits.toLocaleString("en-IN")} out`, tone: "neutral" }] : undefined,
      replenishmentWatch: [{ label: "Cover threshold", badge: `< ${MOVEMENT_REPLENISHMENT_COVER_DAYS} days`, tone: "negative" }],
      highTransfersAdjustments: [{ label: "Materiality threshold", badge: `≥ ${MOVEMENT_TRANSFER_SHARE_THRESHOLD}%`, tone: "neutral" }],
      shrinkageVariance: [{ label: "Variance threshold", badge: `> ${MOVEMENT_SHRINKAGE_THRESHOLD}%`, tone: "negative" }],
    };
    const onClickByKey: Record<string, (() => void) | undefined> = {
      fastMovingCategory: topDept ? () => focusDepartment(topDept.departmentId ?? "unclassified") : undefined,
      replenishmentWatch: () => scrollTo("top-movers"),
      highTransfersAdjustments: () => scrollTo("movement-composition"),
      shrinkageVariance: () => scrollTo("top-movers"),
    };
    return (data?.insights ?? []).map((i) => ({
      key: i.key,
      icon: INSIGHT_ICON[i.key],
      tone: INSIGHT_TONE[i.key] ?? "muted",
      title: i.title,
      description: i.description,
      count: 0,
      countLabel: "",
      countText: i.countLabel,
      examples: examplesByKey[i.key],
      onClick: onClickByKey[i.key],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const topMoversColumns: Column<StockMovementTopMoverItem>[] = [
    { key: "idx", header: "#", width: "1.2rem", render: (_r, i) => <span className={css.rowNum}>{i + 1}</span> },
    { key: "product", header: "Product", width: "6.7rem", render: (r) => (
      <Link href={`/inventory?productId=${r.productId}`} className={css.productCellLink} data-tooltip="View in Inventory">
        <span className={css.skucode}>{r.product.sku ?? r.productId}</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`} title={r.product.name ?? ""}>{r.product.name ?? ""}</div>
      </Link>
    ) },
    { key: "category", header: "Category", width: "5.2rem", render: (r) => (
      <span className={css.categoryCell}>
        <CategoryIconBadge name={r.departmentName} size={17} />
        <span className={`${css.mutedcell} ${css.productNameCell}`} title={r.departmentName}>{r.departmentName}</span>
      </span>
    ) },
    { key: "flow", header: "Out / In", align: "right", width: "4.3rem", sortable: true, getValue: (r) => r.unitsOut, render: (r) => (
      <>
        <span>{r.unitsOut.toLocaleString("en-IN")} out</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`}>{r.unitsIn.toLocaleString("en-IN")} in</div>
      </>
    ) },
    { key: "net", header: "Net", align: "right", width: "4.6rem", sortable: true, getValue: (r) => r.netChange, render: (r) => (
      <>
        <span className={r.netChange > 0 ? css.deltaUp : r.netChange < 0 ? css.deltaDown : undefined}>{r.netChange > 0 ? "+" : ""}{r.netChange.toLocaleString("en-IN")}</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`}>{r.avgDailyUnitsOut.toFixed(1)}/day</div>
      </>
    ) },
    { key: "status", header: "Status", width: "4.1rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[REORDER_STATUS_TONE[r.reorderStatus]]}`} title={REORDER_STATUS_LABEL[r.reorderStatus] === "Overstock" ? "Overstocking" : undefined}>{REORDER_STATUS_LABEL[r.reorderStatus]}</span> },
  ];

  const breakdownColumns: Column<(typeof breakdownRows)[number]>[] = [
    { key: "name", header: "Commercial Category", width: "7.5rem", render: (r) => (
      <span className={css.categoryCell}>
        <CategoryIconBadge name={r.departmentName} size={19} />
        <span className={`${css.productNameCell}`} title={r.departmentName}>{r.departmentName}</span>
      </span>
    ) },
    { key: "in", header: "In", align: "right", width: "3.6rem", sortable: true, getValue: (r) => r.inboundUnits, render: (r) => r.inboundUnits.toLocaleString("en-IN") },
    { key: "out", header: "Out", align: "right", width: "3.6rem", sortable: true, getValue: (r) => r.outboundUnits, render: (r) => r.outboundUnits.toLocaleString("en-IN") },
    { key: "net", header: "Net", align: "right", width: "4rem", sortable: true, getValue: (r) => r.netUnits, render: (r) => <span className={r.netUnits > 0 ? css.deltaUp : r.netUnits < 0 ? css.deltaDown : undefined}>{r.netUnits > 0 ? "+" : ""}{r.netUnits.toLocaleString("en-IN")}</span> },
    { key: "cover", header: "Cover", align: "right", width: "3.5rem", sortable: true, getValue: (r) => r.avgDaysCover ?? -1, render: (r) => (r.avgDaysCover == null ? "—" : `${r.avgDaysCover}d`) },
    { key: "trend", header: "Trend (Net)", align: "right", width: "5.5rem", render: (r) => <NetSparkline points={r.trend} /> },
  ];

  useEffect(() => {
    if (!data || topMoversAll.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `stock-movement-${days}d.csv`,
      headers: ["SKU", "Product", "Commercial Category", "Units Out", "Units In", "Net Change", "Avg Daily Units Out", "Stock On Hand", "Reorder Level", "Reorder Status"],
      rows: topMoversAll.map((t) => [
        t.product.sku ?? "",
        t.product.name ?? t.productId,
        t.departmentName,
        t.unitsOut,
        t.unitsIn,
        t.netChange,
        Number(t.avgDailyUnitsOut.toFixed(2)),
        t.qtyOnHand,
        t.reorderLevel,
        REORDER_STATUS_LABEL[t.reorderStatus],
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, topMoversAll, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;
  const noActivity = !loading && data && kpis && kpis.inboundUnits === 0 && kpis.outboundUnits === 0 && kpis.reorderAlerts === 0;

  if (noActivity) {
    return (
      <div>
        <StatGrid columns={4} dense className={css.heroGrid}>
          <StatCard size="sm" showMenu={false} title="Inventory Turnover" value="—" subtitle="vs previous period" icon={<IconRefresh size={16} />} />
          <StatCard size="sm" showMenu={false} title="Sell-Through Rate" value="—" subtitle="vs previous period" icon={<IconTarget size={16} />} />
          <StatCard size="sm" showMenu={false} title="Average Days of Cover" value="—" subtitle="Closing stock ÷ daily sell-through" icon={<IconActivity size={16} />} />
          <StatCard size="sm" showMenu={false} title="Stockout Events" value="0" subtitle="Times stock hit zero this period" icon={<IconAlertTriangle size={16} />} />
        </StatGrid>
        <div className={css.card}>
          <p className={css.emptyNote}>No stock movement recorded for the selected filters in this range.</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Inventory Turnover"
          value={loading || !kpis || kpis.inventoryTurnover == null ? "—" : `${kpis.inventoryTurnover.toFixed(1)}×`}
          subtitle="Annualized, vs previous period"
          icon={<IconRefresh size={16} />}
          iconTone="info"
          trend={!loading && kpis && kpis.inventoryTurnover != null && kpis.prevInventoryTurnover != null && kpis.prevInventoryTurnover > 0 ? { value: formatPctTrend(pctChange(kpis.inventoryTurnover, kpis.prevInventoryTurnover)), direction: kpis.inventoryTurnover >= kpis.prevInventoryTurnover ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Sell-Through Rate"
          value={loading || !kpis || kpis.sellThroughRate == null ? "—" : `${kpis.sellThroughRate.toFixed(1)}%`}
          subtitle="Sold ÷ available this period"
          icon={<IconTarget size={16} />}
          iconTone="success"
          trend={!loading && kpis && kpis.sellThroughRate != null && kpis.prevSellThroughRate != null && kpis.prevSellThroughRate > 0 ? { value: formatPctTrend(pctChange(kpis.sellThroughRate, kpis.prevSellThroughRate)), direction: kpis.sellThroughRate >= kpis.prevSellThroughRate ? "up" : "down", tone: kpis.sellThroughRate >= kpis.prevSellThroughRate ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Average Days of Cover"
          value={loading || !kpis || kpis.avgDaysCover == null ? "—" : `${Math.round(kpis.avgDaysCover)}d`}
          subtitle="Closing stock ÷ daily sell-through"
          icon={<IconActivity size={16} />}
          iconTone="primary"
          trend={!loading && kpis && kpis.avgDaysCover != null && kpis.prevAvgDaysCover != null && kpis.prevAvgDaysCover > 0 ? { value: formatPctTrend(pctChange(kpis.avgDaysCover, kpis.prevAvgDaysCover)), direction: kpis.avgDaysCover >= kpis.prevAvgDaysCover ? "up" : "down", tone: kpis.avgDaysCover <= kpis.prevAvgDaysCover ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Stockout Events"
          value={loading || !kpis ? "…" : kpis.stockoutEvents.toLocaleString("en-IN")}
          subtitle="Times stock hit zero this period"
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
          trend={!loading && kpis && kpis.prevStockoutEvents > 0 ? { value: formatPctTrend(pctChange(kpis.stockoutEvents, kpis.prevStockoutEvents)), direction: kpis.stockoutEvents >= kpis.prevStockoutEvents ? "up" : "down", tone: kpis.stockoutEvents <= kpis.prevStockoutEvents ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Stock Flow Bridge</h3>
              <p>Opening → closing stock this period, in units</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <WaterfallChart steps={data?.stockFlowBridge ?? []} formatValue={(n) => n.toLocaleString("en-IN")} />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Inbound vs Outbound Movement Trend</h3>
              <p>{data?.granularity === "monthly" ? "Monthly" : data?.granularity === "weekly" ? "Weekly" : "Daily"} units moved</p>
            </div>
            <ReportSelect ariaLabel="Trend granularity" value={granularityChoice} onChange={(v) => setGranularityChoice(v as typeof granularityChoice)} options={GRANULARITY_OPTIONS} />
          </div>
          <div className={css.heatmapGrow}>
            <MovementDivergingBarChart points={data?.trend ?? []} />
          </div>
          <div className={css.movementFooterStrip}>
            <div className={css.movementFooterCell}>
              <span className={`${css.movementFooterIcon} ${css.actionIconSq} ${css.primary}`}><IconDownload size={11} /></span>
              <span className={css.movementFooterText}>
                <span className={css.movementFooterLabel} title="Average Inbound / Day">Avg In</span>
                <span className={css.movementFooterValue}>{Math.round(data?.avgInboundPerDay ?? 0).toLocaleString("en-IN")}</span>
              </span>
            </div>
            <div className={css.movementFooterCell}>
              <span className={`${css.movementFooterIcon} ${css.actionIconSq} ${css.warning}`}><IconUpload size={11} /></span>
              <span className={css.movementFooterText}>
                <span className={css.movementFooterLabel} title="Average Outbound / Day">Avg Out</span>
                <span className={css.movementFooterValue}>{Math.round(data?.avgOutboundPerDay ?? 0).toLocaleString("en-IN")}</span>
              </span>
            </div>
            <div className={css.movementFooterCell}>
              <span className={`${css.movementFooterIcon} ${css.actionIconSq} ${css.muted}`}><IconActivity size={11} /></span>
              <span className={css.movementFooterText}>
                <span className={css.movementFooterLabel} title="Average Net / Day">Avg Net</span>
                <span className={css.movementFooterValue}>{(data?.avgNetPerDay ?? 0) > 0 ? "+" : ""}{Math.round(data?.avgNetPerDay ?? 0).toLocaleString("en-IN")}</span>
              </span>
            </div>
            <div className={css.movementFooterCell}>
              <span className={`${css.movementFooterIcon} ${css.actionIconSq} ${css.purple}`}><IconTrophy size={11} /></span>
              <span className={css.movementFooterText}>
                <span className={css.movementFooterLabel} title="Most Significant Net Day">Best Day</span>
                <span className={css.movementFooterValue}>
                  {data?.bestNetDay ? data.bestNetDay.label : "—"}
                  {data?.bestNetDay ? <small className={data.bestNetDay.netUnits >= 0 ? css.deltaUp : css.deltaDown}>{data.bestNetDay.netUnits >= 0 ? "+" : ""}{data.bestNetDay.netUnits.toLocaleString("en-IN")}</small> : null}
                </span>
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className={`${css.grid3} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`} id="movement-composition">
          <div className={css.cardhead}>
            <div>
              <h3>Movement Composition</h3>
              <p>What makes up each direction this period</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <MovementCompositionBars rows={data?.movementComposition ?? []} />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Movement by Commercial Category</h3>
              <p>Inbound (left) vs. outbound (right) units</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <MovementMirrorChart rows={mirrorRows} formatValue={(n) => n.toLocaleString("en-IN")} onRowClick={focusDepartment} activeId={selectedDeptId} />
          </div>
          {(data?.highestMovementCategories?.length ?? 0) > 0 ? (
            <div className={css.churnFooter}>
              <span className={css.churnFooterTitle}>Highest movement categories</span>
              <div className={css.chipRow2}>
                {data!.highestMovementCategories.map((c) => {
                  const deptId = c.departmentId ?? "unclassified";
                  return (
                    <button
                      key={deptId}
                      type="button"
                      className={`${css.chip2} ${css.chip2Button}${selectedDeptId === deptId ? ` ${css.chip2ButtonActive}` : ""}`}
                      onClick={() => focusDepartment(deptId)}
                    >
                      <span className={css.chip2Label}>{c.departmentName}</span>
                      <b className={css.chip2Neutral}>{c.totalUnits.toLocaleString("en-IN")} units</b>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        <ActionsPanel
          title="Movement Insights"
          items={insightItems}
          variant="cards"
          pageSize={4}
        />
      </div>

      <div className={`${css.grid2Even} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="top-movers">
          <div className={css.cardhead}>
            <div>
              <h3>Top Movers</h3>
              <p>Ranked by {TOP_MOVERS_SORT_OPTIONS.find((o) => o.value === topMoversSort)?.label.toLowerCase()}</p>
            </div>
            <ReportSelect ariaLabel="Rank by" value={topMoversSort} onChange={(v) => setTopMoversSort(v as TopMoversSort)} options={TOP_MOVERS_SORT_OPTIONS} />
          </div>
          {selectedDeptId ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by ${selectedDeptName ?? "category"} · ${topMoversSorted.length} product${topMoversSorted.length === 1 ? "" : "s"}`}
                pills={[{ key: "filter", label: selectedDeptName ?? "Category" }]}
                onClear={() => setSelectedDeptId(null)}
                clearTooltip="Show all categories"
              />
            </div>
          ) : null}
          <DataTable columns={topMoversColumns} data={topMoversSorted} rowKey={(r) => r.productId} loading={loading} pageSize={7} emptyTitle="No product movement in this range" compact className={css.fixedLayoutTable} />
        </div>

        <div className={css.card} id="movement-breakdown-by-category">
          <div className={css.cardhead}>
            <div>
              <h3>Movement Breakdown by Category</h3>
              <p>Inbound, outbound and net units by Commercial Category</p>
            </div>
            {selectedDeptId ? (
              <button type="button" className={css.cardLink} onClick={() => setSelectedDeptId(null)}>Show all categories →</button>
            ) : null}
          </div>
          <DataTable columns={breakdownColumns} data={breakdownTableRows} rowKey={(r) => r.departmentId ?? "unclassified"} loading={loading} pageSize={8} emptyTitle="No categorized movement in this range" compact className={css.fixedLayoutTable} />
        </div>
      </div>
    </div>
  );
}
