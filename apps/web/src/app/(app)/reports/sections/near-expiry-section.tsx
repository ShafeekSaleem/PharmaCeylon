"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconAlertTriangle, IconArchive, IconEye, IconTag, IconTrash, IconTruck } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge } from "@/components/ui/status-badge";
import { fetchNearExpiry } from "../lib/fetchers";
import { formatDate, formatMoney } from "../lib/format";
import { recommendExpiryAction, type ExpiryRecommendation } from "../lib/recommendations";
import { SeverityCards, type SeveritySummary } from "../components/severity-cards";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { RowActionMenu } from "../components/row-action-menu";
import type { ExportPayload, ExpiryTier, NearExpiryItem, OnExportData } from "../lib/types";
import css from "../reports.module.css";

type Props = { branchId: string | null; withinDays: number; onExportData: OnExportData };

type Row = NearExpiryItem & { daysLeft: number; tier: ExpiryTier; recommendation: { key: ExpiryRecommendation; label: string } };

function tierOf(daysLeft: number): ExpiryTier {
  if (daysLeft <= 30) return "critical";
  if (daysLeft <= 60) return "watch";
  return "notice";
}

const TIER_STATUS: Record<ExpiryTier, "danger" | "warning" | "success"> = { critical: "danger", watch: "warning", notice: "success" };
const TIER_LABEL: Record<ExpiryTier, string> = { critical: "Critical", watch: "Watch", notice: "Upcoming" };
const REC_BADGE: Record<ExpiryRecommendation, string> = { dispose: "dispose", transfer: "transfer", discount: "discount", monitor: "monitor" };

