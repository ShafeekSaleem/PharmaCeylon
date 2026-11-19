"use client";

import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import type { DashboardData } from "../hooks/use-dashboard-data";
import dashCss from "../dashboard.module.css";
import css from "./owner-payment-mix.module.css";

type Slice = { label: string; value: number; color: string };

/** Share of each tender, rounded to one decimal; the slices keep the order they came in. */
export function paymentMixShares(
  slices: readonly Slice[],
): Array<Slice & { pct: number }> {
  const total = slices.reduce((s, p) => s + Math.max(0, p.value), 0);
  return slices
    .filter((p) => p.value > 0)
    .map((p) => ({ ...p, pct: total > 0 ? (p.value / total) * 100 : 0 }));
}

/**
 * How customers paid (UI1 #205): one stacked bar and a legend with the amount and share of each
 * tender. A bar stays readable at any card width, and the period is printed on the card, so a
 * "Today" in the centre can't sit beside a month's totals the way the old donut did.
 */
export function OwnerPaymentMixWidget({ data }: { data: DashboardData }) {
  const { paymentMix, paymentMixIsPlaceholder, paymentMixLabel } = data;
  const shares = paymentMixShares(paymentMix);
  const description = shares
    .map((p) => `${p.label} ${p.pct.toFixed(0)} percent`)
    .join(", ");

  return (
    <DashboardPanel
      title="How customers paid"
      compact
      badge={
        paymentMixIsPlaceholder ? (
          <span className={dashCss.placeholderBadge}>Sample</span>
        ) : (
          <span className={css.period}>{paymentMixLabel}</span>
        )
      }
      footerHref="/reports?category=sales&report=payment-methods"
      footerLabel="Payment methods report"
    >
      {shares.length === 0 ? (
        <p className={dashCss.emptyState}>
          No payments recorded {paymentMixLabel.toLowerCase()}.
        </p>
      ) : (
        <>
          <div className={css.bar} role="img" aria-label={description}>
            {shares.map((p) => (
              <span
                key={p.label}
                className={css.segment}
                style={{ flexGrow: p.pct, background: p.color }}
              />
            ))}
          </div>
          <ul className={css.legend}>
            {shares.map((p) => (
              <li key={p.label} className={css.legendRow}>
                <span
                  className={css.swatch}
                  style={{ background: p.color }}
                  aria-hidden
                />
                <span className={css.legendLabel}>{p.label}</span>
                <span className={css.amount}>{formatMoney(p.value)}</span>
                <span className={css.pct}>{p.pct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </DashboardPanel>
  );
}
