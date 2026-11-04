import { Prisma } from "@prisma/client";

/**
 * Sri Lankan rupee notes and coins a drawer is counted in, in minor units (cents). The 20 rupee
 * coin and note both exist; they count the same, so there is one line for them.
 */
export const LKR_DENOMINATIONS_MINOR: readonly number[] = Object.freeze([
  500_000, 200_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000, 500, 200, 100,
]);

/** A drawer count: the total and the note-and-coin lines it came from. */
export type CashCount = Readonly<{
  totalMinor: number;
  lines: ReadonlyArray<Readonly<{ denominationMinor: number; count: number }>>;
}>;

/** One drawer can't plausibly hold more; it also keeps every sum a safe integer. */
const MAX_PIECES = 100_000;
export const MAX_DRAWER_MINOR = 2_000_000_000;

export class CashCountError extends Error {}

/**
 * Validates a count the counter added up: known denominations, each once, whole non-negative
 * counts, and a total that equals the lines. The server adds them up again rather than trusting
 * the counter's total, then keeps both (they match by construction). Lines with no pieces are
 * dropped and the rest are kept largest first, so the same drawer always stores the same way.
 */
export function parseCashCount(raw: {
  totalMinor: number;
  lines: ReadonlyArray<{ denominationMinor: number; count: number }>;
}): CashCount {
  if (!Array.isArray(raw.lines) || raw.lines.length > LKR_DENOMINATIONS_MINOR.length)
    throw new CashCountError("Count the drawer by note and coin.");
  const seen = new Set<number>();
  let total = 0;
  const lines: Array<{ denominationMinor: number; count: number }> = [];
  for (const line of raw.lines) {
    if (!LKR_DENOMINATIONS_MINOR.includes(line.denominationMinor))
      throw new CashCountError("That isn't a rupee note or coin.");
    if (seen.has(line.denominationMinor))
      throw new CashCountError("Each note and coin is counted once.");
    seen.add(line.denominationMinor);
    if (!Number.isSafeInteger(line.count) || line.count < 0 || line.count > MAX_PIECES)
      throw new CashCountError("Counts are whole numbers.");
    if (line.count === 0) continue;
    total += line.denominationMinor * line.count;
    lines.push({ denominationMinor: line.denominationMinor, count: line.count });
  }
  if (total > MAX_DRAWER_MINOR) throw new CashCountError("That is more than a drawer holds.");
  if (!Number.isSafeInteger(raw.totalMinor) || raw.totalMinor !== total)
    throw new CashCountError("The total doesn't match the notes and coins counted.");
  lines.sort((a, b) => b.denominationMinor - a.denominationMinor);
  return { totalMinor: total, lines };
}

/** Rupees as stored (Decimal(12,2)) to minor units, exactly. */
export function toMinor(value: Prisma.Decimal | string | number | null | undefined): number {
  if (value == null) return 0;
  return new Prisma.Decimal(value).mul(100).toDecimalPlaces(0).toNumber();
}

export type ExpectedCashParts = Readonly<{
  openingCashMinor: number;
  /** Cash tendered on the shift's sales (before change). */
  cashTakenMinor: number;
  changeGivenMinor: number;
  cashRefundsMinor: number;
  cashPaidOutMinor: number;
  cashPaidInMinor: number;
}>;

/**
 * Expected cash = opening count + cash taken − change given − cash refunds − cash paid out
 * (+ cash paid in, which nothing writes yet). The server's figure; the counter keeps its own.
 */
export function expectedCash(parts: ExpectedCashParts): number {
  return (
    parts.openingCashMinor +
    parts.cashTakenMinor -
    parts.changeGivenMinor -
    parts.cashRefundsMinor -
    parts.cashPaidOutMinor +
    parts.cashPaidInMinor
  );
}

/** The hour a moment falls in at the branch, as `YYYY-MM-DDTHH` (24-hour) — Colombo is +05:30,
 * so UTC hours would split every local hour in two. */
export function branchHourKey(timeZone: string, at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}`;
}
