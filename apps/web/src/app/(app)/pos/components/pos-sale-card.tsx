"use client";

import {
  IconEye,
  IconPrinter,
  IconRotateCcw,
  IconSearch,
} from "@/components/icons";
import { useEffect, useState } from "react";
import {
  Modal,
  StatusBadge,
  TablePager,
  type BadgeVariant,
} from "@/components/ui";
import { PAYMENT_METHOD_LABELS } from "../constants";
import { useSteadyHeight } from "../hooks/use-steady-height";
import type { RefundRow } from "../services/pos-api";
import type { RecentSale } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import css from "../pos.module.css";
import tcss from "../till.module.css";

const STATUS: Record<
  RecentSale["status"],
  { label: string; variant: BadgeVariant }
> = {
  posted: { label: "Completed", variant: "success" },
  partially_refunded: { label: "Part refunded", variant: "warning" },
  refunded: { label: "Refunded", variant: "danger" },
  voided: { label: "Voided", variant: "danger" },
};

export type SaleCardActions = {
  onView: (sale: RecentSale) => void;
  onReprint: (sale: RecentSale) => void;
  onReturnItems: (sale: RecentSale) => void;
};

/** One sale as the till shows it: who, when, how it was paid, and what can be done with it. */
export function PosSaleCard({
  sale,
  onView,
  onReprint,
  onReturnItems,
}: { sale: RecentSale } & SaleCardActions) {
  const status = STATUS[sale.status] ?? {
    label: sale.status,
    variant: "default" as BadgeVariant,
  };
  const returnable =
    sale.status === "posted" || sale.status === "partially_refunded";
  return (
    <div className={tcss.saleCard}>
      <div className={tcss.saleCardTop}>
        <span className={tcss.saleCardMain}>
          <span className={tcss.saleCardTitle}>
            <span className={tcss.saleCardNo}>{sale.invoiceNo}</span>
            <StatusBadge
              status={sale.status}
              label={status.label}
              variant={status.variant}
              dot
            />
          </span>
          <span className={tcss.saleCardMeta}>
            {sale.customerName ?? "Walk-in customer"}
          </span>
          <span className={tcss.saleCardMeta}>
            {formatDate(sale.soldAt)} {formatTime(sale.soldAt)}
          </span>
        </span>
        <span className={tcss.saleCardSide}>
          <span className={tcss.saleCardAmount}>
            {formatMoney(sale.grandTotal)}
          </span>
          <span className={tcss.saleCardMeta}>
            {(sale.paymentMethods ?? [])
              .map((m) => PAYMENT_METHOD_LABELS[m])
              .join(" + ") || "—"}
          </span>
        </span>
      </div>
      <div className={tcss.saleCardActions}>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => onView(sale)}
        >
          <IconEye size={16} /> View
        </button>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => onReprint(sale)}
        >
          <IconPrinter size={16} /> Reprint
        </button>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => onReturnItems(sale)}
          disabled={!returnable}
          data-tooltip={
            returnable ? undefined : "Nothing on this sale can be returned"
          }
        >
          <IconRotateCcw size={16} /> Return items
        </button>
      </div>
    </div>
  );
}

/**
 * A refund in the same card: what came back and whether it went back on the shelf, how the money
 * went back, and View · Reprint · Open sale (to return more of it).
 */
