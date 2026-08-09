"use client";

import { useEffect, useMemo, useState } from "react";
import { apiJson } from "@/lib/auth-client";
import { formatMoney } from "@/app/(app)/inventory/utils";
import type { FinancialSnapshot } from "../hooks/use-dashboard-data";
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
  financial: FinancialSnapshot | null;
  /** When set, payment mix filters to this branch; omit for tenant-wide. */
  analyticsBranchId?: string | null;
};

function withBranch(path: string, branchId: string | null | undefined): string {
  if (!branchId) return path;
  const qs = `branchId=${encodeURIComponent(branchId)}`;
  return path.includes("?") ? `${path}&${qs}` : `${path}?${qs}`;
}

export function CashFlowPanel({ financial, analyticsBranchId = null }: Props) {
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

  return (
    <DashboardPanel
      title="Cash Flow & Payments"
      compact
      className={css.splitPanel}
      footerHref="/reports"
      footerLabel="View details →"
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
        <div className={css.cashFlowSummary}>
          <div>
            <span className={css.muted}>Receivables</span>
            <span className={css.statEmph}>
              {financial
                ? formatMoney(financial.receivablesOutstanding)
                : "—"}
            </span>
            <span className={css.placeholderNote}>
              {financial
                ? `${financial.receivablesCustomerCount} customers`
                : "—"}
            </span>
          </div>
          <div>
            <span className={css.muted}>Payables</span>
            <span className={css.statEmph}>
              {financial ? formatMoney(financial.payablesOutstanding) : "—"}
            </span>
            <span className={css.placeholderNote}>
              {financial
                ? `${financial.payablesSupplierCount} suppliers`
                : "—"}
            </span>
          </div>
        </div>
      </div>
    </DashboardPanel>
  );
}
