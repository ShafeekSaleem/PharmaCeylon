/** Max rows fetched per stock / batch priority list (matches usePriorityStock). */
export const PRIORITY_LIST_TAKE = 200;

export type PriorityListCount = number | "200+";

export function priorityListCount(length: number): PriorityListCount {
  if (length >= PRIORITY_LIST_TAKE) return "200+";
  return length;
}

export function formatPriorityListTotal(
  total: number,
  capped: boolean,
): string {
  if (capped) return "200+";
  return String(total);
}

export function chipCountForDisplay(
  value: PriorityListCount | undefined,
  loading: boolean,
): string {
  if (loading && value == null) return "—";
  if (value === "200+") return "200+";
  return String(value ?? 0);
}