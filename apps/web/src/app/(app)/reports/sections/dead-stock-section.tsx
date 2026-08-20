"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArchive, IconDollarSign, IconPill, IconRotateCcw, IconSearch, IconTag, IconTruck, IconX } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fetchDeadStock } from "../lib/fetchers";
import { daysBetween, formatMoney } from "../lib/format";
import { recommendDeadStockAction, type DeadStockAction } from "../lib/recommendations";
import { AgeingCards, type AgeBucket } from "../components/ageing-cards";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { InlineBarCell } from "../components/inline-bar-cell";
import { RowActionMenu } from "../components/row-action-menu";
import type { DeadStockItem, ExportPayload, OnExportData, Scope } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

type Row = DeadStockItem & { valueN: number; daysSinceLastSale: number | null; suggested: { key: DeadStockAction; label: string } };

const ACTION_BADGE: Record<DeadStockAction, string> = { transfer: "transfer", markdown: "markdown", discontinue: "discontinue" };

function buildAgeBuckets(rows: Row[], window: number): AgeBucket[] {
  const b1 = window;
  const b2 = Math.round(window * 1.33);
  const b3 = window * 2;
  const buckets: AgeBucket[] = [
    { key: "never", label: "Never sold", count: 0, value: 0 },
    { key: "b1", label: `${b1}–${b2 - 1} days`, count: 0, value: 0 },
    { key: "b2", label: `${b2}–${b3 - 1} days`, count: 0, value: 0 },
    { key: "b3", label: `${b3}+ days`, count: 0, value: 0 },
  ];
  for (const r of rows) {
    const idx = r.daysSinceLastSale == null ? 0 : r.daysSinceLastSale < b2 ? 1 : r.daysSinceLastSale < b3 ? 2 : 3;
    buckets[idx]!.count += 1;
    buckets[idx]!.value += r.valueN;
  }
  return buckets.filter((b) => b.count > 0);
}

