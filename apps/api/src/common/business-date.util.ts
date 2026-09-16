/**
 * Calendar dates as the pharmacy sees them.
 *
 * Expiry dates are stored as `@db.Date`, which Prisma hands back as UTC midnight. "Is this batch
 * expired?" used to be answered by comparing that against the *server's* local midnight — so an
 * API running in UTC treated a Colombo batch as still sellable for the first five and a half
 * hours of the day it expired. Every expiry, "today" and date-range decision in Operations goes
 * through these helpers with the tenant's configured timezone instead.
 */

export const DEFAULT_TENANT_TIMEZONE = "Asia/Colombo";

const MS_PER_DAY = 86_400_000;

/** A bad timezone string on a tenant row must not take stock screens down. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TENANT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TENANT_TIMEZONE;
  }
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** `YYYY-MM-DD` for the calendar day `at` falls on in `timeZone`. */
export function businessDateKey(timeZone: string, at: Date = new Date()): string {
  const parts = formatterFor(timeZone).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The tenant's current calendar day as UTC midnight — directly comparable with a `@db.Date`
 * column (`expiryDate < businessToday(tz)` means "expired").
 */
export function businessToday(timeZone: string, at: Date = new Date()): Date {
  return dateKeyToUtc(businessDateKey(timeZone, at));
}

/** `YYYY-MM-DD` → UTC midnight of that date. Throws on anything that isn't a real date. */
export function dateKeyToUtc(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new Error(`Invalid date key: ${key}`);
  }
  const date = new Date(`${key}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== key) {
    throw new Error(`Invalid date key: ${key}`);
  }
  return date;
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`, both UTC-midnight dates. Negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Offset of `timeZone` from UTC at instant `at`, in minutes (Colombo → +330). */
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
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/**
 * The instant a tenant's calendar day starts — for filtering timestamp columns such as
 * `occurredAt` by a date the user picked. DST-safe: the offset is taken at that day's noon.
 */
export function startOfBusinessDay(timeZone: string, key: string): Date {
  const utcMidnight = dateKeyToUtc(key);
  const zone = safeTimeZone(timeZone);
  const noon = new Date(utcMidnight.getTime() + 12 * 60 * 60_000);
  return new Date(utcMidnight.getTime() - offsetMinutes(zone, noon) * 60_000);
}
