"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  IconCheck,
  IconChevronRight,
  IconPrinter,
  IconReceipt,
  IconRotateCcw,
  IconSearch,
} from "@/components/icons";
import { DatePicker, SelectField, StatusBadge, TablePager, type BadgeVariant } from "@/components/ui";
import { PAYMENT_METHOD_LABELS } from "../constants";
import { usePageFit } from "../hooks/use-page-fit";
import type { SaleReturnable } from "../services/pos-api";
import type { PaymentMethod, RecentSale, SaleReceipt } from "../types";
import { formatAmount, formatDate, formatMoney, formatTime } from "../utils";
import { METHOD_ICONS } from "./pos-pay-panel";
import tcss from "../till.module.css";

/* ── Header: what this is, where you are, and the history ─────────── */

export type ReturnStep = 1 | 2 | 3;

const STEPS: Array<{ step: ReturnStep; label: string }> = [
  { step: 1, label: "Find sale" },
  { step: 2, label: "Select items" },
  { step: 3, label: "Review refund" },
];

export function ReturnsHeader({
  step,
  onHistory,
  historyEnabled,
}: {
  step: ReturnStep;
  onHistory: () => void;
  historyEnabled: boolean;
}) {
  return (
    <div className={tcss.retHead}>
      <div className={tcss.retHeadText}>
        <h1 className={tcss.retTitle}>Customer return</h1>
        <p className={tcss.retSub}>Find the original sale, select items to return, and review the refund.</p>
      </div>
      <ol className={tcss.retSteps} aria-label="Return steps">
        {STEPS.map(({ step: n, label }) => {
          const state = n < step ? "done" : n === step ? "on" : "todo";
          return (
            <li key={n} className={`${tcss.retStep} ${tcss[`retStep_${state}`] ?? ""}`} aria-current={n === step ? "step" : undefined}>
              <span className={tcss.retStepBtn}>
                <span className={tcss.retStepDot}>{state === "done" ? <IconCheck size={14} /> : n}</span>
                <span className={tcss.retStepLabel}>{label}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {historyEnabled ? (
        <button type="button" className={tcss.secondaryBtn} onClick={onHistory}>
          <IconRotateCcw size={16} /> Return history
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/* ── Recent sales: the list the cashier picks from ─────────────────── */

export type SalesRange = { kind: "today" } | { kind: "week" } | { kind: "date"; date: string };
export type PaymentFilter = "all" | PaymentMethod;

const SALE_STATUS: Record<RecentSale["status"], { label: string; variant: BadgeVariant }> = {
  posted: { label: "Paid", variant: "success" },
  partially_refunded: { label: "Part returned", variant: "warning" },
  refunded: { label: "Fully returned", variant: "danger" },
  voided: { label: "Voided", variant: "muted" },
};

const PAY_TONE: Record<PaymentMethod, BadgeVariant> = {
  cash: "success",
  card: "info",
  mobile_wallet: "primary",
};

const PAY_OPTIONS = [
  { value: "all", label: "All payments" },
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "mobile_wallet", label: "Mobile wallet" },
];

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function ReturnSalesList({
  sales,
  loading,
  searchedFor,
  searching,
  range,
  onRange,
  payment,
  onPayment,
  selectedId,
  openingInvoice,
  onSelect,
}: {
  sales: RecentSale[];
  loading: boolean;
  /** The till bar's search; when set the list shows its matches instead of the range. */
  searchedFor: string;
  searching: boolean;
  range: SalesRange;
  onRange: (range: SalesRange) => void;
  payment: PaymentFilter;
  onPayment: (payment: PaymentFilter) => void;
  selectedId: string | null;
  openingInvoice: string | null;
  onSelect: (sale: RecentSale) => void;
}) {
  const [page, setPage] = useState(1);
  const fit = usePageFit<HTMLDivElement>({
    fallback: 6,
    itemSelector: `.${tcss.retRow}`,
    itemHeight: 66,
    gap: 8,
  });
  const shown = payment === "all" ? sales : sales.filter((s) => (s.paymentMethods ?? []).includes(payment));
  const rangeKey = range.kind === "date" ? range.date : range.kind;
  useEffect(() => setPage(1), [rangeKey, payment, searchedFor]);
  const rows = shown.slice((page - 1) * fit.perPage, page * fit.perPage);
  const searchingNow = searchedFor.length >= 2;

  return (
    <section aria-label="Recent sales" className={`${tcss.ticket} ${tcss.retPanel}`}>
      <div className={tcss.retPanelHead}>
        <span className={tcss.retPanelTitle}>{searchingNow ? "Matching sales" : "Recent sales"}</span>
        <span className={tcss.retPanelSub}>
          {searchingNow
            ? searching
              ? "Searching…"
              : `${shown.length} match “${searchedFor}”`
            : "Pick the sale the customer is returning from"}
        </span>
      </div>

      {!searchingNow && (
        <div className={tcss.retFilters}>
          <button
            type="button"
            className={`${tcss.retChip}${range.kind === "today" ? ` ${tcss.retChipOn}` : ""}`}
            onClick={() => onRange({ kind: "today" })}
          >
            Today
          </button>
          <button
            type="button"
            className={`${tcss.retChip}${range.kind === "week" ? ` ${tcss.retChipOn}` : ""}`}
            onClick={() => onRange({ kind: "week" })}
          >
            Last 7 days
          </button>
          <div className={`${tcss.retDate}${range.kind === "date" ? ` ${tcss.retDateOn}` : ""}`}>
            <DatePicker
              label="Sales on"
              variant="field"
              value={range.kind === "date" ? range.date : ""}
              max={todayIso()}
              placeholder="Pick a day"
              clearable
              onChange={(date) => onRange(date ? { kind: "date", date } : { kind: "today" })}
            />
          </div>
          <span className={tcss.retFilterRule} aria-hidden />
          <div className={tcss.retPay}>
            <SelectField
              label="Payment"
              hideLabel
              value={payment}
              onChange={(v) => onPayment(v as PaymentFilter)}
              options={PAY_OPTIONS}
            />
          </div>
        </div>
      )}

      <div className={tcss.retCols} aria-hidden>
        <span>Receipt / customer</span>
        <span>Time</span>
        <span>Payment</span>
        <span className={tcss.right}>Total</span>
        <span>Status</span>
        <span />
      </div>

      <div className={tcss.retRows} ref={fit.ref}>
        {shown.length === 0 ? (
          <div className={tcss.ready}>
            <span className={tcss.readyIcon} aria-hidden>
              <IconSearch size={28} />
            </span>
            <span className={tcss.readyHint}>
              {loading || searching
                ? "Loading sales…"
                : searchingNow
                  ? `No sale matches “${searchedFor}”. Try the invoice number on the receipt, or the customer's phone.`
                  : payment !== "all"
                    ? `No ${PAY_OPTIONS.find((o) => o.value === payment)?.label.toLowerCase()} sales in this range.`
                    : "No sales in this range."}
            </span>
          </div>
        ) : (
          rows.map((s) => {
            const status = SALE_STATUS[s.status];
            const on = s.id === selectedId;
            const opening = openingInvoice === s.invoiceNo;
            return (
              <button
                key={s.id}
                type="button"
                className={`${tcss.retRow}${on ? ` ${tcss.retRowOn}` : ""}`}
                aria-pressed={on}
                onClick={() => onSelect(s)}
              >
                <span className={tcss.retRowMain}>
                  <span className={tcss.retRowNo}>{s.invoiceNo}</span>
                  <span className={tcss.retRowSub}>{s.customerName ?? "Walk-in"}</span>
                </span>
                <span className={tcss.retRowTime}>
                  <span>{formatDate(s.soldAt)}</span>
                  <span>{formatTime(s.soldAt)}</span>
                </span>
                <span className={tcss.retRowPay}>
                  {(s.paymentMethods ?? []).length === 0
                    ? "—"
                    : (s.paymentMethods ?? []).map((m) => (
                        <StatusBadge key={m} status={m} label={m === "mobile_wallet" ? "Wallet" : PAYMENT_METHOD_LABELS[m]} variant={PAY_TONE[m]} />
                      ))}
                </span>
                <span className={tcss.retRowTotal}>{formatMoney(s.grandTotal)}</span>
                <span>
                  <StatusBadge status={s.status} label={status.label} variant={status.variant} />
                </span>
                <span className={tcss.retRowGo} aria-hidden>
                  {opening ? "…" : <IconChevronRight size={18} />}
                </span>
              </button>
            );
          })
        )}
      </div>
      <TablePager page={page} pageSize={fit.perPage} total={shown.length} onPageChange={setPage} />
    </section>
  );
}

/* ── Invoice details: the chosen sale, before choosing what comes back ── */

function originalPayments(sale: SaleReceipt): Array<{ method: PaymentMethod; amount: number }> {
  const paid = new Map<PaymentMethod, number>();
  for (const p of sale.payments) {
    if (Number(p.amount) > 0) paid.set(p.method, (paid.get(p.method) ?? 0) + Number(p.amount));
  }
  if (paid.has("cash")) paid.set("cash", (paid.get("cash") ?? 0) - Number(sale.changeDue));
  return [...paid].filter(([, amount]) => amount > 0).map(([method, amount]) => ({ method, amount }));
}

export function InvoiceDetails({
  sale,
  returnable,
  loadingInvoice,
  blockedReason,
  onSelectItems,
  onReprint,
}: {
  sale: SaleReceipt | null;
  returnable: SaleReturnable | null;
  /** The invoice being fetched; its details replace the current ones when it arrives. */
  loadingInvoice: string | null;
  /** Why "Select items to return" is unavailable, or null when it is. */
  blockedReason: string | null;
  onSelectItems: () => void;
  onReprint: () => void;
}) {
  if (loadingInvoice && (!sale || sale.invoiceNo !== loadingInvoice)) {
    return (
      <aside aria-label="Invoice details" className={`${tcss.pay} ${tcss.retDetail}`}>
        <span className={tcss.retPanelTitle}>Invoice details</span>
        <div className={tcss.ready}>
          <span className={tcss.readyHint}>Opening {loadingInvoice}…</span>
        </div>
      </aside>
    );
  }

  if (!sale || !returnable) {
    return (
      <aside aria-label="Invoice details" className={`${tcss.pay} ${tcss.retDetail}`}>
        <span className={tcss.retPanelTitle}>Invoice details</span>
        <div className={tcss.ready}>
          <span className={tcss.readyIcon} aria-hidden>
            <IconReceipt size={30} />
          </span>
          <span className={tcss.readyTitle}>Pick a sale</span>
          <span className={tcss.readyHint}>
            Choose a sale on the left, or scan its receipt. Its items, what has already come back and how it was
            paid show here.
          </span>
        </div>
        <div className={tcss.menuHint}>
          <b>Sending stock back to a supplier?</b>
          <span>
            That&apos;s a supplier return — <Link href="/purchasing/supplier-returns">open Supplier returns</Link>.
          </span>
        </div>
      </aside>
    );
  }

  const status = SALE_STATUS[sale.status];
  const sold = returnable.lines.reduce((n, l) => n + l.soldQty, 0);
  const available = returnable.lines.reduce((n, l) => n + l.remainingQty, 0);
  const paid = originalPayments(sale);

  return (
    <aside aria-label="Invoice details" className={`${tcss.pay} ${tcss.payPinned} ${tcss.retDetail}`}>
      <span className={tcss.retPanelTitle}>Invoice details</span>

      <div className={tcss.retInvoice}>
        <div className={tcss.retInvoiceTop}>
          <span className={tcss.retInvoiceNo}>{sale.invoiceNo}</span>
          <StatusBadge status={sale.status} label={status.label} variant={status.variant} />
        </div>
        <div className={tcss.retInvoiceBottom}>
          <span className={tcss.retInvoiceMeta}>
            <span>
              {formatDate(sale.soldAt)} {formatTime(sale.soldAt)} · {sale.customer?.fullName ?? "Walk-in customer"}
            </span>
            <span>Cashier: {sale.seller.fullName}</span>
          </span>
          <span className={tcss.retInvoiceTotal}>{formatMoney(sale.grandTotal)}</span>
        </div>
      </div>

      <div className={tcss.payScroll}>
        <div className={tcss.payBlock}>
          <span className={tcss.retBlockTitle}>Items in this sale</span>
          <div className={tcss.retItems}>
            <div className={tcss.retItemsHead} aria-hidden>
              <span>Item</span>
              <span className={tcss.center}>Qty</span>
              <span className={tcss.right}>Unit price</span>
              <span className={tcss.right}>Total</span>
            </div>
            {sale.items.map((item) => (
              <div key={item.id} className={tcss.retItem}>
                <span className={tcss.retItemName}>
                  <b>{item.product.name}</b>
                  <span>Batch {item.batch.batchNo}</span>
                </span>
                <span className={tcss.center}>{item.qty}</span>
                <span className={tcss.right}>{formatAmount(item.unitPrice)}</span>
                <span className={`${tcss.right} ${tcss.strongText}`}>{formatAmount(item.lineTotal)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={tcss.retStats}>
          <div>
            <span>Sold</span>
            <b>{sold}</b>
          </div>
          <div>
            <span>Returned</span>
            <b>{sold - available}</b>
          </div>
          <div>
            <span>Available to return</span>
            <b className={tcss.retStatGood}>{available}</b>
          </div>
        </div>

        <div className={tcss.payBlock}>
          <span className={tcss.retBlockTitle}>Original payment</span>
          <div className={tcss.origPay}>
            {paid.length === 0 ? (
              <span className={tcss.emptyNote}>No payment recorded on this sale.</span>
            ) : (
              paid.map((p) => (
                <div key={p.method} className={tcss.origPayRow}>
                  <span className={tcss.origPayMethod}>
                    {METHOD_ICONS[p.method]}
                    {PAYMENT_METHOD_LABELS[p.method]}
                  </span>
                  <span className={tcss.strongText}>{formatMoney(p.amount)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className={tcss.payFoot}>
        {blockedReason && <span className={tcss.blockedHint}>{blockedReason}</span>}
        <div className={tcss.retActions}>
          <button
            type="button"
            className={`${tcss.completeBtn} ${tcss.completeBtnCentered}`}
            onClick={onSelectItems}
            disabled={blockedReason !== null}
          >
            <IconRotateCcw size={18} /> Select items to return
          </button>
          <button type="button" className={tcss.secondaryBtn} onClick={onReprint}>
            <IconPrinter size={16} /> Reprint receipt
          </button>
        </div>
      </div>
    </aside>
  );
}
