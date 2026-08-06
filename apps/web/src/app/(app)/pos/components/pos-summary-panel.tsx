"use client";

import {
  IconBanknote,
  IconCheck,
  IconCreditCard,
  IconPrinter,
  IconSave,
  IconSmartphone,
  IconSplit,
} from "@/components/icons";
import { PAYMENT_METHODS, QUICK_CASH_AMOUNTS } from "../constants";
import type { CartTotals, PaymentMethod } from "../types";
import { formatAmount, formatMoney, round2 } from "../utils";
import css from "../pos.module.css";

export type TenderMode = PaymentMethod | "split";

const METHOD_ICONS: Record<PaymentMethod, React.ReactNode> = {
  cash: <IconBanknote size={15} />,
  card: <IconCreditCard size={15} />,
  mobile_wallet: <IconSmartphone size={15} />,
};

type Props = {
  totals: CartTotals;
  vatRatePercent: number;
  tenderMode: TenderMode;
  onTenderModeChange: (mode: TenderMode) => void;
  amountPaid: string;
  onAmountPaidChange: (value: string) => void;
  splitAmounts: Record<PaymentMethod, string>;
  onSplitChange: (method: PaymentMethod, value: string) => void;
  busy: boolean;
  blockedReason: string | null;
  /** Soft hint when Complete opens pharmacist PIN (not a hard block). */
  approveHint?: string | null;
  hasLastReceipt: boolean;
  onComplete: () => void;
  onPrint: () => void;
  onHold: () => void;
};

