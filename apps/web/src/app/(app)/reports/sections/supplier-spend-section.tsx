"use client";

import { useEffect, useMemo, useState } from "react";
import { IconClipboardList, IconDollarSign, IconTarget, IconUsers } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { ActiveFilterBanner, type FilterPill } from "@/components/ui";
import { BarRows, type BarRow } from "../components/bar-rows";
import { CategorySupplierMatrix } from "../components/category-supplier-matrix";
import { ActionsPanel, type ActionPanelItem } from "../components/actions-panel";
import { fetchSupplierSpend } from "../lib/fetchers";
import { formatMoney, formatPctTrend, pctChange } from "../lib/format";
import type { ExportPayload, OnExportData, Scope, SupplierSpendResponse, SupplierSpendRow } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; days: number; onExportData: OnExportData };

const STATUS_TONE: Record<string, string> = { active: "healthy", on_hold: "watch", inactive: "deadSlow" };
const STATUS_LABEL: Record<string, string> = { active: "Active", on_hold: "On Hold", inactive: "Inactive" };

/** Where is procurement spend concentrated? Ranking + Pareto concentration + a category×supplier
 *  dependency matrix, all from the same period's ordered-value data. */
export function SupplierSpendSection({ scope, isOwner, days, onExportData }: Props) {
  const [data, setData] = useState<SupplierSpendResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedSupplierId(null);
    fetchSupplierSpend(days, scope, isOwner)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load supplier spend data");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, scope, isOwner]);

  const rankingRows: BarRow[] = useMemo(
    () =>
      (data?.ranking ?? []).map((r) => ({
        key: r.supplierId,
        label: r.supplierName,
        sublabel: `${r.poCount} PO${r.poCount === 1 ? "" : "s"} · cumulative ${r.cumulativePct.toFixed(0)}%`,
        value: r.spend,
        valueLabel: formatMoney(r.spend),
        subValue: `${r.sharePct.toFixed(1)}%`,
      })),
    [data],
  );

  function scrollTo(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  }
  function toggleSupplier(supplierId: string) {
    setSelectedSupplierId((cur) => (cur === supplierId ? null : supplierId));
  }

  const insightItems: ActionPanelItem[] = useMemo(
    () =>
      (data?.insights ?? []).map((i) => ({
        key: i.key,
        icon: i.key === "categoryDependency" ? <IconTarget size={16} /> : <IconClipboardList size={16} />,
        tone: i.key === "categoryDependency" ? ("danger" as const) : ("primary" as const),
        title: i.title,
        description: i.description,
        count: 0,
        countLabel: "",
        countText: i.countLabel,
        onClick: () => scrollTo(i.key === "categoryDependency" ? "supplier-dependency-matrix" : "supplier-spend-table"),
        examples: [{ label: "Impact", badge: i.countLabel, tone: "negative" as const }],
      })),
    [data],
  );

  const filteredSpendRows = useMemo(
    () => (selectedSupplierId ? (data?.ranking ?? []).filter((r) => r.supplierId === selectedSupplierId) : (data?.ranking ?? [])),
    [data, selectedSupplierId],
  );
  const selectedSupplierName = selectedSupplierId ? (data?.ranking ?? []).find((r) => r.supplierId === selectedSupplierId)?.supplierName : undefined;
  const supplierFilterPills: FilterPill[] = selectedSupplierName ? [{ key: "supplier", label: selectedSupplierName }] : [];

  const spendColumns: Column<SupplierSpendRow>[] = [
    { key: "supplier", header: "Supplier", width: "8rem", render: (r) => r.supplierName },
    { key: "spend", header: "Spend", align: "right", width: "5.5rem", sortable: true, getValue: (r) => r.spend, render: (r) => formatMoney(r.spend) },
    { key: "share", header: "Share %", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.sharePct, render: (r) => `${r.sharePct.toFixed(1)}%` },
    { key: "pos", header: "POs", align: "right", width: "3.5rem", sortable: true, getValue: (r) => r.poCount, render: (r) => r.poCount.toLocaleString("en-IN") },
    { key: "avgPo", header: "Avg PO", align: "right", width: "5rem", sortable: true, getValue: (r) => r.avgPoValue, render: (r) => formatMoney(r.avgPoValue) },
    { key: "categories", header: "Categories", align: "right", width: "4.5rem", sortable: true, getValue: (r) => r.categoriesSupplied, render: (r) => r.categoriesSupplied.toLocaleString("en-IN") },
    { key: "status", header: "Status", width: "4.5rem", render: (r) => <span className={`${css.badge2} ${css.badge2Tight} ${css[STATUS_TONE[r.status] ?? "healthy"]}`}>{STATUS_LABEL[r.status] ?? r.status}</span> },
  ];

  useEffect(() => {
    if (!data || data.ranking.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: `supplier-spend-${days}d.csv`,
      headers: ["Supplier", "Spend", "Share %", "Cumulative %", "POs", "Avg PO Value", "Categories Supplied", "Status"],
      rows: data.ranking.map((r) => [r.supplierName, r.spend, r.sharePct.toFixed(1), r.cumulativePct.toFixed(1), r.poCount, r.avgPoValue, r.categoriesSupplied, STATUS_LABEL[r.status] ?? r.status]),
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
          title="Total Supplier Spend"
          value={loading || !kpis ? "…" : formatMoney(kpis.totalSpend)}
          subtitle="vs previous period"
          icon={<IconDollarSign size={16} />}
          iconTone="info"
          trend={!loading && kpis && kpis.prevTotalSpend > 0 ? { value: formatPctTrend(pctChange(kpis.totalSpend, kpis.prevTotalSpend)), direction: kpis.totalSpend >= kpis.prevTotalSpend ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Active Suppliers"
          value={loading || !kpis ? "…" : kpis.activeSuppliers.toLocaleString("en-IN")}
          subtitle="With spend this period"
          icon={<IconUsers size={16} />}
          iconTone="primary"
          trend={!loading && kpis && kpis.prevActiveSuppliers > 0 ? { value: formatPctTrend(pctChange(kpis.activeSuppliers, kpis.prevActiveSuppliers)), direction: kpis.activeSuppliers >= kpis.prevActiveSuppliers ? "up" : "down", tone: "neutral" } : undefined}
        />
        <StatCard size="sm" showMenu={false}
          title="Top Supplier Share"
          value={loading || !kpis || kpis.topSupplierSharePct == null ? "—" : `${kpis.topSupplierSharePct.toFixed(1)}%`}
          subtitle="Of total spend"
          icon={<IconTarget size={16} />}
          iconTone="warning"
        />
        <StatCard size="sm" showMenu={false}
          title="Avg PO Value"
          value={loading || !kpis || kpis.avgPoValue == null ? "—" : formatMoney(kpis.avgPoValue)}
          subtitle="Across all POs this period"
          icon={<IconClipboardList size={16} />}
          iconTone="success"
        />
      </StatGrid>

      <div className={`${css.grid2} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card}>
          <div className={css.cardhead}>
            <div>
              <h3>Supplier Spend Ranking</h3>
              <p>Ranked by spend, highest first</p>
            </div>
          </div>
          <BarRows rows={rankingRows} pageSize={8} onRowClick={toggleSupplier} activeKey={selectedSupplierId} />
        </div>

        <ActionsPanel title="Spend Insights" items={insightItems} variant="cards" pageSize={4} />
      </div>

      <div className={`${css.grid2Even} ${css.firstRow} ${css.snugFirstRow}`}>
        <div className={css.card} id="supplier-dependency-matrix">
          <div className={css.cardhead}>
            <div>
              <h3>Category × Supplier Dependency</h3>
              <p>Share of each category&apos;s spend held by its top suppliers</p>
            </div>
          </div>
          <CategorySupplierMatrix
            rows={data?.dependencyMatrix ?? []}
            suppliers={data?.dependencySuppliers ?? []}
            formatValue={formatMoney}
            onSupplierClick={toggleSupplier}
            activeSupplierId={selectedSupplierId}
          />
        </div>

        <div className={css.card} id="supplier-spend-table">
          <div className={css.cardhead}>
            <div>
              <h3>Supplier Spend Detail</h3>
              <p>Every supplier with activity this period</p>
            </div>
          </div>
          {selectedSupplierName ? (
            <div className={css.activeFilterSlot}>
              <ActiveFilterBanner
                active
                summary={`Filtered by supplier · ${filteredSpendRows.length} row${filteredSpendRows.length === 1 ? "" : "s"}`}
                pills={supplierFilterPills}
                onClear={() => setSelectedSupplierId(null)}
                clearTooltip="Show all suppliers"
              />
            </div>
          ) : null}
          <DataTable columns={spendColumns} data={filteredSpendRows} rowKey={(r) => r.supplierId} loading={loading} pageSize={8} emptyTitle="No supplier spend in this range" compact className={css.fixedLayoutTable} />
        </div>
      </div>
    </div>
  );
}
