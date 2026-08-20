"use client";

import { useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconArchive, IconDollarSign, IconSearch, IconShoppingCart, IconSparkles } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import {
  fetchMarginComparison,
  fetchSalesByHour,
  fetchSalesComparison,
  fetchSalesDaily,
  fetchSalesTrendWithComparison,
} from "../lib/fetchers";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { formatCompactMoney, formatMoney, pctChange, formatPctTrend } from "../lib/format";
import { TrendChart } from "../components/trend-chart";
import { HeatmapGrid } from "../components/heatmap-grid";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { MarginRow, Scope, BranchTrendPoint, ExportPayload, OnExportData, SalesByHourResponse, SalesDailyRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; branchId: string | null; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

function formatDayLabel(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

type EnrichedDailyRow = SalesDailyRow & { grossSalesN: number; discountsN: number; returnsN: number; netSalesN: number; growthPct: number | null };

export function SalesSection({ scope, isOwner, branchId, days, onNavigate, onExportData }: Props) {
  const [points, setPoints] = useState<BranchTrendPoint[]>([]);
  const [previousPoints, setPreviousPoints] = useState<BranchTrendPoint[]>([]);
  const [total, setTotal] = useState(0);
  const [previousTotal, setPreviousTotal] = useState(0);
  const [txnCount, setTxnCount] = useState(0);
  const [previousTxnCount, setPreviousTxnCount] = useState(0);
  const [itemsSold, setItemsSold] = useState(0);
  const [previousItemsSold, setPreviousItemsSold] = useState(0);
  const [dailyRows, setDailyRows] = useState<SalesDailyRow[]>([]);
  const [hourData, setHourData] = useState<SalesByHourResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");

  const [marginRows, setMarginRows] = useState<MarginRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      fetchSalesTrendWithComparison(days, scope, branchId),
      fetchSalesComparison(days, scope, isOwner),
      fetchMarginComparison(days, scope, isOwner),
      fetchSalesDaily(days, scope, isOwner),
      fetchSalesByHour(days, scope, isOwner),
    ])
      .then(([trend, comparison, margin, daily, hours]) => {
        if (cancelled) return;
        setPoints(trend.currentPoints);
        setPreviousPoints(trend.previousPoints);
        setTotal(trend.total);
        setPreviousTotal(trend.previousTotal);
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
  }, [days, scope, branchId, isOwner]);

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

  const avgBasket = txnCount > 0 ? total / txnCount : 0;
  const previousAvgBasket = previousTxnCount > 0 ? previousTotal / previousTxnCount : 0;

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
    let best = { day: 0, hour: 0, value: 0 };
    hourData.grid.forEach((row, day) => row.forEach((value, hour) => { if (value > best.value) best = { day, hour, value }; }));
    if (best.value <= 0) return null;
    const hourLabel = best.hour === 0 ? "12AM" : best.hour < 12 ? `${best.hour}AM` : best.hour === 12 ? "12PM" : `${best.hour - 12}PM`;
    return { ...best, dayLabel: hourData.weekdayLabels[best.day]!, hourLabel };
  }, [hourData]);

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
    if (totalReturns > total * 0.03 && total > 0) {
      out.push({
        key: "returns",
        icon: <IconAlertTriangle size={16} />,
        tone: "danger",
        title: `${formatMoney(totalReturns)} in returns this period`,
        description: `That's ${((totalReturns / total) * 100).toFixed(1)}% of revenue — worth checking return reasons.`,
        count: daysWithReturns,
        countLabel: daysWithReturns === 1 ? "day with returns" : "days with returns",
        onClick: () => onNavigate("sales", "returns-discounts"),
      });
    }
    return out;
  }, [topCategory, totalReturns, daysWithReturns, total, days, onNavigate]);

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
          title="Revenue"
          value={loading ? "…" : formatMoney(total)}
          subtitle={`vs previous ${days} days`}
          icon={<IconDollarSign size={16} />}
          trend={!loading && previousTotal > 0 ? { value: formatPctTrend(pctChange(total, previousTotal)), direction: total >= previousTotal ? "up" : "down", tone: total >= previousTotal ? "positive" : "danger" } : undefined}
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
          subtitle="Per transaction"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && previousAvgBasket > 0 ? { value: formatPctTrend(pctChange(avgBasket, previousAvgBasket)), direction: avgBasket >= previousAvgBasket ? "up" : "down", tone: avgBasket >= previousAvgBasket ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Items Sold"
          value={loading ? "…" : itemsSold.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && previousItemsSold > 0 ? { value: formatPctTrend(pctChange(itemsSold, previousItemsSold)), direction: itemsSold >= previousItemsSold ? "up" : "down", tone: itemsSold >= previousItemsSold ? "positive" : "danger" } : undefined}
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
              <p>Revenue by weekday × hour, last {days} days</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            {hourData ? <HeatmapGrid grid={hourData.grid} weekdayLabels={hourData.weekdayLabels} formatValue={formatMoney} /> : null}
          </div>
          {peakSlot ? (
            <div className={css.cardFooter}>
              <div className={css.peakBadge}>
                <IconSparkles size={13} />
                <span>
                  Peak <b>{peakSlot.dayLabel} {peakSlot.hourLabel}</b>
                </span>
                <span className={css.peakBadgeValue}>{formatCompactMoney(peakSlot.value)}</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className={css.dailySalesRow}>
        <div className={css.card}>
          <div className={css.toolbarrow}>
            <h3 style={{ margin: 0 }}>Daily Sales</h3>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search date" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <DataTable columns={columns} data={sortedForDisplay} rowKey={(r) => r.date} loading={loading} pageSize={10} emptyTitle="No days in this range" compact />
        </div>

        <ActionsPanel title="Sales Insights" items={insights} variant="cards" />
      </div>
    </div>
  );
}
