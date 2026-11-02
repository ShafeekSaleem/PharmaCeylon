"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/alert";
import {
  DatePicker,
  Modal,
  ModalButton,
  ModalFooter,
  SegmentedTabs,
} from "@/components/ui";
import { apiJson } from "@/lib/auth-client";
import { ApiError } from "@/lib/api-error";
import { useAuth } from "@/lib/use-auth";
import { useBranchRollout } from "@/lib/branch-rollout";
import {
  evidenceFileProblem,
  isPaymentAmount,
  paymentAllocations,
  EVIDENCE_TYPES,
} from "./payment-evidence";
import { createIdempotencyKey, randomUuid } from "@/lib/idempotency";
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
export function RecordPaymentModal({
  open,
  onClose,
  onRecorded,
  preset,
}: Props) {
  const suppliers = useSuppliers();
  const { branchId, user } = useAuth();
  const { rollout } = useBranchRollout();
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState(false);
  const [locked, setLocked] = useState(false);
  const [canDiscard, setCanDiscard] = useState(false);
  const recoveryKey = `supplier-payment:${user?.tenantId}:${user?.id}:${branchId}`;
  const context = useRef(recoveryKey);
  context.current = recoveryKey;
  const reviewed = useRef<{
    payment: {
      supplierId: string;
      paidOn: string;
      amount: string;
      method: string;
      reference: string;
      notes: string | null;
      allocations: { invoiceId: string; amount: string }[];
    };
    labels: Record<string, string>;
  } | null>(null);
  const attempt = useRef<{
    evidenceId: string;
    key: string;
    payment: object;
    file: File | null;
    uploaded: boolean;
    branchId: string;
  } | null>(null);

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
  const evidenceRequired = ["bank_transfer", "cheque", "card"].includes(method);
  // Cash and other payouts stay on the web while the web is in charge: before go-live and during
  // an owner's fallback. At a live branch (or while the state is unknown) they are refused here.
  const counterOnly =
    !evidenceRequired &&
    rollout?.state !== "not_live" &&
    rollout?.state !== "fallback";
  const disabled = saving || locked || review;

  const invoices = useInvoices(
    { supplierId: supplierId || undefined, status: "outstanding" },
    open && !!supplierId,
  );
  // Rows from another supplier stay on screen while a new supplier's load is in flight, so the
  // form waits for rows that answer the current supplier before it allocates anything.
  const invoicesReady = !invoices.loading && invoices.fresh;

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
    attempt.current = null;
    reviewed.current = null;
    setFile(null);
    setReview(false);
    setLocked(false);
    setCanDiscard(false);
    try {
      const saved = sessionStorage.getItem(recoveryKey);
      if (saved) {
        const restored = JSON.parse(saved);
        if (
          restored.branchId === branchId &&
          restored.evidenceId &&
          restored.key &&
          restored.payment
        ) {
          attempt.current = { ...restored, file: null };
          const payment = restored.payment;
          reviewed.current = { payment, labels: restored.labels || {} };
          setSupplierId(payment.supplierId);
          setAmount(payment.amount);
          setMethod(payment.method);
          setPaidOn(payment.paidOn);
          setReference(payment.reference);
          setNotes(payment.notes || "");
          setMode("choose");
          setAllocations(
            Object.fromEntries(
              payment.allocations.map(
                (part: { invoiceId: string; amount: string }) => [
                  part.invoiceId,
                  part.amount,
                ],
              ),
            ),
          );
          setLocked(true);
          setReview(true);
          setError(
            restored.uploaded
              ? "A previous payment needs confirmation. Retry the same payment to recover its result."
              : "An upload was interrupted. Select the same document and retry, or discard the unused evidence.",
          );
          setCanDiscard(!restored.uploaded);
        }
      }
    } catch {
      setError(
        "Saved payment recovery could not be read. Check payment history before recording again.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, branchId, user?.id, user?.tenantId]);

  // A preset invoice starts with its whole balance allocated and the amount to match.
  useEffect(() => {
    if (
      attempt.current ||
      reviewed.current ||
      locked ||
      review ||
      !preset?.invoiceId ||
      !invoicesReady
    )
      return;
    const invoice = invoices.rows.find((row) => row.id === preset.invoiceId);
    if (invoice && !(invoice.id in allocations)) {
      setAllocations({ [invoice.id]: invoice.balance });
      setAmount(invoice.balance);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.invoiceId, invoicesReady, invoices.rows]);

  const owed = useMemo(
    () => invoices.rows.reduce((sum, row) => sum + Number(row.balance), 0),
    [invoices.rows],
  );
  const allocated = Object.values(allocations).reduce(
    (sum, v) => sum + (Number(v) || 0),
    0,
  );
  const amountNumber = Number(amount) || 0;

  const allocationProblem =
    mode === "choose"
      ? Math.abs(allocated - amountNumber) > 0.004
        ? `The invoices below add up to ${formatMoney(allocated)}; the payment is ${formatMoney(amountNumber)}.`
        : invoices.rows.some(
              (row) =>
                (Number(allocations[row.id]) || 0) >
                Number(row.balance) + 0.004,
            )
          ? "One invoice has more set against it than it has left to pay."
          : null
      : amountNumber > owed + 0.004
        ? `That is more than is owed to this supplier (${formatMoney(owed)}).`
        : null;

  const valid =
    !!supplierId &&
    isPaymentAmount(amount) &&
    !!paidOn &&
    !allocationProblem &&
    invoicesReady &&
    !invoices.error &&
    !!branchId &&
    !counterOnly &&
    (!evidenceRequired ||
      (!!file && !evidenceFileProblem(file) && !!reference.trim()));

  // Paying one chosen invoice: the amount is what goes against it, so typing a part payment
  // doesn't leave the invoice still set to its whole balance.
  function changeAmount(next: string) {
    setAmount(next);
    if (mode !== "choose") return;
    const chosen = Object.keys(allocations);
    if (chosen.length !== 1) return;
    const invoiceId = chosen[0]!;
    const invoice = invoices.rows.find((row) => row.id === invoiceId);
    if (!invoice) return;
    const capped = Math.min(Number(next) || 0, Number(invoice.balance));
    setAllocations({ [invoiceId]: capped > 0 ? capped.toFixed(2) : "" });
  }

  async function submit() {
    if (saving || (!valid && !attempt.current && !reviewed.current)) return;
    if (evidenceRequired) {
      if (!review && !attempt.current) {
        try {
          reviewed.current = {
            payment: {
              supplierId,
              paidOn,
              amount: amountNumber.toFixed(2),
              method,
              reference: reference.trim(),
              notes: notes.trim() || null,
              allocations: paymentAllocations(
                invoices.rows,
                amount,
                mode === "choose" ? allocations : undefined,
              ),
            },
            labels: Object.fromEntries(
              invoices.rows.map((row) => [row.id, row.invoiceNumber]),
            ),
          };
          setError(null);
          setReview(true);
        } catch (err) {
          setError(
            err instanceof Error ? err.message : "Check invoice allocations",
          );
        }
        return;
      }
      setSaving(true);
      setError(null);
      try {
        if (!attempt.current) {
          const payment = reviewed.current!.payment;
          attempt.current = {
            evidenceId: randomUuid(),
            key: createIdempotencyKey("supplier-evidenced-payment", supplierId),
            payment,
            file: file!,
            uploaded: false,
            branchId: branchId!,
          };
        }
        const current = attempt.current;
        if (!current.uploaded && !current.file) {
          if (!file)
            throw new Error(
              "Select the original supporting document to retry the upload.",
            );
          current.file = file;
        }
        // Recovery is best effort: a browser that refuses storage still records the payment, it
        // just can't offer recovery after a reload.
        const persist = () => {
          try {
            sessionStorage.setItem(
              recoveryKey,
              JSON.stringify({
                ...current,
                file: null,
                labels: reviewed.current?.labels,
              }),
            );
          } catch {
            // Retrying from this open modal still reuses the same evidence and key.
          }
        };
        setLocked(true);
        persist();
        const headers = { "x-branch-id": current.branchId };
        if (!current.uploaded) {
          const form = new FormData();
          form.append("evidenceId", current.evidenceId);
          form.append("payment", JSON.stringify(current.payment));
          form.append("file", current.file!);
          await apiJson("/purchasing/payment-evidence", {
            method: "POST",
            headers,
            body: form,
          });
          current.uploaded = true;
          persist();
        }
        if (context.current !== recoveryKey || attempt.current !== current)
          return;
        setCanDiscard(false);
        const payment = await apiJson<PaymentRow>(
          "/purchasing/payments/evidenced",
          {
            method: "POST",
            headers: { ...headers, "Idempotency-Key": current.key },
            body: JSON.stringify({
              evidenceId: current.evidenceId,
              payment: current.payment,
            }),
          },
        );
        sessionStorage.removeItem(recoveryKey);
        if (context.current !== recoveryKey || attempt.current !== current)
          return;
        attempt.current = null;
        setLocked(false);
        onRecorded(payment);
      } catch (err) {
        if (context.current !== recoveryKey) return;
        // A 4xx other than a timeout or rate limit is the server's answer: retrying the same
        // binding gets the same refusal. Anything else may have landed, so only a retry can tell.
        const refused =
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          ![408, 429].includes(err.status);
        setCanDiscard(!attempt.current?.uploaded || refused);
        setError(
          (err instanceof Error ? err.message : "Unable to record payment") +
            (refused
              ? " This payment was not recorded. Discard the unused evidence, correct the payment and review it again."
              : " Your payment details are retained. Retry this payment to check the original result; do not create another payment."),
        );
      } finally {
        if (context.current === recoveryKey) setSaving(false);
      }
      return;
    }
    if (!idempotency.current)
      idempotency.current = createIdempotencyKey(
        "supplier-payment",
        supplierId,
      );
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
                  .map(([invoiceId, value]) => ({
                    invoiceId,
                    amount: Number(value).toFixed(2),
                  })),
              }
            : {}),
        }),
      });
      idempotency.current = null;
      onRecorded(payment);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to record the payment",
      );
    } finally {
      setSaving(false);
    }
  }

  async function discardEvidence() {
    const current = attempt.current;
    if (!current || !canDiscard || saving) return;
    setSaving(true);
    try {
      try {
        await apiJson(
          `/purchasing/payment-evidence/${current.evidenceId}/revoke`,
          {
            method: "POST",
            headers: { "x-branch-id": current.branchId },
            body: JSON.stringify({
              reason: "Discarded unused payment draft in web review",
            }),
          },
        );
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) throw err;
      }
      sessionStorage.removeItem(recoveryKey);
      if (context.current !== recoveryKey || attempt.current !== current)
        return;
      attempt.current = null;
      reviewed.current = null;
      setLocked(false);
      setReview(false);
      setCanDiscard(false);
      setError(null);
    } catch (err) {
      if (context.current === recoveryKey)
        setError(
          err instanceof Error ? err.message : "Unable to discard evidence",
        );
    } finally {
      if (context.current === recoveryKey) setSaving(false);
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
            {locked ? "Close and keep recovery" : "Cancel"}
          </ModalButton>
          <ModalButton
            variant="primary"
            onClick={(event) => {
              // The same button turns into "Record payment" once the review shows, so the second
              // click of a double-click on "Review payment" must not record unseen allocations.
              if (review && event.detail > 1) return;
              void submit();
            }}
            loading={saving}
            disabled={
              saving || (!valid && !attempt.current && !reviewed.current)
            }
          >
            {locked
              ? "Retry same payment"
              : evidenceRequired && !review
                ? "Review payment"
                : "Record payment"}
          </ModalButton>
        </ModalFooter>
      }
    >
      {error && <Alert variant="error">{error}</Alert>}

      {locked && canDiscard && (
        <ModalButton disabled={saving} onClick={() => void discardEvidence()}>
          Discard unused evidence and edit
        </ModalButton>
      )}
      {counterOnly && (
        <Alert variant="warning">
          {rollout
            ? "This branch sells on PharmaCeylon POS, so cash and other supplier payouts are not recorded from the web here, and the counter can't record them yet. Pay by bank transfer, cheque or card with its document."
            : "This branch's PharmaCeylon POS state isn't confirmed yet, so cash and other supplier payouts are held back. Reload the page if this doesn't clear."}
        </Alert>
      )}
      {invoices.error && <Alert variant="error">{invoices.error}</Alert>}
      {review && !locked && (
        <ModalButton
          onClick={() => {
            reviewed.current = null;
            setReview(false);
          }}
        >
          Edit payment details
        </ModalButton>
      )}
      {review && (
        <p className={css.fieldHint}>
          Review the supplier, amount, date, reference, document and invoice
          allocations below. Recording this payment stores the supporting
          document privately; it does not independently verify bank settlement.
        </p>
      )}
      <div className={css.formGrid}>
        <div className={css.field}>
          <PurchasingSelect
            label="Supplier"
            required
            value={supplierId}
            options={suppliers.rows.map((s) => ({
              value: s.id,
              label: s.name,
              meta: s.code,
            }))}
            placeholder={suppliers.loading ? "Loading…" : "Select supplier…"}
            searchPlaceholder="Search suppliers…"
            onChange={(value) => {
              setSupplierId(value);
              setAllocations({});
            }}
            disabled={disabled}
          />
          {supplierId && invoicesReady ? (
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
            onChange={(e) => changeAmount(e.target.value)}
            disabled={disabled}
          />
        </div>
        <div className={css.field}>
          <PurchasingSelect
            label="Paid by"
            value={method}
            options={PAYMENT_METHOD_OPTIONS.map((o) => ({
              value: o.value,
              label: o.label,
            }))}
            onChange={(value) => setMethod(value as SupplierPaymentMethod)}
            disabled={disabled}
          />
        </div>
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="pay-date">
            Paid on
          </label>
          <DatePicker
            variant="field"
            id="pay-date"
            label="Paid on"
            value={paidOn}
            onChange={(value) => setPaidOn(value)}
            max={todayIsoDate()}
            disabled={disabled}
            clearable={false}
            placeholder="Select a date"
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
            maxLength={100}
            required={evidenceRequired}
            onChange={(e) => setReference(e.target.value)}
            disabled={disabled}
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
            maxLength={1000}
            onChange={(e) => setNotes(e.target.value)}
            disabled={disabled}
          />
        </div>
      </div>

      {evidenceRequired && (
        <div className={css.field}>
          <label className={css.fieldLabel} htmlFor="payment-document">
            Supporting document
          </label>
          <input
            id="payment-document"
            type="file"
            accept={EVIDENCE_TYPES.join(",")}
            disabled={
              saving ||
              (disabled &&
                (attempt.current?.uploaded !== false ||
                  !!attempt.current?.file))
            }
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              setFile(next);
              setError(next ? evidenceFileProblem(next) : null);
            }}
          />
          <p className={css.fieldHint}>
            PDF, JPEG, PNG or WebP, up to 5 MB. Use a transfer confirmation,
            cheque record or card receipt without full card details.
          </p>
          {file && <p>{file.name}</p>}
        </div>
      )}
      {review && reviewed.current && (
        <ul aria-label="Reviewed invoice allocations">
          {reviewed.current.payment.allocations.map((part) => (
            <li key={part.invoiceId}>
              {reviewed.current?.labels[part.invoiceId] || part.invoiceId}:{" "}
              {formatMoney(part.amount)}
            </li>
          ))}
        </ul>
      )}

      {supplierId && !review && (
        <>
          <SegmentedTabs<Mode>
            ariaLabel="How to set this payment against invoices"
            active={mode}
            onChange={(next) => {
              if (!disabled) setMode(next);
            }}
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
                        <div className={css.cellStrong}>
                          {row.invoiceNumber}
                        </div>
                        {row.source === "system" ? (
                          <div className={css.muted}>
                            Delivery awaiting invoice
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {formatDate(row.dueDate)}
                        {row.overdue ? (
                          <>
                            {" · "}
                            <span className={css.fieldWarning}>overdue</span>
                          </>
                        ) : null}
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
                            setAllocations((prev) => ({
                              ...prev,
                              [row.id]: e.target.value,
                            }))
                          }
                          disabled={disabled}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {allocationProblem ? (
            <p
              className={css.fieldWarning}
              role="alert"
              style={{ marginTop: "0.5rem" }}
            >
              {allocationProblem}
            </p>
          ) : null}
        </>
      )}
    </Modal>
  );
}
