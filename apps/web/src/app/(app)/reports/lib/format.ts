export { formatMoney } from "@/app/(app)/inventory/utils";

/** Compact currency for chart axes / dense KPI subtext, e.g. "LKR 220K", "LKR 1.2M". */
export function formatCompactMoney(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}LKR ${(abs / 1_000_000).toFixed(abs % 1_000_000 === 0 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}LKR ${Math.round(abs / 1000)}K`;
  return `${sign}LKR ${Math.round(abs)}`;
}

/** Percent change from `previous` to `current`; null when it can't be meaningfully computed. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

/** Percentage-point change (for margin % comparisons, not relative %). */
export function ppChange(current: number, previous: number): number {
  return current - previous;
}

/** Signed relative-change label for a StatCard trend pill, e.g. "+8.4%" / "-3.1%". */
export function formatPctTrend(n: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

/** Signed percentage-point label, e.g. "+1.2pp" / "-0.5pp". */
export function formatPpTrend(n: number | null): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}pp`;
}

export function formatDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateShort(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}
