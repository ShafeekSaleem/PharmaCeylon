"use client";

import { Suspense, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import {
  IconAlertTriangle,
  IconClipboardList,
  IconDollarSign,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTruck,
} from "@/components/icons";
import {
  ActionButton,
  ActiveFilterBanner,
  DataTable,
  DateRangeField,
  PageHeader,
  SegmentedTabs,
  StatCard,
  StatusBadge,
  type Column,
  type FilterPill,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { InventoryFilterSelect } from "../../inventory/components/inventory-filter-select";
import { InvoiceSheet } from "../components/invoice-sheet";
import { PurchasingSubnav } from "../components/purchasing-subnav";
import { RecordInvoiceModal } from "../components/record-invoice-modal";
import { RecordPaymentModal } from "../components/record-payment-modal";
import { useDebitNotes, useInvoices, usePayables, usePayments } from "../hooks/use-ledger";
import { usePurchasingAccess } from "../hooks/use-purchasing-access";
import { useSuppliers } from "../hooks/use-suppliers";
import {
  paymentMethodLabel,
  type DebitNoteRow,
  type InvoiceRow,
  type PaymentRow,
} from "../ledger-types";
import css from "../purchasing.module.css";
import { formatDate, formatMoney } from "../utils";

type View = "invoices" | "payments" | "debit-notes";
type Tile = "all" | "outstanding" | "overdue" | "awaiting";

const STATUS_OPTIONS = [
  { value: "all", label: "All but voided" },
  { value: "outstanding", label: "Outstanding" },
  { value: "overdue", label: "Overdue" },
  { value: "open", label: "Open" },
  { value: "partial", label: "Part paid" },
  { value: "paid", label: "Paid" },
  { value: "voided", label: "Voided" },
];

function InvoicesContent() {
  const access = usePurchasingAccess();
  const suppliers = useSuppliers();
  const [view, setView] = useState<View>("invoices");
  const [tile, setTile] = useState<Tile>("outstanding");
  const [status, setStatus] = useState("outstanding");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [openInvoice, setOpenInvoice] = useState<string | null>(null);
  const [recordInvoice, setRecordInvoice] = useState<{ supplierId?: string; receiptId?: string } | null>(null);
  const [recordPayment, setRecordPayment] = useState<{ supplierId?: string; invoiceId?: string } | null>(null);
  const [voidPayment, setVoidPayment] = useState<PaymentRow | null>(null);
  const [applyNote, setApplyNote] = useState<DebitNoteRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const supplierId = supplierFilter === "all" ? undefined : supplierFilter;
  const allowed = access.canInvoice || access.canPay;
  const invoices = useInvoices(
    {
      supplierId,
      status,
      source: tile === "awaiting" ? "system" : undefined,
      from: dateFrom || undefined,
      to: dateTo || undefined,
      q: search,
    },
    allowed && view === "invoices",
  );
  const payments = usePayments(
    { supplierId, from: dateFrom || undefined, to: dateTo || undefined },
    allowed && view === "payments",
  );
  const debitNotes = useDebitNotes({ supplierId }, allowed && view === "debit-notes");
  const payables = usePayables(allowed);

  const refreshAll = () => {
    void invoices.reload();
    void payments.reload();
    void debitNotes.reload();
    void payables.reload();
  };

  const selectTile = (next: Tile) => {
    const value = tile === next ? "all" : next;
    setTile(value);
    setStatus(value === "overdue" ? "overdue" : value === "all" ? "all" : "outstanding");
  };

  const supplierOptions = useMemo(
    () => [
      { value: "all", label: "All suppliers" },
      ...suppliers.rows.map((s) => ({ value: s.id, label: s.name })),
    ],
    [suppliers.rows],
  );

  const pills: FilterPill[] = [
    ...(supplierId
      ? [{ key: "supplier", label: supplierOptions.find((o) => o.value === supplierId)?.label ?? "Supplier" }]
      : []),
    ...(dateFrom || dateTo ? [{ key: "dates", label: `${dateFrom || "any"} → ${dateTo || "today"}` }] : []),
    ...(search.trim() ? [{ key: "search", label: `“${search.trim()}”` }] : []),
    ...(tile === "awaiting" ? [{ key: "awaiting", label: "Deliveries awaiting an invoice" }] : []),
  ];
  const clearFilters = () => {
    setSupplierFilter("all");
    setDateFrom("");
    setDateTo("");
    setSearch("");
    setTile("all");
    setStatus("all");
  };

  async function confirmVoidPayment() {
    if (!voidPayment || !voidReason.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/payments/${voidPayment.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      setVoidPayment(null);
      setVoidReason("");
      refreshAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to void the payment");
    } finally {
      setBusy(false);
    }
  }

  async function confirmApplyNote() {
    if (!applyNote) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/debit-notes/${applyNote.id}/apply`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setApplyNote(null);
      refreshAll();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to apply the debit note");
    } finally {
      setBusy(false);
    }
  }

  const invoiceColumns: Column<InvoiceRow>[] = [
    {
      key: "invoice",
      header: "Invoice",
      render: (row) => (
        <>
          <button
            type="button"
            className={css.linkLikeButton}
            onClick={() => setOpenInvoice(row.id)}
            aria-label={`Open invoice ${row.invoiceNumber}`}
          >
            {row.invoiceNumber}
          </button>
          {row.source === "system" ? <div className={css.muted}>Delivery awaiting invoice</div> : null}
        </>
      ),
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (row) => (
        <>
          <div>{row.supplier.name}</div>
          <div className={css.supplierCode}>{row.supplier.code}</div>
        </>
      ),
    },
    { key: "invoiceDate", header: "Invoiced", render: (row) => formatDate(row.invoiceDate) },
    {
      key: "dueDate",
      header: "Due",
      render: (row) => (
        <div className={css.stackedCell}>
          <span>{formatDate(row.dueDate)}</span>
          {row.overdue ? <span className={css.fieldWarning}>Overdue</span> : null}
        </div>
      ),
    },
    { key: "total", header: "Total", align: "right", render: (row) => formatMoney(row.totalAmount) },
    { key: "balance", header: "Left to pay", align: "right", render: (row) => formatMoney(row.balance) },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
  ];

  const paymentColumns: Column<PaymentRow>[] = [
    {
      key: "payment",
      header: "Payment",
      render: (row) => (
        <>
          <div className={css.cellStrong}>{row.paymentNo}</div>
          {row.voided ? <StatusBadge status="voided" /> : null}
        </>
      ),
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (row) => row.supplier.name,
    },
    { key: "paidOn", header: "Paid on", render: (row) => formatDate(row.paidOn) },
    {
      key: "method",
      header: "Paid by",
      render: (row) => (
        <>
          {paymentMethodLabel(row.method)}
          {row.reference ? <div className={css.muted}>{row.reference}</div> : null}
        </>
      ),
    },
    {
      key: "settles",
      header: "Settles",
      render: (row) => row.allocations.map((a) => `${a.invoiceNumber} (${formatMoney(a.amount)})`).join(", "),
    },
    { key: "amount", header: "Amount", align: "right", render: (row) => formatMoney(row.amount) },
    ...(access.canPay
      ? [
          {
            key: "actions",
            header: "",
            render: (row: PaymentRow) =>
              row.voided ? null : (
                <button type="button" className={css.actionBtn} onClick={() => setVoidPayment(row)}>
                  Void
                </button>
              ),
          },
        ]
      : []),
  ];

  const debitColumns: Column<DebitNoteRow>[] = [
    { key: "debitNo", header: "Debit note", render: (row) => <span className={css.cellStrong}>{row.debitNo}</span> },
    { key: "supplier", header: "Supplier", render: (row) => row.supplier.name },
    {
      key: "return",
      header: "From return",
      render: (row) => row.goodsReturn?.returnNumber ?? "—",
    },
    { key: "issuedOn", header: "Issued", render: (row) => formatDate(row.issuedOn) },
    { key: "amount", header: "Amount", align: "right", render: (row) => formatMoney(row.amount) },
    { key: "remaining", header: "Not yet applied", align: "right", render: (row) => formatMoney(row.remaining) },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    ...(access.canPay
      ? [
          {
            key: "actions",
            header: "",
            render: (row: DebitNoteRow) =>
              row.status === "open" ? (
                <button type="button" className={css.actionBtn} onClick={() => setApplyNote(row)}>
                  Apply
                </button>
              ) : null,
          },
        ]
      : []),
  ];

  if (access.ready && !allowed) {
    return (
      <div className={css.page}>
        <PurchasingSubnav />
        <Alert variant="info">Supplier invoices and payments are handled by owners and managers.</Alert>
      </div>
    );
  }

  return (
    <div className={css.page}>
      <PageHeader
        subtitleOnly
        floatingActions
        description="What each supplier billed, checked against what was ordered and what arrived, and what has been paid."
        actions={
          <>
            {access.canPay ? (
              <button type="button" className={css.actionBtn} onClick={() => setRecordPayment({})}>
                <IconDollarSign size={14} />
                Record payment
              </button>
            ) : null}
            {access.canInvoice ? (
              <ActionButton icon={<IconPlus size={16} />} onClick={() => setRecordInvoice({})}>
                Record invoice
              </ActionButton>
            ) : null}
          </>
        }
      />

      <PurchasingSubnav />

      {!invoices.hasBranch ? (
        <div className={css.branchNotice}>Select a branch in the header to see its payables.</div>
      ) : (
        <>
          <div className={css.kpiRow}>
            <StatCard
              size="sm"
              title="Owed to suppliers"
              value={formatMoney(payables.data?.outstanding ?? 0)}
              subtitle="Everything not yet paid"
              icon={<IconDollarSign size={16} />}
              iconTone="primary"
              active={tile === "outstanding"}
              onClick={() => {
                setView("invoices");
                selectTile("outstanding");
              }}
            />
            <StatCard
              size="sm"
              title="Overdue"
              value={formatMoney(payables.data?.overdue ?? 0)}
              subtitle="Past the due date"
              icon={<IconAlertTriangle size={16} />}
              iconTone={Number(payables.data?.overdue ?? 0) > 0 ? "warning" : "info"}
              active={tile === "overdue"}
              onClick={() => {
                setView("invoices");
                selectTile("overdue");
              }}
            />
            <StatCard
              size="sm"
              title="Awaiting invoice"
              value={String(payables.data?.awaitingInvoiceCount ?? 0)}
              subtitle={`Deliveries · ${formatMoney(payables.data?.awaitingInvoice ?? 0)}`}
              icon={<IconTruck size={16} />}
              iconTone="info"
              active={tile === "awaiting"}
              onClick={() => {
                setView("invoices");
                selectTile("awaiting");
              }}
            />
            <StatCard
              size="sm"
              title="Credits to apply"
              value={formatMoney(payables.data?.openCredits ?? 0)}
              subtitle="Open debit notes"
              icon={<IconRefresh size={16} />}
              iconTone="success"
              active={view === "debit-notes"}
              onClick={() => setView(view === "debit-notes" ? "invoices" : "debit-notes")}
            />
          </div>

          <SegmentedTabs<View>
            ariaLabel="Payables sections"
            active={view}
            onChange={setView}
            items={[
              { id: "invoices", label: "Invoices", icon: <IconClipboardList size={14} /> },
              { id: "payments", label: "Payments", icon: <IconDollarSign size={14} /> },
              { id: "debit-notes", label: "Debit notes", icon: <IconRefresh size={14} /> },
            ]}
          />

          <div className={css.toolbar}>
            {view === "invoices" ? (
              <div className={css.searchWrap}>
                <IconSearch size={15} className={css.searchIcon} />
                <input
                  type="search"
                  className={css.searchInput}
                  placeholder="Search invoice number or supplier…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            ) : null}
            <InventoryFilterSelect
              label="Supplier"
              value={supplierFilter}
              options={supplierOptions}
              onChange={setSupplierFilter}
            />
            {view === "invoices" ? (
              <InventoryFilterSelect
                label="Status"
                value={status}
                options={STATUS_OPTIONS}
                onChange={(value) => {
                  setStatus(value);
                  setTile(value === "overdue" ? "overdue" : value === "outstanding" ? "outstanding" : "all");
                }}
              />
            ) : null}
            {view !== "debit-notes" ? (
              <DateRangeField
                label={view === "payments" ? "Paid between" : "Invoiced between"}
                from={dateFrom}
                to={dateTo}
                onFromChange={setDateFrom}
                onToChange={setDateTo}
              />
            ) : null}
          </div>

          <ActiveFilterBanner
            active={pills.length > 0}
            summary={`Filtered ${view === "invoices" ? "invoices" : view === "payments" ? "payments" : "debit notes"}`}
            pills={pills}
            onClear={clearFilters}
          />

          {(actionError || invoices.error || payments.error || debitNotes.error) && (
            <Alert variant="error">{actionError ?? invoices.error ?? payments.error ?? debitNotes.error}</Alert>
          )}

          {view === "invoices" ? (
            <DataTable
              columns={invoiceColumns}
              data={invoices.rows}
              rowKey={(row) => row.id}
              loading={invoices.loading}
              emptyIcon={<IconClipboardList size={22} />}
              emptyTitle="No invoices here"
              emptyDescription="Record the supplier's invoice when it arrives, against the deliveries it bills for."
            />
          ) : view === "payments" ? (
            <DataTable
              columns={paymentColumns}
              data={payments.rows}
              rowKey={(row) => row.id}
              loading={payments.loading}
              emptyIcon={<IconDollarSign size={22} />}
              emptyTitle="No payments recorded"
              emptyDescription="Payments to suppliers appear here, with the invoices they settled."
            />
          ) : (
            <DataTable
              columns={debitColumns}
              data={debitNotes.rows}
              rowKey={(row) => row.id}
              loading={debitNotes.loading}
              emptyIcon={<IconRefresh size={22} />}
              emptyTitle="No debit notes"
              emptyDescription="A debit note is raised automatically when a supplier return is completed."
            />
          )}
        </>
      )}

      <InvoiceSheet
        invoiceId={openInvoice}
        access={access}
        onClose={() => setOpenInvoice(null)}
        onChanged={refreshAll}
        onPay={(invoice) => {
          setOpenInvoice(null);
          setRecordPayment({ supplierId: invoice.supplier.id, invoiceId: invoice.id });
        }}
        onRecordFor={(invoice) => {
          setOpenInvoice(null);
          setRecordInvoice({
            supplierId: invoice.supplier.id,
            receiptId: invoice.deliveries[0]?.id,
          });
        }}
      />

      <RecordInvoiceModal
        open={recordInvoice !== null}
        preset={recordInvoice}
        onClose={() => setRecordInvoice(null)}
        onRecorded={(invoice) => {
          setRecordInvoice(null);
          refreshAll();
          setOpenInvoice(invoice.id);
        }}
      />

      <RecordPaymentModal
        open={recordPayment !== null}
        preset={recordPayment}
        onClose={() => setRecordPayment(null)}
        onRecorded={() => {
          setRecordPayment(null);
          refreshAll();
        }}
      />

      <ConfirmDialog
        open={voidPayment !== null}
        title={`Void ${voidPayment?.paymentNo ?? "payment"}?`}
        confirmLabel="Void payment"
        cancelLabel="Keep it"
        loading={busy}
        confirmDisabled={!voidReason.trim()}
        onCancel={() => {
          if (!busy) setVoidPayment(null);
        }}
        onConfirm={() => void confirmVoidPayment()}
      >
        <p>
          The invoices it settled go back to owing {formatMoney(voidPayment?.amount ?? 0)}. The payment
          stays on record, marked voided.
        </p>
        <label className={css.fieldLabel} htmlFor="void-payment-reason">
          Why
        </label>
        <input
          id="void-payment-reason"
          className={css.input}
          placeholder="Cheque bounced, entered twice…"
          value={voidReason}
          onChange={(e) => setVoidReason(e.target.value)}
          disabled={busy}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={applyNote !== null}
        title={`Apply ${applyNote?.debitNo ?? "debit note"}?`}
        confirmLabel="Apply"
        cancelLabel="Not now"
        variant="primary"
        loading={busy}
        onCancel={() => {
          if (!busy) setApplyNote(null);
        }}
        onConfirm={() => void confirmApplyNote()}
      >
        <p>
          {formatMoney(applyNote?.remaining ?? 0)} is set against {applyNote?.supplier.name ?? "the supplier"}
          &apos;s oldest open invoices, and reduces what is owed. Anything left over stays open for the
          next invoice.
        </p>
      </ConfirmDialog>
    </div>
  );
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={null}>
      <InvoicesContent />
    </Suspense>
  );
}
