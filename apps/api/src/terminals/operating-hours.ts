import {
  WEEKDAYS,
  rangeSpan,
  validateBranchHours,
  type BranchHours,
  type DayHours,
  type Weekday,
} from "@pharmaceylon/shared";
import { addDays, dateKeyToUtc } from "../common/business-date.util";

/** What a branch's own hours say about one instant. "unknown" is never "open". */
export type OperatingHoursVerdict =
  | Readonly<{ kind: "unknown"; reason: "hours_unset" | "hours_invalid" | "timezone_invalid" }>
  | Readonly<{ kind: "outside_mandatory" }>
  | Readonly<{ kind: "open"; via: "routine" | "extension" }>
  | Readonly<{ kind: "closed" }>;

export type OperatingHoursInput = Readonly<{
  /** `Branch.operatingHours` exactly as stored; validated here, never trusted. */
  hours: unknown;
  /** `Branch.timezone`. An unusable zone is unknown hours, not a silent Colombo fallback. */
  timeZone: string;
  /** Unrevoked online business extensions (W7) — approved time added to the routine schedule. */
  extensions: ReadonlyArray<Readonly<{ startsAt: Date; endsAt: Date }>>;
}>;

const MINUTES_PER_DAY = 24 * 60;

type LocalClock = { dateKey: string; weekday: Weekday; minute: number };

function localClock(timeZone: string, at: Date): LocalClock | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(at);
  } catch {
    return null;
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday").toLowerCase().slice(0, 3) as Weekday;
  if (!WEEKDAYS.includes(weekday)) return null;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    weekday,
    minute: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function spans(day: DayHours): Array<[number, number]> {
  if (day.mode === "closed") return [];
  if (day.mode === "open_24h") return [[0, MINUTES_PER_DAY]];
  return day.ranges.map((r) => rangeSpan(r.opens, r.closes)).filter((s): s is [number, number] => s !== null);
}

/** A range belongs to the day it opens on: today's ranges, plus yesterday's overnight tail. */
function covers(today: Array<[number, number]>, yesterday: Array<[number, number]>, minute: number) {
  return (
    today.some(([start, end]) => start <= minute && minute < end) ||
    yesterday.some(([start, end]) => start <= minute + MINUTES_PER_DAY && minute + MINUTES_PER_DAY < end)
  );
}

/**
 * Decide from the branch's structured hours (W7 `BranchHours`) whether `at` is selling time.
 *
 * - Dated exceptions (owner-entered or confirmed gazette holidays) replace the weekly schedule
 *   for that local date; a range still belongs to the day it opens on.
 * - Mandatory windows are a hard weekly limit: `null` = none, `[]` = no selling at all. Dated
 *   exceptions and business extensions never widen them.
 * - Online business extensions add time to the routine schedule only.
 * - Unset or unreadable hours, or an unusable timezone, is "unknown": callers fail closed.
 *
 * Times are compared in the branch's local wall clock. This records branch policy; it does not
 * decide which hours the law permits.
 */
export function evaluateOperatingHours(input: OperatingHoursInput, at: Date): OperatingHoursVerdict {
  if (input.hours === null || input.hours === undefined) return { kind: "unknown", reason: "hours_unset" };
  const parsed = validateBranchHours(input.hours);
  if (!parsed.ok) return { kind: "unknown", reason: "hours_invalid" };
  const hours: BranchHours = parsed.value;
  const clock = localClock(input.timeZone, at);
  if (!clock) return { kind: "unknown", reason: "timezone_invalid" };

  const previousWeekday = WEEKDAYS[(WEEKDAYS.indexOf(clock.weekday) + 6) % 7]!;
  const previousDateKey = addDays(dateKeyToUtc(clock.dateKey), -1).toISOString().slice(0, 10);

  if (hours.mandatory !== null) {
    const windows = (day: Weekday) =>
      hours.mandatory!
        .filter((w) => w.day === day)
        .map((w) => rangeSpan(w.opens, w.closes))
        .filter((s): s is [number, number] => s !== null);
    if (!covers(windows(clock.weekday), windows(previousWeekday), clock.minute))
      return { kind: "outside_mandatory" };
  }

  const dayHours = (dateKey: string, weekday: Weekday) =>
    hours.exceptions.find((e) => e.date === dateKey)?.hours ?? hours.weekly[weekday];
  if (
    covers(
      spans(dayHours(clock.dateKey, clock.weekday)),
      spans(dayHours(previousDateKey, previousWeekday)),
      clock.minute,
    )
  )
    return { kind: "open", via: "routine" };

  const instant = at.getTime();
  if (input.extensions.some((e) => e.startsAt.getTime() <= instant && instant < e.endsAt.getTime()))
    return { kind: "open", via: "extension" };
  return { kind: "closed" };
}