export function DeadStockSection({ scope, isOwner, days, onExportData }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDeadStock(days, scope, isOwner)
      .then((resp) => {
        if (cancelled) return;
        const now = new Date();
        setRows(
          resp.items.map((item) => {
            const daysSinceLastSale = item.lastSoldAt ? daysBetween(new Date(item.lastSoldAt), now) : null;
            return { ...item, valueN: Number(item.value), daysSinceLastSale, suggested: recommendDeadStockAction(daysSinceLastSale, days) };
          }),
        );
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dead-stock data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const totalValue = rows.reduce((s, r) => s + r.valueN, 0);
  const totalUnits = rows.reduce((s, r) => s + r.qtyOnHand, 0);
  const buckets = useMemo(() => buildAgeBuckets(rows, days), [rows, days]);
  const knownIdleDays = rows.map((r) => r.daysSinceLastSale).filter((d): d is number => d != null);
  const avgIdleDays = knownIdleDays.length > 0 ? Math.round(knownIdleDays.reduce((s, d) => s + d, 0) / knownIdleDays.length) : null;

  const tableRows = useMemo(
    () => (search ? rows.filter((r) => (r.product.name ?? "").toLowerCase().includes(search.toLowerCase()) || (r.product.sku ?? "").toLowerCase().includes(search.toLowerCase())) : rows),
    [rows, search],
  );
  const maxValue = Math.max(...rows.map((r) => r.valueN), 1);

  useEffect(() => {
    if (tableRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `dead-stock-${days}d.csv`,
      headers: ["SKU", "Product", "Qty on hand", "Value tied up", "Idle days", "Last sale", "Suggested action"],
      rows: tableRows.map((r) => [r.product.sku ?? "", r.product.name ?? r.productId, r.qtyOnHand, r.valueN, r.daysSinceLastSale ?? "", r.daysSinceLastSale == null ? "Never sold" : `${r.daysSinceLastSale}d ago`, r.suggested.label]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [tableRows, days, onExportData]);

  const actionItems: ActionPanelItem[] = useMemo(() => {
    const groups: Record<DeadStockAction, { count: number }> = { transfer: { count: 0 }, markdown: { count: 0 }, discontinue: { count: 0 } };
    for (const r of rows) groups[r.suggested.key].count += 1;
    return [
      { key: "transfer", icon: <IconTruck size={16} />, tone: "primary" as const, title: "Transfer to another branch", description: "Move slow stock to where demand is higher.", count: groups.transfer.count, countLabel: "products" },
      { key: "markdown", icon: <IconTag size={16} />, tone: "warning" as const, title: "Apply markdown", description: "Run a discount or bundle to clear ageing stock.", count: groups.markdown.count, countLabel: "products" },
      { key: "discontinue", icon: <IconX size={16} />, tone: "muted" as const, title: "Discontinue reorder", description: "Never sold — reconsider restocking.", count: groups.discontinue.count, countLabel: "products" },
    ].filter((item) => item.count > 0);
  }, [rows]);

  const columns: Column<Row>[] = [
    { key: "idx", header: "#", render: (_r, i) => <span className={css.rowNum}>{i + 1}</span> },
    { key: "name", header: "Product", render: (r) => (
      <>
        {r.product.name ?? r.productId}
        <div className={css.mutedcell}>{r.product.sku}</div>
      </>
    ) },
    { key: "value", header: "Value Tied Up", align: "right", sortable: true, getValue: (r) => r.valueN, render: (r) => <InlineBarCell valueLabel={formatMoney(r.valueN)} pct={(r.valueN / maxValue) * 100} danger /> },
    { key: "qtyOnHand", header: "Qty", align: "right", sortable: true, getValue: (r) => r.qtyOnHand },
    { key: "idle", header: "Idle Days", align: "right", sortable: true, getValue: (r) => r.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER, render: (r) => (r.daysSinceLastSale == null ? "—" : r.daysSinceLastSale) },
    { key: "lastSale", header: "Last Sale", render: (r) => (r.daysSinceLastSale == null ? "Never sold" : `${r.daysSinceLastSale}d ago`) },
    { key: "suggested", header: "Suggested Action", render: (r) => <span className={`${css.badge2} ${css[ACTION_BADGE[r.suggested.key]]}`}>{r.suggested.label}</span> },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <RowActionMenu
          actions={[
            { label: "Transfer stock", href: `/transfers?productId=${r.productId}` },
            { label: "Create return", href: `/returns?productId=${r.productId}` },
            { label: "View in inventory", href: `/inventory?productId=${r.productId}` },
          ]}
        />
      ),
    },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={4} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Dead SKUs" value={loading ? "…" : rows.length} subtitle={`No sale in ${days}+ days`} icon={<IconArchive size={16} />} iconTone="warning" />
        <StatCard size="sm" showMenu={false} title="Units Tied Up" value={loading ? "…" : totalUnits.toLocaleString("en-IN")} subtitle="On hand, unsold" icon={<IconPill size={16} />} />
        <StatCard size="sm" showMenu={false} title="Capital Tied Up" value={loading ? "…" : formatMoney(totalValue)} subtitle="At cost price" icon={<IconDollarSign size={16} />} iconTone="danger" />
        <StatCard size="sm" showMenu={false} title="Avg. Days Idle" value={loading ? "…" : avgIdleDays ?? "—"} subtitle="Across dead SKUs" icon={<IconRotateCcw size={16} />} />
      </StatGrid>

      {buckets.length > 0 ? (
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Ageing Distribution</h3>
              <p>By cost value</p>
            </div>
          </div>
          <AgeingCards buckets={buckets} totalValue={totalValue} />
        </div>
      ) : null}

      <div className={css.grid2}>
        <div className={css.card}>
          <div className={css.toolbarrow}>
            <h3 style={{ margin: 0 }}>Top capital tied up</h3>
            <div className={css.searchbox}>
              <IconSearch size={14} />
              <input placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          <DataTable columns={columns} data={tableRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No dead stock in this window" compact />
        </div>

        <ActionsPanel
          title="Recommended actions & insights"
          items={actionItems}
          primaryAction={{ label: "Review transfers", icon: <IconTruck size={15} />, onClick: () => router.push("/transfers") }}
        />
      </div>
    </div>
  );
}
