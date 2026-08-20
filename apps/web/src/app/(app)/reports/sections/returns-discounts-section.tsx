"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconArchive, IconRefresh, IconTarget } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fetchReturnsDiscountsComparison } from "../lib/fetchers";
import { formatDateShort, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import { bucketTrend, type ChartGranularity } from "../lib/chart-bucketing";
import { BarRows, type BarRow } from "../components/bar-rows";
import { MultiLineChart, type MultiLineSeries } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import type { ExportPayload, OnExportData, ReturnedProductRow, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

export function ReturnsDiscountsSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchReturnsDiscountsComparison>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [granularity, setGranularity] = useState<ChartGranularity>("daily");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReturnsDiscountsComparison(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
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

  const avgReturnValue = current && current.returnedItemCount > 0 ? current.totalReturnValue / current.returnedItemCount : 0;
  const prevAvgReturnValue = previous.returnedItemCount > 0 ? previous.totalReturnValue / previous.returnedItemCount : 0;

  const trendSeries: MultiLineSeries[] = useMemo(() => {
    if (!current) return [];
    const returnPoints = current.trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: t.returnValue }));
    return [{ key: "returns", label: "Return Value", color: "#dc2626", values: bucketTrend(returnPoints, granularity).map((p) => p.value) }];
  }, [current, granularity]);
  const trendLabels = current ? bucketTrend(current.trend.map((t) => ({ label: formatDateShort(t.date), date: t.date, value: 0 })), granularity).map((p) => p.label) : [];

  const reasonBars: BarRow[] = (current?.topReasons ?? []).map((r) => ({ key: r.reason, label: r.reason, value: r.value, valueLabel: formatMoney(r.value), subValue: `${r.count} return${r.count === 1 ? "" : "s"}` }));

  const highReturnRate = (current?.topReturnedProducts ?? []).filter((r): r is ReturnedProductRow & { returnRatePct: number } => r.returnRatePct != null && r.returnRatePct >= 10);

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
          examples: highReturnRate.slice(0, 3).map((r) => ({ label: r.name, badge: `${r.returnRatePct.toFixed(1)}%`, tone: "negative" as const })),
        }]
      : []),
  ];

  useEffect(() => {
    if (!current || current.topReturnedProducts.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `returns-${days}d.csv`,
      headers: ["Product", "SKU", "Returned Qty", "Return Value", "Refund Rate %"],
      rows: current.topReturnedProducts
        .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()))
        .map((r) => [r.name, r.sku, r.qty, r.value, r.returnRatePct?.toFixed(1) ?? ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [current, search, days, onExportData]);

  const detailRows = useMemo(
    () => (current?.topReturnedProducts ?? []).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase())),
    [current, search],
  );

  const columns: Column<ReturnedProductRow>[] = [
    { key: "name", header: "Product" },
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.sku}</span> },
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
          title="Avg Return Value"
          value={loading || !current ? "…" : formatMoney(avgReturnValue)}
          subtitle={`vs previous ${days} days`}
          icon={<IconTarget size={16} />}
          trend={!loading && current && prevAvgReturnValue > 0 ? { value: formatPctTrend(pctChange(avgReturnValue, prevAvgReturnValue)), direction: avgReturnValue >= prevAvgReturnValue ? "up" : "down", tone: avgReturnValue >= prevAvgReturnValue ? "danger" : "positive" } : undefined}
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
          <div className={css.toolbarrow}>
            <h3 style={{ margin: 0 }}>Returns Detail</h3>
            <div className={css.searchbox}>
              <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <DataTable columns={columns} data={detailRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No returned products in this range" compact />
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Top Return Reasons</h3>
            </div>
          </div>
          <BarRows rows={reasonBars} danger />
        </div>
      </div>
    </div>
  );
}
