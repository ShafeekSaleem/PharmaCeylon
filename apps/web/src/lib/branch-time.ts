const dayKey = (at: number | Date, timeZone: string) =>
  new Date(at).toLocaleDateString("en-CA", { timeZone });

/**
 * "14:02" today, "3 Nov, 14:02" on another day, in the branch's timezone (as Daily work reads
 * it), so a manager looking from elsewhere sees the counter's own clock.
 */
export function branchTime(
  at: number,
  timeZone: string,
  now: Date = new Date(),
): string {
  const clock = { hour: "2-digit", minute: "2-digit", timeZone } as const;
  return dayKey(at, timeZone) === dayKey(now, timeZone)
    ? new Date(at).toLocaleTimeString("en-GB", clock)
    : new Date(at).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        ...clock,
      });
}
