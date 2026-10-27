/** W7 / D-W6: a branch's structured hours, edited on the web and read by P3 when it resolves a
 * grant's signed `operatingWindows` / `mandatoryOperatingWindows` (revised D8).
 *
 * Every time is the branch's local wall-clock time ("HH:MM", branch timezone). A range whose
 * closing time is earlier than its opening time runs past midnight and ends the next day; a
 * closing time of "24:00" is midnight at the end of the day. The range belongs to the day it
 * opens on, so a dated exception for the next day does not cut it short.
 *
 * - `weekly` is the routine schedule. Outside it, a prepared manager may acknowledge a bounded
 *   continuation at the counter during an outage.
 * - `exceptions` replace the weekly hours for one local date (holidays, stocktake days).
 * - `mandatory` is a hard limit nobody can override at the counter. `null` means no mandatory
 *   restriction; an empty list means NO SELLING AT ALL. Otherwise selling is allowed only inside
 *   the listed weekly windows. It is null unless the owner sets it, and never inferred.
 *
 * Online business extensions are stored separately (they carry an approver and a reason) and add
 * time to the routine schedule; they never extend a mandatory limit.
 *
 * This model records branch policy. It does not decide which hours the law permits.
 */

export const BRANCH_HOURS_SCHEMA_VERSION = 1 as const;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const MAX_RANGES_PER_DAY = 4;
export const MAX_HOURS_EXCEPTIONS = 400;
export const MAX_EXCEPTION_LABEL_LENGTH = 80;
/** One extension may cover at most one grant's worth of time. */
export const MAX_HOURS_EXTENSION_MS = 24 * 60 * 60 * 1000;

export type HoursRange = Readonly<{ opens: string; closes: string }>;

export type DayHours =
  | Readonly<{ mode: "closed" }>
  | Readonly<{ mode: "open_24h" }>
  | Readonly<{ mode: "hours"; ranges: ReadonlyArray<HoursRange> }>;

export type WeeklyHours = Readonly<Record<Weekday, DayHours>>;

/** `holiday_suggestion` exceptions were offered from a holiday list and confirmed by a person. */
export type HoursExceptionSource = "owner" | "holiday_suggestion";

export type HoursException = Readonly<{
  date: string; // YYYY-MM-DD, branch-local
  label: string;
  hours: DayHours;
  source: HoursExceptionSource;
  holidayKey: string | null; // required for holiday_suggestion, so the same holiday isn't offered twice
}>;

export type MandatoryWindow = Readonly<{ day: Weekday; opens: string; closes: string }>;

export type BranchHours = Readonly<{
  schemaVersion: typeof BRANCH_HOURS_SCHEMA_VERSION;
  weekly: WeeklyHours;
  exceptions: ReadonlyArray<HoursException>;
  mandatory: ReadonlyArray<MandatoryWindow> | null;
}>;

/** How the stored document came to exist; null while a branch has no structured hours. */
export type BranchHoursOrigin = "legacy_text" | "editor";

export type BranchHoursExtensionView = Readonly<{
  id: string;
  startsAt: string; // ISO instant
  endsAt: string;
  reason: string;
  approvedBy: Readonly<{ id: string; name: string | null }>;
  approvedAt: string;
}>;

/** GET/PUT `/tenant/branches/:branchId/hours`. */
export type BranchHoursView = Readonly<{
  branchId: string;
  branchName: string;
  timezone: string;
  /** Bumps on every change to hours or extensions; send it back as `expectedVersion`. */
  version: number;
  hours: BranchHours | null;
  origin: BranchHoursOrigin | null;
  updatedAt: string | null;
  updatedBy: Readonly<{ id: string; name: string | null }> | null;
  /** The free text that hours were entered as before W7. Kept as it was; never written again. */
  legacyText: string | null;
  /** Extensions that have not ended or been revoked, earliest first. */
  extensions: ReadonlyArray<BranchHoursExtensionView>;
}>;

export const HOLIDAY_KINDS = ["public", "poya", "bank", "mercantile"] as const;
export type HolidayKind = (typeof HOLIDAY_KINDS)[number];

/** One date. Holidays the gazette puts on the same date are offered together, because a branch
 *  has one set of hours per date. */
export type HolidaySuggestion = Readonly<{
  key: string; // "lk:YYYY-MM-DD", kept on the exception so the date isn't offered again
  date: string; // YYYY-MM-DD
  name: string;
  kinds: ReadonlyArray<HolidayKind>;
}>;

/** Where one year's list was copied from, and when a person last checked it. */
export type HolidayListSource = Readonly<{
  name: string;
  reference: string | null;
  checkedOn: string; // YYYY-MM-DD
}>;

/** GET `/tenant/branches/:branchId/hours/holiday-suggestions`. One entry per year the suggestions
 *  cover (this year and next); `source` is null when there is no list for that year yet, and then
 *  nothing is suggested for it — dates are never guessed. Suggestions are only ever offered,
 *  never applied. */
export type HolidaySuggestionsView = Readonly<{
  years: ReadonlyArray<Readonly<{ year: number; source: HolidayListSource | null }>>;
  holidays: ReadonlyArray<HolidaySuggestion>;
}>;

