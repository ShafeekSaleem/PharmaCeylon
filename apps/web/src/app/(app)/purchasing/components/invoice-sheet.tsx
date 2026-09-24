"use client";

import { useState } from "react";
import { Alert } from "@/components/alert";
import { Modal, ModalButton, ModalFooter, StatusBadge } from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ConfirmDialog } from "../../products/components/confirm-dialog";
import { useInvoiceDetail } from "../hooks/use-ledger";
import type { PurchasingAccess } from "../hooks/use-purchasing-access";
import {
  MATCH_STATUS_LABEL,
  paymentMethodLabel,
  type InvoiceDetail,
  type MatchLine,
} from "../ledger-types";
import css from "../purchasing.module.css";
import { formatDate, formatMoney } from "../utils";

type Props = {
  invoiceId: string | null;
  access: PurchasingAccess;
  onClose: () => void;
  onChanged: () => void;
  onPay: (invoice: InvoiceDetail) => void;
  onRecordFor: (invoice: InvoiceDetail) => void;
};

/** A match line's tone: money at risk reads as danger, anything else unusual as a warning. */
function matchVariant(line: MatchLine): "success" | "danger" | "warning" {
  if (line.status === "matched") return "success";
  if (Number(line.valueAtStake) > 0) return "danger";
  return "warning";
}

/**
 * One supplier invoice: what it bills, what it bills *for*, and what has been set against it.
 *
 * The three-way match sits at the top on purpose — it is the reason to open an invoice before
 * paying it. A delivery still waiting for the supplier's invoice opens here too, with the way
 * to record the real one.
 */
