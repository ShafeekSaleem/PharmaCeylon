import {
  PRIORITY_LIST_TAKE,
  formatPriorityListTotal,
  priorityListCount,
} from "./priority-list-count";

describe("priorityListCount", () => {
  it("returns length below the take cap", () => {
    expect(priorityListCount(12)).toBe(12);
    expect(priorityListCount(PRIORITY_LIST_TAKE - 1)).toBe(PRIORITY_LIST_TAKE - 1);
  });

  it("returns 200+ at the take cap", () => {
    expect(priorityListCount(PRIORITY_LIST_TAKE)).toBe("200+");
    expect(priorityListCount(PRIORITY_LIST_TAKE + 5)).toBe("200+");
  });
});

describe("formatPriorityListTotal", () => {
  it("shows 200+ when the list is capped", () => {
    expect(formatPriorityListTotal(200, true)).toBe("200+");
  });

  it("shows the real total when not capped", () => {
    expect(formatPriorityListTotal(42, false)).toBe("42");
  });
});