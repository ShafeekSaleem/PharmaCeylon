"use client";

import {
  IconAlertTriangle,
  IconBanknote,
  IconCheck,
  IconCreditCard,
  IconFileText,
  IconInfo,
  IconLock,
  IconPrinter,
  IconSmartphone,
  IconSplit,
} from "@/components/icons";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "../constants";
import type {
  CartTotals,
  HeldSaleSummary,
  PaymentMethod,
  PosAlert,
  PosAlertActionKind,
  SaleReceipt,
} from "../types";
import { formatAmount, formatMoney, formatTime, round2 } from "../utils";
import tcss from "../till.module.css";

export type TenderMode = PaymentMethod | "split";

const METHOD_ICONS: Record<TenderMode, React.ReactNode> = {
  cash: <IconBanknote size={20} />,
  card: <IconCreditCard size={20} />,
  mobile_wallet: <IconSmartphone size={20} />,
  split: <IconSplit size={20} />,
};

const METHOD_SHORT: Record<TenderMode, string> = {
  cash: "Cash",
  card: "Card",
  mobile_wallet: "Wallet",
  split: "Split",
};

/**
 * The notes a customer is likely to hand over: the next 100, 500, 1,000 and 5,000 above the
 * total, topped up with the next-but-one when they coincide, three in all.
 */
export function quickTenders(total: number): number[] {
  if (total <= 0) return [];
  const up = (step: number) => Math.ceil(total / step) * step;
  const picks = new Set<number>();
  for (const value of [up(100), up(500), up(1000), up(5000)])
    if (value > total) picks.add(value);
  for (const extra of [up(500) + 500, up(1000) + 1000, up(5000) + 5000]) {
    if (picks.size >= 3) break;
    if (extra > total) picks.add(extra);
  }
  return [...picks].sort((a, b) => a - b).slice(0, 3);
}

/** Alerts that sit on the cart lines rather than in the pay panel. */
const LINE_ALERTS = new Set(["low-stock", "near-expiry"]);

const ALERT_COPY: Record<
  string,
  { title: string; text?: (detail: string) => string }
> = {
  "rx-required": {
    title: "Link a prescription",
    text: (detail) => `${detail} can only be sold against a prescription.`,
  },
  "controlled-cosign": {
    title: "Pharmacist co-sign",
    text: (detail) =>
      `${detail} is controlled. A pharmacist enters their till PIN at Complete.`,
  },
  "needs-pharmacist-pin": {
    title: "Pharmacist co-sign",
    text: () =>
      "A pharmacist enters their till PIN at Complete — or hold the sale for them.",
  },
  "over-stock": { title: "More than is in stock" },
  "patient-name-mismatch": { title: "Confirm the patient" },
};

const ACTION_LABELS: Record<PosAlertActionKind, string> = {
  link_rx: "Link prescription",
  pharmacist_pin: "Enter PIN",
  hold_pharmacist: "Hold for pharmacist",
};

