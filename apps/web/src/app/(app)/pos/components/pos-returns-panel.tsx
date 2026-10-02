"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronRight,
  IconMinus,
  IconPackage,
  IconPlus,
  IconRotateCcw,
  IconSearch,
} from "@/components/icons";
import { StatusBadge } from "@/components/ui";
import { ApiError } from "@/lib/api-error";
import {
  cancelOldReturn,
  findSaleByInvoice,
  searchInvoices,
  fetchSaleReturnable,
  listRefundApprovers,
  listRefunds,
  refundSale,
  type InvoiceSearchHit,
  type RefundDisposition,
  type RefundRow,
  type RefundSalePayload,
  type SaleReturnable,
} from "../services/pos-api";
import { PosPharmacistPinModal } from "./pos-pharmacist-pin-modal";
import type { RecentSale, SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Props = {
  canRefund: boolean;
  canRefundControlled: boolean;
  /** `returns.process` — may cancel a customer return left open on the old Returns page. */
  canCancelOldReturns: boolean;
  recentSales: RecentSale[];
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

/** Statuses a customer return from the old Returns page could still be sitting in. */
const OPEN_OLD_STATUSES = new Set(["draft", "pending_approval", "awaiting_logistics", "in_review"]);

/**
 * Returns lane: the one door for a customer return. Search an invoice, choose the lines and
 * whether each goes back on the shelf or is held for a pharmacist to inspect, and refund — over
 * the tenant's limit, an approver signs it off with their till PIN.
 */
export function PosReturnsPanel({
  canRefund,
  canRefundControlled,
  canCancelOldReturns,
  recentSales,
  onRefunded,
  onError,
  onNotice,
}: Props) {
  const [invoiceNo, setInvoiceNo] = useState("");
  const [sale, setSale] = useState<SaleReceipt | null>(null);
  const [returnable, setReturnable] = useState<SaleReturnable | null>(null);
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({});
  const [dispositionByKey, setDispositionByKey] = useState<Record<string, RefundDisposition>>({});
  /** A refund waiting for an approver's PIN because it is over the tenant's limit. */
  const [pendingApproval, setPendingApproval] = useState<{
    payload: RefundSalePayload;
    message: string;
  } | null>(null);
  const [refunds, setRefunds] = useState<RefundRow[]>([]);
  const loadRefunds = useCallback(() => {
    if (!canRefund) return;
    listRefunds()
      .then(setRefunds)
      .catch(() => setRefunds([]));
  }, [canRefund]);
  useEffect(loadRefunds, [loadRefunds]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<InvoiceSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const applyReturnable = useCallback((data: SaleReturnable) => {
    setReturnable(data);
    const next: Record<string, number> = {};
    const dispositions: Record<string, RefundDisposition> = {};
    for (const line of data.lines) {
      // Start at 0 — cashier sets qty with steppers (or Select all remaining).
      next[line.saleItemId] = 0;
      // A medicine back from a patient is held for a pharmacist to look at first.
      dispositions[line.saleItemId] =
        line.isControlled || line.requiresPrescription ? "quarantine" : "restock";
    }
    setQtyByKey(next);
    setDispositionByKey(dispositions);
  }, []);

  const loadSale = useCallback(
    async (term: string) => {
      if (!term.trim()) return;
      setBusy(true);
      setMenuOpen(false);
      try {
        const found = await findSaleByInvoice(term);
        setSale(found);
        setInvoiceNo(found.invoiceNo);
        setHits([]);
        const rem = await fetchSaleReturnable(found.id);
        applyReturnable(rem);
      } catch (e) {
        setSale(null);
        setReturnable(null);
        onError(e instanceof Error ? e.message : "Invoice not found");
      } finally {
        setBusy(false);
      }
    },
    [applyReturnable, onError],
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = invoiceNo.trim();
    if (term.length < 2) {
      setHits([]);
      setSearching(false);
      return;
    }
    if (sale && sale.invoiceNo.toLowerCase() === term.toLowerCase()) {
      setHits([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void searchInvoices(term)
        .then((rows) => {
          setHits(rows);
          setMenuOpen(rows.length > 0);
        })
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, 220);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [invoiceNo, sale]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selectedItems = useMemo(() => {
    if (!returnable) return [];
    return returnable.lines
      .map((line) => {
        const qty = qtyByKey[line.saleItemId] ?? 0;
        return { line, qty };
      })
      .filter((row) => row.qty > 0);
  }, [returnable, qtyByKey]);

  const selectedTotal = useMemo(
    () =>
      selectedItems.reduce(
        (sum, row) =>
          sum + row.qty * Number(row.line.refundUnitPrice ?? row.line.unitPrice),
        0,
      ),
    [selectedItems],
  );

  const blockedControlled =
    Boolean(returnable?.requiresPharmacist) && !canRefundControlled;

  const canAct =
    canRefund &&
    !blockedControlled &&
    sale &&
    returnable &&
    returnable.totalRemainingQty > 0 &&
    (sale.status === "posted" || sale.status === "partially_refunded");

  function setAllRemaining() {
    if (!returnable) return;
    const next: Record<string, number> = {};
    for (const line of returnable.lines) {
      next[line.saleItemId] = line.remainingQty;
    }
    setQtyByKey(next);
  }

  function stepQty(saleItemId: string, remainingQty: number, delta: number) {
    setQtyByKey((prev) => {
      const cur = prev[saleItemId] ?? 0;
      return {
        ...prev,
        [saleItemId]: Math.max(0, Math.min(remainingQty, cur + delta)),
      };
    });
  }

  async function refund(mode: "selected" | "all") {
    if (!sale || !returnable) return;
    if (!reason.trim()) {
      onError("Enter a reason for the refund");
      return;
    }

    // Always send explicit line items so the API never falls back to "refund all"
    // if the payload is stripped or mis-parsed.
    let items: NonNullable<RefundSalePayload["items"]>;
    if (mode === "selected") {
      if (selectedItems.length === 0) {
        onError("Set refund qty on at least one line (use + / −)");
        return;
      }
      items = selectedItems.map(({ line, qty }) => ({
        productId: line.productId,
        batchId: line.batchId,
        qty,
        disposition: dispositionByKey[line.saleItemId] ?? "restock",
      }));
    } else {
      items = returnable.lines
        .filter((line) => line.remainingQty > 0)
        .map((line) => ({
          productId: line.productId,
          batchId: line.batchId,
          qty: line.remainingQty,
          disposition: dispositionByKey[line.saleItemId] ?? "restock",
        }));
      if (items.length === 0) {
        onError("Nothing remains returnable on this invoice");
        return;
      }
    }

    await submitRefund({ reason: reason.trim(), items, refundMethod: "cash" });
  }

  async function submitRefund(payload: RefundSalePayload) {
    if (!sale) return;
    setBusy(true);
    try {
      const refunded = await refundSale(sale.id, payload);
      setPendingApproval(null);
      setSale(refunded);
      setReason("");
      const rem = await fetchSaleReturnable(refunded.id);
      applyReturnable(rem);
      onRefunded(refunded);
      loadRefunds();
      const held = (payload.items ?? [])
        .filter((item) => item.disposition === "quarantine")
        .reduce((n, item) => n + item.qty, 0);
      const heldNote = held > 0 ? ` ${held} unit${held === 1 ? "" : "s"} held for inspection.` : "";
      onNotice(
        (refunded.status === "refunded"
          ? `Fully refunded ${refunded.invoiceNo}.`
          : `Partial refund posted for ${refunded.invoiceNo} — remaining lines can still be refunded.`) +
          heldNote,
      );
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

  async function cancelOld(row: RefundRow) {
    setBusy(true);
    try {
      await cancelOldReturn(row.id);
      onNotice(`${row.returnNumber} cancelled. Refund the sale here if the customer is owed money.`);
      loadRefunds();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't cancel the return");
    } finally {
      setBusy(false);
    }
  }

  const openOldReturns = refunds.filter((row) => OPEN_OLD_STATUSES.has(row.status));
  const recentRefunds = refunds.filter((row) => row.status === "completed").slice(0, 8);

  const refundableRecent = recentSales.filter(
    (s) => s.status === "posted" || s.status === "partially_refunded",
  );

  const statusVariant =
    sale?.status === "posted"
      ? "success"
      : sale?.status === "partially_refunded"
        ? "warning"
        : "danger";

  return (
    <section className={`${css.card} ${css.returnsPanel}`}>
      <header className={css.returnsHeader}>
        <div className={css.returnsHeaderCopy}>
          <h2 className={css.returnsTitle}>Invoice refund</h2>
          <p className={css.returnsSubtitle}>
            Search by invoice or customer, pick the lines to refund, and choose whether each
            goes back on the shelf or is held for a pharmacist to inspect.
          </p>
        </div>
        <Link href="/purchasing/supplier-returns" className={css.returnsWorkspaceCard}>
          <span className={css.returnsWorkspaceIcon} aria-hidden>
            <IconPackage size={16} />
          </span>
          <span className={css.returnsWorkspaceText}>
            <span className={css.returnsWorkspaceTitle}>Supplier returns</span>
            <span className={css.returnsWorkspaceHint}>
              Send damaged, expired or recalled stock back to a supplier
            </span>
          </span>
          <span className={css.returnsWorkspaceCta}>
            Open
            <IconChevronRight size={14} />
          </span>
        </Link>
      </header>

      <div className={css.returnsSearchBlock} ref={wrapRef}>
        <div className={css.returnsSearchRow}>
          <div className={css.returnsSearchField}>
            <IconSearch size={15} className={css.returnsSearchIcon} />
            <input
              className={css.control}
              placeholder="Search invoice no. or customer… e.g. INV-SEED-0001"
              value={invoiceNo}
              autoFocus
              aria-autocomplete="list"
              aria-expanded={menuOpen}
              aria-controls="returns-invoice-results"
              onChange={(e) => {
                setInvoiceNo(e.target.value);
                setSale(null);
                setReturnable(null);
                setMenuOpen(true);
              }}
              onFocus={() => {
                if (hits.length > 0) setMenuOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (hits[0]) void loadSale(hits[0].invoiceNo);
                  else void loadSale(invoiceNo);
                }
                if (e.key === "Escape") setMenuOpen(false);
              }}
            />
            {searching && <span className={css.returnsSearchHint}>Searching…</span>}
          </div>
          <button
            type="button"
            className={css.toolBtn}
            onClick={() => void loadSale(invoiceNo)}
            disabled={busy || !invoiceNo.trim()}
          >
            <IconSearch size={15} />
            Find invoice
          </button>
        </div>

        {menuOpen && hits.length > 0 && (
          <ul id="returns-invoice-results" className={css.returnsSuggest} role="listbox">
            {hits.map((hit) => (
              <li key={hit.id} role="option">
                <button
                  type="button"
                  className={css.returnsSuggestItem}
                  onClick={() => void loadSale(hit.invoiceNo)}
                >
                  <span className={css.returnsSuggestMain}>
                    <span className={css.returnsSuggestInvoice}>{hit.invoiceNo}</span>
                    <StatusBadge
                      status={hit.status}
                      variant={
                        hit.status === "posted"
                          ? "success"
                          : hit.status === "partially_refunded"
                            ? "warning"
                            : "danger"
                      }
                      dot
                    />
                  </span>
                  <span className={css.returnsSuggestMeta}>
                    {hit.customer?.fullName ?? "Walk-in"} · {formatDate(hit.soldAt)}{" "}
                    {formatTime(hit.soldAt)} · {hit._count.items} item
                    {hit._count.items === 1 ? "" : "s"} · {formatMoney(hit.grandTotal)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {sale && returnable ? (
        <>
          <div className={css.returnsSummary}>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Invoice</span>
              <span className={css.returnsStatValue}>{sale.invoiceNo}</span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Sold</span>
              <span className={css.returnsStatValue}>
                {formatDate(sale.soldAt)} {formatTime(sale.soldAt)}
              </span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Customer</span>
              <span className={css.returnsStatValue}>
                {sale.customer?.fullName ?? "Walk-in"}
              </span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Original total</span>
              <span className={css.returnsStatValue}>{formatMoney(sale.grandTotal)}</span>
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Status</span>
              <StatusBadge status={sale.status} variant={statusVariant} dot />
            </div>
            <div className={css.returnsStat}>
              <span className={css.returnsStatLabel}>Still returnable</span>
              <span className={css.returnsStatValue}>
                {returnable.totalRemainingQty} unit
                {returnable.totalRemainingQty === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          {blockedControlled && (
            <p className={css.returnsNote}>
              This invoice includes controlled or prescription items. A pharmacist,
              manager, or owner must process the refund.
            </p>
          )}

          <div className={css.returnsTableWrap}>
            <table className={css.cartTable}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch</th>
                  <th>Sold</th>
                  <th>Left</th>
                  <th>Refund qty</th>
                  <th>Then</th>
                  <th className={css.colNum}>Unit</th>
                </tr>
              </thead>
              <tbody>
                {returnable.lines.map((line) => {
                  const qty = qtyByKey[line.saleItemId] ?? 0;
                  const disabled = !canAct || line.remainingQty <= 0 || busy;
                  return (
                    <tr key={line.saleItemId}>
                      <td>
                        <Link href={`/products/${line.productId}`} className={css.productLink}>
                          {line.productName}
                        </Link>
                        {line.isControlled && <span className={css.tagRx}>Rx</span>}
                      </td>
                      <td>{line.batchNo}</td>
                      <td>{line.soldQty}</td>
                      <td>{line.remainingQty}</td>
                      <td>
                        <div className={css.qtyGroup}>
                          <button
                            type="button"
                            className={css.qtyBtn}
                            disabled={disabled || qty <= 0}
                            aria-label={`Decrease refund qty for ${line.productName}`}
                            onClick={() => stepQty(line.saleItemId, line.remainingQty, -1)}
                          >
                            <IconMinus size={13} />
                          </button>
                          <input
                            type="number"
                            min={0}
                            max={line.remainingQty}
                            className={css.qtyInput}
                            value={qty}
                            disabled={disabled}
                            aria-label={`Refund qty for ${line.productName}`}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === "") {
                                setQtyByKey((prev) => ({ ...prev, [line.saleItemId]: 0 }));
                                return;
                              }
                              const next = Math.trunc(Number(raw));
                              if (!Number.isFinite(next)) return;
                              setQtyByKey((prev) => ({
                                ...prev,
                                [line.saleItemId]: Math.max(
                                  0,
                                  Math.min(line.remainingQty, next),
                                ),
                              }));
                            }}
                            onFocus={(e) => e.currentTarget.select()}
                          />
                          <button
                            type="button"
                            className={css.qtyBtn}
                            disabled={disabled || qty >= line.remainingQty}
                            aria-label={`Increase refund qty for ${line.productName}`}
                            onClick={() => stepQty(line.saleItemId, line.remainingQty, 1)}
                          >
                            <IconPlus size={13} />
                          </button>
                        </div>
                      </td>
                      <td>
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
                              aria-pressed={(dispositionByKey[line.saleItemId] ?? "restock") === value}
                              disabled={disabled}
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
                      </td>
                      <td className={css.colNum}>
                        {formatAmount(line.refundUnitPrice ?? line.unitPrice)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {canAct ? (
            <div className={css.returnsActions}>
              <input
                className={css.control}
                style={{ flex: "1 1 220px", width: "auto" }}
                placeholder="Reason for refund (required)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="button"
                className={css.toolBtn}
                onClick={setAllRemaining}
                disabled={busy}
              >
                Select all remaining
              </button>
              <button
                type="button"
                className={css.toolBtn}
                onClick={() => void refund("selected")}
                disabled={busy || selectedItems.length === 0}
                data-tooltip={
                  selectedItems.length
                    ? `Refund ${formatMoney(selectedTotal.toFixed(2))}`
                    : "Set refund qty on one or more lines"
                }
              >
                <IconRotateCcw size={15} />
                Refund selected
              </button>
              <button
                type="button"
                className={`${css.toolBtn} ${css.toolBtnDanger}`}
                onClick={() => void refund("all")}
                disabled={busy}
                data-tooltip="Refund every remaining unit on this invoice"
              >
                <IconRotateCcw size={15} />
                Refund all remaining
              </button>
            </div>
          ) : sale.status === "voided" ? (
            <p className={css.returnsNote}>
              This invoice was voided and cannot be refunded from POS.
            </p>
          ) : sale.status === "refunded" || returnable.totalRemainingQty <= 0 ? (
            <p className={css.returnsNote}>
              This invoice has no remaining returnable quantity.
            </p>
          ) : !canRefund ? (
            <p className={css.returnsNote}>
              You do not have permission to process refunds on this counter.
            </p>
          ) : null}
        </>
      ) : (
        <div className={css.returnsEmpty}>
          <p className={css.pickerEmpty}>
            Start typing an invoice number or customer name — matching bills appear as you type.
            You can also pick a recent sale below.
          </p>

          {refundableRecent.length > 0 && (
            <div className={css.returnsRecent}>
              <h3 className={css.returnsRecentTitle}>Recent invoices</h3>
              <ul className={css.returnsRecentList}>
                {refundableRecent.slice(0, 8).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={css.returnsRecentItem}
                      onClick={() => void loadSale(row.invoiceNo)}
                    >
                      <span className={css.returnsSuggestMain}>
                        <span className={css.returnsSuggestInvoice}>{row.invoiceNo}</span>
                        <span className={css.returnsRecentTotal}>
                          {formatMoney(row.grandTotal)}
                        </span>
                      </span>
                      <span className={css.returnsSuggestMeta}>
                        {formatDate(row.soldAt)} {formatTime(row.soldAt)} ·{" "}
                        {row.customerName ?? "Walk-in"} · {row.itemCount} unit
                        {row.itemCount === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {openOldReturns.length > 0 && (
            <div className={css.returnsRecent}>
              <h3 className={css.returnsRecentTitle}>Left open on the old Returns page</h3>
              <p className={css.returnsNote}>
                These were raised before customer returns moved to the till, and refunded nobody.
                Cancel each one, then refund its sale here if the customer is owed money.
              </p>
              <ul className={css.returnsRecentList}>
                {openOldReturns.map((row) => (
                  <li key={row.id} className={css.returnsOldRow}>
                    <span className={css.returnsSuggestMain}>
                      <span className={css.returnsSuggestInvoice}>{row.returnNumber}</span>
                      <span className={css.returnsRecentTotal}>{formatMoney(row.amount)}</span>
                    </span>
                    <span className={css.returnsSuggestMeta}>
                      {row.sale ? `${row.sale.invoiceNo} · ` : ""}
                      {row.customerName ?? "Walk-in"} · {row.status.replace(/_/g, " ")}
                    </span>
                    <span className={css.returnsOldActions}>
                      {row.sale ? (
                        <button
                          type="button"
                          className={css.toolBtn}
                          onClick={() => void loadSale(row.sale!.invoiceNo)}
                          disabled={busy}
                        >
                          Open the sale
                        </button>
                      ) : null}
                      {canCancelOldReturns ? (
                        <button
                          type="button"
                          className={`${css.toolBtn} ${css.toolBtnDanger}`}
                          onClick={() => void cancelOld(row)}
                          disabled={busy}
                        >
                          Cancel return
                        </button>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {recentRefunds.length > 0 && (
            <div className={css.returnsRecent}>
              <h3 className={css.returnsRecentTitle}>Recent refunds</h3>
              <ul className={css.returnsRecentList}>
                {recentRefunds.map((row) => {
                  const held = row.items
                    .filter((item) => item.disposition === "quarantine")
                    .reduce((n, item) => n + item.qty, 0);
                  return (
                    <li key={row.id} className={css.returnsOldRow}>
                      <span className={css.returnsSuggestMain}>
                        <span className={css.returnsSuggestInvoice}>
                          {row.returnNumber}
                          {row.sale ? ` · ${row.sale.invoiceNo}` : ""}
                        </span>
                        <span className={css.returnsRecentTotal}>{formatMoney(row.amount)}</span>
                      </span>
                      <span className={css.returnsSuggestMeta}>
                        {formatDate(row.createdAt)} {formatTime(row.createdAt)} ·{" "}
                        {row.refundedBy.fullName}
                        {row.approvedBy ? ` · approved by ${row.approvedBy.fullName}` : ""}
                        {held > 0 ? ` · ${held} held for inspection` : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
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
          await submitRefund({ ...pendingApproval.payload, approval });
        }}
      />
    </section>
  );
}
