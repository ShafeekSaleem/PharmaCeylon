"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconArchive, IconBox, IconDollarSign, IconInfo, IconSearch, IconShoppingCart, IconSparkles } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  fetchMarginComparison,
  fetchNetSalesTrendComparison,
  fetchSalesByHour,
  fetchSalesComparison,
  fetchSalesDaily,
} from "../lib/fetchers";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { formatCompactMoney, formatMoney, pctChange, formatPctTrend } from "../lib/format";
import { TrendChart } from "../components/trend-chart";
import { HeatmapGrid } from "../components/heatmap-grid";
import { WaterfallChart, type WaterfallStep } from "../components/waterfall-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { MarginRow, Scope, BranchTrendPoint, ExportPayload, OnExportData, SalesByHourResponse, SalesDailyRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; branchId: string | null; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

function formatDayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

type EnrichedDailyRow = SalesDailyRow & { grossSalesN: number; discountsN: number; returnsN: number; netSalesN: number; growthPct: number | null };

export function SalesSection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [points, setPoints] = useState<BranchTrendPoint[]>([]);
  const [previousPoints, setPreviousPoints] = useState<BranchTrendPoint[]>([]);
  // "Net Sales" — tax-inclusive, returns-netted, the same revenue basis marginByProduct/
  // Profitability's Net Revenue use, so this KPI and the trend chart it's built from reconcile
  // with Profit Summary for the same filters instead of quietly running on a different total.
  const [netSales, setNetSales] = useState(0);
  const [previousNetSales, setPreviousNetSales] = useState(0);
  const [txnCount, setTxnCount] = useState(0);
  const [previousTxnCount, setPreviousTxnCount] = useState(0);
  const [itemsSold, setItemsSold] = useState(0);
  const [previousItemsSold, setPreviousItemsSold] = useState(0);
  const [dailyRows, setDailyRows] = useState<SalesDailyRow[]>([]);
  const [hourData, setHourData] = useState<SalesByHourResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");
  const [heatmapMetric, setHeatmapMetric] = useState<"revenue" | "count">("revenue");

  const [marginRows, setMarginRows] = useState<MarginRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchNetSalesTrendComparison(days, scope, isOwner),
      fetchSalesComparison(days, scope, isOwner),
      fetchMarginComparison(days, scope, isOwner),
      fetchSalesDaily(days, scope, isOwner),
      fetchSalesByHour(days, scope, isOwner),
    ])
      .then(([trend, comparison, margin, daily, hours]) => {
        if (cancelled) return;
        setPoints(trend.currentPoints);
        setPreviousPoints(trend.previousPoints);
        setNetSales(trend.total);
        setPreviousNetSales(trend.previousTotal);
        setTxnCount(comparison.current.count);
        setPreviousTxnCount(comparison.previous.count);
        setItemsSold(margin.currentTotals.unitsSold);
        setPreviousItemsSold(margin.previousTotals.unitsSold);
        setMarginRows(margin.current);
        setDailyRows(daily.rows);
        setHourData(hours);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load sales data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const categoryAgg = useMemo(() => {
    const map = new Map<string, { name: string; revenue: number; products: MarginRow[] }>();
    for (const r of marginRows) {
      const cur = map.get(r.category) ?? { name: r.category, revenue: 0, products: [] as MarginRow[] };
      cur.revenue += Number(r.revenue);
      cur.products.push(r);
      map.set(r.category, cur);
    }
    return [...map.values()].sort((a, b) => b.revenue - a.revenue);
  }, [marginRows]);
  const topCategory = categoryAgg[0] ?? null;
  const topProduct = useMemo(
    () => (marginRows.length === 0 ? null : [...marginRows].sort((a, b) => Number(b.revenue) - Number(a.revenue))[0]!),
    [marginRows],
  );

  const avgBasket = txnCount > 0 ? netSales / txnCount : 0;
  const previousAvgBasket = previousTxnCount > 0 ? previousNetSales / previousTxnCount : 0;
  const unitsPerBasket = txnCount > 0 ? itemsSold / txnCount : 0;
  const previousUnitsPerBasket = previousTxnCount > 0 ? previousItemsSold / previousTxnCount : 0;

  // Standard volume/price variance decomposition — exact by construction (volumeEffect +
  // basketEffect === ΔNetSales), so the bridge's final bar always matches the Net Sales KPI without
  // needing a 3rd "return/discount impact" factor (Net Sales is already return-netted upstream).
  const volumeEffect = (txnCount - previousTxnCount) * previousAvgBasket;
  const basketEffect = txnCount * (avgBasket - previousAvgBasket);
  const hasComparablePeriod = previousNetSales > 0;
  const waterfallSteps: WaterfallStep[] = [
    { key: "prevNet", label: "Previous Net Sales", kind: "total", value: previousNetSales },
    { key: "volume", label: "Transaction Volume Effect", kind: volumeEffect >= 0 ? "addition" : "deduction", value: Math.abs(volumeEffect) },
    { key: "basket", label: "Basket Value Effect", kind: basketEffect >= 0 ? "addition" : "deduction", value: Math.abs(basketEffect) },
    { key: "curNet", label: "Current Net Sales", kind: "total", value: netSales },
  ];

  const enrichedDailyRows: EnrichedDailyRow[] = useMemo(() => {
    const withValues = dailyRows.map((r) => ({
      ...r,
      grossSalesN: Number(r.grossSales),
      discountsN: Number(r.discounts),
      returnsN: Number(r.returns),
      netSalesN: Number(r.netSales),
    }));
    return withValues.map((r, i) => ({
      ...r,
      growthPct: i === 0 ? null : pctChange(r.netSalesN, withValues[i - 1]!.netSalesN),
    }));
  }, [dailyRows]);

  const [search, setSearch] = useState("");
  const filteredRows = useMemo(
    () => (search ? enrichedDailyRows.filter((r) => formatDayLabel(r.date).toLowerCase().includes(search.toLowerCase())) : enrichedDailyRows),
    [enrichedDailyRows, search],
  );
  const sortedForDisplay = useMemo(() => [...filteredRows].reverse(), [filteredRows]);

  useEffect(() => {
    if (enrichedDailyRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `sales-summary-${days}d.csv`,
      headers: ["Date", "Transactions", "Gross Sales", "Discounts", "Returns", "Net Sales", "Growth %"],
      rows: enrichedDailyRows.map((r) => [formatDayLabel(r.date), r.transactions, r.grossSalesN, r.discountsN, r.returnsN, r.netSalesN, r.growthPct == null ? "" : r.growthPct.toFixed(1)]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [enrichedDailyRows, days, onExportData]);

  const bucketedCurrent = useMemo(() => bucketTrend(points, granularity), [points, granularity]);
  const bucketedPrevious = useMemo(() => bucketTrend(previousPoints, granularity), [previousPoints, granularity]);

  const peakSlot = useMemo(() => {
    if (!hourData) return null;
    const grid = heatmapMetric === "revenue" ? hourData.grid : hourData.counts;
    let best = { day: 0, hour: 0, value: 0 };
    grid.forEach((row, day) => row.forEach((value, hour) => { if (value > best.value) best = { day, hour, value }; }));
    if (best.value <= 0) return null;
    const hourLabel = best.hour === 0 ? "12AM" : best.hour < 12 ? `${best.hour}AM` : best.hour === 12 ? "12PM" : `${best.hour - 12}PM`;
    return { ...best, dayLabel: hourData.weekdayLabels[best.day]!, hourLabel };
  }, [hourData, heatmapMetric]);

  const totalReturns = useMemo(() => enrichedDailyRows.reduce((s, r) => s + r.returnsN, 0), [enrichedDailyRows]);
  const daysWithReturns = useMemo(() => enrichedDailyRows.filter((r) => r.returnsN > 0).length, [enrichedDailyRows]);

  const insights: ActionPanelItem[] = useMemo(() => {
    const out: ActionPanelItem[] = [];
    if (topCategory) {
      out.push({
        key: "top-cat",
        icon: <IconActivity size={16} />,
        tone: "primary",
        title: `${topCategory.name} leads category sales`,
        description: `${formatMoney(topCategory.revenue)} in the last ${days} days.`,
        count: topCategory.products.length,
        countLabel: topCategory.products.length === 1 ? "product" : "products",
        onClick: () => onNavigate("sales", "category-sales"),
        examples: [...topCategory.products]
          .sort((a, b) => Number(b.revenue) - Number(a.revenue))
          .slice(0, 3)
          .map((r) => ({ label: r.name, badge: formatMoney(Number(r.revenue)), href: `/inventory?productId=${r.productId}` })),
      });
    }
    if (topProduct) {
      out.push({
        key: "top-product",
        icon: <IconBox size={16} />,
        tone: "purple",
        title: `${topProduct.name} is the top-selling product`,
        description: `${formatMoney(Number(topProduct.revenue))} · ${topProduct.unitsSold.toLocaleString("en-IN")} units in the last ${days} days.`,
        count: topProduct.unitsSold,
        countLabel: topProduct.unitsSold === 1 ? "unit sold" : "units sold",
        onClick: () => onNavigate("sales", "product-sales"),
      });
    }
    if (totalReturns > netSales * 0.03 && netSales > 0) {
      out.push({
        key: "returns",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: `${formatMoney(totalReturns)} in returns this period`,
        description: `That's ${((totalReturns / netSales) * 100).toFixed(1)}% of net sales — worth checking return reasons.`,
        count: daysWithReturns,
        countLabel: daysWithReturns === 1 ? "day with returns" : "days with returns",
        onClick: () => onNavigate("sales", "returns-discounts"),
      });
    }
    return out;
  }, [topCategory, topProduct, totalReturns, daysWithReturns, netSales, days, onNavigate]);

  const columns: Column<EnrichedDailyRow>[] = [
    { key: "date", header: "Date", render: (r) => formatDayLabel(r.date) },
    { key: "transactions", header: "Transactions", align: "right", sortable: true, getValue: (r) => r.transactions, render: (r) => r.transactions.toLocaleString("en-IN") },
    { key: "grossSalesN", header: "Gross Sales", align: "right", sortable: true, getValue: (r) => r.grossSalesN, render: (r) => formatMoney(r.grossSalesN) },
    { key: "discountsN", header: "Discounts", align: "right", sortable: true, getValue: (r) => r.discountsN, render: (r) => <span className={css.mutedcell}>{formatMoney(r.discountsN)}</span> },
    { key: "returnsN", header: "Returns", align: "right", sortable: true, getValue: (r) => r.returnsN, render: (r) => <span className={css.mutedcell}>{formatMoney(r.returnsN)}</span> },
    { key: "netSalesN", header: "Net Sales", align: "right", sortable: true, getValue: (r) => r.netSalesN, render: (r) => formatMoney(r.netSalesN) },
    {
      key: "growthPct",
      header: "Growth",
      align: "right",
      sortable: true,
      getValue: (r) => r.growthPct ?? 0,
      render: (r) => (r.growthPct == null ? "—" : <span className={r.growthPct >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growthPct)}</span>),
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Net Sales"
          value={loading ? "…" : formatMoney(netSales)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && previousNetSales > 0 ? { value: formatPctTrend(pctChange(netSales, previousNetSales)), direction: netSales >= previousNetSales ? "up" : "down", tone: netSales >= previousNetSales ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Transactions"
          value={loading ? "…" : txnCount.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconShoppingCart size={16} />}
          iconTone="success"
          trend={!loading && previousTxnCount > 0 ? { value: formatPctTrend(pctChange(txnCount, previousTxnCount)), direction: txnCount >= previousTxnCount ? "up" : "down", tone: txnCount >= previousTxnCount ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Avg. Basket Value"
          value={loading ? "…" : formatMoney(avgBasket)}
          subtitle="Net sales per transaction"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && previousAvgBasket > 0 ? { value: formatPctTrend(pctChange(avgBasket, previousAvgBasket)), direction: avgBasket >= previousAvgBasket ? "up" : "down", tone: avgBasket >= previousAvgBasket ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Units per Basket"
          value={loading ? "…" : unitsPerBasket.toFixed(1)}
          subtitle="Units sold per transaction"
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && previousUnitsPerBasket > 0 ? { value: formatPctTrend(pctChange(unitsPerBasket, previousUnitsPerBasket)), direction: unitsPerBasket >= previousUnitsPerBasket ? "up" : "down", tone: unitsPerBasket >= previousUnitsPerBasket ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Sales Performance</h3>
              <p>{scope === "tenant" ? "All branches" : "This branch"}</p>
            </div>
            <div className={css.segmented}>
              {(["daily", "weekly", "monthly"] as ChartGranularity[]).map((g) => (
                <button key={g} type="button" className={granularity === g ? css.on : undefined} onClick={() => setGranularity(g)}>
                  {g === "daily" ? "Daily" : g === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
          </div>
          <TrendChart points={bucketedCurrent} previousPoints={bucketedPrevious} tooltipFormat={formatMoney} currentLabel={`Last ${days} days`} previousLabel={`Previous ${days} days`} height={222} />
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Hourly Sales (Daypart)</h3>
              <p>{heatmapMetric === "revenue" ? "Revenue" : "Transactions"} by weekday × hour, last {days} days</p>
            </div>
            <div className={css.segmented}>
              {(["revenue", "count"] as const).map((m) => (
                <button key={m} type="button" className={heatmapMetric === m ? css.on : undefined} onClick={() => setHeatmapMetric(m)}>
                  {m === "revenue" ? "Revenue" : "Transactions"}
                </button>
              ))}
            </div>
          </div>
          <div className={css.heatmapGrow}>
            {hourData ? (
              <HeatmapGrid
                grid={heatmapMetric === "revenue" ? hourData.grid : hourData.counts}
                weekdayLabels={hourData.weekdayLabels}
                formatValue={heatmapMetric === "revenue" ? formatMoney : (n) => n.toLocaleString("en-IN")}
              />
            ) : null}
          </div>
          {peakSlot ? (
            <div className={css.cardFooter}>
              <div className={css.peakBadge}>
                <IconSparkles size={13} />
                <span>
                  Peak <b>{peakSlot.dayLabel} {peakSlot.hourLabel}</b>
                </span>
                <span className={css.peakBadgeValue}>
                  {heatmapMetric === "revenue" ? formatCompactMoney(peakSlot.value) : `${peakSlot.value.toLocaleString("en-IN")} txns`}
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className={css.grid2}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Sales Change Bridge</h3>
              <p>Why net sales changed vs. the comparison period</p>
            </div>
          </div>
          {hasComparablePeriod ? (
            <WaterfallChart steps={waterfallSteps} formatValue={formatMoney} />
          ) : (
            <p className={css.emptyNote}>Not enough history yet to show a period-over-period bridge.</p>
          )}
        </div>

        <ActionsPanel title="Sales Insights" items={insights} variant="cards" />
      </div>

      <div className={css.card}>
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>
            Daily Sales{" "}
            <span className={css.oppInfoIcon} data-tooltip="Gross Sales already reflects discounts (it's the tax-inclusive total actually charged) — Discounts is shown for reference only, not subtracted again. Net Sales = Gross Sales − Returns.">
              <IconInfo size={13} />
            </span>
          </h3>
          <div className={css.searchbox}>
            <IconSearch size={14} />
            <input placeholder="Search date" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <DataTable columns={columns} data={sortedForDisplay} rowKey={(r) => r.date} loading={loading} pageSize={10} emptyTitle="No days in this range" compact />
      </div>
    </div>
  );
}
