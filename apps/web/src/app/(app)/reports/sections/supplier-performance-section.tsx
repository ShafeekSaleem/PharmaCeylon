"use client";

import { useEffect, useMemo, useState } from "react";
import { IconAlertTriangle, IconCalendar, IconCheckCircle, IconClipboardList, IconTarget, IconTrophy } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { SupplierPerformanceMatrix, type SupplierMatrixPoint } from "../components/supplier-performance-matrix";
import { SupplierScoreRadialGrid, type SupplierScorePoint } from "../components/supplier-score-radial";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { fetchSupplierPerformance } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import type { ExportPayload, OnExportData, Scope, SupplierPerformanceResponse, SupplierScoreRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const GRADE_TONE: Record<string, string> = { preferred: "healthy", good: "monitor", monitor: "watch", review: "atRisk" };
const GRADE_LABEL: Record<string, string> = { preferred: "Preferred", good: "Good", monitor: "Monitor", review: "Review" };

/** Which suppliers provide the best overall value and service? Every metric here is a disclosed
 *  derivation from real PO/receipt/batch data — see the API's `ReportsService.supplierPerformance`
 *  doc comment for exactly how, including why light demo data makes most suppliers read as
 *  near-perfect until they've built up a real delivery history. */
export function SupplierPerformanceSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<SupplierPerformanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedSupplierId(null);
    fetchSupplierPerformance(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load supplier performance data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const matrixPoints: SupplierMatrixPoint[] = useMemo(
    () => (data?.scorecard ?? []).map((s) => ({ supplierId: s.supplierId, supplierName: s.supplierName, spend: s.spend, onTimePct: s.onTimePct, priceVariancePct: s.priceVariancePct, grade: s.grade })),
    [data],
  );

  const scorePoints: SupplierScorePoint[] = useMemo(
    () => (data?.scorecard ?? []).slice(0, 12).map((s) => ({ supplierId: s.supplierId, supplierName: s.supplierName, score: s.score, grade: s.grade })),
    [data],
  );

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleSupplier(supplierId: string) {
    setSelectedSupplierId((cur) => (cur === supplierId ? null : supplierId));
  }

  const insightItems: ActionPanelItem[] = useMemo(() => {
    const backendInsights: ActionPanelItem[] = (data?.insights ?? []).map((i) => ({
      key: i.key,
      icon: i.key === "lateDeliveries" ? <IconAlertTriangle size={16} /> : i.key === "priceIncrease" ? <IconTarget size={16} /> : <IconClipboardList size={16} />,
      tone: "danger" as const,
      title: i.title,
      description: i.description,
      count: 0,
      countLabel: "",
      countText: i.countLabel,
      onClick: () => scrollTo("supplier-scorecard"),
      examples: [{ label: "Impact", badge: i.countLabel, tone: "negative" as const }],
    }));

    // The backend's own insights are alert-only (late deliveries, price increases, suppliers
    // needing review) and stay empty whenever every supplier is performing well — which is
    // common with a short delivery history. These derived ones are always populated whenever
    // there's a scorecard at all, so the panel reads as "here's what's happening" rather than
    // "nothing to show" the moment nothing is actively wrong.
    const scorecard = data?.scorecard ?? [];
    const derived: ActionPanelItem[] = [];
    const topScore = [...scorecard].sort((a, b) => b.score - a.score)[0];
    if (topScore) {
      derived.push({
        key: "topPerformer",
        icon: <IconTrophy size={16} />,
        tone: "primary",
        title: "Top performer",
        description: `${topScore.supplierName} leads this period with a ${topScore.score.toFixed(0)}/100 composite score.`,
        count: 1,
        countLabel: "supplier",
        onClick: () => {
          toggleSupplier(topScore.supplierId);
          scrollTo("supplier-scorecard");
        },
        examples: [{ label: topScore.supplierName, badge: `${topScore.score.toFixed(0)}/100`, tone: "positive" }],
      });
    }
    const totalSpend = scorecard.reduce((s, r) => s + r.spend, 0);
    const topSpend = [...scorecard].sort((a, b) => b.spend - a.spend)[0];
    if (topSpend && totalSpend > 0) {
      const sharePct = (topSpend.spend / totalSpend) * 100;
      derived.push({
        key: "spendConcentration",
        icon: <IconTarget size={16} />,
        tone: sharePct > 40 ? "warning" : "muted",
        title: "Spend concentration",
        description: `${topSpend.supplierName} accounts for ${sharePct.toFixed(0)}% of total supplier spend measured this period.`,
        count: 1,
        countLabel: "supplier",
        onClick: () => {
          toggleSupplier(topSpend.supplierId);
          scrollTo("supplier-scorecard");
        },
        examples: [{ label: topSpend.supplierName, badge: `${sharePct.toFixed(0)}% of spend`, tone: sharePct > 40 ? "negative" : "neutral" }],
      });
    }

    return [...backendInsights, ...derived];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const scoreColumns: Column<SupplierScoreRow>[] = [
    { key: "supplier", header: "Supplier", width: "8rem", render: (r) => r.supplierName },
    { key: "spend", header: "Spend", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.spend, render: (r) => formatMoney(r.spend) },
    { key: "onTime", header: "On-Time %", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.onTimePct ?? -1, render: (r) => (r.onTimePct == null ? "—" : `${r.onTimePct.toFixed(0)}%`) },
    { key: "fill", header: "Fill Rate", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.fillRatePct ?? -1, render: (r) => (r.fillRatePct == null ? "—" : `${r.fillRatePct.toFixed(0)}%`) },
    { key: "leadTime", header: "Avg Lead Time", align: "right", width: "5rem", sortable: true, getValue: (r) => r.avgLeadTimeDays ?? -1, render: (r) => (r.avgLeadTimeDays == null ? "—" : `${r.avgLeadTimeDays.toFixed(1)}d`) },
    { key: "variance", header: "Price Var.", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.priceVariancePct ?? 0, render: (r) => (r.priceVariancePct == null ? "—" : <span className={r.priceVariancePct > 0 ? css.deltaDown : css.deltaUp}>{r.priceVariancePct > 0 ? "+" : ""}{r.priceVariancePct.toFixed(1)}%</span>) },
    { key: "returns", header: "Returns", align: "right", width: "5rem", sortable: true, getValue: (r) => r.returnsValue, render: (r) => formatMoney(r.returnsValue) },
    { key: "score", header: "Score", align: "right", width: "3.5rem", sortable: true, getValue: (r) => r.score, render: (r) => r.score.toFixed(0) },
    { key: "grade", header: "Status", width: "4.5rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[GRADE_TONE[r.grade] ?? "monitor"]}`}>{GRADE_LABEL[r.grade] ?? r.grade}</span> },
  ];

  const filteredScorecard = useMemo(
    () => (selectedSupplierId ? (data?.scorecard ?? []).filter((r) => r.supplierId === selectedSupplierId) : (data?.scorecard ?? [])),
    [data, selectedSupplierId],
  );
  const selectedSupplierName = selectedSupplierId ? (data?.scorecard ?? []).find((r) => r.supplierId === selectedSupplierId)?.supplierName : undefined;
  const supplierFilterPills: FilterPill[] = selectedSupplierName ? [{ key: "supplier", label: selectedSupplierName }] : [];

  useEffect(() => {
    if (!data || data.scorecard.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `supplier-performance-${days}d.csv`,
      headers: ["Supplier", "Spend", "On-Time %", "Fill Rate %", "Avg Lead Time (days)", "Price Variance %", "Returns Value", "Score", "Status"],
      rows: data.scorecard.map((r) => [r.supplierName, r.spend, r.onTimePct ?? "", r.fillRatePct ?? "", r.avgLeadTimeDays ?? "", r.priceVariancePct ?? "", r.returnsValue, r.score, GRADE_LABEL[r.grade] ?? r.grade]),
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
          title="On-Time Delivery %"
          value={loading || !kpis || kpis.onTimePct == null ? "—" : `${kpis.onTimePct.toFixed(1)}%`}
          subtitle="Received by the PO's expected date"
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && kpis && kpis.onTimePct != null && kpis.prevOnTimePct != null && kpis.prevOnTimePct > 0 ? { value: formatPctTrend(pctChange(kpis.onTimePct, kpis.prevOnTimePct)), direction: kpis.onTimePct >= kpis.prevOnTimePct ? "up" : "down", tone: kpis.onTimePct >= kpis.prevOnTimePct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Fill Rate %"
          value={loading || !kpis || kpis.fillRatePct == null ? "—" : `${kpis.fillRatePct.toFixed(1)}%`}
          subtitle="Received ÷ ordered units"
          icon={<IconClipboardList size={16} />}
          iconTone="primary"
          trend={!loading && kpis && kpis.fillRatePct != null && kpis.prevFillRatePct != null && kpis.prevFillRatePct > 0 ? { value: formatPctTrend(pctChange(kpis.fillRatePct, kpis.prevFillRatePct)), direction: kpis.fillRatePct >= kpis.prevFillRatePct ? "up" : "down", tone: kpis.fillRatePct >= kpis.prevFillRatePct ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Avg Lead Time"
          value={loading || !kpis || kpis.avgLeadTimeDays == null ? "—" : `${kpis.avgLeadTimeDays.toFixed(1)}d`}
          subtitle="Order date to delivery"
          icon={<IconCalendar size={16} />}
          iconTone="warning"
          trend={!loading && kpis && kpis.avgLeadTimeDays != null && kpis.prevAvgLeadTimeDays != null && kpis.prevAvgLeadTimeDays > 0 ? { value: formatPctTrend(pctChange(kpis.avgLeadTimeDays, kpis.prevAvgLeadTimeDays)), direction: kpis.avgLeadTimeDays >= kpis.prevAvgLeadTimeDays ? "up" : "down", tone: kpis.avgLeadTimeDays <= kpis.prevAvgLeadTimeDays ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Purchase Price Variance"
          value={loading || !kpis || kpis.priceVariancePct == null ? "—" : `${kpis.priceVariancePct > 0 ? "+" : ""}${kpis.priceVariancePct.toFixed(1)}%`}
          subtitle="Delivered cost vs. agreed PO price"
          icon={<IconTarget size={16} />}
          iconTone="danger"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Supplier Performance Matrix</h3>
              <p>Delivery reliability × price competitiveness — bubble size = spend</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            <SupplierPerformanceMatrix points={matrixPoints} formatValue={formatMoney} />
          </div>
        </div>

        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Supplier Score Comparison</h3>
              <p>Composite 0-100 performance score</p>
            </div>
          </div>
          <SupplierScoreRadialGrid points={scorePoints} onSupplierClick={toggleSupplier} activeSupplierId={selectedSupplierId} />
        </div>
      </div>

      <div className={`${css.grid2Even} ${css.scorecardRow} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="supplier-scorecard">
          <div className={css.cardhead}>
            <div>
              <h3>Supplier Scorecard</h3>
              <p>Every supplier with a delivery in this range</p>
            </div>
          </div>
          {selectedSupplierName ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by supplier · ${filteredScorecard.length} row${filteredScorecard.length === 1 ? "" : "s"}`}
                pills={supplierFilterPills}
                onClear={() => setSelectedSupplierId(null)}
                clearTooltip="Show all suppliers"
              />
            </div>
          ) : null}
          <DataTable columns={scoreColumns} data={filteredScorecard} rowKey={(r) => r.supplierId} loading={loading} pageSize={8} emptyTitle="No supplier deliveries in this range" compact className={css.fixedLayoutTable} />
        </div>

        <ActionsPanel title="Performance Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>
    </div>
  );
}
