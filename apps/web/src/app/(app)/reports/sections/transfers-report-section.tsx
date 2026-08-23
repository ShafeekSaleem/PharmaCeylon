"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconCalendar, IconCheckCircle, IconClipboardList, IconDollarSign, IconEye, IconTruck } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { BarRows, type BarRow } from "../components/bar-rows";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { fetchTransfersReport } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import type { ExportPayload, OnExportData, TransferActivityRow, TransfersReportResponse } from "../lib/types";
import css from "../reports.module.css";

type Props = { days: number; onExportData: OnExportData };

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  approved: "Approved",
  in_transit: "In Transit",
  partially_received: "Partial",
  received: "Received",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
const STATUS_TONE: Record<string, string> = {
  requested: "watch",
  approved: "watch",
  in_transit: "watch",
  partially_received: "watch",
  received: "healthy",
  rejected: "atRisk",
  cancelled: "deadSlow",
};

/** How effectively are branches using transfers to balance inventory? Tenant-wide by nature (a
 *  transfer only means something across branches) — distinct from the operational Transfers
 *  screen, which creates/approves/receives individual transfers; this one only ever displays
 *  aggregated outcomes and a live cross-branch rebalancing opportunity scan. Not shown at all for
 *  single-branch tenants. */
export function TransfersReportSection({ days, onExportData }: Props) {
  const [data, setData] = useState<TransfersReportResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedLaneKey, setSelectedLaneKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedLaneKey(null);
    fetchTransfersReport(days)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load transfers data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const flowRows: BarRow[] = useMemo(
    () =>
      (data?.branchFlow ?? []).slice(0, 8).map((f) => ({
        key: `${f.fromBranchId}::${f.toBranchId}`,
        label: `${f.fromBranchName} → ${f.toBranchName}`,
        sublabel: `${f.transferCount} transfer${f.transferCount === 1 ? "" : "s"}`,
        value: f.units,
        valueLabel: `${f.units.toLocaleString("en-IN")} units`,
        subValue: formatMoney(f.value),
      })),
    [data],
  );

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleLane(key: string) {
    setSelectedLaneKey((cur) => (cur === key ? null : key));
  }

  const insightItems: ActionPanelItem[] = useMemo(
    () =>
      (data?.insights ?? []).map((i) => ({
        key: i.key,
        icon: <IconClipboardList size={16} />,
        tone: i.key === "lowSuccessRate" ? ("danger" as const) : i.key === "repeatLoops" ? ("warning" as const) : ("primary" as const),
        title: i.title,
        description: i.description,
        count: 0,
        countLabel: "",
        countText: i.countLabel,
        onClick: () => scrollTo(i.key === "repeatLoops" ? "transfer-flow" : "transfer-activity"),
      })),
    [data],
  );

  const activityColumns: Column<TransferActivityRow>[] = [
    { key: "transferNumber", header: "Transfer #", width: "6rem" },
    { key: "from", header: "From", width: "6.5rem", render: (r) => r.fromBranchName },
    { key: "to", header: "To", width: "6.5rem", render: (r) => r.toBranchName },
    { key: "status", header: "Status", width: "5rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[STATUS_TONE[r.status] ?? "monitor"]}`}>{STATUS_LABEL[r.status] ?? r.status}</span> },
    { key: "items", header: "Items", align: "right", width: "3.5rem", sortable: true, getValue: (r) => r.itemCount, render: (r) => r.itemCount.toLocaleString("en-IN") },
    { key: "units", header: "Units", align: "right", width: "4rem", sortable: true, getValue: (r) => r.units, render: (r) => r.units.toLocaleString("en-IN") },
    { key: "value", header: "Value", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.value, render: (r) => formatMoney(r.value) },
    { key: "createdAt", header: "Requested", width: "5rem", sortable: true, getValue: (r) => r.createdAt, render: (r) => new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
    {
      key: "action",
      header: "",
      width: "2.5rem",
      align: "right",
      render: (r) => (
        <Link className={css.rowIconBtn} href={`/transfers?transfer=${r.id}`} data-tooltip="View in transfers" aria-label="View in transfers">
          <IconEye size={12} />
        </Link>
      ),
    },
  ];

  const filteredActivity = useMemo(
    () => (selectedLaneKey ? (data?.activity ?? []).filter((r) => `${r.fromBranchId}::${r.toBranchId}` === selectedLaneKey) : (data?.activity ?? [])),
    [data, selectedLaneKey],
  );
  const selectedLaneRow = selectedLaneKey ? flowRows.find((r) => r.key === selectedLaneKey) : undefined;
  const laneFilterPills: FilterPill[] = selectedLaneRow ? [{ key: "lane", label: selectedLaneRow.label }] : [];

  useEffect(() => {
    if (!data || data.activity.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `transfers-${days}d.csv`,
      headers: ["Transfer #", "From Branch", "To Branch", "Status", "Items", "Units", "Value (LKR)", "Requested", "Completed"],
      rows: data.activity.map((r) => [r.transferNumber, r.fromBranchName, r.toBranchName, STATUS_LABEL[r.status] ?? r.status, r.itemCount, r.units, r.value, r.createdAt, r.completedAt ?? ""]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [data, days, onExportData]);

  if (error) return <div className={css.errorState}>{error}</div>;

  if (!loading && data && !data.isMultiBranch) {
    return (
      <div className={css.card}>
        <p className={css.emptyNote}>Transfer analytics need at least two branches to compare — this tenant currently operates a single branch.</p>
      </div>
    );
  }

  const kpis = data?.kpis;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false}
          title="Transfers"
          value={loading || !kpis ? "…" : kpis.transferCount.toLocaleString("en-IN")}
          subtitle={`vs previous ${days} days`}
          icon={<IconTruck size={16} />}
          iconTone="primary"
          trend={!loading && kpis && kpis.prevTransferCount > 0 ? { value: formatPctTrend(pctChange(kpis.transferCount, kpis.prevTransferCount)), direction: kpis.transferCount >= kpis.prevTransferCount ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Stock Value Moved"
          value={loading || !kpis ? "…" : formatMoney(kpis.valueMoved)}
          subtitle="At cost, received units only"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && kpis && kpis.prevValueMoved > 0 ? { value: formatPctTrend(pctChange(kpis.valueMoved, kpis.prevValueMoved)), direction: kpis.valueMoved >= kpis.prevValueMoved ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Avg Completion Time"
          value={loading || !kpis || kpis.avgCompletionHours == null ? "—" : kpis.avgCompletionHours < 24 ? `${Math.round(kpis.avgCompletionHours)}h` : `${(kpis.avgCompletionHours / 24).toFixed(1)}d`}
          subtitle="Request to receipt"
          icon={<IconCalendar size={16} />}
          iconTone="warning"
          trend={!loading && kpis && kpis.avgCompletionHours != null && kpis.prevAvgCompletionHours != null && kpis.prevAvgCompletionHours > 0 ? { value: formatPctTrend(pctChange(kpis.avgCompletionHours, kpis.prevAvgCompletionHours)), direction: kpis.avgCompletionHours >= kpis.prevAvgCompletionHours ? "up" : "down", tone: kpis.avgCompletionHours <= kpis.prevAvgCompletionHours ? "positive" : "danger" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Transfer Success Rate"
          value={loading || !kpis || kpis.successRatePct == null ? "—" : `${kpis.successRatePct.toFixed(1)}%`}
          subtitle="Received vs rejected/cancelled"
          icon={<IconCheckCircle size={16} />}
          iconTone="success"
          trend={!loading && kpis && kpis.successRatePct != null && kpis.prevSuccessRatePct != null && kpis.prevSuccessRatePct > 0 ? { value: formatPctTrend(pctChange(kpis.successRatePct, kpis.prevSuccessRatePct)), direction: kpis.successRatePct >= kpis.prevSuccessRatePct ? "up" : "down", tone: kpis.successRatePct >= kpis.prevSuccessRatePct ? "positive" : "danger" } : undefined}
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="transfer-flow">
          <div className={css.cardhead}>
            <div>
              <h3>Branch Transfer Flow</h3>
              <p>Top branch-to-branch lanes by units moved</p>
            </div>
          </div>
          <div className={css.transferFlowWide}>
            <BarRows rows={flowRows} pageSize={8} onRowClick={toggleLane} activeKey={selectedLaneKey} />
          </div>
        </div>

        <ActionsPanel title="Transfer Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>

      <div className={css.card} id="transfer-opportunities">
        <div className={css.cardhead}>
          <div>
            <h3>Transfer Opportunities</h3>
            <p>Live cross-branch days-of-cover imbalances, independent of the selected range</p>
          </div>
        </div>
        {(data?.opportunities.length ?? 0) === 0 ? (
          <p className={css.emptyNote}>No cross-branch rebalancing opportunities right now.</p>
        ) : (
          <div className={css.transferOppList}>
            {data!.opportunities.map((o) => (
              <div key={o.productId} className={css.transferOppRow}>
                <span className={css.transferOppText}>
                  <b>{o.fromBranchName}</b> has {o.fromDaysCover}d of cover on {o.product.name ?? o.product.sku ?? o.productId}, while <b>{o.toBranchName}</b>{" "}
                  {o.toDaysCover == null ? "has no recent cover" : `has only ${o.toDaysCover}d`} — estimated {formatMoney(o.estimatedValue)} at risk.
                </span>
                <Link className={css.transferOppAction} href={`/transfers?productId=${o.productId}&fromBranchId=${o.fromBranchId}&toBranchId=${o.toBranchId}&qty=${o.suggestedUnits}`}>
                  <IconTruck size={13} /> Transfer {o.suggestedUnits}
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={css.card} id="transfer-activity">
        <div className={css.cardhead}>
          <div>
            <h3>Transfer Activity</h3>
            <p>Every transfer requested in this range</p>
          </div>
        </div>
        {selectedLaneRow ? (
          <div className={css.activeFilterSlot}>
            <ActiveFilterBanner
              active
              summary={`Filtered by lane · ${filteredActivity.length} transfer${filteredActivity.length === 1 ? "" : "s"}`}
              pills={laneFilterPills}
              onClear={() => setSelectedLaneKey(null)}
              clearTooltip="Show all lanes"
            />
          </div>
        ) : null}
        <DataTable columns={activityColumns} data={filteredActivity} rowKey={(r) => r.id} loading={loading} pageSize={10} emptyTitle="No transfers requested in this range" compact className={css.fixedLayoutTable} />
      </div>
    </div>
  );
}
