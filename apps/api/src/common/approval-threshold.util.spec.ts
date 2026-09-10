import { Prisma } from "@prisma/client";
import { linesValue, meetsApprovalThreshold } from "./approval-threshold.util";

const dec = (v: string | number) => new Prisma.Decimal(v);

describe("meetsApprovalThreshold", () => {
  it("is false when no threshold is configured", () => {
    expect(meetsApprovalThreshold(dec("1000000"), null)).toBe(false);
    expect(meetsApprovalThreshold(dec("1000000"), undefined)).toBe(false);
  });

  it("trips at the threshold, not just above it", () => {
    expect(meetsApprovalThreshold(dec("50000"), dec("50000"))).toBe(true);
    expect(meetsApprovalThreshold(dec("49999.99"), dec("50000"))).toBe(false);
  });

  it("treats a zero threshold as 'approve everything', not as off", () => {
    // `null` is how the settings UI records off; 0 is a deliberate choice.
    expect(meetsApprovalThreshold(dec("0.01"), dec(0))).toBe(true);
    expect(meetsApprovalThreshold(dec(0), dec(0))).toBe(true);
  });
});

describe("linesValue", () => {
  it("applies tax to the post-discount net, matching the web's poTotals", () => {
    // 10 × 100 = 1000; less 10% = 900; plus 18% tax = 1062.
    const value = linesValue([
      { qty: 10, unitAmount: "100", discountPercent: 10, taxPercent: 18 },
    ]);
    expect(value.toFixed(2)).toBe("1062.00");
  });

  it("adds shipping charges to the committed total", () => {
    const value = linesValue(
      [{ qty: 2, unitAmount: "50", discountPercent: 0, taxPercent: 0 }],
      "25.50",
    );
    expect(value.toFixed(2)).toBe("125.50");
  });

  it("treats missing discount and tax as zero", () => {
    const value = linesValue([{ qty: 3, unitAmount: "33.33" }]);
    expect(value.toFixed(2)).toBe("99.99");
  });

  it("sums independently rated lines without cross-contamination", () => {
    const value = linesValue([
      { qty: 1, unitAmount: "100", taxPercent: 18 },
      { qty: 1, unitAmount: "100", discountPercent: 50 },
    ]);
    // 118 + 50
    expect(value.toFixed(2)).toBe("168.00");
  });

  it("keeps decimal precision rather than drifting through floats", () => {
    const value = linesValue([{ qty: 3, unitAmount: "0.1" }]);
    expect(value.toFixed(2)).toBe("0.30");
  });
});
