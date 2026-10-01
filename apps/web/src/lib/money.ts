/**
 * Money formatting for the whole app.
 *
 * The one rule worth stating: a value the API **withheld** (`null`) is not zero. Cost, margin and
 * supplier prices come back `null` when the caller's role may not see them, and printing those as
 * `LKR 0.00` claims the stock was free and makes totals that don't add up. A withheld value reads
 * as a dash — "not yours to see" — and so does a figure derived from one.
 */
const DASH = "—";

export type MoneyOptions = {
  /** Currency prefix. The app says "LKR"; a few older screens say "Rs". */
  currency?: string;
  /** What to print when there is no number. Defaults to a dash. */
  fallback?: string;
};

export function formatMoney(
  value: string | number | null | undefined,
  { currency = "LKR", fallback = DASH }: MoneyOptions = {},
): string {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return `${currency} ${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Short money figure for tight spaces: "LKR 14.5M". Withheld reads as a dash, same as above. */
export function formatCompactMoney(
  value: string | number | null | undefined,
  { currency = "LKR", fallback = DASH }: MoneyOptions = {},
): string {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return `${currency} ${new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n)}`;
}

/** True when the API withheld this figure rather than it genuinely being absent or zero. */
export function isWithheld(value: string | number | null | undefined): boolean {
  return value === null || value === undefined;
}
