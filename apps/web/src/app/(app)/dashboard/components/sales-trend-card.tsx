"use client";

import { useEffect, useState } from "react";
import { DISPLAY_LOCALE, formatDayMonth } from "@pharmaceylon/shared";
import { apiJson } from "@/lib/auth-client";
import { withBranch } from "@/lib/api-branch";
import { formatMoney } from "@/app/(app)/inventory/utils";
import { useDashboardRefresh } from "../hooks/use-dashboard-refresh";
import { dashboardHref, usePosHidden } from "../lib/pos-links";
import { formatCompactAxis } from "./simple-charts";
import Link from "next/link";
import css from "./sales-trend-card.module.css";

export type TrendDays = 7 | 14 | 30;
export type DailySales = { date?: string; label: string; value: number };

const RANGES: TrendDays[] = [7, 14, 30];

/** "Wed 11", or "11 Nov" over longer ranges; the last bar is "Today". */
export function dayBarLabel(
  point: DailySales,
  isLast: boolean,
  days: TrendDays,
): string {
  if (isLast) return "Today";
  if (!point.date) return point.label;
  const d = new Date(`${point.date}T12:00:00`);
  if (days === 7)
    return `${d.toLocaleDateString(DISPLAY_LOCALE, { weekday: "short" })} ${d.getDate()}`;
  return formatDayMonth(d);
}

/**
 * When the last days in the range are zero, say since when, so a run of empty days reads as a
 * question about the counters rather than a flat line. Today (the last bar) is not over, so it
 * never counts towards the run on its own: it takes two whole days without sales, and none so far
 * today, before the card asks. One closed day (a Sunday) is not a question.
 */
export function quietSince(
  points: readonly DailySales[],
  days: TrendDays,
): string | null {
  const today = points.length - 1;
  if (today < 0 || points[today].value !== 0) return null;
  let i = today - 1;
  while (i >= 0 && points[i].value === 0) i--;
  const quietWholeDays = today - 1 - i;
  if (quietWholeDays < 2) return null;
  if (i < 0) return `No sales recorded in the last ${days} days.`;
  const last = points[i];
  const when = last.date
    ? new Date(`${last.date}T12:00:00`).toLocaleDateString(DISPLAY_LOCALE, {
        weekday: "long",
        day: "numeric",
        month: "short",
      })
    : last.label;
  return `No sales recorded since ${when}. Check that the counters are sending their sales.`;
}

/**
 * Sales, one bar per day (UI1 #205). Bars, not a smoothed line, so a day without sales is a zero
 * and never a dip below it. Same source as before (`/analytics/sales-pulse?days=`), scoped to the
 * top-bar branch.
 */
export function SalesTrendCard({
  analyticsBranchId,
  fallback,
}: {
  analyticsBranchId: string | null;
  /** The page's own 7-day trend, shown until (or if) the range read lands. */
  fallback: DailySales[];
}) {
  const refreshVersion = useDashboardRefresh();
  const posHidden = usePosHidden();
  const [days, setDays] = useState<TrendDays>(7);
  const [points, setPoints] = useState<DailySales[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    apiJson<{ salesTrend?: DailySales[]; salesTrend7d?: DailySales[] }>(
      withBranch(`/analytics/sales-pulse?days=${days}`, analyticsBranchId),
    )
      .then((res) => {
        if (!cancelled) setPoints(res.salesTrend ?? res.salesTrend7d ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setPoints(null);
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [days, analyticsBranchId, refreshVersion]);

  // The page's own 7-day trend stands in only for the 7-day range; other ranges show nothing
  // until their read lands.
  const shown = points ?? (days === 7 ? fallback : []);
  const max = Math.max(0, ...shown.map((p) => p.value));
  const quiet = quietSince(shown, days);
  const showValues = days === 7;
  const labelEvery = days === 30 ? 5 : days === 14 ? 2 : 1;
  const reportHref = dashboardHref(
    "/reports?category=sales&report=sales-summary",
    posHidden,
  );

  return (
    <section className={css.card} aria-labelledby="sales-trend-title">
      <div className={css.head}>
        <div className={css.titleBlock}>
          <h2 id="sales-trend-title">Sales, last {days} days</h2>
          {quiet ? <p>{quiet}</p> : null}
        </div>
        <div className={css.range} role="group" aria-label="Range">
          {RANGES.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={days === n}
              className={days === n ? css.rangeOn : undefined}
              onClick={() => {
                if (n === days) return;
                // The old range's bars must not sit under the new range's title while it loads.
                setPoints(null);
                setDays(n);
              }}
            >
              {n} days
            </button>
          ))}
        </div>
        {reportHref ? (
          <Link href={reportHref} className={css.link}>
            Sales report
          </Link>
        ) : null}
      </div>
      {failed && shown.length === 0 ? (
        <p className={css.empty} role="status">
          Sales trend unavailable. Refresh to try again.
        </p>
      ) : shown.length === 0 ? (
        <p className={css.empty}>Loading sales…</p>
      ) : (
        <ol
          className={css.bars}
          style={{
            gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))`,
          }}
        >
          {shown.map((p, i) => {
            const last = i === shown.length - 1;
            const label = dayBarLabel(p, last, days);
            const pct = max > 0 ? (p.value / max) * 100 : 0;
            const showLabel = last || (shown.length - 1 - i) % labelEvery === 0;
            return (
              <li
                key={p.date ?? `${p.label}-${i}`}
                className={css.day}
                aria-label={`${label}: ${formatMoney(p.value)}`}
              >
                <span className={css.plot}>
                  {showValues ? (
                    <span className={css.value} aria-hidden>
                      {p.value === 0 ? "0" : formatCompactAxis(p.value)}
                    </span>
                  ) : null}
                  <span
                    className={p.value > 0 ? css.bar : css.barZero}
                    style={
                      p.value > 0
                        ? { height: `${Math.max(pct * 0.82, 2)}%` }
                        : undefined
                    }
                    aria-hidden
                  />
                </span>
                <span className={css.dayLabel} aria-hidden>
                  {showLabel ? label : ""}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
