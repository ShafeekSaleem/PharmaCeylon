"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconChevronRight, IconInfo, IconMinus, IconPlus, IconSearch } from "@/components/icons";
import { ApiError } from "@/lib/api-error";
import {
  fetchSaleReturnable,
  findSaleByInvoice,
  listRefundApprovers,
  listRefunds,
  refundSale,
  searchInvoices,
  type InvoiceSearchHit,
  type RefundDisposition,
  type RefundReason,
  type RefundRow,
  type RefundSalePayload,
  type SaleReturnable,
} from "../services/pos-api";
import { PAYMENT_METHOD_LABELS } from "../constants";
import type { PaymentMethod, RecentSale, SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import { PosPharmacistPinModal } from "./pos-pharmacist-pin-modal";
import { PosRefundReceiptModal, type RefundReceipt } from "./pos-refund-receipt-modal";
import type { ReceiptPreferences } from "./pos-receipt-modal";
import tcss from "../till.module.css";

export type ReturnsSlots = {
  search: ReactNode;
  body: ReactNode;
  recentOpen: boolean;
  toggleRecent: () => void;
};

type Props = {
  canRefund: boolean;
  canRefundControlled: boolean;
  recentSales: RecentSale[];
  /** Open this invoice straight away — "Return items" on the last sale. */
  initialInvoice: string | null;
  onInitialInvoiceUsed: () => void;
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  receiptPreferences: ReceiptPreferences;
  organization: { displayName: string; logoUrl: string | null } | null;
  children: (slots: ReturnsSlots) => ReactNode;
};

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
const METHOD_SHORT: Record<PaymentMethod, string> = { cash: "Cash", card: "Card", mobile_wallet: "Wallet" };
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
 * The one door for a customer return, laid out like a sale: find it from the till bar, choose
 * what's coming back on the left (and whether each item goes back on the shelf or is held for a
 * pharmacist), refund on the right. Over the tenant's limit an approver signs it off with their
 * till PIN. The page places the pieces through `children`.
 */