export function PosRefundCard({
  refund,
  onView,
  onReprint,
  onOpenSale,
}: {
  refund: RefundRow;
  onView: (refund: RefundRow) => void;
  onReprint: (refund: RefundRow) => void;
  onOpenSale: (invoiceNo: string) => void;
}) {
  const held = refund.items
    .filter((item) => item.disposition === "quarantine")
    .reduce((n, item) => n + item.qty, 0);
  return (
    <div
      className={tcss.saleCard}
    >
      <div className={tcss.saleCardTop}>
        <span className={tcss.saleCardMain}>
          <span className={tcss.saleCardTitle}>
            <span className={tcss.saleCardNo}>{refund.returnNumber}</span>
            <StatusBadge
              status={held > 0 ? "on_hold" : "completed"}
              label={held > 0 ? `${held} held` : "On shelf"}
              variant={held > 0 ? "warning" : "success"}
              dot
            />
          </span>
          <span className={tcss.saleCardMeta}>
            {refund.sale?.invoiceNo ?? "—"} ·{" "}
            {refund.customerName ?? "Walk-in customer"}
          </span>
          <span className={tcss.saleCardMeta}>
            {formatDate(refund.createdAt)} {formatTime(refund.createdAt)} ·{" "}
            {refund.refundedBy.fullName}
          </span>
        </span>
        <span className={tcss.saleCardSide}>
          <span className={tcss.saleCardAmount}>
            {formatMoney(refund.amount)}
          </span>
          <span className={tcss.saleCardMeta}>
            {refund.refundedTo
              .map((p) =>
                refund.refundedTo.length > 1
                  ? `${PAYMENT_METHOD_LABELS[p.method]} ${formatAmount(p.amount)}`
                  : PAYMENT_METHOD_LABELS[p.method],
              )
              .join(" + ") || "—"}
          </span>
        </span>
      </div>
      <div className={tcss.saleCardActions}>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => onView(refund)}
        >
          <IconEye size={16} /> View
        </button>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => onReprint(refund)}
        >
          <IconPrinter size={16} /> Reprint
        </button>
        <button
          type="button"
          className={tcss.secondaryBtn}
          onClick={() => refund.sale && onOpenSale(refund.sale.invoiceNo)}
          disabled={!refund.sale}
          data-tooltip={
            refund.sale
              ? `Open ${refund.sale.invoiceNo} to return more of it`
              : "The sale is no longer available"
          }
        >
          <IconRotateCcw size={16} /> Open sale
        </button>
      </div>
    </div>
  );
}

/** Three cards, the filters and the pager fit a 768px-tall till screen without the popup scrolling. */
const SALES_PAGE_SIZE = 3;

type SalesFilter = "all" | "cash" | "card" | "mobile_wallet" | "refunded";

/** Quick filters for Today's sales: how it was paid, or whether any of it came back. */
const SALES_FILTERS: Array<{ value: SalesFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "mobile_wallet", label: "Wallet" },
  { value: "refunded", label: "Refunded" },
];

function inFilter(sale: RecentSale, filter: SalesFilter): boolean {
  if (filter === "all") return true;
  if (filter === "refunded")
    return sale.status === "refunded" || sale.status === "partially_refunded";
  return (sale.paymentMethods ?? []).includes(filter);
}

