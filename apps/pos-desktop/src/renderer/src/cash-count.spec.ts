import { describe, expect, it } from "@jest/globals";
import { describeCount, drawerCount, rowCount } from "./cash-count";

describe("counting the drawer", () => {
  it("adds up notes and the coins' rupee amount, leaving empty rows out", () => {
    expect(drawerCount({ "5000": "2", "1000": "9", "500": "6", "100": "14", "50": "11", "20": "15", coins: "400" })).toEqual({
      totalMinor: 2_465_000,
      lines: [
        { denominationMinor: 500_000, count: 2 },
        { denominationMinor: 100_000, count: 9 },
        { denominationMinor: 50_000, count: 6 },
        { denominationMinor: 10_000, count: 14 },
        { denominationMinor: 5_000, count: 11 },
        { denominationMinor: 2_000, count: 15 },
        { denominationMinor: 100, count: 400 },
      ],
    });
  });

  it("counts an empty drawer as zero, and refuses anything that isn't a whole number", () => {
    expect(drawerCount({})).toEqual({ totalMinor: 0, lines: [] });
    expect(rowCount("1.5")).toBeNull();
    expect(rowCount("-2")).toBeNull();
    expect(drawerCount({ "100": "two" })).toBeNull();
  });

  it("describes a count the way the cash list shows it", () => {
    expect(
      describeCount([
        { denominationMinor: 100_000, count: 2 },
        { denominationMinor: 50_000, count: 4 },
        { denominationMinor: 100, count: 40 },
      ]),
    ).toBe("2 × 1,000, 4 × 500, Rs 40 in coins");
  });
});
