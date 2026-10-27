import {
  HOLIDAY_KINDS,
  MAX_EXCEPTION_LABEL_LENGTH,
  isRealDate,
  type HolidayKind,
  type HolidayListSource,
  type HolidaySuggestion,
} from "@pharmaceylon/shared";

/** One gazetted year, ready to offer: holidays on the same date merged into one suggestion. */
export type HolidayYearList = Readonly<{
  year: number;
  source: HolidayListSource;
  holidays: ReadonlyArray<HolidaySuggestion>;
}>;

/**
 * Checks one `lk-holidays-YYYY.json` file (format in README.md) and throws with every problem
 * at once. These files are typed in by hand from the gazette, so the check is strict: an unknown
 * field, a date outside the year or an unexplained kind is a typo to fix, not something to guess
 * around. An empty list is refused too — a gazetted year always has holidays, and an empty file
 * would read as "none this year".
 */
export function parseHolidayYearFile(input: unknown, file: string): HolidayYearList {
  const errors: string[] = [];
  const doc = record(input, file, ["year", "source", "checkedBy", "checkedOn", "holidays"], errors);
  if (!doc) throw problems(file, errors);

  const year = doc.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2020 || year > 2100) {
    errors.push("year must be a four-digit year");
  }
  const source = record(doc.source, "source", ["name", "reference", "publishedOn", "copiedFrom"], errors);
  if (source) {
    if (!text(source.name, 200)) errors.push("source.name must name the gazette");
    if (source.reference !== null && !isHttpsLink(source.reference)) {
      errors.push("source.reference must be an https link to the gazette, or null");
    }
    if (source.publishedOn !== null && !isRealDate(source.publishedOn)) {
      errors.push("source.publishedOn must be a date (YYYY-MM-DD), or null");
    }
    // When the gazette itself couldn't be opened, the official list the rows were copied from
    // instead (the Central Bank's, say) — so nobody mistakes it for a check against the gazette.
    if (source.copiedFrom !== null) {
      const copied = record(source.copiedFrom, "source.copiedFrom", ["name", "reference"], errors);
      if (copied && (!text(copied.name, 200) || !isHttpsLink(copied.reference))) {
        errors.push("source.copiedFrom must give the list's name and an https link, or be null");
      }
    }
  }
  if (!text(doc.checkedBy, 120)) errors.push("checkedBy must name the person who checked the file against the gazette");
  if (!isRealDate(doc.checkedOn)) errors.push("checkedOn must be a date (YYYY-MM-DD)");

  const byDate = new Map<string, { names: string[]; kinds: Set<HolidayKind> }>();
  if (!Array.isArray(doc.holidays) || doc.holidays.length === 0) {
    errors.push("holidays must list the year's holidays");
  } else {
    doc.holidays.forEach((raw, index) => {
      const at = `holidays[${index}]`;
      const row = record(raw, at, ["date", "name", "kinds"], errors);
      if (!row) return;
      if (!isRealDate(row.date) || !row.date.startsWith(`${year}-`)) {
        errors.push(`${at}.date must be a real date in ${year}`);
        return;
      }
      const name = text(row.name, MAX_EXCEPTION_LABEL_LENGTH);
      if (!name) {
        errors.push(`${at}.name must be the holiday's name, up to ${MAX_EXCEPTION_LABEL_LENGTH} characters`);
        return;
      }
      const kinds = row.kinds;
      if (
        !Array.isArray(kinds) ||
        kinds.length === 0 ||
        new Set(kinds).size !== kinds.length ||
        kinds.some((kind) => !HOLIDAY_KINDS.includes(kind as HolidayKind))
      ) {
        errors.push(`${at}.kinds must list some of ${HOLIDAY_KINDS.join(", ")}, once each`);
        return;
      }
      const entry = byDate.get(row.date) ?? { names: [], kinds: new Set<HolidayKind>() };
      if (entry.names.includes(name)) {
        errors.push(`${at} repeats ${name} on ${row.date}`);
        return;
      }
      entry.names.push(name);
      kinds.forEach((kind) => entry.kinds.add(kind as HolidayKind));
      byDate.set(row.date, entry);
    });
  }

  const holidays = [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({
      key: `lk:${date}`,
      date,
      name: entry.names.join(" / "),
      kinds: HOLIDAY_KINDS.filter((kind) => entry.kinds.has(kind)),
    }));
  for (const holiday of holidays) {
    if (holiday.name.length > MAX_EXCEPTION_LABEL_LENGTH) {
      errors.push(
        `${holiday.date}: "${holiday.name}" is longer than ${MAX_EXCEPTION_LABEL_LENGTH} characters once the holidays on that date are joined; shorten the names`,
      );
    }
  }

  if (errors.length > 0 || !source) throw problems(file, errors);
  return {
    year: year as number,
    source: {
      name: (source.name as string).trim(),
      reference: source.reference as string | null,
      checkedOn: doc.checkedOn as string,
    },
    holidays,
  };
}

function isHttpsLink(value: unknown): boolean {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function record<K extends string>(
  input: unknown,
  at: string,
  allowed: ReadonlyArray<K>,
  errors: string[],
): Record<K, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(`${at} must be an object`);
    return null;
  }
  const keys = Object.keys(input);
  const unknown = keys.filter((key) => !allowed.includes(key as K));
  const missing = allowed.filter((key) => !keys.includes(key));
  if (unknown.length) errors.push(`${at} has unexpected ${unknown.join(", ")}`);
  if (missing.length) errors.push(`${at} is missing ${missing.join(", ")}`);
  return unknown.length || missing.length ? null : (input as Record<K, unknown>);
}

function problems(file: string, errors: string[]): Error {
  return new Error(`Holiday list ${file} is not valid:\n- ${errors.join("\n- ")}`);
}
