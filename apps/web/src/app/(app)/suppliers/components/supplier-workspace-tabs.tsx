"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DataTable, StatusBadge, type Column } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import type { DeliveryRow, PurchaseOrderListItem } from "../../purchasing/types";
import type { DebitNoteRow, InvoiceRow, PaymentRow } from "../../purchasing/ledger-types";
import { formatDate, formatMoney, purchasingPoHref } from "../utils";
import scss from "../suppliers.module.css";

/** Load a list for a tab once it opens; a failed list reads as empty rather than breaking the window. */
function useList<T>(path: string | null, refreshKey = 0): { rows: T[]; loading: boolean } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) {
      setRows([]);
      return;
    }
    let live = true;
    setLoading(true);
    apiJson<T[] | { data?: T[]; rows?: T[]; items?: T[] }>(path)
      .then((body) => {
        if (!live) return;
        setRows(Array.isArray(body) ? body : (body.data ?? body.rows ?? body.items ?? []));
      })
      .catch(() => live && setRows([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, refreshKey]);
  return { rows, loading };
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={scss.detailSection}>
      <div className={scss.detailSectionHeader}>
        <h3 className={scss.detailSectionTitle}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** This supplier's orders and the deliveries against them. */
export function SupplierOrdersTab({ supplierId }: { supplierId: string }) {
  const orders = useList<PurchaseOrderListItem>("/purchasing/purchase-orders");
  const deliveries = useList<DeliveryRow>(`/purchasing/deliveries?supplierId=${supplierId}`);
  const mine = orders.rows.filter((po) => po.supplier?.id === supplierId);

  const orderColumns: Column<PurchaseOrderListItem>[] = [
    {
      key: "po",
      header: "Order",
      render: (po) => (
        <Link href={purchasingPoHref(po.id)} className={scss.poLink}>
          {po.poNumber}
        </Link>
      ),
    },
    { key: "status", header: "Status", render: (po) => <StatusBadge status={po.status} /> },
    { key: "created", header: "Raised", render: (po) => formatDate(po.createdAt) },
    { key: "expected", header: "Expected", render: (po) => (po.expectedOn ? formatDate(po.expectedOn) : "—") },
  ];
  const deliveryColumns: Column<DeliveryRow>[] = [
    { key: "grn", header: "Delivery", render: (row) => row.grnNumber },
    { key: "on", header: "Received", render: (row) => formatDate(row.receivedOn) },
    {
      key: "po",
      header: "Order",
      render: (row) => (
        <Link href={purchasingPoHref(row.purchaseOrder.id)} className={scss.poLink}>
          {row.purchaseOrder.poNumber}
        </Link>
      ),
    },
    { key: "units", header: "Units", align: "right", render: (row) => row.paidUnits },
  ];

  return (
    <>
      <Section title="Orders">
        <DataTable
          columns={orderColumns}
          data={mine}
          rowKey={(po) => po.id}
          loading={orders.loading}
          pageSize={8}
          compact
          emptyTitle="No orders with this supplier yet"
        />
      </Section>
      <Section title="Deliveries">
        <DataTable
          columns={deliveryColumns}
          data={deliveries.rows}
          rowKey={(row) => row.id}
          loading={deliveries.loading}
          pageSize={8}
          compact
          emptyTitle="Nothing delivered yet"
        />
      </Section>
    </>
  );
}

type MoneyProps = {
  supplierId: string;
  canInvoice: boolean;
  canPay: boolean;
  refreshKey: number;
  onPay: (invoiceId?: string) => void;
  onRecordInvoice: () => void;
};

/**
 * Invoices, payments and credits for one supplier — the same ledger as Purchasing → Invoices,
 * filtered to them. An invoice typed in without any delivery is flagged, because it skipped the
 * three-way match.
 */
export function SupplierMoneyTab({ supplierId, canInvoice, canPay, refreshKey, onPay, onRecordInvoice }: MoneyProps) {
  const invoices = useList<InvoiceRow>(
    canInvoice || canPay ? `/purchasing/invoices?supplierId=${supplierId}` : null,
    refreshKey,
  );
  const payments = useList<PaymentRow>(canInvoice ? `/purchasing/payments?supplierId=${supplierId}` : null, refreshKey);
  const credits = useList<DebitNoteRow>(canPay ? `/purchasing/debit-notes?supplierId=${supplierId}` : null, refreshKey);

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: "number",
      header: "Invoice",
      render: (inv) => (
        <div>
          <div>{inv.source === "system" ? "Awaiting invoice" : inv.invoiceNumber}</div>
          <div className={scss.supplierMeta}>
            {inv.deliveries.length > 0
              ? inv.deliveries.map((d) => d.grnNumber).join(", ")
              : inv.source === "supplier"
                ? <span className={scss.noDeliveryChip}>No delivery linked</span>
                : "—"}
          </div>
        </div>
      ),
    },
    {
      key: "due",
      header: "Due",
      render: (inv) => (
        <span className={inv.overdue ? scss.dueOverdue : undefined}>
          {formatDate(inv.dueDate)}
          {inv.overdue ? " · overdue" : ""}
        </span>
      ),
    },
    { key: "status", header: "Status", render: (inv) => <StatusBadge status={inv.status} /> },
    { key: "total", header: "Total", align: "right", render: (inv) => formatMoney(Number(inv.totalAmount)) },
    { key: "balance", header: "Balance", align: "right", render: (inv) => formatMoney(Number(inv.balance)) },
    {
      key: "pay",
      header: "",
      render: (inv) =>
        canPay && Number(inv.balance) > 0 && (inv.status === "open" || inv.status === "partial") ? (
          <button type="button" className={scss.payBtn} onClick={() => onPay(inv.id)}>
            Pay
          </button>
        ) : null,
    },
  ];
  const paymentColumns: Column<PaymentRow>[] = [
    { key: "no", header: "Payment", render: (p) => p.paymentNo },
    { key: "on", header: "Paid", render: (p) => formatDate(p.paidOn) },
    { key: "method", header: "Method", render: (p) => p.method.replace(/_/g, " ") },
    {
      key: "to",
      header: "Against",
      render: (p) => p.allocations.map((a) => a.invoiceNumber).join(", ") || "—",
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      render: (p) => (p.voided ? <s>{formatMoney(Number(p.amount))}</s> : formatMoney(Number(p.amount))),
    },
  ];
  const creditColumns: Column<DebitNoteRow>[] = [
    { key: "no", header: "Debit note", render: (n) => n.debitNo },
    { key: "return", header: "Return", render: (n) => n.goodsReturn?.returnNumber ?? "—" },
    { key: "status", header: "Status", render: (n) => <StatusBadge status={n.status} /> },
    { key: "left", header: "To apply", align: "right", render: (n) => formatMoney(Number(n.remaining)) },
  ];

  if (!canInvoice && !canPay) {
    return <p className={scss.supplierMeta}>Supplier money needs the invoice or payment permission.</p>;
  }
  return (
    <>
      <p className={scss.supplierMeta}>
        At the branch selected in the header — switch branch to see another&apos;s.
      </p>
      <Section
        title="Invoices"
        action={
          <span className={scss.sectionActions}>
            {canInvoice ? (
              <button type="button" className={scss.payBtn} onClick={onRecordInvoice}>
                Record invoice
              </button>
            ) : null}
            {canPay ? (
              <button type="button" className={scss.payBtn} onClick={() => onPay()}>
                Record payment
              </button>
            ) : null}
          </span>
        }
      >
        <DataTable
          columns={invoiceColumns}
          data={invoices.rows}
          rowKey={(inv) => inv.id}
          loading={invoices.loading}
          pageSize={8}
          compact
          emptyTitle="No invoices from this supplier"
        />
      </Section>
      {canInvoice ? (
        <Section title="Payments">
          <DataTable
            columns={paymentColumns}
            data={payments.rows}
            rowKey={(p) => p.id}
            loading={payments.loading}
            pageSize={8}
            compact
            emptyTitle="Nothing paid yet"
          />
        </Section>
      ) : null}
      {canPay ? (
        <Section title="Credits from returns">
          <DataTable
            columns={creditColumns}
            data={credits.rows}
            rowKey={(n) => n.id}
            loading={credits.loading}
            pageSize={8}
            compact
            emptyTitle="No debit notes"
          />
        </Section>
      ) : null}
    </>
  );
}

