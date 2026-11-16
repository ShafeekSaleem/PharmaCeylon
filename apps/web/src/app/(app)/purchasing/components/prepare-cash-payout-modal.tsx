"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/alert";
import { DatePicker, Modal, ModalButton, ModalFooter } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { useInvoices } from "../hooks/use-ledger";
import { useSuppliers } from "../hooks/use-suppliers";
import { formatMoney, todayIsoDate } from "../utils";
import { PurchasingSelect } from "./purchasing-select";
import { paymentAllocations } from "./payment-evidence";
import css from "../purchasing.module.css";

type Props = {
  open: boolean;
  onClose: () => void;
  onPrepared: () => void;
};

export function PrepareCashPayoutModal({ open, onClose, onPrepared }: Props) {
  const suppliers = useSuppliers();
  const [supplierId, setSupplierId] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayIsoDate());
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selfApproveNote, setSelfApproveNote] = useState(false);

  const invoices = useInvoices(
    { supplierId: supplierId || undefined, status: "outstanding" },
    open && !!supplierId,
  );

  useEffect(() => {
    if (!open) return;
    setSupplierId("");
    setAmount("");
    setPaidOn(todayIsoDate());
    setReference("");
    setNotes("");
    setAllocations({});
    setError(null);
    setSelfApproveNote(false);
  }, [open]);

  const owed = useMemo(
    () => invoices.rows.reduce((sum, row) => sum + Number(row.balance), 0),
    [invoices.rows],
  );
  const amountNumber = Number(amount);
  const allocationSum = Object.values(allocations).reduce((s, v) => s + (Number(v) || 0), 0);
  const allocationMismatch =
    allocationSum > 0 && Math.abs(allocationSum - amountNumber) > 0.004
      ? `The allocations add up to ${allocationSum.toFixed(2)}, but the payment is ${amountNumber.toFixed(2)}`
      : null;

  const valid =
    !!supplierId &&
    amountNumber > 0 &&
    !!paidOn &&
    invoices.fresh &&
    !invoices.error &&
    !allocationMismatch;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parts = paymentAllocations(invoices.rows, amount, allocations);
      const created = await apiJson<{ status: string }>("/purchasing/cash-payouts", {
        method: "POST",
        body: JSON.stringify({
          supplierId,
          paidOn,
          amount: amountNumber.toFixed(2),
          reference: reference.trim() || undefined,
          notes: notes.trim() || undefined,
          allocations: parts,
        }),
      });
      if (created.status === "approved") setSelfApproveNote(true);
      onPrepared();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work");
      if (err instanceof ApiError && err.status === 409) setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Prepare cash payout" size="xl">
      {error && <Alert variant="error">{error}</Alert>}
      {selfApproveNote && (
        <Alert variant="info">
          Your role can self-approve supplier payments, so this payout was prepared and approved in
          one step. Someone at the counter can pay it out from the drawer.
        </Alert>
      )}
      {!amount.trim() && <Alert variant="warning">Enter the amount to pay out</Alert>}
      {allocationMismatch && <Alert variant="error">{allocationMismatch}</Alert>}
      <div className={css.formGrid}>
        <div className={css.field}>
          <PurchasingSelect
            label="Supplier"
            value={supplierId}
            options={suppliers.rows.map((s) => ({ value: s.id, label: s.name }))}
            onChange={setSupplierId}
          />
        </div>
        <div className={css.field}>
          <label>
            Amount (LKR)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        <div className={css.field}>
          <DatePicker label="Paid on" value={paidOn} onChange={setPaidOn} />
        </div>
        <div className={css.field}>
          <label>
            Reference
            <input value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
          </label>
        </div>
        <div className={css.fieldWide}>
          <label>
            Notes
            <textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
      {supplierId && (
        <div className={css.heldTableScroll}>
          <table className={css.heldTable}>
            <thead>
              <tr>
                <th>Invoice</th>
                <th className={css.heldNum}>Balance</th>
                <th className={css.heldNum}>Allocate</th>
              </tr>
            </thead>
            <tbody>
              {invoices.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.invoiceNumber}</td>
                  <td className={css.heldNum}>{formatMoney(row.balance)}</td>
                  <td className={css.heldNum}>
                    <input
                      aria-label={`Allocate to ${row.invoiceNumber}`}
                      value={allocations[row.id] ?? ""}
                      onChange={(e) =>
                        setAllocations((prev) => ({ ...prev, [row.id]: e.target.value }))
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={css.fieldHint}>
            {owed > 0
              ? `${formatMoney(owed)} outstanding on open invoices. Leave allocations blank to let the server apply the amount.`
              : "No outstanding invoices for this supplier."}
          </p>
        </div>
      )}
      <ModalFooter>
        <ModalButton variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </ModalButton>
        <ModalButton variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()}>
          Prepare cash payout
        </ModalButton>
      </ModalFooter>
    </Modal>
  );
}