/** Every sale at this branch today, in the same cards — opened from "View all". */
export function PosTodaySalesModal({
  open,
  sales,
  loading,
  onClose,
  ...actions
}: {
  open: boolean;
  sales: RecentSale[];
  loading: boolean;
  onClose: () => void;
} & SaleCardActions) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SalesFilter>("all");
  const term = query.trim().toLowerCase();
  const filtered = sales.filter((s) => inFilter(s, filter));
  const shown = term
    ? filtered.filter((s) =>
        [
          s.invoiceNo,
          s.customerName ?? "walk-in",
          s.sellerName,
          s.grandTotal,
          ...(s.paymentMethods ?? []).map((m) => PAYMENT_METHOD_LABELS[m]),
        ].some((field) => field.toLowerCase().includes(term)),
      )
    : filtered;
  useEffect(() => {
    if (open) setPage(1);
    else {
      setQuery("");
      setFilter("all");
    }
  }, [open]);
  useEffect(() => setPage(1), [term, filter]);
  const steady = useSteadyHeight<HTMLDivElement>(open);
  const pageRows = shown.slice(
    (page - 1) * SALES_PAGE_SIZE,
    page * SALES_PAGE_SIZE,
  );
  const counted = sales.filter((s) => s.status !== "voided");
  const total = counted.reduce((sum, s) => sum + Number(s.grandTotal), 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Today's sales"
      description={
        sales.length > 0
          ? `${counted.length} sale${counted.length === 1 ? "" : "s"} at this branch today · ${formatMoney(total)}`
          : "Sales at this branch since the start of today."
      }
      size="lg"
    >
      {sales.length > 0 && (
        <div className={css.holdFilterRow}>
          {SALES_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`${css.holdFilterBtn}${filter === f.value ? ` ${css.holdFilterBtnActive}` : ""}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label} ({sales.filter((s) => inFilter(s, f.value)).length})
            </button>
          ))}
          <div className={`${css.pickerSearch} ${css.pickerSearchSmall}`}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.pickerSearchInput}
              placeholder="Search sales"
              aria-label="Search today's sales — invoice, customer, cashier or amount"
              data-tooltip="Invoice, customer, cashier or amount"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      )}
      <div ref={steady.ref} style={steady.style} className={css.pagedArea}>
        {loading && sales.length === 0 ? (
          <p className={css.pickerEmpty}>Loading today&apos;s sales…</p>
        ) : sales.length === 0 ? (
          <p className={css.pickerEmpty}>No sales at this branch yet today.</p>
        ) : shown.length === 0 ? (
          <p className={css.pickerEmpty}>
            {term
              ? `No sale today matches “${query.trim()}”.`
              : "No sales today in this filter."}
          </p>
        ) : (
          <div className={tcss.saleCardList}>
            {pageRows.map((sale) => (
              <PosSaleCard key={sale.id} sale={sale} {...actions} />
            ))}
          </div>
        )}
        <div className={css.pagedFoot}>
          <TablePager
            page={page}
            pageSize={SALES_PAGE_SIZE}
            total={shown.length}
            onPageChange={setPage}
          />
        </div>
      </div>
    </Modal>
  );
}

const HISTORY_PAGE_SIZE = 3;

type HistoryFilter = "all" | "today" | "held";

const HISTORY_FILTERS: Array<{ value: HistoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "today", label: "Today" },
  { value: "held", label: "With held items" },
];

function inHistoryFilter(refund: RefundRow, filter: HistoryFilter): boolean {
  if (filter === "today")
    return new Date(refund.createdAt).toDateString() === new Date().toDateString();
  if (filter === "held")
    return refund.items.some((item) => item.disposition === "quarantine");
  return true;
}

/**
 * Refunds given at this branch, newest first, in the same cards: View, Reprint, or open the sale to
 * return more of it. Opened from "Return history" on the Returns screen.
 */
export function PosReturnHistoryModal({
  open,
  refunds,
  onClose,
  onView,
  onReprint,
  onOpenSale,
}: {
  open: boolean;
  refunds: RefundRow[];
  onClose: () => void;
  onView: (refund: RefundRow) => void;
  onReprint: (refund: RefundRow) => void;
  onOpenSale: (invoiceNo: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  const term = query.trim().toLowerCase();
  const filtered = refunds.filter((r) => inHistoryFilter(r, filter));
  const shown = term
    ? filtered.filter((r) =>
        [
          r.returnNumber,
          r.sale?.invoiceNo ?? "",
          r.customerName ?? "walk-in",
          r.refundedBy.fullName,
          r.amount,
          r.reason ?? "",
        ].some((field) => field.toLowerCase().includes(term)),
      )
    : filtered;
  useEffect(() => {
    if (open) setPage(1);
    else {
      setQuery("");
      setFilter("all");
    }
  }, [open]);
  useEffect(() => setPage(1), [term, filter]);
  const steady = useSteadyHeight<HTMLDivElement>(open);
  const pageRows = shown.slice(
    (page - 1) * HISTORY_PAGE_SIZE,
    page * HISTORY_PAGE_SIZE,
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Return history"
      description="Refunds at this branch, newest first. Open a sale to see what came back and what's left."
      size="lg"
    >
      {refunds.length > 0 && (
        <div className={css.holdFilterRow}>
          {HISTORY_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`${css.holdFilterBtn}${filter === f.value ? ` ${css.holdFilterBtnActive}` : ""}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label} ({refunds.filter((r) => inHistoryFilter(r, f.value)).length})
            </button>
          ))}
          <div className={`${css.pickerSearch} ${css.pickerSearchSmall}`}>
            <IconSearch size={15} className={css.searchIcon} />
            <input
              className={css.pickerSearchInput}
              placeholder="Search refunds"
              aria-label="Search refunds — return number, invoice, customer or staff"
              data-tooltip="Return number, invoice, customer or staff"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      )}
      <div ref={steady.ref} style={steady.style} className={css.pagedArea}>
        {refunds.length === 0 ? (
          <p className={css.pickerEmpty}>No refunds at this branch yet.</p>
        ) : shown.length === 0 ? (
          <p className={css.pickerEmpty}>
            {term ? `No refund matches “${query.trim()}”.` : "No refunds in this filter."}
          </p>
        ) : (
          <div className={tcss.saleCardList}>
            {pageRows.map((refund) => (
              <PosRefundCard
                key={refund.id}
                refund={refund}
                onView={onView}
                onReprint={onReprint}
                onOpenSale={onOpenSale}
              />
            ))}
          </div>
        )}
        <div className={css.pagedFoot}>
          <TablePager
            page={page}
            pageSize={HISTORY_PAGE_SIZE}
            total={shown.length}
            onPageChange={setPage}
          />
        </div>
      </div>
    </Modal>
  );
}
