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
import {
  findSaleByInvoice,
  searchInvoices,
  fetchSaleReturnable,
  refundSale,
  type InvoiceSearchHit,
  type SaleReturnable,
} from "../services/pos-api";
import type { RecentSale, SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";

type Props = {
  canRefund: boolean;
  canRefundControlled: boolean;
  recentSales: RecentSale[];
  onRefunded: (sale: SaleReceipt) => void;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

/**
 * Returns lane: search an invoice, refund selected lines (or all remaining),
 * then restock via a completed goods return. Partial / supplier workflow → /returns.
 */
export function PosReturnsPanel({
  canRefund,
  canRefundControlled,
  recentSales,
  onRefunded,
  onError,
  onNotice,
}: Props) {
  const [invoiceNo, setInvoiceNo] = useState("");
  const [sale, setSale] = useState<SaleReceipt | null>(null);
  const [returnable, setReturnable] = useState<SaleReturnable | null>(null);
  const [qtyByKey, setQtyByKey] = useState<Record<string, number>>({});
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
    for (const line of data.lines) {
      // Start at 0 — cashier sets qty with steppers (or Select all remaining).
      next[line.saleItemId] = 0;
    }
    setQtyByKey(next);
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
        (sum, row) => sum + row.qty * Number(row.line.unitPrice),
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
    let items: { productId: string; batchId: string; qty: number }[];
    if (mode === "selected") {
      if (selectedItems.length === 0) {
        onError("Set refund qty on at least one line (use + / −)");
        return;
      }
      items = selectedItems.map(({ line, qty }) => ({
        productId: line.productId,
        batchId: line.batchId,
        qty,
      }));
    } else {
      items = returnable.lines
        .filter((line) => line.remainingQty > 0)
        .map((line) => ({
          productId: line.productId,
          batchId: line.batchId,
          qty: line.remainingQty,
        }));
      if (items.length === 0) {
        onError("Nothing remains returnable on this invoice");
        return;
      }
    }

    setBusy(true);
    try {
      const refunded = await refundSale(sale.id, {
        reason: reason.trim(),
        items,
        refundMethod: "cash",
      });
      setSale(refunded);
      setReason("");
      const rem = await fetchSaleReturnable(refunded.id);
      applyReturnable(rem);
      onRefunded(refunded);
      onNotice(
        refunded.status === "refunded"
          ? `Fully refunded ${refunded.invoiceNo} — stock returned and logged on Returns.`
          : `Partial refund posted for ${refunded.invoiceNo} — remaining lines can still be refunded.`,
      );
    } catch (e) {
      onError(e instanceof Error ? e.message : "Refund failed");
    } finally {
      setBusy(false);
    }
  }

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
            Search by invoice or customer, pick lines to refund (or all remaining),
            and restock in one step.
          </p>
        </div>
        <Link href="/returns" className={css.returnsWorkspaceCard}>
          <span className={css.returnsWorkspaceIcon} aria-hidden>
            <IconPackage size={16} />
          </span>
          <span className={css.returnsWorkspaceText}>
            <span className={css.returnsWorkspaceTitle}>Partial &amp; supplier returns</span>
            <span className={css.returnsWorkspaceHint}>
              Approval &amp; supplier flows in Returns
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

          <div className={css.cartWrap}>
            <table className={css.cartTable}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Batch</th>
                  <th>Sold</th>
                  <th>Left</th>
                  <th>Refund qty</th>
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
                      <td className={css.colNum}>{formatAmount(line.unitPrice)}</td>
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
          ) : sale.status === "refunded" || returnable.totalRemainingQty <= 0 ? (
            <p className={css.returnsNote}>
              This invoice has no remaining returnable quantity.
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
        </div>
      )}
    </section>
  );
}