type SupplierReturnRow = {
  id: string;
  returnNumber: string;
  type: string;
  status: string;
  amount: string | number;
  createdAt: string;
  supplier: { id: string } | null;
  goodsReceipt: { grnNumber: string } | null;
  debitNote: { debitNo: string } | null;
};

/** Stock sent back to this supplier, and the credit each return raised. */
export function SupplierReturnsTab({ supplierId }: { supplierId: string }) {
  const all = useList<SupplierReturnRow>("/returns");
  const rows = all.rows.filter((r) => r.type === "supplier" && r.supplier?.id === supplierId);
  const columns: Column<SupplierReturnRow>[] = [
    {
      key: "no",
      header: "Return",
      render: (r) => (
        <Link href={`/purchasing/supplier-returns?return=${r.id}`} className={scss.poLink}>
          {r.returnNumber}
        </Link>
      ),
    },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    { key: "on", header: "Raised", render: (r) => formatDate(r.createdAt) },
    { key: "grn", header: "Delivery", render: (r) => r.goodsReceipt?.grnNumber ?? "—" },
    { key: "credit", header: "Debit note", render: (r) => r.debitNote?.debitNo ?? "—" },
    { key: "amount", header: "Value", align: "right", render: (r) => formatMoney(Number(r.amount)) },
  ];
  return (
    <Section
      title="Supplier returns"
      action={
        <Link href="/purchasing/supplier-returns" className={scss.payBtn}>
          New return
        </Link>
      }
    >
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        loading={all.loading}
        pageSize={8}
        compact
        emptyTitle="Nothing sent back to this supplier"
      />
    </Section>
  );
}
