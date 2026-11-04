import { Prisma } from "@prisma/client";
import { branchHourKey, CashCountError, expectedCash, parseCashCount, toMinor } from "./till-shift-math";

describe("counting a drawer", () => {
  it("adds up notes and coins, drops empty lines and stores largest first", () => {
    expect(
      parseCashCount({
        totalMinor: 1_250_000,
        lines: [
          { denominationMinor: 100, count: 0 },
          { denominationMinor: 50_000, count: 5 },
          { denominationMinor: 500_000, count: 2 },
        ],
      }),
    ).toEqual({
      totalMinor: 1_250_000,
      lines: [
        { denominationMinor: 500_000, count: 2 },
        { denominationMinor: 50_000, count: 5 },
      ],
    });
  });

  it("accepts an empty drawer", () => {
    expect(parseCashCount({ totalMinor: 0, lines: [] })).toEqual({ totalMinor: 0, lines: [] });
  });

  it.each([
    ["a total that doesn't match", { totalMinor: 1, lines: [{ denominationMinor: 100, count: 2 }] }],
    ["an unknown denomination", { totalMinor: 300, lines: [{ denominationMinor: 300, count: 1 }] }],
    ["a denomination twice", { totalMinor: 200, lines: [{ denominationMinor: 100, count: 1 }, { denominationMinor: 100, count: 1 }] }],
    ["a fractional count", { totalMinor: 150, lines: [{ denominationMinor: 100, count: 1.5 }] }],
    ["a negative count", { totalMinor: -100, lines: [{ denominationMinor: 100, count: -1 }] }],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseCashCount(raw)).toThrow(CashCountError);
  });
});

describe("expected cash", () => {
  it("is opening + cash taken − change − cash refunds − paid out + paid in", () => {
    expect(
      expectedCash({
        openingCashMinor: 500_000,
        cashTakenMinor: 300_000,
        changeGivenMinor: 20_000,
        cashRefundsMinor: 15_000,
        cashPaidOutMinor: 100_000,
        cashPaidInMinor: 5_000,
      }),
    ).toBe(670_000);
  });

  it("converts stored rupees to cents exactly", () => {
    expect(toMinor(new Prisma.Decimal("1234.56"))).toBe(123_456);
    expect(toMinor("0.10")).toBe(10);
    expect(toMinor(null)).toBe(0);
  });
});

describe("takings by hour", () => {
  it("buckets by the branch's clock, not UTC (Colombo is +05:30)", () => {
    expect(branchHourKey("Asia/Colombo", new Date("2026-11-04T08:45:00Z"))).toBe("2026-11-04T14");
    expect(branchHourKey("Asia/Colombo", new Date("2026-11-04T09:15:00Z"))).toBe("2026-11-04T14");
    expect(branchHourKey("Asia/Colombo", new Date("2026-11-04T18:30:00Z"))).toBe("2026-11-05T00");
  });
});
