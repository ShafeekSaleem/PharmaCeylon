import { formatShiftRange } from "./utils";
import type { SalesHistoryShiftOption } from "./types";

/** Shifts for history filters, scoped to the active branch when one is selected. */
export function shiftsForPicker(
  shifts: readonly SalesHistoryShiftOption[],
  branchId: string | null,
): SalesHistoryShiftOption[] {
  const scoped = branchId ? shifts.filter((s) => s.branchId === branchId) : shifts;
  return [...scoped];
}

/** Label for history filter shifts (`GET /sales/history/options` #247). */
export function shiftOptionLabel(
  shift: SalesHistoryShiftOption,
  branchId: string | null,
  branches: { id: string; name: string }[],
): string {
  const range = formatShiftRange({
    id: shift.shiftId,
    shiftNumber: shift.shiftNumber,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt,
  });
  const branchName = branchId
    ? null
    : branches.find((b) => b.id === shift.branchId)?.name ?? null;
  const register = branchName ? `${shift.registerLabel} · ${branchName}` : shift.registerLabel;
  return `${register} · ${shift.shiftNumber} (${range})`;
}