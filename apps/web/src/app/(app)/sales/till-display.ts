import type { SaleListRow } from "./types";
import { DASH } from "./utils";

type SaleTillSource = Pick<SaleListRow, "register" | "till">;

/** Real till name from the API only — never derived from the counter label. */
export function saleTillLabel(sale: SaleTillSource): string | null {
  return sale.till?.label ?? sale.register?.tillLabel ?? null;
}

/** List cell: blank when the API sent no till name (mock uses an em dash for empty attribution). */
export function saleTillCell(sale: SaleTillSource): string {
  return saleTillLabel(sale) ?? DASH;
}