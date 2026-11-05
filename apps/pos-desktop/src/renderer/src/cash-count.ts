import type { CashCount } from "../../shared/ipc-contract";

/**
 * The drawer as the counter counts it (mockup screen=cash): notes one row each, and the coins as a
 * single rupee amount. Coins are all whole rupees, so they travel to the server as that many
 * one-rupee pieces (`denominationMinor: 100`); the server adds every line up again.
 */
export type DrawerRow = Readonly<{
  key: string;
  label: string;
  /** Minor units per piece; for coins, one rupee. */
  denominationMinor: number;
  coin: boolean;
  /** One of the mockup's tone tokens, for the little note swatch. */
  tone: string;
}>;

export const DRAWER_ROWS: readonly DrawerRow[] = [
  { key: "5000", label: "5,000", denominationMinor: 500_000, coin: false, tone: "violet" },
  { key: "2000", label: "2,000", denominationMinor: 200_000, coin: false, tone: "indigo" },
  { key: "1000", label: "1,000", denominationMinor: 100_000, coin: false, tone: "blue" },
  { key: "500", label: "500", denominationMinor: 50_000, coin: false, tone: "amber" },
  { key: "100", label: "100", denominationMinor: 10_000, coin: false, tone: "rose" },
  { key: "50", label: "50", denominationMinor: 5_000, coin: false, tone: "emerald" },
  { key: "20", label: "20", denominationMinor: 2_000, coin: false, tone: "cyan" },
  { key: "coins", label: "Coins", denominationMinor: 100, coin: true, tone: "amber" },
];

/** What has been typed per row: a count of notes, or the coins' rupee amount. */
export type DrawerEntry = Readonly<Record<string, string>>;

const MAX_PIECES = 100_000;

/** A row's whole-number value, or null if what's typed isn't one. Empty counts as nothing. */
export function rowCount(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (text === "") return 0;
  if (!/^\d{1,6}$/.test(text)) return null;
  const n = Number(text);
  return n <= MAX_PIECES ? n : null;
}

export const rowAmountMinor = (row: DrawerRow, raw: string | undefined) =>
  (rowCount(raw) ?? 0) * row.denominationMinor;

/** The count to send, or null while any row isn't a whole number. Empty rows are left out. */
export function drawerCount(entry: DrawerEntry): CashCount | null {
  let totalMinor = 0;
  const lines: { denominationMinor: number; count: number }[] = [];
  for (const row of DRAWER_ROWS) {
    const count = rowCount(entry[row.key]);
    if (count === null) return null;
    if (count === 0) continue;
    totalMinor += count * row.denominationMinor;
    lines.push({ denominationMinor: row.denominationMinor, count });
  }
  return { totalMinor, lines };
}

/** "2 × 1,000, 4 × 500, Rs 40 in coins", for the cash in and out list. */
export function describeCount(lines: CashCount["lines"]): string {
  return lines
    .map((line) =>
      line.denominationMinor === 100
        ? `Rs ${line.count.toLocaleString("en-LK")} in coins`
        : `${line.count} × ${(line.denominationMinor / 100).toLocaleString("en-LK")}`,
    )
    .join(", ");
}
