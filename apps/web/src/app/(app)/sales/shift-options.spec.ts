import { shiftOptionLabel, shiftsForPicker } from "./shift-options";
import type { SalesHistoryShiftOption } from "./types";

const BRANCHES = [
  { id: "branch-a", name: "Colombo" },
  { id: "branch-b", name: "Kandy" },
];

const SHIFTS: SalesHistoryShiftOption[] = [
  {
    shiftId: "shift-a",
    shiftNumber: "S-1",
    branchId: "branch-a",
    registerId: "reg-1",
    registerLabel: "Counter 1",
    openedAt: "2026-11-20T08:00:00.000Z",
    closedAt: null,
  },
  {
    shiftId: "shift-b",
    shiftNumber: "S-2",
    branchId: "branch-b",
    registerId: "reg-2",
    registerLabel: "Counter 2",
    openedAt: "2026-11-20T09:00:00.000Z",
    closedAt: null,
  },
];

describe("shiftsForPicker", () => {
  it("suffixes register labels with branch name when no branch is selected", () => {
    expect(shiftsForPicker(SHIFTS, null).map((s) => s.shiftId)).toEqual(["shift-a", "shift-b"]);
    expect(shiftOptionLabel(SHIFTS[0]!, null, BRANCHES)).toContain("Counter 1 · Colombo");
    expect(shiftOptionLabel(SHIFTS[1]!, null, BRANCHES)).toContain("Counter 2 · Kandy");
  });

  it("filters to the active branch and omits the suffix", () => {
    const scoped = shiftsForPicker(SHIFTS, "branch-a");
    expect(scoped.map((s) => s.shiftId)).toEqual(["shift-a"]);
    expect(shiftOptionLabel(scoped[0]!, "branch-a", BRANCHES)).toMatch(/^Counter 1 · S-1/);
    expect(shiftOptionLabel(scoped[0]!, "branch-a", BRANCHES)).not.toContain("Colombo");
  });
});