export const BRANCH_HOURS_ERROR_CODES = {
  versionConflict: "HOURS_VERSION_CONFLICT",
  noSellingConfirmationRequired: "NO_SELLING_CONFIRMATION_REQUIRED",
  mandatoryOwnerOnly: "MANDATORY_HOURS_OWNER_ONLY",
} as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HOLIDAY_KEY = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/** Minutes after local midnight, or null. "24:00" is accepted only where `closing` is true. */
export function localTimeMinutes(value: unknown, closing = false): number | null {
  if (typeof value !== "string") return null;
  if (closing && value === "24:00") return 24 * 60;
  const match = TIME.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** [start, end) in minutes from the opening day's midnight; end may pass 1440 (overnight). */
export function rangeSpan(opens: string, closes: string): [number, number] | null {
  const start = localTimeMinutes(opens);
  const end = localTimeMinutes(closes, true);
  if (start === null || end === null || start === end) return null;
  return [start, end > start ? end : end + 24 * 60];
}

export function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** `[]`: the owner has stopped all selling at this branch, which needs a second confirmation. */
export function isNoSelling(hours: Pick<BranchHours, "mandatory"> | null | undefined): boolean {
  return Array.isArray(hours?.mandatory) && hours.mandatory.length === 0;
}

/** Weekdays a mandatory limit leaves with no selling time at all (empty when there is no limit). */
export function daysWithoutMandatoryTime(mandatory: BranchHours["mandatory"]): Weekday[] {
  if (mandatory === null) return [];
  return WEEKDAYS.filter((day) => !mandatory.some((window) => window.day === day));
}

export function sameMandatory(a: BranchHours["mandatory"], b: BranchHours["mandatory"]): boolean {
  if (a === null || b === null) return a === b;
  const key = (list: ReadonlyArray<MandatoryWindow>) =>
    JSON.stringify(sortMandatory(list).map((w) => [w.day, w.opens, w.closes]));
  return key(a) === key(b);
}

export type BranchHoursValidation =
  | Readonly<{ ok: true; value: BranchHours }>
  | Readonly<{ ok: false; errors: ReadonlyArray<string> }>;

/**
 * Strict structural check for a whole hours document from a client or the database. Unknown
 * fields are refused rather than dropped, so nobody can smuggle in something P3 might later read.
 * The returned value is normalized: ranges and windows sorted, labels trimmed, a closing time of
 * "00:00" written as "24:00".
 */
export function validateBranchHours(input: unknown): BranchHoursValidation {
  const errors: string[] = [];
  const doc = asRecord(input, "Hours", ["schemaVersion", "weekly", "exceptions", "mandatory"], errors);
  if (!doc) return { ok: false, errors };
  if (doc.schemaVersion !== BRANCH_HOURS_SCHEMA_VERSION) errors.push("Hours: unsupported schema version.");

  const weeklyInput = asRecord(doc.weekly, "Weekly hours", WEEKDAYS, errors);
  const weekly = {} as Record<Weekday, DayHours>;
  if (weeklyInput) {
    for (const day of WEEKDAYS) {
      if (!(day in weeklyInput)) {
        errors.push(`${WEEKDAY_LABELS[day]}: hours are missing.`);
        continue;
      }
      const parsed = parseDayHours(weeklyInput[day], WEEKDAY_LABELS[day], errors);
      if (parsed) weekly[day] = parsed;
    }
  }

  const exceptions: HoursException[] = [];
  if (!Array.isArray(doc.exceptions)) {
    errors.push("Exceptions must be a list.");
  } else {
    if (doc.exceptions.length > MAX_HOURS_EXCEPTIONS) {
      errors.push(`No more than ${MAX_HOURS_EXCEPTIONS} dated exceptions can be saved.`);
    }
    const seen = new Set<string>();
    doc.exceptions.forEach((raw, index) => {
      const parsed = parseException(raw, index, errors);
      if (!parsed) return;
      if (seen.has(parsed.date)) errors.push(`${parsed.date}: there is already an exception for this date.`);
      seen.add(parsed.date);
      exceptions.push(parsed);
    });
    exceptions.sort((a, b) => a.date.localeCompare(b.date));
  }

  let mandatory: MandatoryWindow[] | null = null;
  if (doc.mandatory !== null) {
    if (!Array.isArray(doc.mandatory)) {
      errors.push("Mandatory limits must be empty, a list of windows, or not set.");
    } else {
      mandatory = [];
      for (const [index, raw] of doc.mandatory.entries()) {
        const window = asRecord(raw, `Mandatory window ${index + 1}`, ["day", "opens", "closes"], errors);
        if (!window) continue;
        if (!WEEKDAYS.includes(window.day as Weekday)) {
          errors.push(`Mandatory window ${index + 1}: day must be one of ${WEEKDAYS.join(", ")}.`);
          continue;
        }
        const day = window.day as Weekday;
        const range = parseRange(window, `Mandatory limit on ${WEEKDAY_LABELS[day]}`, errors);
        if (range) mandatory.push({ day, ...range });
      }
      mandatory = sortMandatory(mandatory);
      for (const day of WEEKDAYS) {
        checkOverlaps(
          mandatory.filter((w) => w.day === day),
          `Mandatory limit on ${WEEKDAY_LABELS[day]}`,
          errors,
        );
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { schemaVersion: BRANCH_HOURS_SCHEMA_VERSION, weekly, exceptions, mandatory },
  };
}

function parseDayHours(input: unknown, label: string, errors: string[]): DayHours | null {
  const mode = (input as { mode?: unknown } | null)?.mode;
  if (mode === "closed" || mode === "open_24h") {
    return asRecord(input, label, ["mode"], errors) ? { mode } : null;
  }
  if (mode !== "hours") {
    errors.push(`${label}: choose closed, open 24 hours, or set hours.`);
    return null;
  }
  const day = asRecord(input, label, ["mode", "ranges"], errors);
  if (!day) return null;
  if (!Array.isArray(day.ranges) || day.ranges.length === 0) {
    errors.push(`${label}: add at least one opening time, or mark the day closed.`);
    return null;
  }
  if (day.ranges.length > MAX_RANGES_PER_DAY) {
    errors.push(`${label}: no more than ${MAX_RANGES_PER_DAY} time ranges a day.`);
    return null;
  }
  const ranges: HoursRange[] = [];
  for (const raw of day.ranges) {
    const range = asRecord(raw, label, ["opens", "closes"], errors);
    const parsed = range ? parseRange(range, label, errors) : null;
    if (parsed) ranges.push(parsed);
  }
  if (ranges.length !== day.ranges.length) return null;
  ranges.sort((a, b) => a.opens.localeCompare(b.opens));
  return checkOverlaps(ranges, label, errors) ? { mode: "hours", ranges } : null;
}

function parseRange(input: Record<string, unknown>, label: string, errors: string[]): HoursRange | null {
  const { opens, closes } = input;
  if (localTimeMinutes(opens) === null) {
    errors.push(`${label}: opening time must be HH:MM, 00:00 to 23:59.`);
    return null;
  }
  if (localTimeMinutes(closes, true) === null) {
    errors.push(`${label}: closing time must be HH:MM, 00:00 to 24:00.`);
    return null;
  }
  const normalized = { opens: opens as string, closes: closes === "00:00" ? "24:00" : (closes as string) };
  if (!rangeSpan(normalized.opens, normalized.closes)) {
    errors.push(`${label}: opening and closing times can't be the same. Use "Open 24 hours" instead.`);
    return null;
  }
  return normalized;
}

function checkOverlaps(ranges: ReadonlyArray<HoursRange>, label: string, errors: string[]): boolean {
  const spans = ranges
    .map((r) => ({ r, span: rangeSpan(r.opens, r.closes)! }))
    .sort((a, b) => a.span[0] - b.span[0]);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].span[0] < spans[i - 1].span[1]) {
      const a = spans[i - 1].r;
      const b = spans[i].r;
      errors.push(`${label}: ${a.opens}–${a.closes} overlaps ${b.opens}–${b.closes}.`);
      return false;
    }
  }
  return true;
}

