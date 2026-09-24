"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, SegmentedTabs } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { createIdempotencyKey } from "@/lib/idempotency";
import { useInvoices } from "../hooks/use-ledger";
import { useSuppliers } from "../hooks/use-suppliers";
import {
  PAYMENT_METHOD_OPTIONS,
  type PaymentRow,
  type SupplierPaymentMethod,
} from "../ledger-types";
import css from "../purchasing.module.css";
import { formatDate, formatMoney, todayIsoDate } from "../utils";
import { PurchasingSelect } from "./purchasing-select";

type Props = {
  open: boolean;
  onClose: () => void;
  onRecorded: (payment: PaymentRow) => void;
  /** Open against one supplier, optionally one invoice (paying its balance). */
  preset?: { supplierId?: string; invoiceId?: string } | null;
};

type Mode = "oldest" | "choose";

/**
 * Record money sent to a supplier.
 *
 * "Pay Hemas 50,000" means clear the oldest bills first, so that is the default and the server
 * works it out. Choosing invoices is there for the payment that settles one particular bill.
 * Either way the whole amount must land on invoices: a payment set against nothing is the
 * ambiguity this ledger replaced.
 */
export function RecordPaymentModal({ open, onClose, onRecorded, preset }: Props) {
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<SupplierPaymentMethod>("bank_transfer");
  const [paidOn, setPaidOn] = useState(todayIsoDate());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [mode, setMode] = useState<Mode>("oldest");
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idempotency = useRef<string | null>(null);

  const invoices = useInvoices(
    { supplierId: supplierId || undefined, status: "outstanding" },
    open && !!supplierId,
  );

  useEffect(() => {
    if (!open) return;
    setSupplierId(preset?.supplierId ?? "");
    setAmount("");
    setMethod("bank_transfer");
    setPaidOn(todayIsoDate());
    setReference("");
    setNotes("");
    setMode(preset?.invoiceId ? "choose" : "oldest");
    setAllocations({});
    setError(null);
    setSaving(false);
    idempotency.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A preset invoice starts with its whole balance allocated and the amount to match.
  useEffect(() => {
    if (!preset?.invoiceId || invoices.loading) return;
    const invoice = invoices.rows.find((row) => row.id === preset.invoiceId);
    if (invoice && !allocations[invoice.id]) {
      setAllocations({ [invoice.id]: invoice.balance });
      setAmount(invoice.balance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.invoiceId, invoices.loading, invoices.rows]);

  const owed = useMemo(
    () => invoices.rows.reduce((sum, row) => sum + Number(row.balance), 0),
    [invoices.rows],
  );
  const allocated = Object.values(allocations).reduce((sum, v) => sum + (Number(v) || 0), 0);
  const amountNumber = Number(amount) || 0;

  const allocationProblem =
    mode === "choose"
      ? Math.abs(allocated - amountNumber) > 0.004
        ? `The invoices below add up to ${formatMoney(allocated)}; the payment is ${formatMoney(amountNumber)}.`
        : invoices.rows.some((row) => (Number(allocations[row.id]) || 0) > Number(row.balance) + 0.004)
          ? "One invoice has more set against it than it has left to pay."
          : null
      : amountNumber > owed + 0.004
        ? `That is more than is owed to this supplier (${formatMoney(owed)}).`
        : null;

  const valid = !!supplierId && amountNumber > 0 && !!paidOn && !allocationProblem;

  async function submit() {
    if (!valid) return;
    if (!idempotency.current) idempotency.current = createIdempotencyKey("supplier-payment", supplierId);
    setSaving(true);
    setError(null);
    try {
      const payment = await apiJson<PaymentRow>("/purchasing/payments", {
        method: "POST",
        headers: { "Idempotency-Key": idempotency.current },
        body: JSON.stringify({
          supplierId,
          paidOn,
          amount: amountNumber.toFixed(2),
          method,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(mode === "choose"
            ? {
                allocations: Object.entries(allocations)
                  .filter(([, value]) => Number(value) > 0)
                  .map(([invoiceId, value]) => ({ invoiceId, amount: Number(value).toFixed(2) })),
              }
            : {}),
        }),
      });
      idempotency.current = null;
      onRecorded(payment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record the payment");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      title="Record supplier payment"
      description="Money sent to a supplier, set against the invoices it settles."
      size="lg"
      canDismiss={!saving}
      footer={
        <ModalFooter>
          <ModalButton onClick={onClose} disabled={saving}>
            Cancel
          </ModalButton>
          <ModalButton variant="primary" onClick={() => void submit()} loading={saving} disabled={!valid}>
            Record payment
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      <div className={css.formGrid}>
        <div className={css.field}>
          <PurchasingSelect
            label="Supplier"
            required
            value={supplierId}
            options={suppliers.rows.map((s) => ({ value: s.id, label: s.name, meta: s.code }))}
            placeholder={suppliers.loading ? "Loading…" : "Select supplier…"}
            searchPlaceholder="Search suppliers…"
            onChange={(value) => {
              setSupplierId(value);
              setAllocations({});
            }}
            disabled={saving}
          />
          {supplierId && !invoices.loading ? (
            <span className={css.fieldHint}>
              {formatMoney(owed)} owed across {invoices.rows.length} invoice
              {invoices.rows.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="pay-amount">
            Amount paid
          </label>
          <input
            id="pay-amount"
            type="number"
            min={0}
            step="0.01"
            className={css.input}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <PurchasingSelect
            label="Paid by"
            value={method}
            options={PAYMENT_METHOD_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(value) => setMethod(value as SupplierPaymentMethod)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="pay-date">
            Paid on
          </label>
          <input
            id="pay-date"
            type="date"
            className={css.input}
            value={paidOn}
            max={todayIsoDate()}
            onChange={(e) => setPaidOn(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="pay-ref">
            {method === "cheque" ? "Cheque number" : "Reference"}
          </label>
          <input
            id="pay-ref"
            className={css.input}
            placeholder={method === "bank_transfer" ? "Transfer reference" : ""}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            disabled={saving}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="pay-notes">
            Notes
          </label>
          <input
            id="pay-notes"
            className={css.input}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      {supplierId && (
        <>
          <SegmentedTabs<Mode>
            ariaLabel="How to set this payment against invoices"
            active={mode}
            onChange={setMode}
            items={[
              { id: "oldest", label: "Oldest due first" },
              { id: "choose", label: "Choose invoices" },
            ]}
          />
          {mode === "oldest" ? (
            <p className={css.fieldHint} style={{ marginTop: "0.5rem" }}>
              The payment clears whichever invoices fall due first.
            </p>
          ) : invoices.rows.length === 0 ? (
            <p className={css.fieldHint} style={{ marginTop: "0.5rem" }}>
              Nothing is owed to this supplier right now.
            </p>
          ) : (
            <div className={css.tableScroll}>
              <table className={css.suggestTable}>
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Due</th>
                    <th scope="col">Left to pay</th>
                    <th scope="col">Pay now</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className={css.cellStrong}>{row.invoiceNumber}</div>
                        {row.source === "system" ? (
                          <div className={css.muted}>Delivery awaiting invoice</div>
                        ) : null}
                      </td>
                      <td>
                        {formatDate(row.dueDate)}
                        {row.overdue ? <div className={css.fieldWarning}>Overdue</div> : null}
                      </td>
                      <td>{formatMoney(row.balance)}</td>
                      <td style={{ width: 140 }}>
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          className={css.input}
                          aria-label={`Pay against ${row.invoiceNumber}`}
                          placeholder="0.00"
                          value={allocations[row.id] ?? ""}
                          onChange={(e) =>
                            setAllocations((prev) => ({ ...prev, [row.id]: e.target.value }))
                          }
                          disabled={saving}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {allocationProblem ? (
            <p className={css.fieldWarning} role="alert" style={{ marginTop: "0.5rem" }}>
              {allocationProblem}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
