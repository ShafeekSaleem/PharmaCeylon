import { counterFilterOptions, registersForPicker, receiptScopeOptions } from "./register-options";
import type { SalesHistoryRegisterOption } from "./types";

const BRANCHES = [
  { id: "branch-a", name: "Colombo" },
  { id: "branch-b", name: "Kandy" },
];

const REGISTERS: SalesHistoryRegisterOption[] = [
  { registerId: "reg-1", tillId: "till-1", label: "Counter 1 Floor 2", branchId: "branch-a" },
  { registerId: "reg-2", tillId: "till-2", label: "Counter 1", branchId: "branch-b" },
];

describe("registersForPicker", () => {
  it("suffixes counter labels with branch name when no branch is selected", () => {
    const picks = registersForPicker(REGISTERS, null, BRANCHES);
    expect(picks.map((p) => p.counterLabel)).toEqual([
      "Counter 1 Floor 2 · Colombo",
      "Counter 1 · Kandy",
    ]);
  });

  it("keeps API counter labels and filters to the active branch", () => {
    const picks = registersForPicker(REGISTERS, "branch-a", BRANCHES);
    expect(picks.map((p) => p.counterLabel)).toEqual(["Counter 1 Floor 2"]);
  });

  it("exposes suffixed labels through counter and receipt scope options", () => {
    const picks = registersForPicker(REGISTERS, null, BRANCHES);
    expect(counterFilterOptions(picks, "All counters").map((o) => o.label)).toEqual([
      "All counters",
      "Counter 1 Floor 2 · Colombo",
      "Counter 1 · Kandy",
    ]);
    expect(receiptScopeOptions(picks).map((o) => o.label)).toEqual([
      "Any counter",
      "Counter 1 Floor 2 · Colombo",
      "Counter 1 · Kandy",
    ]);
  });
});
