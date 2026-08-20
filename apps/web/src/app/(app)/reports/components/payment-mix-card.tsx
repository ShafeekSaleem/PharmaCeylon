"use client";

import { IconCreditCard } from "@/components/icons";
import { SimpleDonutChart } from "@/app/(app)/dashboard/components/simple-charts";
import { formatMoney } from "../lib/format";
import css from "../reports.module.css";

type MixRow = { label: string; value: number; color: string };

type Props = {
  rows: MixRow[];
  totalRevenue: number;
  periodLabel: string;
};

/** Same donut + leader-pill design as the dashboard's "Cash Flow & Payments" Payment Mix widget
 * (SimpleDonutChart, legend beside, no per-row amount column) — wired to this report's own
 * already-filtered data instead of a separate Today/Week/Month fetch, so it never shows a different
 * number than the rest of the page. */
export function PaymentMixCard({ rows, totalRevenue, periodLabel }: Props) {
  if (rows.length === 0) {
    return <p className={css.emptyNote}>No payment data for this range yet.</p>;
  }

  const leader = [...rows].sort((a, b) => b.value - a.value)[0]!;
  const leaderPct = totalRevenue > 0 ? (leader.value / totalRevenue) * 100 : 0;

  return (
    <>
      <SimpleDonutChart slices={rows} centerValue={formatMoney(totalRevenue)} centerLabel={periodLabel} legendBeside />
      <p className={css.mixLeaderMeta}>
        <span className={css.mixLeaderPill}>
          <IconCreditCard size={11} strokeWidth={2.5} aria-hidden />
          {leader.label} leads
        </span>
        <span className={css.mixLeaderCaption}>
          {leaderPct.toFixed(0)}% of {periodLabel.toLowerCase()}&apos;s tenders
        </span>
      </p>
    </>
  );
}
