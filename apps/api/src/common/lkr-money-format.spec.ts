import { formatLkrFromMinor } from "./lkr-money-format";

describe("formatLkrFromMinor", () => {
  it("formats minor units with two decimal places", () => {
    expect(formatLkrFromMinor(1500)).toBe("LKR 15.00");
    expect(formatLkrFromMinor(1500n)).toBe("LKR 15.00");
    expect(formatLkrFromMinor(1)).toBe("LKR 0.01");
    expect(formatLkrFromMinor(125_050)).toBe("LKR 1,250.50");
  });
});