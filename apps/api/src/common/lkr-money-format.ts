import { formatAmount, WEB_CURRENCY } from "@pharmaceylon/shared";

/** Minor units (cents of LKR) to the same label SQL uses via `lkr_minor_label_sql()`. */
export function formatLkrFromMinor(minor: number | bigint): string {
  return `${WEB_CURRENCY} ${formatAmount(Number(minor) / 100)}`;
}

/** PostgreSQL expression for `formatLkrFromMinor` on an integer minor-unit column. */
export function lkrMinorLabelSql(columnSql: string): string {
  return `'${WEB_CURRENCY} ' || to_char((${columnSql})::numeric / 100.0, 'FM999,999,999,990.00')`;
}