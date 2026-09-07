"use client";

import css from "../products.module.css";
import type { StockStatus } from "../types";
import { stockStatusLabel } from "../utils";

type Props = {
  qtyOnHand: number | null | undefined;
  stockStatus: StockStatus | null | undefined;
  reorderGap?: number | null;
  reorderLevel?: number;
  variant?: "inline" | "default";
  showReorderHint?: boolean;
};

function StockIcon({ status }: { status: StockStatus | null | undefined }) {
  if (status === "low") {
    return (
      <svg
        className={css.stockPillWarnIcon}
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden
      >
        <path
          d="M5.13 1.45a1 1 0 0 1 1.74 0l4.4 7.7A1 1 0 0 1 10.4 10.7H1.6a1 1 0 0 1-.87-1.55l4.4-7.7Z"
          fill="currentColor"
        />
        <path
          d="M6 4.15v2.7"
          stroke="#fff"
          strokeWidth="1.35"
          strokeLinecap="round"
        />
        <circle cx="6" cy="8.35" r="0.7" fill="#fff" />
      </svg>
    );
  }
  return <span className={css.stockPillDot} aria-hidden />;
}

export function ProductStockBadge({
  qtyOnHand,
  stockStatus,
  reorderGap,
  reorderLevel,
  variant = "default",
  showReorderHint = false,
}: Props) {
  if (qtyOnHand === null || qtyOnHand === undefined) {
    return (
      <span
        className={css.stockUnavailable}
        data-tooltip="Select a branch to view stock"
      >
        —
      </span>
    );
  }

  const tone =
    stockStatus === "out"
      ? css.stockPillOut
      : stockStatus === "low"
        ? css.stockPillLow
        : css.stockPillOk;

  const label = stockStatusLabel(stockStatus);
  const units = qtyOnHand === 1 ? "unit" : "units";
  const text = `${qtyOnHand} ${units} - ${label}`;
  /*
   * What the pill shows is shorter than what it means, because the full wording never fitted
   * the column — it used to run out under the Status badge beside it.
   *
   * Neither word it drops is carrying anything: "out of stock" is nought units by definition,
   * and a healthy count is healthy because of the number already in the pill. Only "low" is a
   * judgement the number alone doesn't make, so only "low" keeps its word. The full text stays
   * in the tooltip and, importantly, in the accessible name — so nothing here rests on colour.
   */
  const shortText =
    stockStatus === "out"
      ? label
      : stockStatus === "low"
        ? `${qtyOnHand} ${units} - ${label}`
        : `${qtyOnHand} ${units}`;

  const showGap =
    showReorderHint &&
    stockStatus === "low" &&
    reorderGap != null &&
    reorderLevel != null;

  return (
    <span
      className={`${css.stockPill} ${tone} ${variant === "inline" ? css.stockPillInline : ""}`}
      data-tooltip={text}
      aria-label={text}
    >
      <StockIcon status={stockStatus} />
      <span className={css.stockPillText}>{shortText}</span>
      {showGap && (
        <span className={css.stockPillHint}>
          {reorderGap} below reorder ({reorderLevel})
        </span>
      )}
    </span>
  );
}
