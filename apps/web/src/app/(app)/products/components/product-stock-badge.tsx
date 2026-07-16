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
      <span className={css.stockPillText}>{text}</span>
      {showGap && (
        <span className={css.stockPillHint}>
          {reorderGap} below reorder ({reorderLevel})
        </span>
      )}
    </span>
  );
}
