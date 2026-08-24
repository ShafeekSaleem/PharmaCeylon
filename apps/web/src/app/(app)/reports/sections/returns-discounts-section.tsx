"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { IconActivity, IconAlertTriangle, IconArchive, IconRefresh } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { fetchMarginComparison, fetchReturnsDiscountsComparison } from "../lib/fetchers";
import { formatDateShort, formatMoney, formatPctTrend, formatPpTrend, pctChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { BarRows, type BarRow } from "../components/bar-rows";
import { MultiLineChart, type MultiLineSeries } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { CategoryKey, ReportKey } from "../lib/nav-config";
import type { ExportPayload, OnExportData, ReturnedProductRow, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onNavigate: (c: CategoryKey, r?: ReportKey) => void; onExportData: OnExportData };

/** A product with only a handful of sales this period trivially hits a "high" return rate off a
 *  single return (1 sold, 1 returned = "100%") — this floor keeps the anomaly list meaningful. */
const MIN_SOLD_QTY_FOR_RETURN_RATE_FLAG = 5;

export function ReturnsDiscountsSection({ scope, isOwner, days, onNavigate, onExportData }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchReturnsDiscountsComparison>> | null>(null);
  const [marginData, setMarginData] = useState<Awaited<ReturnType<typeof fetchMarginComparison>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");
  const [search, setSearch] = useState("");
  const [reasonFocus, setReasonFocus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([fetchReturnsDiscountsComparison(days, scope, isOwner), fetchMarginComparison(days, scope, isOwner)])
      .then(([res, margin]) => {
        if (cancelled) return;
        setData(res);
        setMarginData(margin);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load returns data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const current = data?.current;
  const previous = data?.previous ?? { totalReturnValue: 0, returnedItemCount: 0, totalDiscount: 0, netSalesImpact: 0 };

  // Reconstructs gross units sold from the already returns-netted `marginByProduct` total (Phase
  // A nets every unitsSold figure against completed returns) by adding the returned units back —
  // the same units-sold basis Product/Category Sales already use, not a separately-scoped number.
  const grossUnitsSold = current ? (marginData?.currentTotals.unitsSold ?? 0) + current.returnedItemCount : 0;
  const returnRatePct = current && grossUnitsSold > 0 ? (current.returnedItemCount / grossUnitsSold) * 100 : null;
  const prevGrossUnitsSold = (marginData?.previousTotals.unitsSold ?? 0) + previous.returnedItemCount;
  const prevReturnRatePct = prevGrossUnitsSold > 0 ? (previous.returnedItemCount / prevGrossUnitsSold) * 100 : null;

  const trendSeries: MultiLineSeries[] = useMemo(() => {
    if (!current) return [];
    const returnPoints = current.trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: t.returnValue }));
    const discountPoints = current.trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: t.discountAmount }));
    return [
      { key: "returns", label: "Return Value", color: "#dc2626", values: bucketTrend(returnPoints, granularity).map((p) => p.value) },
      { key: "discounts", label: "Discount Amount", color: "#ea580c", values: bucketTrend(discountPoints, granularity).map((p) => p.value) },
    ];
  }, [current, granularity]);
  const trendLabels = current ? bucketTrend(current.trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: 0 })), granularity).map((p) => p.label) : [];

  const reasonBars: BarRow[] = (current?.topReasons ?? []).map((r) => ({ key: r.reason, label: r.reason, value: r.value, valueLabel: formatMoney(r.value), subValue: `${r.count} return${r.count === 1 ? "" : "s"}` }));

  const discountLeakageBars: BarRow[] = (current?.topDiscountLeakage ?? []).map((r) => ({ key: r.productId, label: r.name, value: r.amount, valueLabel: formatMoney(r.amount), subValue: r.sku }));

  const highReturnRate = (current?.topReturnedProducts ?? []).filter(
    (r): r is ReturnedProductRow & { returnRatePct: number } => r.returnRatePct != null && r.returnRatePct >= 10 && r.soldQty >= MIN_SOLD_QTY_FOR_RETURN_RATE_FLAG,
  );

  const actionItems: ActionPanelItem[] = [
    ...(highReturnRate.length > 0
      ? [{
          key: "high-return",
          icon: <IconAlertTriangle size={16} />,
          tone: "warning" as const,
          title: "High Return Rate Products",
          description: "10%+ of units sold this period were returned.",
          count: highReturnRate.length,
          countLabel: highReturnRate.length === 1 ? "product" : "products",
          onClick: () => onNavigate("sales", "product-sales"),
          examples: highReturnRate.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.returnRatePct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
  ];

  const matchesDetailFilters = useCallback(
    (r: ReturnedProductRow): boolean => {
      if (search && !r.name.toLowerCase().includes(search.toLowerCase()) && !r.sku.toLowerCase().includes(search.toLowerCase())) return false;
      if (reasonFocus && !r.reasons.some((x) => x.reason === reasonFocus)) return false;
      return true;
    },
    [search, reasonFocus],
  );

  useEffect(() => {
    if (!current || current.topReturnedProducts.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `returns-${days}d.csv`,
      headers: ["Product", "SKU", "Reason", "Returned Qty", "Return Value", "Refund Rate %"],
      rows: current.topReturnedProducts
        .filter(matchesDetailFilters)
        .map((r) => [r.name, r.sku, r.reasons[0]?.reason ?? "", r.qty, r.value, r.returnRatePct?.toFixed(1) ?? ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [current, matchesDetailFilters, days, onExportData]);

  const detailRows = useMemo(
    () => (current?.topReturnedProducts ?? []).filter(matchesDetailFilters),
    [current, matchesDetailFilters],
  );

  const columns: Column<ReturnedProductRow>[] = [
    { key: "name", header: "Product" },
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
    { key: "reason", header: "Reason", render: (r) => r.reasons[0]?.reason ?? "—" },
    { key: "qty", header: "Returned Qty", align: "right", sortable: true, getValue: (r) => r.qty, render: (r) => r.qty.toLocaleString("en-IN") },
    { key: "value", header: "Return Value", align: "right", sortable: true, getValue: (r) => r.value, render: (r) => formatMoney(r.value) },
    { key: "returnRatePct", header: "Refund Rate", align: "right", sortable: true, getValue: (r) => r.returnRatePct ?? 0, render: (r) => (r.returnRatePct == null ? "—" : <span className={r.returnRatePct >= 10 ? css.deltaDown : undefined}>{r.returnRatePct.toFixed(1)}%</span>) },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard
          size="sm" showMenu={false}
          title="Return Value"
          value={loading || !current ? "…" : formatMoney(current.totalReturnValue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconRefresh size={16} />}
          iconTone="danger"
          trend={!loading && current && previous.totalReturnValue > 0 ? { value: formatPctTrend(pctChange(current.totalReturnValue, previous.totalReturnValue)), direction: current.totalReturnValue >= previous.totalReturnValue ? "up" : "down", tone: current.totalReturnValue >= previous.totalReturnValue ? "danger" : "positive" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Returned Items"
          value={loading || !current ? "…" : current.returnedItemCount.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconArchive size={16} />}
          iconTone="warning"
          trend={!loading && current && previous.returnedItemCount > 0 ? { value: formatPctTrend(pctChange(current.returnedItemCount, previous.returnedItemCount)), direction: current.returnedItemCount >= previous.returnedItemCount ? "up" : "down", tone: current.returnedItemCount >= previous.returnedItemCount ? "danger" : "positive" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="Return Rate"
          value={loading || returnRatePct == null ? "…" : `${returnRatePct.toFixed(1)}%`}
          subtitle="Returned units ÷ gross units sold"
          icon={<IconActivity size={16} />}
          iconTone="danger"
          trend={!loading && returnRatePct != null && prevReturnRatePct != null ? { value: formatPpTrend(returnRatePct - prevReturnRatePct), direction: returnRatePct >= prevReturnRatePct ? "up" : "down", tone: returnRatePct >= prevReturnRatePct ? "danger" : "positive" } : undefined}
        />
        <StatCard
          size="sm" showMenu={false}
          title="High Return Rate Products"
          value={loading || !current ? "…" : highReturnRate.length.toLocaleString("en-IN")}
          subtitle="10%+ of units sold returned"
          icon={<IconAlertTriangle size={16} />}
          iconTone="danger"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Returns Over Time</h3>
            </div>
            <div className={css.segmented}>
              {(["daily", "weekly", "monthly"] as ChartGranularity[]).map((g) => (
                <button key={g} type="button" className={granularity === g ? css.on : undefined} onClick={() => setGranularity(g)}>
                  {g === "daily" ? "Daily" : g === "weekly" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
          </div>
          <div className={css.chartTopOffset}>
            <MultiLineChart labels={trendLabels} series={trendSeries} tooltipFormat={formatMoney} />
          </div>
        </div>

        <ActionsPanel title="Actions & Controls" items={actionItems} variant="cards" />
      </div>

      <div className={`${css.dailySalesRow} ${css.alignStart}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Top Return Reasons</h3>
              <p>Click a reason to filter the detail table below</p>
            </div>
          </div>
          <BarRows
            rows={reasonBars}
            danger
            onRowClick={(key) => {
              setReasonFocus((cur) => (cur === key ? null : key));
              document.getElementById("returns-detail-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }}
            activeKey={reasonFocus}
          />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Top Discount Leakage</h3>
            </div>
          </div>
          <BarRows rows={discountLeakageBars} />
        </div>
      </div>

      <div className={css.card} id="returns-detail-table">
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>Returns Detail</h3>
          <div className={css.searchbox}>
            <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {reasonFocus ? (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by reason · ${detailRows.length} product${detailRows.length === 1 ? "" : "s"}`}
              pills={[{ key: "reason", label: reasonFocus } satisfies FilterPill]}
              onClear={() => setReasonFocus(null)}
              clearTooltip="Show every return reason"
            />
          </div>
        ) : null}
        <DataTable columns={columns} data={detailRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No returned products match these filters" compact />
      </div>
    </div>
  );
}