function parseException(input: unknown, index: number, errors: string[]): HoursException | null {
  const at = `Exception ${index + 1}`;
  const raw = asRecord(input, at, ["date", "label", "hours", "source", "holidayKey"], errors);
  if (!raw) return null;
  if (!isRealDate(raw.date)) {
    errors.push(`${at}: date must be a real date (YYYY-MM-DD).`);
    return null;
  }
  const date = raw.date;
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!label || label.length > MAX_EXCEPTION_LABEL_LENGTH) {
    errors.push(`${date}: give the exception a name of up to ${MAX_EXCEPTION_LABEL_LENGTH} characters.`);
    return null;
  }
  if (raw.source !== "owner" && raw.source !== "holiday_suggestion") {
    errors.push(`${date}: source must be owner or holiday_suggestion.`);
    return null;
  }
  const holidayKey = raw.holidayKey ?? null;
  if (holidayKey !== null && (typeof holidayKey !== "string" || !HOLIDAY_KEY.test(holidayKey))) {
    errors.push(`${date}: holiday key is not valid.`);
    return null;
  }
  if (raw.source === "holiday_suggestion" && holidayKey === null) {
    errors.push(`${date}: a suggested holiday must keep its holiday key.`);
    return null;
  }
  const hours = parseDayHours(raw.hours, date, errors);
  return hours ? { date, label, hours, source: raw.source, holidayKey } : null;
}

function sortMandatory(list: ReadonlyArray<MandatoryWindow>): MandatoryWindow[] {
  return [...list].sort(
    (a, b) => WEEKDAYS.indexOf(a.day) - WEEKDAYS.indexOf(b.day) || a.opens.localeCompare(b.opens),
  );
}

function asRecord<K extends string>(
  input: unknown,
  label: string,
  allowed: ReadonlyArray<K>,
  errors: string[],
): Record<K, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(`${label}: expected an object.`);
    return null;
  }
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key as K));
  if (unknown.length > 0) {
    errors.push(`${label}: unexpected field ${unknown.join(", ")}.`);
    return null;
  }
  return input as Record<K, unknown>;
}