export function InvoiceSheet({ invoiceId, access, onClose, onChanged, onPay, onRecordFor }: Props) {
  const { detail, loading, error, reload } = useInvoiceDetail(invoiceId);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const outstanding = detail && (detail.status === "open" || detail.status === "partial");
  const placeholder = detail?.source === "system";

  async function voidInvoice() {
    if (!detail || !voidReason.trim()) return;
    setBusy(true);
    setActionError(null);
    try {
      await apiJson(`/purchasing/invoices/${detail.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason.trim() }),
      });
      setVoiding(false);
      setVoidReason("");
      await reload();
      onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to void the invoice");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal
        open={invoiceId !== null}
        onClose={onClose}
        variant="sheet"
        title={detail ? detail.invoiceNumber : "Invoice"}
        description={
          detail
            ? `${detail.supplier.name} · ${placeholder ? "delivery awaiting the supplier's invoice" : `invoiced ${formatDate(detail.invoiceDate)}`}`
            : undefined
        }
        footer={
          <ModalFooter>
            {detail && access.canInvoice && detail.status !== "voided" && !placeholder ? (
              <ModalButton variant="danger" onClick={() => setVoiding(true)} disabled={busy}>
                Void
              </ModalButton>
            ) : null}
            {detail && placeholder && access.canInvoice && detail.status !== "voided" ? (
              <ModalButton onClick={() => onRecordFor(detail)}>Record the supplier&apos;s invoice</ModalButton>
            ) : null}
            {detail && outstanding && access.canPay ? (
              <ModalButton variant="primary" onClick={() => onPay(detail)}>
                Record payment
              </ModalButton>
            ) : null}
            <ModalButton onClick={onClose}>Done</ModalButton>
          </ModalFooter>
        }
      >
        {(error || actionError) && <Alert variant="error">{actionError ?? error}</Alert>}
        {loading && !detail ? <p className={css.muted}>Loading…</p> : null}

        {detail && (
          <>
            <div className={css.kpiRow} style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
              {[
                ["Total", formatMoney(detail.totalAmount)],
                ["Paid", formatMoney(detail.paidAmount)],
                ["Left to pay", formatMoney(detail.balance)],
                ["Due", formatDate(detail.dueDate)],
              ].map(([label, value]) => (
                <div key={label} className={css.sideCard}>
                  <div className={css.sideCardTitle}>{label}</div>
                  <div className={css.cellStrong}>{value}</div>
                </div>
              ))}
            </div>
            <p style={{ margin: "0.5rem 0" }}>
              <StatusBadge status={detail.status} />
            </p>

            {detail.deliveries.length > 0 && (
              <section className={css.suggestGroup}>
                <header className={css.suggestHeader}>
                  <div>
                    <h3 className={css.suggestSupplier}>Ordered, received, billed</h3>
                    <p className={css.muted}>
                      {detail.match.matched
                        ? "Everything billed arrived, at the price that was ordered."
                        : Number(detail.match.valueAtStake) > 0
                          ? `${formatMoney(detail.match.valueAtStake)} of this bill is for goods that did not arrive or a price nobody agreed. Check before paying.`
                          : "Some lines differ from what was ordered or received."}
                    </p>
                  </div>
                </header>
                <div className={css.tableScroll}>
                  <table className={css.suggestTable}>
                    <thead>
                      <tr>
                        <th scope="col">Product</th>
                        <th scope="col">Ordered</th>
                        <th scope="col">Received</th>
                        <th scope="col">Billed</th>
                        <th scope="col">Check</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.match.lines.map((line) => (
                        <tr key={`${line.productId ?? line.product}`}>
                          <td className={css.cellStrong}>{line.product}</td>
                          <td>
                            {line.orderedQty}
                            {line.orderedUnitCost ? (
                              <div className={css.muted}>@ {formatMoney(line.orderedUnitCost)}</div>
                            ) : null}
                          </td>
                          <td>{line.receivedQty}</td>
                          <td>
                            {line.billedQty}
                            {line.billedUnitCost ? (
                              <div className={css.muted}>@ {formatMoney(line.billedUnitCost)}</div>
                            ) : null}
                          </td>
                          <td>
                            <StatusBadge
                              status={line.status}
                              label={MATCH_STATUS_LABEL[line.status]}
                              variant={matchVariant(line)}
                            />
                            {Number(line.valueAtStake) > 0 ? (
                              <div className={css.fieldWarning}>{formatMoney(line.valueAtStake)} at stake</div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className={css.suggestGroup}>
              <header className={css.suggestHeader}>
                <h3 className={css.suggestSupplier}>Lines</h3>
              </header>
              <div className={css.tableScroll}>
                <table className={css.suggestTable}>
                  <thead>
                    <tr>
                      <th scope="col">Item</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Unit cost</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{line.product?.name ?? line.description ?? "—"}</td>
                        <td>{line.qty}</td>
                        <td>{formatMoney(line.unitCost)}</td>
                        <td>{formatMoney(line.lineTotal)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td colSpan={3} className={css.muted}>
                        Goods {formatMoney(detail.subtotalAmount)} · tax {formatMoney(detail.taxAmount)} ·
                        shipping {formatMoney(detail.shippingAmount)}
                      </td>
                      <td className={css.cellStrong}>{formatMoney(detail.totalAmount)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            {detail.deliveries.length > 0 && (
              <p className={css.muted}>
                Covers{" "}
                {detail.deliveries
                  .map((d) => `${d.grnNumber} (${d.poNumber}, ${formatDate(d.receivedOn)})`)
                  .join(", ")}
              </p>
            )}

            {(detail.payments.length > 0 || detail.debitNotes.length > 0) && (
              <section className={css.suggestGroup}>
                <header className={css.suggestHeader}>
                  <h3 className={css.suggestSupplier}>Set against this invoice</h3>
                </header>
                <ul className={css.plainList}>
                  {detail.payments.map((payment) => (
                    <li key={payment.paymentId} className={payment.voided ? css.rowMuted : undefined}>
                      <span className={css.cellStrong}>{payment.paymentNo}</span>{" "}
                      <span className={css.muted}>
                        {formatDate(payment.paidOn)} · {paymentMethodLabel(payment.method)}
                        {payment.reference ? ` · ${payment.reference}` : ""} · {formatMoney(payment.amount)}
                        {payment.voided ? " · voided" : ""}
                      </span>
                    </li>
                  ))}
                  {detail.debitNotes.map((note) => (
                    <li key={note.debitNoteId}>
                      <span className={css.cellStrong}>{note.debitNo}</span>{" "}
                      <span className={css.muted}>debit note · {formatMoney(note.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.notes ? <p className={css.muted}>{detail.notes}</p> : null}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={voiding}
        title="Void this invoice?"
        confirmLabel="Void invoice"
        cancelLabel="Keep it"
        loading={busy}
        confirmDisabled={!voidReason.trim()}
        onCancel={() => {
          if (!busy) setVoiding(false);
        }}
        onConfirm={() => void voidInvoice()}
      >
        <p>
          A voided invoice stays on record but no longer counts as owed. Invoices with payments set
          against them can&apos;t be voided until those payments are.
        </p>
        <label className={css.fieldLabel} htmlFor="void-reason">
          Why
        </label>
        <input
          id="void-reason"
          className={css.input}
          placeholder="Entered twice, wrong supplier…"
          value={voidReason}
          onChange={(e) => setVoidReason(e.target.value)}
          disabled={busy}
        />
      </ConfirmDialog>
    </>
  );
}
