/**
 * How every screen and printout writes dates, times and money (UI1 #205).
 *
 * Dates are day-month ("18 Nov 2026"), never 11/18/2026; times are 24-hour ("14:32"); amounts
 * use comma thousands and two decimals ("12,450.00"). The web says LKR, the desktop counter and
 * its receipts say Rs. Every `toLocale*String` / `Intl.*Format` call in web and desktop passes
 * `DISPLAY_LOCALE`, so the computer's own regional settings never decide the order; guard specs in
 * both apps enforce it.
 */
export const DISPLAY_LOCALE = "en-GB";

export const WEB_CURRENCY = "LKR";
export const COUNTER_CURRENCY = "Rs";

const DASH = "—";

type DateInput = Date | string | number;

export type DisplayDateOptions = {
  /** IANA zone to show the moment in; the computer's own zone when left out. */
  timeZone?: string;
  /** What to print for a missing or unreadable date. Defaults to a dash. */
  fallback?: string;
};

function toDate(value: DateInput | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function named(
  date: Date,
  options: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Partial<Record<Intl.DateTimeFormatPartTypes, string>> {
  const out: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  const fmt = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    ...options,
    ...(timeZone ? { timeZone } : {}),
  });
  for (const part of fmt.formatToParts(date)) out[part.type] = part.value;
  return out;
}

function format(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions,
  draw: (date: Date, tz: string | undefined) => string,
): string {
  const d = toDate(value);
  return d ? draw(d, opts.timeZone) : (opts.fallback ?? DASH);
}

/** "18 Nov 2026". */
export function formatDisplayDate(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions = {},
): string {
  return format(value, opts, (d, tz) => {
    const p = named(d, { day: "numeric", month: "short", year: "numeric" }, tz);
    return `${p.day} ${p.month} ${p.year}`;
  });
}

/** "18 Nov", for lists where the year is obvious. */
export function formatDayMonth(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions = {},
): string {
  return format(value, opts, (d, tz) => {
    const p = named(d, { day: "numeric", month: "short" }, tz);
    return `${p.day} ${p.month}`;
  });
}

/** "14:32". */
export function formatDisplayTime(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions = {},
): string {
  return format(value, opts, (d, tz) => {
    const p = named(
      d,
      { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
      tz,
    );
    return `${p.hour}:${p.minute}`;
  });
}

/** "18 Nov 2026, 14:32". */
export function formatDisplayDateTime(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions = {},
): string {
  const d = toDate(value);
  if (!d) return opts.fallback ?? DASH;
  return `${formatDisplayDate(d, opts)}, ${formatDisplayTime(d, opts)}`;
}

/** "November 2026". */
export function formatMonthYear(
  value: DateInput | null | undefined,
  opts: DisplayDateOptions = {},
): string {
  return format(value, opts, (d, tz) => {
    const p = named(d, { month: "long", year: "numeric" }, tz);
    return `${p.month} ${p.year}`;
  });
}

const amount = new Intl.NumberFormat(DISPLAY_LOCALE, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** 12450.5 → "12,450.50": comma thousands, two decimals, whatever the computer's region. */
export function formatAmount(value: number): string {
  return amount.format(value);
}
