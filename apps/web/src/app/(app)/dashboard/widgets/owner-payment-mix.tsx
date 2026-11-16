"use client";

import { useMemo } from "react";
import { IconCreditCard } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { SimpleDonutChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

/** Fixed-grid payment mix for owners (v6). */
export function OwnerPaymentMixWidget({ data }: { data: DashboardData }) {
  const { paymentMix, paymentMixIsPlaceholder, todaySalesTotal } = data;

  const topPaymentMethod = useMemo(() => {
    if (paymentMixIsPlaceholder || paymentMix.length === 0) return null;
    const total = paymentMix.reduce((s, p) => s + p.value, 0);
    const top = paymentMix.reduce((a, b) => (b.value > a.value ? b : a));
    return { label: top.label, pct: total > 0 ? (top.value / total) * 100 : 0 };
  }, [paymentMix, paymentMixIsPlaceholder]);

  return (
    <DashboardPanel
      title="Payment mix"
      compact
      badge={
        paymentMixIsPlaceholder ? (
          <span className={css.placeholderBadge}>Sample</span>
        ) : undefined
      }
      footerHref="/reports?category=sales&report=payment-methods"
      footerLabel="View reports →"
      footerMeta={
        topPaymentMethod ? (
          <span className={css.footfallFooterMeta}>
            <span className={css.footfallPeakPill}>
              <IconCreditCard size={11} strokeWidth={2.5} aria-hidden />
              {topPaymentMethod.label} leads
            </span>
            <span className={css.muted}>
              {topPaymentMethod.pct.toFixed(0)}% of today&apos;s tenders
            </span>
          </span>
        ) : (
          <span className={css.muted}>
            {formatMoney(todaySalesTotal)} today
          </span>
        )
      }
    >
      {paymentMix.length === 0 ? (
        <p className={css.emptyState}>No tender data in today&apos;s sales yet.</p>
      ) : (
        <SimpleDonutChart
          slices={paymentMix}
          centerValue={formatMoney(todaySalesTotal)}
          centerLabel="Today"
          formatValue={(n) => formatMoney(n)}
        />
      )}
    </DashboardPanel>
  );
}