"use client";

import { useMemo } from "react";
import { IconCreditCard } from "@/components/icons";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "../components/dashboard-panel";
import { SimpleDonutChart } from "../components/simple-charts";
import type { DashboardData } from "../hooks/use-dashboard-data";
import css from "../dashboard.module.css";

export function CashierPaymentMethodsWidget({ data }: { data: DashboardData }) {
  const { todaySalesTotal, paymentMix, paymentMixIsPlaceholder } = data;

  const topPaymentMethod = useMemo(() => {
    if (paymentMixIsPlaceholder || paymentMix.length === 0) return null;
    const total = paymentMix.reduce((s, p) => s + p.value, 0);
    const top = paymentMix.reduce((a, b) => (b.value > a.value ? b : a));
    return { label: top.label, pct: total > 0 ? (top.value / total) * 100 : 0 };
  }, [paymentMix, paymentMixIsPlaceholder]);

  return (
    <DashboardPanel
      title="Payment Methods Today"
      compact
      badge={paymentMixIsPlaceholder ? <span className={css.placeholderBadge}>Sample</span> : undefined}
      footerHref="/pos"
      footerLabel="Open POS →"
      footerMeta={
        topPaymentMethod ? (
          <span className={css.footfallFooterMeta}>
            <span className={css.footfallPeakPill}>
              <IconCreditCard size={11} strokeWidth={2.5} aria-hidden />
              {topPaymentMethod.label} leads
            </span>
            <span className={css.muted}>{topPaymentMethod.pct.toFixed(0)}% of today&apos;s tenders</span>
          </span>
        ) : undefined
      }
    >
      {paymentMixIsPlaceholder ? (
        <>
          <p className={css.emptyState}>No tender data in today&apos;s sales yet.</p>
          <p className={css.placeholderNote}>
            Mix chart stays empty until payment lines are present — not a live sample mix.
          </p>
        </>
      ) : (
        <SimpleDonutChart
          slices={paymentMix}
          centerValue={formatMoney(todaySalesTotal)}
          centerLabel="Total"
          formatValue={(n) => formatMoney(n)}
        />
      )}
    </DashboardPanel>
  );
}
