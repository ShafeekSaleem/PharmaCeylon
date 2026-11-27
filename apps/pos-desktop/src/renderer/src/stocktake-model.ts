import type { CounterWorkStocktakeDetail, CounterWorkStocktakeLine } from "@pharmaceylon/shared";
import { minor, money } from "./sell-model";

/** A counted line whose difference is not zero: one adjustment when the count posts. */
export const isDifference = (line: CounterWorkStocktakeLine) =>
  line.difference !== null && line.difference !== 0;

export type StocktakeSummary = {
  lines: number;
  /** The adjustments posting writes. */
  differences: number;
  /** Lines never counted; posting leaves them as they are. */
  uncounted: number;
  /** Every other line, counted the same as on hand, or not counted. */
  unchanged: number;
  /** Sum of the differences at cost; null without `costs.view`. */
  valueAtCost: string | null;
};

/**
 * What the screen and the confirm sheet say about the count, from the server's own totals where it
 * gives them. The lines decide only what the totals do not carry (the uncounted lines).
 */
export function stocktakeSummary(detail: CounterWorkStocktakeDetail): StocktakeSummary {
  const uncounted = detail.lines.filter((l) => l.countedQty === null).length;
  return {
    lines: detail.totals.lines,
    differences: detail.totals.differences,
    uncounted,
    unchanged: Math.max(0, detail.totals.lines - detail.totals.differences),
    valueAtCost: detail.totals.valueAtCost,
  };
}

/** A signed whole number as the mockup writes it: "+10", "−12", "0". */
export function signed(n: number): string {
  if (n > 0) return `+${n.toLocaleString("en-US")}`;
  if (n < 0) return `−${Math.abs(n).toLocaleString("en-US")}`;
  return "0";
}

/** A signed amount at cost: "+Rs 30.00", "−Rs 3,240.00", "Rs 0.00". */
export function signedRs(amount: string): string {
  const value = minor(amount);
  const text = `Rs ${money(Math.abs(value))}`;
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
