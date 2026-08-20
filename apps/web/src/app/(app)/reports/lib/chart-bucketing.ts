import type { BranchTrendPoint } from "./types";

export type ChartGranularity = "daily" | "weekly" | "monthly";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Buckets a daily series into weekly (rolling 7-day windows from the start of the range) or
 * monthly (calendar month) totals. Weekly is index-based rather than ISO-week so it stays
 * meaningful for an arbitrary "last N days" window instead of clipping at a calendar boundary. */
export function bucketTrend(points: BranchTrendPoint[], mode: ChartGranularity): BranchTrendPoint[] {
  if (mode === "daily" || points.length === 0) return points;

  if (mode === "weekly") {
    const buckets: BranchTrendPoint[] = [];
    for (let i = 0; i < points.length; i += 7) {
      const slice = points.slice(i, i + 7);
      const value = slice.reduce((s, p) => s + p.value, 0);
      buckets.push({ label: `${slice[0]!.label} – ${slice[slice.length - 1]!.label}`, date: slice[0]!.date, value });
    }
    return buckets;
  }

  const byMonth = new Map<string, BranchTrendPoint>();
  for (const p of points) {
    const d = new Date(p.date);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const cur = byMonth.get(key) ?? { label: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`, date: p.date, value: 0 };
    cur.value += p.value;
    byMonth.set(key, cur);
  }
  return [...byMonth.values()];
}
