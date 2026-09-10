"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconCheckCircle, IconClipboardList, IconMinus } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { BarRows, type BarRow } from "../components/bar-rows";
import { MultiLineChart } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { fetchStocktakesReport } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import type { ExportPayload, OnExportData, Scope, StocktakeDiscrepancyRow, StocktakesReportResponse } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

/** How accurate is our recorded inventory, and where are discrepancies concentrated? Distinct
 *  from the operational Stocktakes screen (create → count → reconcile → approve) — this only ever
 *  displays already-posted count outcomes. */
export function StocktakesReportSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<StocktakesReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStocktakesReport(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stocktakes data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const trendSeries = useMemo(() => {
    const points = (data?.accuracyTrend ?? []).filter((p) => p.accuracyPct != null);
    return {
      labels: points.map((p) => p.label),
      values: points.map((p) => p.accuracyPct as number),
    };
  }, [data]);

  const varianceRows: BarRow[] = useMemo(() => {
    const rows = data?.isMultiBranch ? (data?.varianceByBranch ?? []) : (data?.varianceByCategory ?? []);
    return rows.map((r) => ({
      key: r.key,
      label: r.label,
      sublabel: `${r.linesCounted} line${r.linesCounted === 1 ? "" : "s"} counted`,
      value: r.varianceValue,
      valueLabel: formatMoney(r.varianceValue),
      subValue: `${r.variancePct.toFixed(1)}%`,
    }));
  }, [data]);

  const insightItems: ActionPanelItem[] = useMemo(
    () =>
      (data?.insights ?? []).map((i) => ({
        key: i.key,
        icon: <IconClipboardList size={16} />,
        tone: i.key === "repeatedDiscrepancies" || i.key === "worstBranch" ? ("danger" as const) : ("warning" as const),
        title: i.title,
        description: i.description,
        count: 0,
        countLabel: "",
        countText: i.countLabel,
      })),
    [data],
  );

  const discrepancyColumns: Column<StocktakeDiscrepancyRow>[] = [
    { key: "product", header: "Product", width: "8rem", render: (r) => (
      <>
        <span className={css.skucode}>{r.product.sku ?? r.productId}</span>
        <div className={`${css.mutedcell} ${css.productNameCell}`} title={r.product.name ?? ""}>{r.product.name ?? ""}</div>
      </>
    ) },
    { key: "branch", header: "Branch", width: "6rem", render: (r) => r.branchName },
    { key: "expected", header: "Expected", align: "right", width: "4.2rem", sortable: true, getValue: (r) => r.expectedQty, render: (r) => r.expectedQty.toLocaleString("en-IN") },
    { key: "counted", header: "Counted", align: "right", width: "4.2rem", sortable: true, getValue: (r) => r.countedQty, render: (r) => r.countedQty.toLocaleString("en-IN") },
    { key: "variance", header: "Variance", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.varianceQty, render: (r) => <span className={r.varianceQty < 0 ? css.deltaDown : css.deltaUp}>{r.varianceQty > 0 ? "+" : ""}{r.varianceQty.toLocaleString("en-IN")}</span> },
    { key: "value", header: "Value", align: "right", width: "5rem", sortable: true, getValue: (r) => r.varianceValue, render: (r) => formatMoney(r.varianceValue) },
    { key: "date", header: "Stocktake", width: "6rem", render: (r) => (
      <>
        {r.stocktakeNumber}
        <div className={css.mutedcell}>{new Date(r.stocktakeDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
      </>
    ) },
    { key: "flag", header: "Pattern", width: "4.5rem", render: (r) => (r.isRepeatDiscrepancy ? <span className={`${css.badge2} ${css.badge2Tight} ${css.atRisk}`} data-tooltip="Negative variance in 2+ recent stocktakes">Repeat</span> : <span className={css.mutedcell}>—</span>) },
  ];

  useEffect(() => {
    if (!data || data.discrepancies.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `stocktakes-${days}d.csv`,
      headers: ["Product", "SKU", "Branch", "Expected Qty", "Counted Qty", "Variance Qty", "Variance Value", "Stocktake", "Date", "Repeated"],
      rows: data.discrepancies.map((r) => [
        r.product.name ?? r.productId,
        r.product.sku ?? "",
        r.branchName,
        r.expectedQty,
        r.countedQty,
        r.varianceQty,
        r.varianceValue,
        r.stocktakeNumber,
        r.stocktakeDate,
        r.isRepeatDiscrepancy ? "Yes" : "No",
      ]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  const kpis = data?.kpis;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Inventory Accuracy"
          value={loading || !kpis || kpis.accuracyPct == null ? "—" : `${kpis.accuracyPct.toFixed(1)}%`}
          subtitle="Lines matched exactly"
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && kpis && kpis.accuracyPct != null && kpis.prevAccuracyPct != null && kpis.prevAccuracyPct > 0 ? { value: formatPctTrend(pctChange(kpis.accuracyPct, kpis.prevAccuracyPct)), direction: kpis.accuracyPct >= kpis.prevAccuracyPct ? "up" : "down", tone: kpis.accuracyPct >= kpis.prevAccuracyPct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Variance Value"
          value={loading || !kpis ? "…" : formatMoney(kpis.varianceValue)}
          subtitle="At cost, |counted − expected|"
          icon={<IconAlertTriangle size={16} />}
          iconTone="warning"
          trend={!loading && kpis && kpis.prevVarianceValue > 0 ? { value: formatPctTrend(pctChange(kpis.varianceValue, kpis.prevVarianceValue)), direction: kpis.varianceValue >= kpis.prevVarianceValue ? "up" : "down", tone: kpis.varianceValue <= kpis.prevVarianceValue ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Shrinkage"
          value={loading || !kpis ? "…" : formatMoney(kpis.shrinkageValue)}
          subtitle="Missing stock only, at cost"
          icon={<IconMinus size={16} />}
          iconTone="danger"
          trend={!loading && kpis && kpis.prevShrinkageValue > 0 ? { value: formatPctTrend(pctChange(kpis.shrinkageValue, kpis.prevShrinkageValue)), direction: kpis.shrinkageValue >= kpis.prevShrinkageValue ? "up" : "down", tone: kpis.shrinkageValue <= kpis.prevShrinkageValue ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Stocktakes Completed"
          value={loading || !kpis ? "…" : `${kpis.completedCount} / ${kpis.plannedCount}`}
          subtitle="Completed vs planned this period"
          icon={<IconClipboardList size={16} />}
          iconTone="primary"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Inventory Accuracy Trend</h3>
              <p>Share of counted lines matching exactly, over time</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            {trendSeries.labels.length === 0 ? (
              <p className={css.emptyNote}>No completed counts in this range yet.</p>
            ) : (
              <MultiLineChart
                labels={trendSeries.labels}
                series={[{ key: "accuracy", label: "Accuracy", color: "var(--pc-tone-success)", values: trendSeries.values }]}
                formatValue={(n) => `${n.toFixed(0)}%`}
              />
            )}
          </div>
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>{data?.isMultiBranch ? "Variance by Branch" : "Variance by Category"}</h3>
              <p>{data?.isMultiBranch ? "Which branches carry the most discrepancy value" : "Which categories carry the most discrepancy value"}</p>
            </div>
          </div>
          <BarRows rows={varianceRows} danger pageSize={6} />
        </div>
      </div>

      <div className={`${css.grid2Even} ${css.discrepancyDetailRow} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="discrepancy-table">
          <div className={css.cardhead}>
            <div>
              <h3>Discrepancy Detail</h3>
              <p>Every line with a nonzero variance, highest value first</p>
            </div>
          </div>
          <DataTable columns={discrepancyColumns} data={data?.discrepancies ?? []} rowKey={(r) => r.lineId} loading={loading} pageSize={8} emptyTitle="No discrepancies in this range" compact className={css.fixedLayoutTable} />
        </div>

        <ActionsPanel title="Stocktake Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>
    </div>
  );
}
