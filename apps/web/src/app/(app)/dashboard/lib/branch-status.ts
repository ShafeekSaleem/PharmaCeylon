export type BranchTrackStatus = "on_track" | "at_risk" | "below" | "none";

/** "2026-08" → "August 2026". */
export function formatYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m) return yearMonth;
  return new Date(y, m - 1, 1).toLocaleString(undefined, { month: "long", year: "numeric" });
}

/** How far into the current month "on pace" should be, as a % of the monthly target. */
export function monthPaceExpectedPct(d = new Date()): number {
  const day = d.getDate();
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return (day / daysInMonth) * 100;
}

export function branchTrackStatus(
  achievementPct: number | null | undefined,
  expectedPct = monthPaceExpectedPct(),
): BranchTrackStatus {
  if (achievementPct == null) return "none";
  if (achievementPct >= expectedPct * 0.95) return "on_track";
  if (achievementPct >= expectedPct * 0.55) return "at_risk";
  return "below";
}
