"use client";

import { useEffect, useMemo, useState } from "react";
import { IconArchive, IconDollarSign, IconPill, IconSearch } from "@/components/icons";
import { StatGrid, StatCard } from "@/components/ui/stat-card";
import { DataTable, type Column } from "@/components/ui/data-table";
import { fetchStockValue } from "../lib/fetchers";
import { formatMoney } from "../lib/format";
import { BarRows, type BarRow } from "../components/bar-rows";
import type { ExportPayload, OnExportData, Scope, StockValueItem } from "../lib/types";
import css from "../reports.module.css";

type Props = { scope: Scope; isOwner: boolean; onExportData: OnExportData };

type Row = StockValueItem & { valueN: number; unitCost: number };

export function StockValueSection({ scope, isOwner, onExportData }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [totalValue, setTotalValue] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchStockValue(scope, isOwner)
      .then((resp) => {
        if (cancelled) return;
        setTotalValue(resp.totalValue);
        setRows(resp.items.map((it) => ({ ...it, valueN: Number(it.value), unitCost: it.qtyOnHand > 0 ? Number(it.value) / it.qtyOnHand : 0 })));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stock value");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, isOwner]);

  const totalUnits = rows.reduce((s, r) => s + r.qtyOnHand, 0);

  const tableRows = useMemo(
    () => (search ? rows.filter((r) => (r.product.name ?? "").toLowerCase().includes(search.toLowerCase()) || (r.product.sku ?? "").toLowerCase().includes(search.toLowerCase())) : rows),
    [rows, search],
  );

  useEffect(() => {
    if (tableRows.length === 0) {
      onExportData(null);
      return;
    }
    const payload: ExportPayload = {
      filename: "stock-value.csv",
      headers: ["SKU", "Product", "Qty on hand", "Avg unit cost", "Value"],
      rows: tableRows.map((r) => [r.product.sku ?? "", r.product.name ?? r.productId, r.qtyOnHand, r.unitCost.toFixed(2), r.valueN]),
    };
    onExportData(payload);
    return () => onExportData(null);
  }, [tableRows, onExportData]);

  const top10: BarRow[] = useMemo(
    () =>
      [...rows]
        .sort((a, b) => b.valueN - a.valueN)
        .slice(0, 10)
        .map((r) => ({ key: r.productId, label: r.product.name ?? r.productId, sublabel: r.product.sku, value: r.valueN, valueLabel: formatMoney(r.valueN), subValue: `${r.qtyOnHand.toLocaleString("en-IN")} units` })),
    [rows],
  );

  const columns: Column<Row>[] = [
    { key: "sku", header: "SKU", render: (r) => <span className={css.skucode}>{r.product.sku ?? "—"}</span> },
    { key: "name", header: "Product", render: (r) => r.product.name ?? r.productId },
    { key: "qtyOnHand", header: "Qty on hand", align: "right", sortable: true, getValue: (r) => r.qtyOnHand },
    { key: "unitCost", header: "Avg unit cost", align: "right", sortable: true, getValue: (r) => r.unitCost, render: (r) => <span className={css.mutedcell}>{formatMoney(r.unitCost)}</span> },
    { key: "value", header: "Value", align: "right", sortable: true, getValue: (r) => r.valueN, render: (r) => formatMoney(r.valueN) },
  ];

  if (error) return <div className={css.errorState}>{error}</div>;

  return (
    <div>
      <StatGrid columns={3} dense className={css.heroGrid}>
        <StatCard size="sm" showMenu={false} title="Total stock value" value={loading ? "…" : formatMoney(totalValue)} subtitle="At cost price" icon={<IconDollarSign size={16} />} />
        <StatCard size="sm" showMenu={false} title="SKUs in stock" value={loading ? "…" : rows.length} subtitle={scope === "tenant" ? "All branches" : "This branch"} icon={<IconArchive size={16} />} />
        <StatCard size="sm" showMenu={false} title="Units on hand" value={loading ? "…" : totalUnits.toLocaleString("en-IN")} subtitle="Across all SKUs" icon={<IconPill size={16} />} />
      </StatGrid>

      <div className={css.card}>
        <div className={css.cardhead}>
          <div>
            <h3>Top 10 by value</h3>
          </div>
        </div>
        <BarRows rows={top10} />
      </div>

      <div className={css.card}>
        <div className={css.toolbarrow}>
          <h3 style={{ margin: 0 }}>All stock</h3>
          <div className={css.searchbox}>
            <IconSearch size={14} />
            <input placeholder="Search product or SKU" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <DataTable columns={columns} data={tableRows} rowKey={(r) => r.productId} loading={loading} pageSize={10} emptyTitle="No stock on hand" compact />
      </div>
    </div>
  );
}