export function NearExpirySection({ branchId, withinDays, onExportData }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId) {
      setRows([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNearExpiry(withinDays)
      .then((resp) => {
        if (cancelled) return;
        const today = new Date();
        const withTier = resp.items.map((item) => {
          const daysLeft = Math.round((new Date(item.expiryDate).getTime() - today.getTime()) / 86_400_000);
          const valueAtRisk = Number(item.valueAtRisk);
          return { ...item, daysLeft, tier: tierOf(daysLeft), recommendation: recommendExpiryAction(daysLeft, valueAtRisk) };
        });
        withTier.sort((a, b) => a.daysLeft - b.daysLeft);
        setRows(withTier);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load near-expiry data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [branchId, withinDays]);

  useEffect(() => {
    if (rows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `near-expiry-${withinDays}d.csv`,
      headers: ["Batch", "SKU", "Product", "Expiry date", "Days left", "Qty on hand", "Value at risk", "Recommendation", "Status"],
      rows: rows.map((r) => [r.batchNo, r.product.sku, r.product.name, formatDate(r.expiryDate), r.daysLeft, r.qtyOnHand, r.valueAtRisk, r.recommendation.label, TIER_LABEL[r.tier]]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [rows, withinDays, onExportData]);

  const summary: SeveritySummary = useMemo(() => {
    const base: SeveritySummary = { critical: { count: 0, value: 0 }, watch: { count: 0, value: 0 }, notice: { count: 0, value: 0 } };
    for (const r of rows) {
      base[r.tier].count += 1;
      base[r.tier].value += Number(r.valueAtRisk);
    }
    return base;
  }, [rows]);

  const totalValue = rows.reduce((s, r) => s + Number(r.valueAtRisk), 0);
  const totalUnits = rows.reduce((s, r) => s + r.qtyOnHand, 0);

  const actionItems: ActionPanelItem[] = useMemo(() => {
    const groups: Record<ExpiryRecommendation, { count: number; value: number }> = {
      dispose: { count: 0, value: 0 },
      transfer: { count: 0, value: 0 },
      discount: { count: 0, value: 0 },
      monitor: { count: 0, value: 0 },
    };
    for (const r of rows) {
      groups[r.recommendation.key].count += 1;
      groups[r.recommendation.key].value += Number(r.valueAtRisk);
    }
    return [
      { key: "dispose", icon: <IconTrash size={16} />, tone: "danger" as const, title: "Dispose / write off", description: "Already past expiry — can no longer be sold.", count: groups.dispose.count, countLabel: "batches" },
      { key: "transfer", icon: <IconTruck size={16} />, tone: "primary" as const, title: "Transfer to another branch", description: "Move stock before it's stranded.", count: groups.transfer.count, countLabel: "batches" },
      { key: "discount", icon: <IconTag size={16} />, tone: "warning" as const, title: "Discount / promote", description: "Clear stock that's too close to expiry to move.", count: groups.discount.count, countLabel: "batches" },
      { key: "monitor", icon: <IconEye size={16} />, tone: "muted" as const, title: "Monitor", description: "Still time — keep an eye on these.", count: groups.monitor.count, countLabel: "batches" },
    ].filter((item) => item.count > 0);
  }, [rows]);

  const columns: Column<Row>[] = [
    {
      key: "product",
      header: "Product / Batch",
      width: "13rem",
      render: (r) => (
        <>
          <div style={{ whiteSpace: "normal" }}>{r.product.name}</div>
          <span className={css.skucode}>{r.batchNo}</span>
        </>
      ),
    },
    { key: "expiryDate", header: "Expiry date", sortable: true, getValue: (r) => r.expiryDate, render: (r) => formatDate(r.expiryDate) },
    {
      key: "daysLeft",
      header: "Days left",
      align: "right",
      sortable: true,
      getValue: (r) => r.daysLeft,
      render: (r) => (r.daysLeft < 0 ? `Expired ${Math.abs(r.daysLeft)}d ago` : r.daysLeft === 0 ? "Expires today" : String(r.daysLeft)),
    },
    { key: "qtyOnHand", header: "Qty on hand", align: "right", sortable: true, getValue: (r) => r.qtyOnHand },
    { key: "valueAtRisk", header: "Value at risk", align: "right", sortable: true, getValue: (r) => Number(r.valueAtRisk), render: (r) => formatMoney(r.valueAtRisk) },
    { key: "recommendation", header: "Recommendation", render: (r) => <span className={`${css.badge2} ${css[REC_BADGE[r.recommendation.key]]}`}>{r.recommendation.label}</span> },
    { key: "tier", header: "Status", render: (r) => <StatusBadge status={r.tier} variant={TIER_STATUS[r.tier]} label={TIER_LABEL[r.tier]} dot /> },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <RowActionMenu
          actions={[
            { label: "Transfer stock", href: `/transfers?productId=${r.product.id}` },
            { label: "Create return", href: `/returns?productId=${r.product.id}` },
            { label: "View in inventory", href: `/inventory?productId=${r.product.id}` },
          ]}
        />
      ),
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;
  if (!branchId) {
    return <p className={css.emptyNote}>Select a branch to see its near-expiry stock — this report is always branch-specific.</p>;
  }

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Batches Expiring" value={loading ? "…" : rows.length} subtitle={`Within ${withinDays} days`} icon={<IconArchive size={16} />} />
        <StatCard size="sm" showMenu={false} title="Units Affected" value={loading ? "…" : totalUnits.toLocaleString("en-IN")} subtitle="On hand across batches" icon={<IconArchive size={16} />} iconTone="warning" />
        <StatCard size="sm" showMenu={false} title="Value at Risk" value={loading ? "…" : formatMoney(totalValue)} subtitle="At cost price" icon={<IconAlertTriangle size={16} />} iconTone="danger" />
        <StatCard size="sm" showMenu={false} title="Critical (≤30 days)" value={loading ? "…" : summary.critical.count} subtitle="Needs action this week" icon={<IconAlertTriangle size={16} />} iconTone="danger" />
      </StatGrid>

      <SeverityCards summary={summary} onViewCritical={() => document.getElementById("expiring-batches-table")?.scrollIntoView({ behavior: "smooth" })} />

      <div className={css.grid2} style={{ marginTop: "0.85rem" }}>
        <div className={css.card} id="expiring-batches-table">
          <div className={css.cardhead}>
            <div>
              <h3>Expiring batches requiring action</h3>
              <p>Sorted by urgency, soonest expiry first</p>
            </div>
          </div>
          <DataTable columns={columns} data={rows} rowKey={(r) => r.batchId} loading={loading} pageSize={6} emptyTitle="No batches expiring in this window" compact />
        </div>

        <ActionsPanel
          title="Top actions this week"
          items={actionItems}
          primaryAction={{ label: "Create transfer request", icon: <IconTruck size={15} />, onClick: () => router.push("/transfers") }}
        />
      </div>
    </div>
  );
}
