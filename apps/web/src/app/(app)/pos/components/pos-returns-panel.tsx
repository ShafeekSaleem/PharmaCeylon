"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import {
  IconInfo,
  IconMinus,
  IconPlus,
  IconPrinter,
  IconSearch,
} from "@/components/icons";
import { ToggleSwitch } from "@/components/ui";
import { ApiError } from "@/lib/api-error";
import {
  fetchSaleReturnable,
  fetchSalesInRange,
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
import { METHOD_ICONS } from "./pos-pay-panel";
import { PosPharmacistPinModal } from "./pos-pharmacist-pin-modal";
import { PosRefundReceiptModal, type RefundReceipt } from "./pos-refund-receipt-modal";
import {
  InvoiceDetails,
  ReturnSalesList,
  ReturnsHeader,
  type PaymentFilter,
  type ReturnStep,
  type SalesRange,
} from "./pos-returns-find";
import { PosReturnHistoryModal } from "./pos-sale-card";
import type { ReceiptPreferences } from "./pos-receipt-modal";
import tcss from "../till.module.css";

export type ReturnsSlots = {
  search: ReactNode;
  /** Title, the 1–2–3 steps and Return history, above the two panels. */
  header: ReactNode;
  body: ReactNode;
};

type Props = {
  canRefund: boolean;
  canRefundControlled: boolean;
  /** Open this invoice straight away — "Return items" on the last sale. */
  initialInvoice: string | null;
  onInitialInvoiceUsed: () => void;
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  receiptPreferences: ReceiptPreferences;
  organization: { displayName: string; logoUrl: string | null } | null;
  /** Print a sale's receipt again — the page owns the sale receipt popup. */
  onReprintSale: (sale: Pick<RecentSale, "invoiceNo">) => void;
  /** The find-a-sale box, owned by the page so `/` can reach it. */
  inputRef: RefObject<HTMLInputElement>;
  /** Tells the page when this panel has a dialog up, so till shortcuts stand down behind it. */
  onOverlayChange: (open: boolean) => void;
  /** Where "Print receipt" starts — the tenant's auto-print setting, the same as a sale's. */
  printByDefault: boolean;
  /** Set to this panel's Refund action, so F4 refunds in Returns as it completes a sale in Sale. */
  refundTriggerRef: MutableRefObject<(() => void) | null>;
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
const METHOD_SHORT: Record<PaymentMethod, string> = { cash: "Cash", card: "Card", mobile_wallet: "Wallet" };
const SPLIT_ORDER: PaymentMethod[] = ["card", "mobile_wallet", "cash"];

/**
 * What "as paid" will do, for the screen — the same rule the server applies: what each method
 * took less what has gone back to it (cash net of change), card and wallet first, cash last.
 */
/** What each method took on the sale, cash net of change, less what has already gone back to it. */
function netPaid(sale: SaleReceipt): Map<PaymentMethod, number> {
  const left = new Map<PaymentMethod, number>();
  for (const payment of sale.payments) {
    left.set(payment.method, (left.get(payment.method) ?? 0) + Number(payment.amount));
  }
  if (left.has("cash")) left.set("cash", (left.get("cash") ?? 0) - Number(sale.changeDue));
  return left;
}

/** The methods the customer actually paid with, for the Original payment box and the default. */
function paidMethods(sale: SaleReceipt): Array<{ method: PaymentMethod; amount: number }> {
  const paid = new Map<PaymentMethod, number>();
  for (const payment of sale.payments) {
    if (Number(payment.amount) > 0) paid.set(payment.method, (paid.get(payment.method) ?? 0) + Number(payment.amount));
  }
  if (paid.has("cash")) paid.set("cash", (paid.get("cash") ?? 0) - Number(sale.changeDue));
  return [...paid].filter(([, amount]) => amount > 0).map(([method, amount]) => ({ method, amount }));
}

function previewAsPaid(sale: SaleReceipt, total: number) {
  const left = netPaid(sale);
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

/** A refund's receipt again, from the list — the same reason/note split the refund itself prints. */
function receiptFromRefund(row: RefundRow): RefundReceipt {
  const label = REFUND_REASON_OPTIONS.find((option) => option.value === row.reasonCode)?.label;
  const other = row.reasonCode === "other" || !label;
  return {
    returnNumber: row.returnNumber,
    invoiceNo: row.sale?.invoiceNo ?? "—",
    at: row.createdAt,
    customerName: row.customerName,
    lines: row.items.map((item) => ({
      name: item.product.name,
      batchNo: item.batchNo ?? "",
      qty: item.qty,
      amount: item.qty * Number(item.unitPrice),
      held: item.disposition === "quarantine",
    })),
    refundedTo: row.refundedTo.map((p) => ({ method: p.method, amount: Number(p.amount) })),
    reason: other ? (row.reason ?? "Other") : label,
    note: other ? null : row.reason,
    approvedBy: row.approvedBy?.fullName ?? null,
  };
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
  initialInvoice,
  onInitialInvoiceUsed,
  onRefunded,
  onError,
  onNotice,
  receiptPreferences,
  organization,
  onReprintSale,
  inputRef,
  onOverlayChange,
  printByDefault,
  refundTriggerRef,
  children,
}: Props) {
  const [query, setQuery] = useState("");
  const [sale, setSale] = useState<SaleReceipt | null>(null);
  const [returnable, setReturnable] = useState<SaleReturnable | null>(null);
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({});
  const [dispositionByKey, setDispositionByKey] = useState<Record<string, RefundDisposition>>({});
  const [reasonCode, setReasonCode] = useState<RefundReason | "">("");
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<MethodChoice>("as_paid");
  const [busy, setBusy] = useState(false);
  /**
   * The invoice being opened from elsewhere ("Return items" on a sale card). Seeded from the prop so
   * the first render already shows it loading, rather than the recent-sales list flashing first.
   */
  const [openingInvoice, setOpeningInvoice] = useState<string | null>(initialInvoice);
  const [hits, setHits] = useState<InvoiceSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{
    payload: RefundSalePayload;
    message: string;
  } | null>(null);
  const [receipt, setReceipt] = useState<RefundReceipt | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const [printReceipt, setPrintReceipt] = useState(printByDefault);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Steps 2–3: choosing what comes back. Step 1 lists sales and shows the chosen one's details. */
  const [pickingItems, setPickingItems] = useState(false);
  /** Set while a sale opened from elsewhere loads straight into steps 2–3. */
  const [openingToPick, setOpeningToPick] = useState(Boolean(initialInvoice));
  const [range, setRange] = useState<SalesRange>({ kind: "today" });
  const [payment, setPayment] = useState<PaymentFilter>("all");
  const [lane, setLane] = useState<RecentSale[]>([]);
  const [laneLoading, setLaneLoading] = useState(false);
  const rangeKey = range.kind === "date" ? range.date : range.kind;

  const loadLane = useCallback(() => {
    setLaneLoading(true);
    fetchSalesInRange(
      range.kind === "today" ? { days: 1 } : range.kind === "week" ? { days: 7 } : { date: range.date },
    )
      .then(setLane)
      .catch(() => setLane([]))
      .finally(() => setLaneLoading(false));
    // The range is read through its key, so a new object for the same range doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);
  useEffect(loadLane, [loadLane]);

  const [autoPrintRefund, setAutoPrintRefund] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = inputRef;

  const overlayOpen = pendingApproval !== null || receipt !== null || historyOpen;
  useEffect(() => {
    onOverlayChange(overlayOpen);
  }, [overlayOpen, onOverlayChange]);
  useEffect(() => () => onOverlayChange(false), [onOverlayChange]);

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
    setPickingItems(false);
    setQuery("");
    setReasonCode("");
    setNote("");
    setMethod("as_paid");
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  const openSale = useCallback(
    async (term: string, pick = false) => {
      if (!term.trim()) return;
      setBusy(true);
      try {
        const found = await findSaleByInvoice(term);
        const data = await fetchSaleReturnable(found.id);
        setSale(found);
        applyReturnable(data);
        if (pick) {
          setHits([]);
          setQuery("");
        }
        setPickingItems(pick);
        setReasonCode("");
        setNote("");
        // Back the way they paid: their one method, or split across them when they paid several ways.
        const methods = paidMethods(found);
        setMethod(methods.length === 1 ? methods[0]!.method : "as_paid");
      } catch (e) {
        onError(e instanceof Error ? e.message : "Invoice not found");
      } finally {
        setBusy(false);
        setOpeningInvoice(null);
        setOpeningToPick(false);
      }
    },
    [applyReturnable, onError],
  );

  useEffect(() => {
    if (!initialInvoice) return;
    setOpeningInvoice(initialInvoice);
    setOpeningToPick(true);
    onInitialInvoiceUsed();
    void openSale(initialInvoice, true);
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
      loadLane();
      setPickingItems(false);
      // The refund's own payment rows carry its return number.
      const rows = refunded.payments.filter(
        (p) => Number(p.amount) < 0 && p.reference?.startsWith("POS refund "),
      );
      const returnNumber = rows[rows.length - 1]?.reference?.replace("POS refund ", "") ?? "";
      const mine = rows.filter((p) => p.reference === `POS refund ${returnNumber}`);
      const printed: RefundReceipt = {
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
      };
      // With "Print receipt" off the refund just completes; it can be reprinted from Recent refunds.
      if (printReceipt) {
        setAutoPrintRefund(true);
        setReceipt(printed);
      }
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

  // F4 refunds here; refund() itself says no while anything is missing.
  useEffect(() => {
    refundTriggerRef.current = refund;
    return () => {
      refundTriggerRef.current = null;
    };
  });

  const closeReceipt = useCallback(() => {
    setReceipt(null);
    setAutoPrintRefund(false);
  }, []);

  const split = sale ? previewAsPaid(sale, total) : [];
  const original = sale ? paidMethods(sale) : [];
  const searchedFor = query.trim();
  const listSales: RecentSale[] =
    searchedFor.length >= 2
      ? hits.map((hit) => ({
          id: hit.id,
          invoiceNo: hit.invoiceNo,
          status: hit.status,
          soldAt: hit.soldAt,
          grandTotal: hit.grandTotal,
          itemCount: hit._count.items,
          customerName: hit.customer?.fullName ?? null,
          sellerName: hit.sellerName,
          paymentMethods: hit.paymentMethods ?? [],
          productIds: [],
          summary: "",
        }))
      : lane;

  // Why the chosen sale can't move on to choosing items, said as the reason.
  const detailsBlocked = !sale || !returnable
    ? "Pick a sale first"
    : !refundable
      ? sale.status === "voided"
        ? "This sale was voided, so nothing can be returned."
        : "Everything on this sale has already been returned."
      : !canRefund
        ? "Your role can't give refunds."
        : blockedControlled
          ? "It has controlled or prescription items — a pharmacist or manager returns it."
          : null;

  const step: ReturnStep = !pickingItems || !sale ? 1 : selected.length > 0 ? 3 : 2;

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
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const term = hits[0]?.invoiceNo ?? query.trim();
            if (!term) return;
            setOpeningInvoice(term);
            void openSale(term);
          }}
          placeholder="Scan the receipt, or search invoice, customer or phone"
          aria-label="Find the sale"
        />
        <span className={tcss.kbd}>/</span>
      </label>
    </div>
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
          <button type="button" className={tcss.linkBtn} onClick={() => setPickingItems(false)} disabled={busy}>
            Back to sale details
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
                          data-tooltip={
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
      <aside aria-label="Refund" className={`${tcss.pay} ${tcss.payPinned}`}>
        <div className={tcss.payBlock}>
          <span className={tcss.label}>Refund summary</span>
          <div className={tcss.breakdown}>
            <div className={tcss.breakdownRow}>
              <span>Items to return</span>
              <b className={tcss.strongText}>
                {selected.length} item{selected.length === 1 ? "" : "s"} ({units} unit{units === 1 ? "" : "s"})
              </b>
            </div>
          </div>
          <div className={tcss.change}>
            <span>Total refund</span>
            <span className={tcss.changeAmount}>{formatMoney(total)}</span>
          </div>
          {units > 0 && (
            <span className={tcss.heldMeta}>
              {units - heldUnits} back on the shelf · {heldUnits} held for the pharmacist
            </span>
          )}
        </div>

        {/* The middle scrolls when it must; the total and Refund always stay in view. */}
        <div className={tcss.payScroll}>
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
            <span className={tcss.label}>Original payment method</span>
            <div className={tcss.origPay}>
              {original.length === 0 ? (
                <span className={tcss.emptyNote}>No payment recorded on this sale.</span>
              ) : (
                original.map((p) => (
                  <div key={p.method} className={tcss.origPayRow}>
                    <span className={tcss.origPayMethod}>
                      {METHOD_ICONS[p.method]}
                      {PAYMENT_METHOD_LABELS[p.method]}
                    </span>
                    <span>{formatMoney(p.amount)}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className={tcss.payBlock}>
            <span className={tcss.label}>Refund method</span>
            <div className={tcss.methods} role="radiogroup" aria-label="Refund method">
              {(["cash", "card", "mobile_wallet", "split"] as const).map((choice) => {
                const value: MethodChoice = choice === "split" ? "as_paid" : choice;
                // Split means "back the way they paid", which only differs from one method when they paid several ways.
                const off = choice === "split" && original.length < 2;
                return (
                  <button
                    key={choice}
                    type="button"
                    role="radio"
                    aria-checked={method === value}
                    disabled={off}
                    data-tooltip={off ? "They paid one way — choose that method" : undefined}
                    className={`${tcss.method} ${tcss.methodCompact}${method === value ? ` ${tcss.methodOn}` : ""}`}
                    onClick={() => setMethod(value)}
                  >
                    {METHOD_ICONS[choice]}
                    {choice === "split" ? "Split" : METHOD_SHORT[choice]}
                  </button>
                );
              })}
            </div>
            {method === "as_paid" && split.length > 0 && total > 0 && (
              <span className={tcss.heldMeta}>
                {split.map((p) => `${PAYMENT_METHOD_LABELS[p.method]} ${formatAmount(p.amount)}`).join(" + ")}
              </span>
            )}
          </div>

          <div className={tcss.printRow}>
            <span className={tcss.printRowIcon} aria-hidden>
              <IconPrinter size={18} />
            </span>
            <span className={tcss.printRowText}>
              <span className={tcss.printRowTitle}>Print receipt</span>
              <span className={tcss.heldMeta}>Print a return receipt for the customer</span>
            </span>
            <ToggleSwitch checked={printReceipt} onChange={setPrintReceipt} label="Print a refund receipt" />
          </div>
        </div>

        <div className={tcss.payFoot}>
          {refundBlocked && <span className={tcss.blockedHint}>{refundBlocked}</span>}
          <button
            type="button"
            className={tcss.completeBtn}
            onClick={refund}
            disabled={busy || refundBlocked !== null}
          >
            <span className={tcss.completeLabel}>
              {busy ? "Refunding…" : "Refund"}
              {!busy && !refundBlocked && <span className={`${tcss.kbd} ${tcss.kbdOnAction}`}>F4</span>}
            </span>
            <span>{formatMoney(total)}</span>
          </button>
          <span className={tcss.blockedHint}>Refunds over the approval limit ask for an approver&apos;s till PIN here.</span>
        </div>
      </aside>
    ) : null;

  const body = (
    <>
      {openingInvoice && openingToPick ? (
        <>
          <section aria-label="Opening the sale" className={tcss.ticket}>
            <div className={tcss.ticketHead}>
              <span className={tcss.ticketTitle}>{openingInvoice}</span>
              <span className={tcss.counts}>Opening the sale…</span>
            </div>
          </section>
          <aside aria-label="Refund" className={tcss.pay}>
            <div className={tcss.totalBlock}>
              <span className={tcss.label}>Refund summary</span>
              <span className={tcss.heldMeta}>Loading what can come back…</span>
            </div>
          </aside>
        </>
      ) : pickingItems && itemsPane ? (
        <>
          {itemsPane}
          {refundPane}
        </>
      ) : (
        <>
          <ReturnSalesList
            sales={listSales}
            loading={laneLoading}
            searchedFor={searchedFor}
            searching={searching}
            range={range}
            onRange={setRange}
            payment={payment}
            onPayment={setPayment}
            selectedId={sale?.id ?? null}
            openingInvoice={openingInvoice}
            onSelect={(picked) => {
              if (busy) return;
              setOpeningInvoice(picked.invoiceNo);
              void openSale(picked.invoiceNo);
            }}
          />
          <InvoiceDetails
            sale={sale}
            returnable={returnable}
            loadingInvoice={openingInvoice}
            blockedReason={detailsBlocked}
            onSelectItems={() => setPickingItems(true)}
            onReprint={() => sale && onReprintSale(sale)}
          />
        </>
      )}
      <PosReturnHistoryModal
        open={historyOpen}
        refunds={refunds}
        onClose={() => setHistoryOpen(false)}
        onView={(r) => {
          setAutoPrintRefund(false);
          setReceipt(receiptFromRefund(r));
        }}
        onReprint={(r) => {
          setAutoPrintRefund(true);
          setReceipt(receiptFromRefund(r));
        }}
        onOpenSale={(invoiceNo) => {
          setHistoryOpen(false);
          setOpeningInvoice(invoiceNo);
          void openSale(invoiceNo);
        }}
      />
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
        autoPrint={autoPrintRefund}
        elevated={historyOpen}
        onClose={closeReceipt}
        preferences={receiptPreferences}
        organization={organization}
      />
    </>
  );

  return (
    <>
      {children({
        search,
        body,
        header: (
          <ReturnsHeader
            step={step}
            onHistory={() => {
              loadRefunds();
              setHistoryOpen(true);
            }}
            historyEnabled={canRefund}
          />
        ),
      })}
    </>
  );
}
