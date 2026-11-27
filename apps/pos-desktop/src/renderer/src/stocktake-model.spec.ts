import { describe, expect, it } from "@jest/globals";
import type { CounterWorkStocktakeDetail } from "@pharmaceylon/shared";
import { isDifference, signed, signedRs, stocktakeSummary } from "./stocktake-model";

const line = (overrides: Record<string, unknown>) => ({
  lineId: "l",
  productName: "Panadol",
  onHandAtCount: 10,
  countedQty: 10,
  difference: 0,
  now: 10,
  afterPost: 10,
  valueAtCost: null,
  ...overrides,
});

describe("stocktake summary", () => {
  it("takes lines, differences and value from the server's totals and counts the uncounted lines", () => {
    const detail = {
      totals: { lines: 4, differences: 2, valueAtCost: "-3240.00" },
      lines: [
        line({ difference: -12 }),
        line({ difference: 10 }),
        line({ countedQty: null, difference: null }),
        line({}),
      ],
    } as unknown as CounterWorkStocktakeDetail;
    expect(stocktakeSummary(detail)).toEqual({
      lines: 4,
      differences: 2,
      uncounted: 1,
      unchanged: 2,
      valueAtCost: "-3240.00",
    });
  });

  it("treats only a counted, non-zero line as a difference", () => {
    expect(isDifference(line({ difference: -2 }) as never)).toBe(true);
    expect(isDifference(line({ difference: 0 }) as never)).toBe(false);
    expect(isDifference(line({ countedQty: null, difference: null }) as never)).toBe(false);
  });

  it("writes signed figures as the mockup does", () => {
    expect(signed(10)).toBe("+10");
    expect(signed(-1140)).toBe("−1,140");
    expect(signed(0)).toBe("0");
    expect(signedRs("-3240.00")).toBe("−Rs 3,240.00");
    expect(signedRs("30")).toBe("+Rs 30.00");
    expect(signedRs("0")).toBe("Rs 0.00");
  });
});
