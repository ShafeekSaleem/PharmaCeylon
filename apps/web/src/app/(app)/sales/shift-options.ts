import { formatShiftRange } from "./utils";
import type { SalesHistoryShiftOption } from "./types";

/** Label for history filter shifts (`GET /sales/history/options` #247). */
export function shiftOptionLabel(shift: SalesHistoryShiftOption): string {
  const range = formatShiftRange({
    id: shift.shiftId,
    shiftNumber: shift.shiftNumber,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
  });
  return `${shift.registerLabel} · ${shift.shiftNumber} (${range})`;
}