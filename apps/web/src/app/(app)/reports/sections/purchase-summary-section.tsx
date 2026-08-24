"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconClipboardList, IconDollarSign, IconEye, IconShoppingCart, IconTruck } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { BarRows, type BarRow } from "../components/bar-rows";
import { MultiLineChart } from "../components/multi-line-chart";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { fetchPurchaseSummary } from "../lib/fetchers";
import { formatCompactMoney, formatMoney, formatPctTrend, pctChange } from "../lib/format";
import type { ExportPayload, OnExportData, PurchaseOrderRow, PurchaseSummaryResponse, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const STATUS_TONE: Record<string, string> = {
  draft: "monitor",
  pending_approval: "watch",
  issued: "watch",
  partially_received: "watch",
  received: "healthy",
  short_closed: "slowMoving",
  cancelled: "deadSlow",
};
const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending",
  issued: "Issued",
  partially_received: "Partial",
  received: "Received",
  short_closed: "Short Closed",
  cancelled: "Cancelled",
};

/** What are we buying, how much are we spending, and are we purchasing efficiently? Evolves from
 *  nothing (Purchasing was entirely "Coming Soon") — spends value stays at pre-tax/discount unit
 *  cost throughout, the same cost-basis convention every Inventory report already uses. */
export function PurchaseSummarySection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<PurchaseSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedStatus(null);
    fetchPurchaseSummary(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load purchase summary data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const trendLabels = useMemo(() => (data?.trend ?? []).map((p) => p.label), [data]);
  const orderedSeries = useMemo(() => (data?.trend ?? []).map((p) => p.orderedValue), [data]);
  const receivedSeries = useMemo(() => (data?.trend ?? []).map((p) => p.receivedValue), [data]);

  const lifecycleRows: BarRow[] = useMemo(
    () =>
      (data?.lifecycle ?? [])
        .filter((l) => l.count > 0)
        .map((l) => ({ key: l.status, label: STATUS_LABEL[l.status] ?? l.status, value: l.count, valueLabel: `${l.count} PO${l.count === 1 ? "" : "s"}`, subValue: formatMoney(l.value) })),
    [data],
  );

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleStatus(status: string) {
    setSelectedStatus((cur) => (cur === status ? null : status));
  }

  const insightItems: ActionPanelItem[] = useMemo(
    () =>
      (data?.insights ?? []).map((i) => ({
        key: i.key,
        icon: i.key === "overstockPurchaseRisk" ? <IconAlertTriangle size={16} /> : <IconClipboardList size={16} />,
        tone: "warning" as const,
        title: i.title,
        description: i.description,
        count: 0,
        countLabel: "",
        countText: i.countLabel,
        onClick: () => scrollTo("purchase-orders"),
        examples: [{ label: "Impact", badge: i.countLabel, tone: "negative" as const }],
      })),
    [data],
  );

  const filteredOrders = useMemo(
    () => (selectedStatus ? (data?.orders ?? []).filter((r) => r.status === selectedStatus) : (data?.orders ?? [])),
    [data, selectedStatus],
  );
  const statusFilterPills: FilterPill[] = selectedStatus ? [{ key: "status", label: STATUS_LABEL[selectedStatus] ?? selectedStatus }] : [];

  const orderColumns: Column<PurchaseOrderRow>[] = [
    { key: "poNumber", header: "PO #", width: "6rem" },
    { key: "supplier", header: "Supplier", width: "7rem", render: (r) => r.supplierName },
    { key: "branch", header: "Branch", width: "6rem", render: (r) => r.branchName },
    { key: "createdAt", header: "Ordered", width: "5rem", sortable: true, getValue: (r) => r.createdAt, render: (r) => new Date(r.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) },
    { key: "ordered", header: "Ordered Value", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.orderedValue, render: (r) => formatMoney(r.orderedValue) },
    { key: "received", header: "Received Value", align: "right", width: "6.5rem", sortable: true, getValue: (r) => r.receivedValue, render: (r) => formatMoney(r.receivedValue) },
    { key: "fill", header: "Fill %", align: "right", width: "3.5rem", sortable: true, getValue: (r) => r.fillPct ?? -1, render: (r) => (r.fillPct == null ? "—" : `${r.fillPct.toFixed(0)}%`) },
    {
      key: "status",
      header: "Status",
      width: "5.5rem",
      render: (r) => (
        <span className={css.actionCell}>
          <span className={`${css.badge2} ${css.badge2Tight} ${css[STATUS_TONE[r.status] ?? "monitor"]}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
          <Link className={css.rowIconBtn} href={`/purchasing?po=${r.id}`} data-tooltip="View PO" aria-label="View PO">
            <IconEye size={12} />
          </Link>
        </span>
      ),
    },
  ];

  useEffect(() => {
    if (!data || data.orders.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `purchase-summary-${days}d.csv`,
      headers: ["PO #", "Supplier", "Branch", "Ordered Date", "Ordered Value", "Received Value", "Fill %", "Status"],
      rows: data.orders.map((r) => [r.poNumber, r.supplierName, r.branchName, r.createdAt, r.orderedValue, r.receivedValue, r.fillPct ?? "", STATUS_LABEL[r.status] ?? r.status]),
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
          title="Purchase Spend"
          value={loading || !kpis ? "…" : formatMoney(kpis.purchaseSpend)}
          subtitle="Ordered value, at cost"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && kpis && kpis.prevPurchaseSpend > 0 ? { value: formatPctTrend(pctChange(kpis.purchaseSpend, kpis.prevPurchaseSpend)), direction: kpis.purchaseSpend >= kpis.prevPurchaseSpend ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="POs Raised"
          value={loading || !kpis ? "…" : kpis.posRaised.toLocaleString("en-IN")}
          subtitle="vs previous period"
          icon={<IconShoppingCart size={16} />}
          iconTone="primary"
          trend={!loading && kpis && kpis.prevPosRaised > 0 ? { value: formatPctTrend(pctChange(kpis.posRaised, kpis.prevPosRaised)), direction: kpis.posRaised >= kpis.prevPosRaised ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Received Value"
          value={loading || !kpis ? "…" : formatMoney(kpis.receivedValue)}
          subtitle="Of this period's POs"
          icon={<IconTruck size={16} />}
          iconTone="success"
          trend={!loading && kpis && kpis.prevReceivedValue > 0 ? { value: formatPctTrend(pctChange(kpis.receivedValue, kpis.prevReceivedValue)), direction: kpis.receivedValue >= kpis.prevReceivedValue ? "up" : "down", tone: "positive" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Open Commitments"
          value={loading || !kpis ? "…" : formatMoney(kpis.openCommitments)}
          subtitle="Outstanding across all open POs"
          icon={<IconClipboardList size={16} />}
          iconTone="warning"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={`${css.card} ${css.cardFlexCol}`}>
          <div className={css.cardhead}>
            <div>
              <h3>Purchases vs Receipts</h3>
              <p>Ordered value vs. received value, weekly</p>
            </div>
          </div>
          <div className={css.heatmapGrow}>
            {trendLabels.length === 0 ? (
              <p className={css.emptyNote}>No purchase orders in this range yet.</p>
            ) : (
              <MultiLineChart
                labels={trendLabels}
                series={[
                  { key: "ordered", label: "Ordered", color: "#0284c7", values: orderedSeries },
                  { key: "received", label: "Received", color: "#16a34a", values: receivedSeries },
                ]}
                formatValue={formatCompactMoney}
                tooltipFormat={formatMoney}
              />
            )}
          </div>
        </div>

        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>PO Lifecycle</h3>
              <p>Where this period&apos;s orders stand</p>
            </div>
          </div>
          <BarRows rows={lifecycleRows} pageSize={7} onRowClick={toggleStatus} activeKey={selectedStatus} />
        </div>
      </div>

      <div className={`${css.grid2TwoOne} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="purchase-orders">
          <div className={css.cardhead}>
            <div>
              <h3>Purchase Orders</h3>
              <p>Every PO raised in this range</p>
            </div>
          </div>
          {selectedStatus ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by status · ${filteredOrders.length} PO${filteredOrders.length === 1 ? "" : "s"}`}
                pills={statusFilterPills}
                onClear={() => setSelectedStatus(null)}
                clearTooltip="Show all statuses"
              />
            </div>
          ) : null}
          <DataTable columns={orderColumns} data={filteredOrders} rowKey={(r) => r.id} loading={loading} pageSize={8} emptyTitle="No purchase orders in this range" compact className={css.fixedLayoutTable} />
        </div>

        <ActionsPanel title="Purchase Exceptions" items={insightItems} variant="cards" pageSize={4} />
      </div>
    </div>
  );
}