function AlertCard({
  alert,
  onAction,
}: {
  alert: PosAlert;
  onAction: (kind: PosAlertActionKind) => void;
}) {
  const copy = ALERT_COPY[alert.id];
  const tone =
    alert.severity === "danger"
      ? tcss.alertDanger
      : alert.severity === "warning"
        ? tcss.alertWarn
        : tcss.alertInfo;
  const icon =
    alert.id === "rx-required" ? (
      <IconFileText size={16} />
    ) : alert.id.includes("pharmacist") || alert.id.includes("cosign") ? (
      <IconLock size={16} />
    ) : alert.severity === "info" ? (
      <IconInfo size={16} />
    ) : (
      <IconAlertTriangle size={16} />
    );
  return (
    <div
      className={`${tcss.alertCard} ${tone}`}
      role={alert.blocking ? "alert" : "status"}
    >
      <span className={tcss.alertTitle}>
        {icon}
        {copy?.title ?? alert.title}
      </span>
      <span className={tcss.alertText}>
        {copy?.text ? copy.text(alert.detail) : alert.detail}
      </span>
      {alert.actions && alert.actions.length > 0 && (
        <span className={tcss.alertActions}>
          {alert.actions.map((action, index) => (
            <button
              key={action.kind}
              type="button"
              className={`${tcss.alertBtn}${index === 0 && alert.severity === "danger" ? ` ${tcss.alertBtnSolid}` : ""}`}
              onClick={() => onAction(action.kind)}
            >
              {ACTION_LABELS[action.kind] ?? action.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/* ── Taking payment ───────────────────────────────────────── */

type PayProps = {
  totals: CartTotals;
  vatRatePercent: number;
  tenderMode: TenderMode;
  onTenderModeChange: (mode: TenderMode) => void;
  amountPaid: string;
  onAmountPaidChange: (value: string) => void;
  splitAmounts: Record<PaymentMethod, string>;
  onSplitChange: (method: PaymentMethod, value: string) => void;
  tenderRef: string;
  onTenderRefChange: (value: string) => void;
  alerts: PosAlert[];
  onAlertAction: (kind: PosAlertActionKind) => void;
  /** Why Complete is unavailable, said as what to do next. */
  blockedHint: string | null;
  busy: boolean;
  onComplete: () => void;
  onHold: () => void;
  holdsEnabled: boolean;
};

export function PosPayPanel({
  totals,
  vatRatePercent,
  tenderMode,
  onTenderModeChange,
  amountPaid,
  onAmountPaidChange,
  splitAmounts,
  onSplitChange,
  tenderRef,
  onTenderRefChange,
  alerts,
  onAlertAction,
  blockedHint,
  busy,
  onComplete,
  onHold,
  holdsEnabled,
}: PayProps) {
  const total = totals.grandTotal;
  const splitPaid = round2(
    PAYMENT_METHODS.reduce(
      (sum, m) => sum + (Number(splitAmounts[m.value]) || 0),
      0,
    ),
  );
  const paid =
    tenderMode === "split"
      ? splitPaid
      : tenderMode === "cash"
        ? Number(amountPaid) || 0
        : total;
  const balance = round2(paid - total);
  const short =
    (tenderMode === "cash" || tenderMode === "split") && balance < -0.004;
  const shown = alerts.filter((a) => !LINE_ALERTS.has(a.id));
  const hint =
    blockedHint ??
    (short ? `${formatMoney(Math.abs(balance))} still to pay` : null);
  const tenders = quickTenders(total);

  return (
    <aside aria-label="Payment" className={`${tcss.pay} ${tcss.payPinned}`}>
      <div className={tcss.totalBlock}>
        <span className={tcss.label}>Total due</span>
        <span className={tcss.totalAmount}>{formatMoney(total)}</span>
        {shown.length > 0 ? (
          <span className={tcss.heldMeta}>
            Subtotal {formatAmount(totals.subtotal)} · Discounts{" "}
            {totals.discountTotal > 0 ? "−" : ""}
            {formatAmount(totals.discountTotal)} · VAT{" "}
            {formatAmount(totals.taxTotal)}
          </span>
        ) : (
          <div className={tcss.breakdown}>
            <div className={tcss.breakdownRow}>
              <span>
                Subtotal · {totals.unitCount} unit
                {totals.unitCount === 1 ? "" : "s"}
              </span>
              <span>{formatAmount(totals.subtotal)}</span>
            </div>
            <div className={tcss.breakdownRow}>
              <span>Discounts</span>
              <span
                className={totals.discountTotal > 0 ? tcss.minus : undefined}
              >
                {totals.discountTotal > 0 ? "−" : ""}
                {formatAmount(totals.discountTotal)}
              </span>
            </div>
            <div className={tcss.breakdownRow}>
              <span>
                VAT ({formatAmount(vatRatePercent).replace(/\.00$/, "")}%)
              </span>
              <span>{formatAmount(totals.taxTotal)}</span>
            </div>
          </div>
        )}
      </div>

      {/* The middle scrolls when alerts crowd it; the total and Complete always stay in view. */}
      <div className={tcss.payScroll}>
        {shown.length > 0 ? (
          <div className={tcss.payBlock}>
            {shown.map((alert) => (
              <AlertCard
                key={alert.id}
                alert={alert}
                onAction={onAlertAction}
              />
            ))}
          </div>
        ) : (
          <div className={tcss.rule} />
        )}

        <div className={tcss.payBlock}>
          <span className={tcss.label}>Payment</span>
          <div className={tcss.methods}>
            {(["cash", "card", "mobile_wallet", "split"] as const).map(
              (mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={tenderMode === mode}
                  className={`${tcss.method}${shown.length > 0 ? ` ${tcss.methodCompact}` : ""}${tenderMode === mode ? ` ${tcss.methodOn}` : ""}`}
                  onClick={() => onTenderModeChange(mode)}
                >
                  {METHOD_ICONS[mode]}
                  {METHOD_SHORT[mode]}
                </button>
              ),
            )}
          </div>
        </div>

        {tenderMode === "cash" && (
          <div className={tcss.payBlock}>
            <label className={tcss.tenderRow}>
              <span>Cash received</span>
              <input
                className={tcss.tenderInput}
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                aria-label="Cash received"
                value={amountPaid}
                onChange={(e) => onAmountPaidChange(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <div className={tcss.quickCash}>
              <button
                type="button"
                className={`${tcss.smallBtn}${Math.abs(paid - total) < 0.005 ? ` ${tcss.smallBtnOn}` : ""}`}
                onClick={() => onAmountPaidChange(total.toFixed(2))}
              >
                Exact
              </button>
              {tenders.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className={`${tcss.smallBtn}${Math.abs(paid - amount) < 0.005 ? ` ${tcss.smallBtnOn}` : ""}`}
                  onClick={() => onAmountPaidChange(amount.toFixed(2))}
                >
                  {amount.toLocaleString("en-LK")}
                </button>
              ))}
            </div>
            <div
              className={`${tcss.change}${short ? ` ${tcss.changeShort}` : ""}`}
              aria-live="polite"
            >
              <span>{short ? "Still to pay" : "Change to give"}</span>
              <span className={tcss.changeAmount}>
                {formatMoney(Math.abs(balance))}
              </span>
            </div>
          </div>
        )}

        {(tenderMode === "card" || tenderMode === "mobile_wallet") && (
          <label className={`${tcss.tenderRow} ${tcss.tenderRowQuiet}`}>
            <span>
              {tenderMode === "card"
                ? "Card approval code"
                : "Wallet reference"}{" "}
              (optional)
            </span>
            <input
              className={`${tcss.tenderInput} ${tcss.tenderInputSmall}`}
              value={tenderRef}
              maxLength={64}
              placeholder={
                tenderMode === "card" ? "e.g. 481203" : "e.g. TXN 5521"
              }
              aria-label={
                tenderMode === "card"
                  ? "Card approval code"
                  : "Wallet reference"
              }
              onChange={(e) => onTenderRefChange(e.target.value)}
            />
          </label>
        )}

        {tenderMode === "split" && (
          <div className={tcss.payBlock}>
            {PAYMENT_METHODS.map((method) => (
              <label
                key={method.value}
                className={`${tcss.tenderRow} ${tcss.tenderRowQuiet}`}
              >
                <span>{PAYMENT_METHOD_LABELS[method.value]}</span>
                <input
                  className={`${tcss.tenderInput} ${tcss.tenderInputSmall}`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={`${method.label} amount`}
                  value={splitAmounts[method.value]}
                  onChange={(e) => onSplitChange(method.value, e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
            ))}
            <div
              className={`${tcss.change}${short ? ` ${tcss.changeShort}` : ""}`}
              aria-live="polite"
            >
              <span>{short ? "Still to pay" : "Change to give"}</span>
              <span className={tcss.changeAmount}>
                {formatMoney(Math.abs(balance))}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className={tcss.payFoot}>
        {hint && (
          <span className={tcss.blockedHint} aria-live="polite">
            {hint}
          </span>
        )}
        <button
          type="button"
          className={tcss.completeBtn}
          onClick={onComplete}
          disabled={
            busy || totals.itemCount === 0 || short || Boolean(blockedHint)
          }
        >
          <span className={tcss.completeLabel}>
            {busy ? "Completing…" : "Complete sale"}
            {!busy && !blockedHint && !short && (
              <span className={`${tcss.kbd} ${tcss.kbdOnAction}`}>F4</span>
            )}
          </span>
          <span>{formatMoney(total)}</span>
        </button>
        {holdsEnabled && (
          <button
            type="button"
            className={tcss.secondaryBtn}
            onClick={onHold}
            disabled={busy}
          >
            Hold sale <span className={tcss.kbd}>F6</span>
          </button>
        )}
      </div>
    </aside>
  );
}

/* ── Between customers ────────────────────────────────────── */

export type LastSaleSummary = {
  invoiceNo: string;
  soldAt: string;
  grandTotal: string;
  itemCount: number;
  detail: string | null;
};

function ago(iso: string): string {
  const minutes = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} d`;
}

export function PosIdlePanel({
  holds,
  holdsEnabled,
  onRecall,
  onShowAllHolds,
  lastSale,
  onReprint,
  onReturnItems,
}: {
  holds: HeldSaleSummary[];
  holdsEnabled: boolean;
  onRecall: (hold: HeldSaleSummary) => void;
  onShowAllHolds: () => void;
  lastSale: LastSaleSummary | null;
  onReprint: () => void;
  onReturnItems: () => void;
}) {
  const shownHolds = holds.slice(0, 3);
  return (
    <aside aria-label="Held sales and last sale" className={tcss.pay}>
      {holdsEnabled && (
        <div className={tcss.payBlock}>
          <div className={tcss.lastSaleTop}>
            <span className={tcss.label}>Held sales · {holds.length}</span>
            {holds.length > shownHolds.length ? (
              <button
                type="button"
                className={tcss.linkBtn}
                onClick={onShowAllHolds}
              >
                See all
              </button>
            ) : (
              <span className={tcss.picksHint}>Recall with F7</span>
            )}
          </div>
          {holds.length === 0 ? (
            <span className={tcss.emptyNote}>
              Nothing held. Hold a sale with F6 to serve someone else first.
            </span>
          ) : (
            shownHolds.map((hold) => {
              const waiting =
                hold.needsPharmacist ||
                hold.holdReason === "awaiting_pharmacist";
              return (
                <div
                  key={hold.id}
                  className={`${tcss.heldRow}${waiting ? ` ${tcss.heldRowWaiting}` : ""}`}
                >
                  <div className={tcss.heldMain}>
                    <span className={tcss.heldName}>
                      {hold.label ?? hold.holdRef}
                      {waiting && (
                        <span className={`${tcss.flag} ${tcss.flagWarn}`}>
                          Waiting for pharmacist
                        </span>
                      )}
                    </span>
                    <span className={tcss.heldMeta}>
                      {hold.itemCount} item{hold.itemCount === 1 ? "" : "s"} ·{" "}
                      {formatMoney(hold.total)} · {ago(hold.createdAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={tcss.recallBtn}
                    onClick={() => onRecall(hold)}
                  >
                    Recall
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      <div className={tcss.rule} />

      <div className={tcss.payBlock}>
        <span className={tcss.label}>Last sale</span>
        {lastSale ? (
          <>
            <div className={tcss.lastSaleTop}>
              <span className={tcss.lastSaleNo}>{lastSale.invoiceNo}</span>
              <span className={tcss.lastSaleAmount}>
                {formatMoney(lastSale.grandTotal)}
              </span>
            </div>
            <span className={tcss.heldMeta}>
              {formatTime(lastSale.soldAt)}
              {lastSale.detail ? ` · ${lastSale.detail}` : ""} ·{" "}
              {lastSale.itemCount} item
              {lastSale.itemCount === 1 ? "" : "s"}
            </span>
            <div className={tcss.twoUp}>
              <button
                type="button"
                className={tcss.secondaryBtn}
                onClick={onReprint}
              >
                Reprint receipt
              </button>
              <button
                type="button"
                className={tcss.secondaryBtn}
                onClick={onReturnItems}
              >
                Return items
              </button>
            </div>
          </>
        ) : (
          <span className={tcss.emptyNote}>
            No sales at this branch yet today.
          </span>
        )}
      </div>

      <div className={tcss.grow} />

      <div className={tcss.menuHint}>
        <b>In the ⋯ menu</b>
        <span>
          Open cash drawer · Manual item · Set my till PIN · Scan sound ·
          Shortcuts
        </span>
      </div>
    </aside>
  );
}

/* ── Sale complete ────────────────────────────────────────── */

export function PosDonePanel({
  sale,
  printed,
  onPrint,
  onNoReceipt,
  onNewSale,
}: {
  sale: SaleReceipt;
  printed: boolean;
  onPrint: () => void;
  onNoReceipt: () => void;
  onNewSale: () => void;
}) {
  const change = Number(sale.changeDue) || 0;
  const methods = [
    ...new Set(
      sale.payments.filter((p) => Number(p.amount) > 0).map((p) => p.method),
    ),
  ];
  const methodText = methods
    .map((m) => PAYMENT_METHOD_LABELS[m].toLowerCase())
    .join(" and ");

  return (
    <aside aria-label="Sale complete" className={tcss.pay}>
      <div className={tcss.doneHead}>
        <span className={tcss.doneIcon} aria-hidden>
          <IconCheck size={22} />
        </span>
        <span className={tcss.partyText}>
          <span className={tcss.doneTitle}>Sale complete</span>
          <span className={tcss.doneSub}>
            {sale.invoiceNo}
            {methodText ? ` · paid by ${methodText}` : ""}
          </span>
        </span>
      </div>

      <div className={tcss.changeBox} aria-live="polite">
        <span className={tcss.changeBoxLabel}>
          {change > 0 ? "Give change" : "No change due"}
        </span>
        <span className={tcss.changeBoxAmount}>
          {formatMoney(change > 0 ? change : sale.grandTotal)}
        </span>
        <span className={tcss.changeBoxSub}>
          {change > 0
            ? `Received ${formatAmount(sale.amountPaid)} · Total ${formatAmount(sale.grandTotal)}`
            : `Paid in full${methodText ? ` by ${methodText}` : ""}`}
        </span>
      </div>

      <div className={tcss.payBlock}>
        <span className={tcss.label}>Receipt</span>
        <div className={tcss.twoUp}>
          <button
            type="button"
            className={`${tcss.receiptBtn} ${tcss.receiptBtnOn}`}
            onClick={onPrint}
          >
            <IconPrinter size={18} />
            {printed ? "Print again" : "Print receipt"}
          </button>
          <button
            type="button"
            className={tcss.receiptBtn}
            onClick={onNoReceipt}
          >
            {printed ? "Done" : "No receipt"}
          </button>
        </div>
        <span className={tcss.emptyNote}>
          {printed
            ? "The receipt went to the printer."
            : "Prints by itself when auto-print is on in Settings."}
        </span>
      </div>

      <div className={tcss.grow} />

      <div className={tcss.payFoot}>
        <button
          type="button"
          className={`${tcss.completeBtn} ${tcss.completeBtnCentered}`}
          onClick={onNewSale}
        >
          New sale <span className={`${tcss.kbd} ${tcss.kbdOnAction}`}>F8</span>
        </button>
        <span className={tcss.blockedHint}>
          Or just scan — the next item starts a new sale.
        </span>
      </div>
    </aside>
  );
}
