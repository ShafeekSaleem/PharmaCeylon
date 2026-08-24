"use client";

import { DataTable, type Column } from "@/components/ui/data-table";
import { StatusBadge, type BadgeVariant } from "@/components/ui/status-badge";
import { PaymentMethodIcon } from "./payment-method-icon";
import { formatMoney, formatPctTrend } from "../lib/format";
import css from "../reports.module.css";

export type ComparisonStatus = { label: string; tone: BadgeVariant };

export type ComparisonRow = {
  method: string;
  transactions: number;
  netRevenue: number;
  avgTicket: number;
  refunds: number;
  refundRate: number;
  growth: number | null;
  status: ComparisonStatus;
};

type Props = {
  rows: ComparisonRow[];
  loading?: boolean;
};

/** Payment Method Comparison answers "which channel performs well or has issues" — operational
 * health (transactions, net revenue, refunds, growth, status), deliberately not a revenue-share
 * column (the KPI row's Cash/Card/Digital Share tiles already own that number). */
export function PaymentMethodComparisonTable({ rows, loading }: Props) {
  const columns: Column<ComparisonRow>[] = [
    { key: "method", header: "Method", render: (r) => <PaymentMethodIcon method={r.method} /> },
    { key: "transactions", header: "Transactions", align: "right", sortable: true, getValue: (r) => r.transactions, render: (r) => r.transactions.toLocaleString("en-IN") },
    { key: "netRevenue", header: "Net Revenue", align: "right", sortable: true, getValue: (r) => r.netRevenue, render: (r) => formatMoney(r.netRevenue) },
    { key: "avgTicket", header: "Avg Ticket", align: "right", sortable: true, getValue: (r) => r.avgTicket, render: (r) => formatMoney(r.avgTicket) },
    { key: "refunds", header: "Refunds", align: "right", sortable: true, getValue: (r) => r.refunds, render: (r) => <span className={css.mutedcell}>{formatMoney(r.refunds)}</span> },
    { key: "refundRate", header: "Refund Rate", align: "right", sortable: true, getValue: (r) => r.refundRate, render: (r) => `${r.refundRate.toFixed(1)}%` },
    {
      key: "growth",
      header: "Growth",
      align: "right",
      sortable: true,
      getValue: (r) => r.growth ?? 0,
      render: (r) => (r.growth == null ? "—" : <span className={r.growth >= 0 ? css.deltaUp : css.deltaDown}>{formatPctTrend(r.growth)}</span>),
    },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status.tone} variant={r.status.tone} label={r.status.label} /> },
  ];

  return (
    <>
      <DataTable columns={columns} data={rows} rowKey={(r) => r.method} loading={loading} pageSize={10} emptyTitle="No payments in this range" compact />
      <p className={css.tableFootnote}>Net revenue = Gross revenue − Refunds</p>
    </>
  );
}
