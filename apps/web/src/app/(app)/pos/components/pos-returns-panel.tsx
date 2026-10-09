"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronLeft,
  IconChevronRight,
  IconMinus,
  IconPackage,
  IconPlus,
  IconRotateCcw,
  IconSearch,
} from "@/components/icons";
import { SegmentedTabs, StatusBadge } from "@/components/ui";
import { ApiError } from "@/lib/api-error";
import {
  findSaleByInvoice,
  searchInvoices,
  fetchSaleReturnable,
  listRefundApprovers,
  listRefunds,
  refundSale,
  type InvoiceSearchHit,
  type RefundDisposition,
  type RefundReason,
  type RefundRow,
  type RefundSalePayload,
  type SaleReturnable,
} from "../services/pos-api";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type { PaymentMethod, RecentSale, SaleReceipt } from "../types";
import { formatDate, formatMoney, formatTime } from "../utils";
import { PosPharmacistPinModal } from "./pos-pharmacist-pin-modal";
import { PosRefundReceiptModal, type RefundReceipt } from "./pos-refund-receipt-modal";
import type { ReceiptPreferences } from "./pos-receipt-modal";
import css from "../pos.module.css";

type Props = {
  canRefund: boolean;
  canRefundControlled: boolean;
  recentSales: RecentSale[];
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  receiptPreferences: ReceiptPreferences;
  organization: { displayName: string; logoUrl: string | null } | null;
};

type Step = "find" | "items" | "refund";

export const REFUND_REASON_OPTIONS: Array<{ value: RefundReason; label: string }> = [
  { value: "wrong_item", label: "Wrong item" },
  { value: "changed_mind", label: "Changed their mind" },
  { value: "damaged", label: "Damaged" },
  { value: "expired", label: "Expired or short-dated" },
  { value: "adverse_reaction", label: "Adverse reaction" },
  { value: "other", label: "Other" },
];

/** "As paid" sends no method, and the server splits it; the others send one method. */
type MethodChoice = "as_paid" | PaymentMethod;
const METHOD_CHOICES: PaymentMethod[] = ["cash", "card", "mobile_wallet"];
const SPLIT_ORDER: PaymentMethod[] = ["card", "mobile_wallet", "cash"];

/**
 * What "as paid" will do, for the screen — the same rule the server applies: what each method
 * took less what has gone back to it (cash net of change), card and wallet first, cash last.
 */
function previewAsPaid(sale: SaleReceipt, total: number) {
  const left = new Map<PaymentMethod, number>();
  for (const payment of sale.payments) {
    left.set(payment.method, (left.get(payment.method) ?? 0) + Number(payment.amount));
  }
  if (left.has("cash")) left.set("cash", (left.get("cash") ?? 0) - Number(sale.changeDue));
  const out: Array<{ method: PaymentMethod; amount: number }> = [];
  let remaining = Math.round(total * 100) / 100;
  for (const method of SPLIT_ORDER) {
    if (remaining <= 0) break;
    const available = left.get(method) ?? 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    out.push({ method, amount: take });
    remaining = Math.round((remaining - take) * 100) / 100;
  }
  if (remaining > 0) {
    const cash = out.find((row) => row.method === "cash");
    if (cash) cash.amount += remaining;
    else out.push({ method: "cash", amount: remaining });
  }
  return out;
}

/**
 * The one door for a customer return, in three steps: find the sale, choose what's coming back
 * (and whether each item goes back on the shelf or is held for a pharmacist), then refund — the
 * amount, why, and how it goes back. Over the tenant's limit an approver signs it off with their
 * till PIN. Recent refunds are a tab of their own rather than a list under the form.
 */
