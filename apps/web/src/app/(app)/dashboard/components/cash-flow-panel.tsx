"use client";

import { useEffect, useMemo, useState } from "react";
import { IconCreditCard } from "@/components/icons";
import { withBranch } from "@/lib/api-branch";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { DashboardPanel } from "./dashboard-panel";
import { PeriodToggle } from "./period-toggle";
import { paymentMixColor } from "../lib/payment-mix-colors";
import { SimpleDonutChart } from "./simple-charts";
import css from "../dashboard.module.css";

type MixPeriod = "today" | "this_week" | "this_month";

const MIX_OPTIONS = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
] as const;

type Props = {
  /** When set, payment mix filters to this branch; omit for tenant-wide. */
  analyticsBranchId?: string | null;
};

export function CashFlowPanel({ analyticsBranchId = null }: Props) {
  const [mixPeriod, setMixPeriod] = useState<MixPeriod>("this_month");
  const [slices, setSlices] = useState<
    Array<{ label: string; value: number; color: string }>
  >([]);
  const [paymentMixTotal, setPaymentMixTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void apiJson<{
      paymentMix: Array<{ method: string; value: number }>;
      paymentMixTotal?: number;
    }>(
      withBranch(
        `/analytics/sales-pulse?days=7&mixPeriod=${mixPeriod}`,
        analyticsBranchId,
      ),
    )
      .then((res) => {
        if (cancelled) return;
        setSlices(
          (res.paymentMix ?? []).map((p) => ({
            label: p.method
              .replace(/_/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase()),
            value: p.value,
            color: paymentMixColor(p.method),
          })),
        );
        setPaymentMixTotal(
          typeof res.paymentMixTotal === "number"
            ? res.paymentMixTotal
            : (res.paymentMix ?? []).reduce((s, p) => s + p.value, 0),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setSlices([]);
          setPaymentMixTotal(0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [mixPeriod, analyticsBranchId]);

  const centerValue = useMemo(
    () => formatMoney(paymentMixTotal),
    [paymentMixTotal],
  );

  const periodLabel =
    MIX_OPTIONS.find((o) => o.value === mixPeriod)?.label ?? "This month";

  const leader = useMemo(() => {
    if (slices.length === 0) return null;
    const top = slices.reduce((a, b) => (b.value > a.value ? b : a));
    return { label: top.label, pct: paymentMixTotal > 0 ? (top.value / paymentMixTotal) * 100 : 0 };
  }, [slices, paymentMixTotal]);

  return (
    <DashboardPanel
      title="Cash Flow & Payments"
      compact
      className={css.splitPanel}
      footerHref="/reports?category=sales&report=payment-methods"
      footerLabel="View details →"
      footerMeta={
        leader ? (
          <span className={css.footfallFooterMeta}>
            <span className={css.footfallPeakPill}>
              <IconCreditCard size={11} strokeWidth={2.5} aria-hidden />
              {leader.label} leads
            </span>
            <span className={css.muted}>{leader.pct.toFixed(0)}% of {periodLabel.toLowerCase()}&apos;s tenders</span>
          </span>
        ) : undefined
      }
    >
      <div className={css.cashFlowBody}>
        <div className={css.subHeadingRow}>
          <h3 className={css.subHeading}>Payment Mix</h3>
          <PeriodToggle
            aria-label="Payment mix duration"
            value={mixPeriod}
            options={MIX_OPTIONS}
            onChange={(v) => setMixPeriod(v as MixPeriod)}
          />
        </div>
        {loading && slices.length === 0 ? (
          <p className={css.emptyState}>Loading payment mix…</p>
        ) : slices.length === 0 ? (
          <p className={css.emptyState}>No tender data for this period.</p>
        ) : (
          <SimpleDonutChart
            slices={slices}
            centerValue={centerValue}
            centerLabel={periodLabel}
            legendBeside
          />
        )}
      </div>
    </DashboardPanel>
  );
}