export function PosReturnsPanel({
  canRefund,
  canRefundControlled,
  recentSales,
  initialInvoice,
  onInitialInvoiceUsed,
  onRefunded,
  onError,
  onNotice,
  receiptPreferences,
  organization,
  children,
}: Props) {
  const [recentOpen, setRecentOpen] = useState(false);
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
  const searchRef = useRef<HTMLInputElement>(null);

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
    setSale(null);
    setReturnable(null);
    setQuery("");
    setReasonCode("");
    setNote("");
    setMethod("as_paid");
    window.setTimeout(() => searchRef.current?.focus(), 0);
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
        setRecentOpen(false);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Invoice not found");
      } finally {
        setBusy(false);
      }
    },
    [applyReturnable, onError],
  );

  useEffect(() => {
    if (!initialInvoice) return;
    onInitialInvoiceUsed();
    void openSale(initialInvoice);
  }, [initialInvoice, onInitialInvoiceUsed, openSale]);

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
  const units = selected.reduce((n, row) => n + row.qty, 0);
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
    setQtyByKey(Object.fromEntries(returnable.lines.map((line) => [line.saleItemId, line.remainingQty])));
  }

  async function submit(payload: RefundSalePayload, approvedBy?: string) {
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
        approvedBy: approvedBy ?? null,
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

  const reasonMissing = !reasonCode
    ? "Choose why it's coming back"
    : reasonCode === "other" && !note.trim()
      ? "Say what the reason is"
      : null;
  const nothingChosen = selected.length === 0 ? "Choose what's coming back" : null;
  const refundBlocked = !canAct
    ? !canRefund
      ? "Your role can't give refunds"
      : blockedControlled
        ? "A pharmacist or manager refunds this sale"
        : "Nothing on this sale can be refunded"
    : (nothingChosen ?? reasonMissing);

  function refund() {
    if (refundBlocked) return;
    void submit({
      reasonCode: reasonCode as RefundReason,
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

  const split = sale ? previewAsPaid(sale, total) : [];
  const refundableRecent = recentSales.filter((s) => s.status === "posted" || s.status === "partially_refunded");
  const saleRows = (hits.length > 0
    ? hits.map((hit) => ({
        key: hit.id,
        invoiceNo: hit.invoiceNo,
        total: hit.grandTotal,
        at: hit.soldAt,
        who: hit.customer?.fullName ?? "Walk-in",
        status: hit.status,
      }))
    : refundableRecent.slice(0, 12).map((s) => ({
        key: s.id,
        invoiceNo: s.invoiceNo,
        total: s.grandTotal,
        at: s.soldAt,
        who: s.customerName ?? "Walk-in",
        status: s.status,
      })));

  /* ── The pieces ───────────────────────────────────────── */

  const search = (
    <div className={tcss.searchWrap}>
      <label className={tcss.searchField}>
        <IconSearch size={18} />
        <input
          ref={searchRef}
          className={tcss.searchInput}
          value={query}
          autoFocus
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setRecentOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void openSale(query);
          }}
          placeholder="Scan the receipt, or search invoice, customer or phone"
          aria-label="Find the sale"
        />
      </label>
    </div>
  );

  const recentList = (
    <section aria-label="Recent refunds" className={tcss.ticket}>
      <div className={tcss.ticketHead}>
        <span className={tcss.ticketTitle}>Recent refunds</span>
        <span className={tcss.counts}>At this branch, newest first</span>
        <span className={tcss.spacer} />
        <button type="button" className={tcss.linkBtn} onClick={() => setRecentOpen(false)}>
          Back to returns
        </button>
      </div>
      {refunds.length === 0 ? (
        <div className={tcss.ready}>
          <span className={tcss.readyHint}>No refunds at this branch yet.</span>
        </div>
      ) : (
        <ul className={tcss.saleList}>
          {refunds.map((row) => {
            const held = row.items.filter((i) => i.disposition === "quarantine").reduce((n, i) => n + i.qty, 0);
            return (
              <li key={row.id} className={tcss.saleRow} style={{ cursor: "default" }}>
                <span className={tcss.saleRowMain}>
                  <span className={tcss.saleRowNo}>{row.returnNumber}</span>
                  <span className={tcss.saleRowMeta}>
                    {row.sale?.invoiceNo ?? "—"} · {formatDate(row.createdAt)} {formatTime(row.createdAt)} ·{" "}
                    {row.refundedBy.fullName}
                    {row.approvedBy ? ` · approved by ${row.approvedBy.fullName}` : ""}
                  </span>
                  <span className={tcss.saleRowMeta}>
                    {row.refundedTo.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatAmount(p.amount)}`).join(" · ")}
                    {row.reason ? `${row.refundedTo.length ? " · " : ""}${row.reason}` : ""}
                    {held > 0 ? ` · ${held} held` : ""}
                  </span>
                </span>
                <span className={tcss.saleRowAmount}>{formatMoney(row.amount)}</span>
                <span />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  const findList = (
    <section aria-label="Find the sale" className={tcss.ticket}>
      <div className={tcss.ticketHead}>
        <span className={tcss.ticketTitle}>{hits.length > 0 ? "Matching sales" : "Recent sales"}</span>
        <span className={tcss.counts}>{searching ? "Searching…" : "Pick the sale the customer is returning from"}</span>
      </div>
      {saleRows.length === 0 ? (
        <div className={tcss.ready}>
          <span className={tcss.readyHint}>
            {query.trim().length >= 2 && !searching
              ? `No sale matches “${query.trim()}”.`
              : "Scan the receipt barcode, or type an invoice number, customer name or phone."}
          </span>
        </div>
      ) : (
        <ul className={tcss.saleList}>
          {saleRows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                className={tcss.saleRow}
                onClick={() => void openSale(row.invoiceNo)}
                disabled={busy}
              >
                <span className={tcss.saleRowMain}>
                  <span className={tcss.saleRowNo}>{row.invoiceNo}</span>
                  <span className={tcss.saleRowMeta}>
                    {formatDate(row.at)} {formatTime(row.at)} · {row.who}
                    {row.status === "partially_refunded" ? " · part refunded" : ""}
                    {row.status === "refunded" ? " · refunded" : ""}
                    {row.status === "voided" ? " · voided" : ""}
                  </span>
                </span>
                <span className={tcss.saleRowAmount}>{formatMoney(row.total)}</span>
                <IconChevronRight size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const itemsPane =
    sale && returnable ? (
      <section aria-label="What is coming back" className={tcss.ticket}>
        <div className={tcss.ticketHead}>
          <span className={tcss.ticketTitle}>{sale.invoiceNo}</span>
          <span className={tcss.counts}>
            {formatDate(sale.soldAt)} {formatTime(sale.soldAt)} · {sale.customer?.fullName ?? "Walk-in"} · paid{" "}
            {formatMoney(sale.grandTotal)}
          </span>
          <span className={tcss.spacer} />
          {canAct && (
            <button type="button" className={tcss.smallBtn} onClick={returnAll} disabled={busy}>
              Return everything
            </button>
          )}
          <button type="button" className={tcss.linkBtn} onClick={reset} disabled={busy}>
            Another sale
          </button>
        </div>
        {!refundable ? (
          <div className={tcss.warnBar}>
            {sale.status === "voided"
              ? "This sale was voided, so there's nothing to refund."
              : "Everything on this sale has already been refunded."}
          </div>
        ) : blockedControlled ? (
          <div className={tcss.warnBar}>
            This sale has controlled or prescription items. Ask a pharmacist or manager to refund it.
          </div>
        ) : !canRefund ? (
          <div className={tcss.warnBar}>Your role can&apos;t give refunds.</div>
        ) : null}
        <div className={tcss.rcols} aria-hidden>
          <span>Item</span>
          <span className={tcss.center}>Bought</span>
          <span className={tcss.center}>Coming back</span>
          <span className={tcss.center}>Then</span>
          <span className={tcss.right}>Refund</span>
        </div>
        <div className={tcss.lines}>
          {returnable.lines.map((line) => {
            const qty = qtyByKey[line.saleItemId] ?? 0;
            const disposition = dispositionByKey[line.saleItemId] ?? "restock";
            const off = !canAct || line.remainingQty <= 0 || busy;
            const each = Number(line.refundUnitPrice ?? line.unitPrice);
            return (
              <div key={line.saleItemId} className={`${tcss.rline}${qty > 0 ? ` ${tcss.rlineOn}` : ""}`}>
                <div className={tcss.lineMain}>
                  <span className={tcss.lineTitle}>
                    <span className={tcss.rlineName}>{line.productName}</span>
                    {line.isControlled ? (
                      <span className={`${tcss.tag} ${tcss.tagCtrl}`}>CONTROLLED</span>
                    ) : line.requiresPrescription ? (
                      <span className={`${tcss.tag} ${tcss.tagRx}`}>Rx</span>
                    ) : null}
                  </span>
                  <span className={tcss.lineMeta}>
                    {formatAmount(each)} each · Batch {line.batchNo}
                    {line.remainingQty < line.soldQty
                      ? ` · ${line.soldQty - line.remainingQty} already returned`
                      : ""}
                  </span>
                </div>
                <span className={tcss.center} style={{ fontSize: 15 }}>
                  {line.soldQty}
                </span>
                <div className={tcss.stepper}>
                  <button
                    type="button"
                    className={tcss.stepBtn}
                    disabled={off || qty <= 0}
                    aria-label={`One less ${line.productName}`}
                    onClick={() => stepQty(line.saleItemId, line.remainingQty, -1)}
                  >
                    <IconMinus size={15} />
                  </button>
                  <span className={tcss.qtyInput} style={{ display: "grid", placeItems: "center" }} aria-live="polite">
                    {qty}
                  </span>
                  <button
                    type="button"
                    className={tcss.stepBtn}
                    disabled={off || qty >= line.remainingQty}
                    aria-label={`One more ${line.productName}`}
                    onClick={() => stepQty(line.saleItemId, line.remainingQty, 1)}
                  >
                    <IconPlus size={15} />
                  </button>
                </div>
                <div className={tcss.disposition}>
                  {qty > 0 ? (
                    <div className={tcss.dispToggle} role="group" aria-label={`What happens to returned ${line.productName}`}>
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
                          className={`${tcss.dispBtn}${
                            disposition === value ? ` ${value === "restock" ? tcss.dispShelf : tcss.dispHold}` : ""
                          }`}
                          title={
                            value === "restock"
                              ? "Back on the shelf, ready to sell"
                              : "Held in quarantine until a pharmacist releases it"
                          }
                          onClick={() => setDispositionByKey((prev) => ({ ...prev, [line.saleItemId]: value }))}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span>—</span>
                  )}
                </div>
                <span className={qty > 0 ? tcss.lineTotal : tcss.right}>
                  {qty > 0 ? formatAmount(qty * each) : "—"}
                </span>
              </div>
            );
          })}
        </div>
        <div className={tcss.returnsFoot}>
          <IconInfo size={16} />
          <span>
            <b>Shelf</b> puts it back on sale. <b>Hold</b> quarantines it for the pharmacist to check — prescription
            and controlled items start on Hold.
          </span>
        </div>
      </section>
    ) : null;

  const refundPane =
    sale && returnable ? (
      <aside aria-label="Refund" className={tcss.pay}>
        <div className={tcss.totalBlock}>
          <span className={tcss.label}>Refund</span>
          <span className={tcss.totalAmount}>{formatMoney(total)}</span>
          <span className={tcss.heldMeta}>
            {units === 0
              ? "Nothing chosen yet"
              : `${units} unit${units === 1 ? "" : "s"} · ${units - heldUnits} back on the shelf, ${heldUnits} held`}
          </span>
        </div>

        <div className={tcss.payBlock}>
          <span className={tcss.label}>Why is it coming back?</span>
          <div className={tcss.reasonChips} role="radiogroup" aria-label="Reason">
            {REFUND_REASON_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={reasonCode === option.value}
                className={`${tcss.reasonChip}${reasonCode === option.value ? ` ${tcss.reasonChipOn}` : ""}`}
                onClick={() => setReasonCode(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            className={tcss.noteInput}
            style={{ flex: "none", height: 40 }}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder={reasonCode === "other" ? "What's the reason? (required)" : "Note (optional)"}
            aria-label="Note"
          />
        </div>

        <div className={tcss.payBlock}>
          <span className={tcss.label}>Refund to</span>
          <div className={tcss.methods} role="radiogroup" aria-label="Refund to">
            <button
              type="button"
              role="radio"
              aria-checked={method === "as_paid"}
              className={`${tcss.method} ${tcss.methodCompact}${method === "as_paid" ? ` ${tcss.methodOn}` : ""}`}
              onClick={() => setMethod("as_paid")}
              title={split.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatAmount(p.amount)}`).join(" + ")}
            >
              As paid
              <span className={tcss.methodSub}>
                {split.length > 0 ? split.map((p) => METHOD_SHORT[p.method]).join(" + ") : "—"}
              </span>
            </button>
            {METHOD_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={method === choice}
                className={`${tcss.method} ${tcss.methodCompact}${method === choice ? ` ${tcss.methodOn}` : ""}`}
                onClick={() => setMethod(choice)}
              >
                {METHOD_SHORT[choice]}
              </button>
            ))}
          </div>
          {method === "as_paid" && split.length > 1 && (
            <span className={tcss.heldMeta}>
              {split.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatAmount(p.amount)}`).join(" + ")}
            </span>
          )}
        </div>

        <div className={tcss.grow} />

        <div className={tcss.payFoot}>
          {refundBlocked && <span className={tcss.blockedHint}>{refundBlocked}</span>}
          <button
            type="button"
            className={tcss.completeBtn}
            onClick={refund}
            disabled={busy || refundBlocked !== null}
          >
            <span>{busy ? "Refunding…" : "Refund"}</span>
            <span>{formatMoney(total)}</span>
          </button>
          <span className={tcss.blockedHint}>Refunds over the approval limit ask for an approver&apos;s till PIN here.</span>
        </div>
      </aside>
    ) : (
      <aside aria-label="Refunds" className={tcss.pay}>
        <div className={tcss.totalBlock}>
          <span className={tcss.label}>Returns</span>
          <span className={tcss.doneTitle}>Find the sale first</span>
          <span className={tcss.heldMeta}>
            Scan the receipt or pick the sale on the left. You&apos;ll choose what&apos;s coming back, why, and how
            the money goes back.
          </span>
        </div>
        <div className={tcss.rule} />
        <div className={tcss.payBlock}>
          <div className={tcss.lastSaleTop}>
            <span className={tcss.label}>Latest refunds</span>
            {refunds.length > 0 && (
              <button type="button" className={tcss.linkBtn} onClick={() => setRecentOpen(true)}>
                See all
              </button>
            )}
          </div>
          {refunds.length === 0 ? (
            <span className={tcss.emptyNote}>No refunds at this branch yet.</span>
          ) : (
            refunds.slice(0, 4).map((row) => (
              <div key={row.id} className={tcss.heldRow}>
                <div className={tcss.heldMain}>
                  <span className={tcss.heldName}>{row.returnNumber}</span>
                  <span className={tcss.heldMeta}>
                    {row.sale?.invoiceNo ?? "—"} · {formatTime(row.createdAt)}
                    {row.reason ? ` · ${row.reason}` : ""}
                  </span>
                </div>
                <span className={tcss.saleRowAmount}>{formatMoney(row.amount)}</span>
              </div>
            ))
          )}
        </div>
        <div className={tcss.grow} />
        <div className={tcss.menuHint}>
          <b>Sending stock back to a supplier?</b>
          <span>
            That&apos;s a supplier return — <Link href="/purchasing/supplier-returns">open Supplier returns</Link>.
          </span>
        </div>
      </aside>
    );

  const body = (
    <>
      {recentOpen ? recentList : (itemsPane ?? findList)}
      {refundPane}
      <PosPharmacistPinModal
        open={pendingApproval !== null}
        title="Approve this refund"
        description={pendingApproval?.message}
        confirmLabel="Approve & refund"
        emptyText="Nobody at this branch can approve refunds over the limit. Ask an owner to grant Approve returns."
        loadApprovers={listRefundApprovers}
        onClose={() => setPendingApproval(null)}
        onError={onError}
        onApprove={async (approval, approverName) => {
          if (!pendingApproval) return;
          await submit({ ...pendingApproval.payload, approval }, approverName);
        }}
      />
      <PosRefundReceiptModal
        receipt={receipt}
        onClose={() => setReceipt(null)}
        preferences={receiptPreferences}
        organization={organization}
      />
    </>
  );

  return <>{children({ search, body, recentOpen, toggleRecent: () => setRecentOpen((v) => !v) })}</>;
}
