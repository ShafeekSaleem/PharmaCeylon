import {
  BRANCH_HOURS_SCHEMA_VERSION,
  WEEKDAYS,
  rangeSpan,
  type BranchHours,
  type DayHours,
  type HoursException,
  type HoursRange,
  type MandatoryWindow,
  type Weekday,
} from "@pharmaceylon/shared";

/**
 * The hours editor works on a draft that reads like the screen, and turns it into the shared
 * `BranchHours` document only to validate and save. The one real translation is the mandatory
 * limit: on screen each day says "any time", "only between…" or "no selling"; in the document it
 * is D8's list of permitted windows, where null is no limit and an empty list is no selling.
 */

export type MandatoryMode = "none" | "limited" | "no_selling";

export type HoursDraft = {
  weekly: Record<Weekday, DayHours>;
  exceptions: HoursException[];
  mandatoryMode: MandatoryMode;
  /** Used when `mandatoryMode` is "limited": open_24h = any time, closed = no selling that day. */
  mandatoryDays: Record<Weekday, DayHours>;
};

export const DEFAULT_RANGE: HoursRange = { opens: "08:00", closes: "20:00" };
const FULL_DAY: HoursRange = { opens: "00:00", closes: "24:00" };

const everyDay = <T,>(value: (day: Weekday) => T) =>
  Object.fromEntries(WEEKDAYS.map((day) => [day, value(day)])) as Record<Weekday, T>;

/** What a branch with no hours yet starts from. Not saved until a person saves it, and never
 *  with a mandatory limit. */
export function startingHours(): BranchHours {
  return {
    schemaVersion: BRANCH_HOURS_SCHEMA_VERSION,
    weekly: everyDay(() => ({ mode: "hours", ranges: [DEFAULT_RANGE] })),
    exceptions: [],
    mandatory: null,
  };
}

/** Switching to "limited" starts every day at "any time", so choosing it adds no limit by
 *  itself; the owner narrows the days that need one. */
export function unrestrictedMandatoryDays(): Record<Weekday, DayHours> {
  return everyDay(() => ({ mode: "open_24h" }));
}

export function draftFromHours(hours: BranchHours): HoursDraft {
  const mandatory = hours.mandatory;
  return {
    weekly: { ...hours.weekly },
    exceptions: [...hours.exceptions],
    mandatoryMode: mandatory === null ? "none" : mandatory.length === 0 ? "no_selling" : "limited",
    mandatoryDays:
      mandatory === null || mandatory.length === 0
        ? unrestrictedMandatoryDays()
        : everyDay((day) => mandatoryDay(mandatory.filter((w) => w.day === day))),
  };
}

function mandatoryDay(windows: MandatoryWindow[]): DayHours {
  if (windows.length === 0) return { mode: "closed" };
  if (windows.length === 1 && windows[0].opens === FULL_DAY.opens && windows[0].closes === FULL_DAY.closes) {
    return { mode: "open_24h" };
  }
  return { mode: "hours", ranges: windows.map(({ opens, closes }) => ({ opens, closes })) };
}

export function hoursFromDraft(draft: HoursDraft): BranchHours {
  let mandatory: MandatoryWindow[] | null = null;
  if (draft.mandatoryMode === "no_selling") mandatory = [];
  if (draft.mandatoryMode === "limited") {
    mandatory = WEEKDAYS.flatMap((day) => {
      const hours = draft.mandatoryDays[day];
      if (hours.mode === "closed") return [];
      if (hours.mode === "open_24h") return [{ day, ...FULL_DAY }];
      return hours.ranges.map((range) => ({ day, ...range }));
    });
  }
  return {
    schemaVersion: BRANCH_HOURS_SCHEMA_VERSION,
    weekly: draft.weekly,
    exceptions: draft.exceptions,
    mandatory,
  };
}

/** A closing time earlier than the opening time runs into the next day. */
export function endsNextDay(range: HoursRange): boolean {
  const span = rangeSpan(range.opens, range.closes);
  return span !== null && span[1] > 24 * 60;
}

export function describeDay(hours: DayHours): string {
  if (hours.mode === "closed") return "Closed";
  if (hours.mode === "open_24h") return "Open 24 hours";
  return hours.ranges
    .map((r) => `${r.opens}–${r.closes}${endsNextDay(r) ? " (next day)" : ""}`)
    .join(", ");
}

/** `<input type="time">` has no 24:00; midnight at the end of the day shows as 00:00. */
export function timeInputValue(value: string): string {
  return value === "24:00" ? "00:00" : value;
}

/** Offset of `timeZone` from UTC at `at`, in minutes (Colombo → +330). */
function offsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/** "2026-10-31T20:00" read as the branch's wall clock → ISO instant. Null when malformed. */
export function branchLocalToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - offsetMinutes(timeZone, new Date(wall)) * 60_000;
  const corrected = wall - offsetMinutes(timeZone, new Date(utc)) * 60_000;
  if (corrected !== utc) utc = corrected;
  return new Date(utc).toISOString();
}

export function formatInBranchTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

/** Today's date (YYYY-MM-DD) on the branch's calendar. */
export function branchToday(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(`${date}T00:00:00.000Z`));
}