export function PosReturnsPanel({
  canRefund,
  canRefundControlled,
  recentSales,
  onRefunded,
  onError,
  onNotice,
  receiptPreferences,
  organization,
}: Props) {
  const [tab, setTab] = useState<"refund" | "recent">("refund");
  const [step, setStep] = useState<Step>("find");
  const [query, setQuery] = useState("");
  const [sale, setSale] = useState<SaleReceipt | null>(null);
  const [returnable, setReturnable] = useState<SaleReturnable | null>(null);
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({});
  const [dispositionByKey, setDispositionByKey] = useState<Record<string, RefundDisposition>>({});
  const [reasonCode, setReasonCode] = useState<RefundReason | "">("");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<MethodChoice>("as_paid");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<InvoiceSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    payload: RefundSalePayload;
    message: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<RefundReceipt | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRefunds = useCallback(() => {
    if (!canRefund) return;
    listRefunds()
      .then(setRefunds)
      .catch(() => setRefunds([]));
  }, [canRefund]);
  useEffect(loadRefunds, [loadRefunds]);

  const applyReturnable = useCallback((data: SaleReturnable) => {
    setReturnable(data);
    const qty: Record<string, number> = {};
    const dispositions: Record<string, RefundDisposition> = {};
    for (const line of data.lines) {
      qty[line.saleItemId] = 0;
      // A medicine back from a patient is held for a pharmacist to look at first.
      dispositions[line.saleItemId] =
        line.isControlled || line.requiresPrescription ? "quarantine" : "restock";
    }
    setQtyByKey(qty);
    setDispositionByKey(dispositions);
  }, []);

  function reset() {
    setStep("find");
    setSale(null);
    setReturnable(null);
    setQuery("");
    setReasonCode("");
    setNote("");
    setMethod("as_paid");
  }

  const openSale = useCallback(
    async (term: string) => {
      if (!term.trim()) return;
      setBusy(true);
      try {
        const found = await findSaleByInvoice(term);
        const data = await fetchSaleReturnable(found.id);
        setSale(found);
        applyReturnable(data);
        setHits([]);
        setQuery("");
        setReasonCode("");
        setNote("");
        setMethod("as_paid");
        setStep("items");
      } catch (e) {
        onError(e instanceof Error ? e.message : "Invoice not found");
      } finally {
        setBusy(false);
      }
    },
    [applyReturnable, onError],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = query.trim();
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void searchInvoices(term)
        .then(setHits)
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  const selected = useMemo(
    () =>
      (returnable?.lines ?? [])
        .map((line) => ({ line, qty: qtyByKey[line.saleItemId] ?? 0 }))
        .filter((row) => row.qty > 0),
    [returnable, qtyByKey],
  );
  const total = useMemo(
    () =>
      Math.round(
        selected.reduce(
          (sum, row) => sum + row.qty * Number(row.line.refundUnitPrice ?? row.line.unitPrice),
          0,
        ) * 100,
      ) / 100,
    [selected],
  );
  const heldUnits = selected
    .filter((row) => dispositionByKey[row.line.saleItemId] === "quarantine")
    .reduce((n, row) => n + row.qty, 0);

  const blockedControlled = Boolean(returnable?.requiresPharmacist) && !canRefundControlled;
  const refundable =
    !!sale &&
    !!returnable &&
    returnable.totalRemainingQty > 0 &&
    (sale.status === "posted" || sale.status === "partially_refunded");
  const canAct = canRefund && !blockedControlled && refundable;

  function stepQty(saleItemId: string, max: number, delta: number) {
    setQtyByKey((prev) => ({
      ...prev,
      [saleItemId]: Math.max(0, Math.min(max, (prev[saleItemId] ?? 0) + delta)),
    }));
  }

  function returnAll() {
    if (!returnable) return;
    setQtyByKey(
      Object.fromEntries(returnable.lines.map((line) => [line.saleItemId, line.remainingQty])),
    );
  }

  async function submit(payload: RefundSalePayload) {
    if (!sale) return;
    setBusy(true);
    try {
      const refunded = await refundSale(sale.id, payload);
      setPendingApproval(null);
      onRefunded(refunded);
      loadRefunds();
      // The refund's own payment rows carry its return number.
      const rows = refunded.payments.filter(
        (p) => Number(p.amount) < 0 && p.reference?.startsWith("POS refund "),
      );
      const returnNumber = rows[rows.length - 1]?.reference?.replace("POS refund ", "") ?? "";
      const mine = rows.filter((p) => p.reference === `POS refund ${returnNumber}`);
      setReceipt({
        returnNumber,
        invoiceNo: refunded.invoiceNo,
        at: new Date().toISOString(),
        customerName: refunded.customer?.fullName ?? null,
        lines: (payload.items ?? []).map((item) => {
          const line = returnable?.lines.find(
            (l) => l.productId === item.productId && l.batchId === item.batchId,
          );
          return {
            name: line?.productName ?? "Item",
            batchNo: line?.batchNo ?? "",
            qty: item.qty,
            amount: item.qty * Number(line?.refundUnitPrice ?? line?.unitPrice ?? 0),
            held: item.disposition === "quarantine",
          };
        }),
        refundedTo: mine.map((p) => ({ method: p.method, amount: -Number(p.amount) })),
        // "Other" is described by the note itself; any other reason is its label plus the note.
        reason:
          payload.reasonCode === "other"
            ? (payload.reason ?? "Other")
            : (REFUND_REASON_OPTIONS.find((option) => option.value === payload.reasonCode)?.label ??
              payload.reason ??
              ""),
        note: payload.reasonCode === "other" ? null : (payload.reason ?? null),
      });
      onNotice(
        `Refunded ${formatMoney(total)} on ${refunded.invoiceNo}.` +
          (heldUnits > 0 ? ` ${heldUnits} unit${heldUnits === 1 ? "" : "s"} held for inspection.` : ""),
      );
      reset();
    } catch (e) {
      // Over the tenant's limit: ask for an approver's PIN, then send the same refund again.
      if (e instanceof ApiError && e.code === "REFUND_APPROVAL_REQUIRED" && !payload.approval) {
        setPendingApproval({ payload, message: e.message });
        return;
      }
      onError(e instanceof Error ? e.message : "Refund failed");
      if (payload.approval) throw e;
    } finally {
      setBusy(false);
    }
  }

  function refund() {
    if (!reasonCode) {
      onError("Choose why it's coming back");
      return;
    }
    if (reasonCode === "other" && !note.trim()) {
      onError("Say what the reason is");
      return;
    }
    void submit({
      reasonCode,
      reason: note.trim() || undefined,
      items: selected.map(({ line, qty }) => ({
        productId: line.productId,
        batchId: line.batchId,
        qty,
        disposition: dispositionByKey[line.saleItemId] ?? "restock",
      })),
      ...(method === "as_paid" ? {} : { refundMethod: method }),
    });
  }

  const steps: Array<[Step, string]> = [
    ["find", "Find the sale"],
    ["items", "What's coming back"],
    ["refund", "Refund"],
  ];
  const stepIndex = steps.findIndex(([key]) => key === step);
  const split = sale ? previewAsPaid(sale, total) : [];
  const refundableRecent = recentSales.filter(
    (s) => s.status === "posted" || s.status === "partially_refunded",
  );

  return (
    <section className={`${css.card} ${css.returnsPanel}`}>
      <header className={css.rfHeader}>
        <div>
          <h2 className={css.returnsTitle}>Returns</h2>
          <p className={css.returnsSubtitle}>Refund a customer, and decide what happens to what comes back.</p>
        </div>
        <Link href="/purchasing/supplier-returns" className={css.rfSupplierLink}>
          <IconPackage size={14} /> Supplier returns
        </Link>
      </header>

      <SegmentedTabs
        ariaLabel="Returns"
        active={tab}
        onChange={setTab}
        items={[
          { id: "refund", label: "Refund" },
          { id: "recent", label: "Recent refunds", count: refunds.length || null },
        ]}
      />

      {tab === "recent" ? (
        refunds.length === 0 ? (
          <p className={css.pickerEmpty}>No refunds at this branch yet.</p>
        ) : (
          <ul className={css.rfRecentList}>
            {refunds.map((row) => {
              const held = row.items
                .filter((item) => item.disposition === "quarantine")
                .reduce((n, item) => n + item.qty, 0);
              return (
                <li key={row.id} className={css.rfRecentRow}>
                  <div className={css.rfRecentTop}>
                    <span className={css.rfStrong}>{row.returnNumber}</span>
                    <span className={css.rfStrong}>{formatMoney(row.amount)}</span>
                  </div>
                  <div className={css.rfMuted}>
                    {row.sale?.invoiceNo ?? "—"} · {formatDate(row.createdAt)} {formatTime(row.createdAt)} ·{" "}
                    {row.refundedBy.fullName}
                    {row.approvedBy ? ` · approved by ${row.approvedBy.fullName}` : ""}
                  </div>
                  <div className={css.rfMuted}>
                    {row.refundedTo.length > 0
                      ? row.refundedTo
                          .map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatMoney(p.amount)}`)
                          .join(" · ")
                      : null}
                    {row.reason ? `${row.refundedTo.length ? " · " : ""}${row.reason}` : ""}
                    {held > 0 ? ` · ${held} held` : ""}
                  </div>
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <>
          <ol className={css.rfSteps} aria-label="Refund steps">
            {steps.map(([key, label], index) => (
              <li
                key={key}
                className={`${css.rfStep}${index === stepIndex ? ` ${css.rfStepActive}` : ""}${
                  index < stepIndex ? ` ${css.rfStepDone}` : ""
                }`}
                aria-current={index === stepIndex ? "step" : undefined}
              >
                <span className={css.rfStepNum}>{index + 1}</span>
                {label}
              </li>
            ))}
          </ol>

          {step === "find" ? (
            <div className={css.rfBody}>
              <div className={css.returnsSearchField}>
                <IconSearch size={15} className={css.returnsSearchIcon} />
                <input
                  className={css.control}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void openSale(query);
                  }}
                  placeholder="Scan the receipt, or search invoice, customer or phone"
                  aria-label="Find the sale"
                  autoFocus
                />
              </div>
              {searching ? <p className={css.rfMuted}>Searching…</p> : null}
              {(hits.length > 0 ? hits : refundableRecent.slice(0, 8)).length > 0 ? (
                <>
                  <h3 className={css.returnsRecentTitle}>
                    {hits.length > 0 ? "Matching sales" : "Recent sales"}
                  </h3>
                  <ul className={css.rfSaleList}>
                    {(hits.length > 0
                      ? hits.map((hit) => ({
                          key: hit.id,
                          invoiceNo: hit.invoiceNo,
                          total: hit.grandTotal,
                          at: hit.soldAt,
                          who: hit.customer?.fullName ?? "Walk-in",
                          status: hit.status,
                        }))
                      : refundableRecent.slice(0, 8).map((s) => ({
                          key: s.id,
                          invoiceNo: s.invoiceNo,
                          total: s.grandTotal,
                          at: s.soldAt,
                          who: s.customerName ?? "Walk-in",
                          status: s.status,
                        }))
                    ).map((row) => (
                      <li key={row.key}>
                        <button
                          type="button"
                          className={css.rfSaleRow}
                          onClick={() => void openSale(row.invoiceNo)}
                          disabled={busy}
                        >
                          <span>
                            <span className={css.rfStrong}>{row.invoiceNo}</span>
                            <span className={css.rfMuted}>
                              {formatDate(row.at)} {formatTime(row.at)} · {row.who}
                              {row.status === "partially_refunded" ? " · part refunded" : ""}
                              {row.status === "refunded" ? " · refunded" : ""}
                              {row.status === "voided" ? " · voided" : ""}
                            </span>
                          </span>
                          <span className={css.rfStrong}>{formatMoney(row.total)}</span>
                          <IconChevronRight size={15} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className={css.rfMuted}>Type at least two characters to search.</p>
              )}
            </div>
          ) : null}

          {step !== "find" && sale && returnable ? (
            <div className={css.rfSaleBar}>
              <span>
                <span className={css.rfStrong}>{sale.invoiceNo}</span>
                <span className={css.rfMuted}>
                  {formatDate(sale.soldAt)} · {sale.customer?.fullName ?? "Walk-in"} · paid{" "}
                  {formatMoney(sale.grandTotal)}
                </span>
              </span>
              <StatusBadge
                status={sale.status}
                variant={
                  sale.status === "posted"
                    ? "success"
                    : sale.status === "partially_refunded"
                      ? "warning"
                      : "danger"
                }
                label={
                  sale.status === "posted"
                    ? "Sold"
                    : sale.status === "partially_refunded"
                      ? "Part refunded"
                      : sale.status === "refunded"
                        ? "Refunded"
                        : "Voided"
                }
              />
            </div>
          ) : null}

          {step === "items" && sale && returnable ? (
            <div className={css.rfBody}>
              {!refundable ? (
                <p className={css.rfNotice}>
                  {sale.status === "voided"
                    ? "This sale was voided, so there's nothing to refund."
                    : "Everything on this sale has already been refunded."}
                </p>
              ) : blockedControlled ? (
                <p className={css.rfNotice}>
                  This sale has controlled or prescription items. Ask a pharmacist or manager to
                  refund it.
                </p>
              ) : !canRefund ? (
                <p className={css.rfNotice}>Your role can&apos;t give refunds.</p>
              ) : null}

              <div className={css.rfItems}>
                {returnable.lines.map((line) => {
                  const qty = qtyByKey[line.saleItemId] ?? 0;
                  const disposition = dispositionByKey[line.saleItemId] ?? "restock";
                  const off = !canAct || line.remainingQty <= 0 || busy;
                  return (
                    <div
                      key={line.saleItemId}
                      className={`${css.rfItem}${qty > 0 ? ` ${css.rfItemOn}` : ""}`}
                    >
                      <div className={css.rfItemMain}>
                        <span className={css.rfStrong}>
                          {line.productName}
                          {line.isControlled || line.requiresPrescription ? (
                            <span className={css.tagRx}>Rx</span>
                          ) : null}
                        </span>
                        <span className={css.rfMuted}>
                          Batch {line.batchNo} · bought {line.soldQty} ·{" "}
                          {line.remainingQty > 0
                            ? `${line.remainingQty} can come back`
                            : "all returned"}{" "}
                          · {formatMoney(line.refundUnitPrice ?? line.unitPrice)} each
                        </span>
                      </div>
                      <div className={css.rfItemControls}>
                        <div className={css.qtyGroup}>
                          <button
                            type="button"
                            className={css.qtyBtn}
                            disabled={off || qty <= 0}
                            aria-label={`One less ${line.productName}`}
                            onClick={() => stepQty(line.saleItemId, line.remainingQty, -1)}
                          >
                            <IconMinus size={13} />
                          </button>
                          <span className={css.rfQty} aria-live="polite">
                            {qty}
                          </span>
                          <button
                            type="button"
                            className={css.qtyBtn}
                            disabled={off || qty >= line.remainingQty}
                            aria-label={`One more ${line.productName}`}
                            onClick={() => stepQty(line.saleItemId, line.remainingQty, 1)}
                          >
                            <IconPlus size={13} />
                          </button>
                        </div>
                        <div
                          className={css.dispositionToggle}
                          role="group"
                          aria-label={`What happens to returned ${line.productName}`}
                        >
                          {(
                            [
                              ["restock", "Shelf"],
                              ["quarantine", "Hold"],
                            ] as const
                          ).map(([value, label]) => (
                            <button
                              key={value}
                              type="button"
                              aria-pressed={disposition === value}
                              disabled={off}
                              data-tooltip={
                                value === "restock"
                                  ? "Back on the shelf, ready to sell"
                                  : "Held in quarantine until a pharmacist releases it"
                              }
                              onClick={() =>
                                setDispositionByKey((prev) => ({ ...prev, [line.saleItemId]: value }))
                              }
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className={css.rfFooter}>
                <button type="button" className={css.toolBtn} onClick={reset} disabled={busy}>
                  <IconChevronLeft size={15} /> Another sale
                </button>
                {canAct ? (
                  <button type="button" className={css.toolBtn} onClick={returnAll} disabled={busy}>
                    Return everything
                  </button>
                ) : null}
                <span className={css.rfTotal}>
                  {selected.length > 0 ? formatMoney(total) : "Nothing chosen"}
                </span>
                <button
                  type="button"
                  className={css.rfPrimary}
                  onClick={() => setStep("refund")}
                  disabled={!canAct || selected.length === 0}
                >
                  Next <IconChevronRight size={15} />
                </button>
              </div>
            </div>
          ) : null}

          {step === "refund" && sale && returnable ? (
            <div className={css.rfBody}>
              <ul className={css.rfSummary}>
                {selected.map(({ line, qty }) => (
                  <li key={line.saleItemId}>
                    <span>
                      {line.productName} × {qty}
                      <span className={css.rfMuted}>
                        {" "}
                        · {dispositionByKey[line.saleItemId] === "quarantine" ? "held for inspection" : "back on the shelf"}
                      </span>
                    </span>
                    <span>{formatMoney(qty * Number(line.refundUnitPrice ?? line.unitPrice))}</span>
                  </li>
                ))}
              </ul>

              <div className={css.rfField}>
                <span className={css.rfLabel}>Why is it coming back?</span>
                <div className={css.rfChips} role="radiogroup" aria-label="Reason">
                  {REFUND_REASON_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={reasonCode === option.value}
                      className={`${css.rfChip}${reasonCode === option.value ? ` ${css.rfChipOn}` : ""}`}
                      onClick={() => setReasonCode(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <input
                  className={css.control}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  placeholder={reasonCode === "other" ? "What's the reason? (required)" : "Note (optional)"}
                  aria-label="Note"
                />
              </div>

              <div className={css.rfField}>
                <span className={css.rfLabel}>Refund to</span>
                <div className={css.rfChips} role="radiogroup" aria-label="Refund to">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={method === "as_paid"}
                    className={`${css.rfChip}${method === "as_paid" ? ` ${css.rfChipOn}` : ""}`}
                    onClick={() => setMethod("as_paid")}
                  >
                    As paid ·{" "}
                    {split.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatMoney(p.amount)}`).join(" + ")}
                  </button>
                  {METHOD_CHOICES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      role="radio"
                      aria-checked={method === choice}
                      className={`${css.rfChip}${method === choice ? ` ${css.rfChipOn}` : ""}`}
                      onClick={() => setMethod(choice)}
                    >
                      {PAYMENT_METHOD_LABELS[choice]}
                    </button>
                  ))}
                </div>
              </div>

              <div className={css.rfFooter}>
                <button type="button" className={css.toolBtn} onClick={() => setStep("items")} disabled={busy}>
                  <IconChevronLeft size={15} /> Back
                </button>
                <span className={css.rfTotal}>{formatMoney(total)}</span>
                <button type="button" className={css.rfPrimary} onClick={refund} disabled={busy}>
                  <IconRotateCcw size={15} /> Refund {formatMoney(total)}
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <PosPharmacistPinModal
        open={pendingApproval !== null}
        title="Approve this refund"
        description={pendingApproval?.message}
        confirmLabel="Approve & refund"
        emptyText="Nobody at this branch can approve refunds over the limit. Ask an owner to grant Approve returns."
        loadApprovers={listRefundApprovers}
        onClose={() => setPendingApproval(null)}
        onError={onError}
        onApprove={async (approval) => {
          if (!pendingApproval) return;
          await submit({ ...pendingApproval.payload, approval });
        }}
      />

      <PosRefundReceiptModal
        receipt={receipt}
        onClose={() => setReceipt(null)}
        preferences={receiptPreferences}
        organization={organization}
      />
    </section>
  );
}