export function PosSummaryPanel({
  totals,
  vatRatePercent,
  tenderMode,
  onTenderModeChange,
  amountPaid,
  onAmountPaidChange,
  splitAmounts,
  onSplitChange,
  busy,
  blockedReason,
  approveHint = null,
  hasLastReceipt,
  onComplete,
  onPrint,
  onHold,
}: Props) {
  const isSplit = tenderMode === "split";
  const isCashLike = tenderMode === "cash" || isSplit;
  const splitTotal = isSplit
    ? PAYMENT_METHODS.reduce((sum, m) => sum + (Number(splitAmounts[m.value]) || 0), 0)
    : 0;
  const paid = isSplit
    ? round2(splitTotal)
    : tenderMode === "cash"
      ? Number(amountPaid) || 0
      : totals.grandTotal;
  const balance = round2(paid - totals.grandTotal);
  const short = isCashLike && balance < -0.004;
  const empty = totals.itemCount === 0;
  const disabled = busy || empty || short || Boolean(blockedReason);

  return (
    <section className={css.panel}>
      <h2 className={css.panelTitle}>Sale Summary</h2>

      <div className={css.summaryRow}>
        <span className={css.summaryLabel}>
          Subtotal ({totals.itemCount} item{totals.itemCount === 1 ? "" : "s"})
        </span>
        <span className={css.summaryValue}>{formatMoney(totals.subtotal)}</span>
      </div>
      <div className={css.summaryRow}>
        <span className={css.summaryLabel}>Discount</span>
        <span className={`${css.summaryValue} ${css.summaryDiscount}`}>
          {totals.discountTotal > 0 ? `- ${formatMoney(totals.discountTotal)}` : formatMoney(0)}
        </span>
      </div>
      <div className={css.summaryRow}>
        <span className={css.summaryLabel}>VAT ({formatAmount(vatRatePercent)}%)</span>
        <span className={css.summaryValue}>{formatMoney(totals.taxTotal)}</span>
      </div>

      <div className={css.grandRow}>
        <span className={css.grandLabel}>Grand total</span>
        <span className={css.grandValue}>{formatMoney(totals.grandTotal)}</span>
      </div>

      {isSplit ? (
        <div className={css.splitRows}>
          {PAYMENT_METHODS.map((method) => (
            <label key={method.value} className={css.splitRow}>
              <span className={css.splitLabel}>{method.label}</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className={css.splitInput}
                value={splitAmounts[method.value]}
                onChange={(e) => onSplitChange(method.value, e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          ))}
          <div className={`${css.splitFoot}${short ? ` ${css.splitFootShort}` : ""}`}>
            <span>Tendered {formatAmount(paid)}</span>
            <span>
              {short
                ? `Short ${formatAmount(Math.abs(balance))}`
                : `Change ${formatAmount(balance)}`}
            </span>
          </div>
        </div>
      ) : tenderMode === "cash" ? (
        <>
          <div className={css.paidRow}>
            <span className={css.summaryLabel}>Amount paid</span>
            <input
              type="number"
              min={0}
              step="0.01"
              className={css.paidInput}
              value={amountPaid}
              aria-label="Amount paid"
              onChange={(e) => onAmountPaidChange(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
          </div>
          <div className={css.paidRow}>
            <span className={css.summaryLabel}>{short ? "Balance due" : "Change"}</span>
            <span className={`${css.changeValue}${short ? ` ${css.changeValueShort}` : ""}`}>
              {formatMoney(Math.abs(balance))}
            </span>
          </div>
          {!empty && (
            <div className={css.quickCashRow}>
              <button
                type="button"
                className={css.quickCashBtn}
                onClick={() => onAmountPaidChange(totals.grandTotal.toFixed(2))}
              >
                Exact
              </button>
              {/* Always rendered (never filtered out) — hiding a button via
                  visibility keeps its slot in the row so crossing a
                  denomination threshold doesn't reflow the panels below. */}
              {QUICK_CASH_AMOUNTS.map((amount) => {
                const usable = amount >= totals.grandTotal;
                return (
                  <button
                    key={amount}
                    type="button"
                    className={`${css.quickCashBtn}${usable ? "" : ` ${css.quickCashBtnHidden}`}`}
                    tabIndex={usable ? 0 : -1}
                    aria-hidden={!usable}
                    disabled={!usable}
                    onClick={() => onAmountPaidChange(amount.toFixed(2))}
                  >
                    {amount.toLocaleString("en-LK")}
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className={css.paidRow}>
          <span className={css.summaryLabel}>Tender</span>
          <span className={css.changeValue}>{formatMoney(totals.grandTotal)} exact</span>
        </div>
      )}

      <h3 className={css.panelTitle} style={{ marginTop: "0.85rem" }}>
        Payment Methods
      </h3>
      <div className={css.payGrid}>
        {PAYMENT_METHODS.map((method) => (
          <button
            key={method.value}
            type="button"
            className={`${css.payBtn}${tenderMode === method.value ? ` ${css.payBtnActive}` : ""}`}
            aria-pressed={tenderMode === method.value}
            onClick={() => onTenderModeChange(method.value)}
          >
            {METHOD_ICONS[method.value]}
            {method.label}
          </button>
        ))}
        <button
          type="button"
          className={`${css.payBtn}${isSplit ? ` ${css.payBtnActive}` : ""}`}
          aria-pressed={isSplit}
          onClick={() => onTenderModeChange("split")}
          data-tooltip="Pay with more than one method"
        >
          <IconSplit size={15} />
          Split
        </button>
      </div>

      <button
        type="button"
        className={css.completeBtn}
        onClick={onComplete}
        disabled={disabled}
        data-tooltip={
          blockedReason ?? approveHint ?? "Post this sale (F4)"
        }
      >
        <IconCheck size={17} />
        {busy ? "Posting…" : approveHint ? "Complete (PIN)" : "Complete Sale"}
        <span className={css.completeTotal}>{formatMoney(totals.grandTotal)}</span>
      </button>

      {/* Always mounted so this line's reserved space doesn't appear/disappear
          and shift the Quick Actions panel below it every time totals change. */}
      <p
        className={`${css.blockedHint}${blockedReason || short || approveHint ? "" : ` ${css.blockedHintHidden}`}`}
        aria-live="polite"
      >
        {blockedReason ??
          (short
            ? `Tender is short by ${formatMoney(Math.abs(balance))}.`
            : approveHint ?? "\u00A0")}
      </p>

      <div className={css.secondaryRow}>
        <button
          type="button"
          className={css.secondaryBtn}
          onClick={onPrint}
          disabled={!hasLastReceipt}
          data-tooltip={hasLastReceipt ? "Reprint the last bill" : "No receipt in this session yet"}
        >
          <IconPrinter size={14} />
          Print Bill
        </button>
        <button type="button" className={css.secondaryBtn} onClick={onHold} disabled={empty || busy}>
          <IconSave size={14} />
          Save / Hold
        </button>
      </div>
    </section>
  );
}
