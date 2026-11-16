import type { BatchRow, StockRow } from "@/app/(app)/inventory/types";
import {
  stockItemsForFilter,
  stockListForChipCount,
} from "./use-priority-stock";

function stockRow(id: string): StockRow {
  return {
    productId: id,
    availableQty: 1,
    stockStatus: "low",
    product: { id, name: id, sku: id, unit: "tab" },
  } as StockRow;
}

describe("stockItemsForFilter", () => {
  const lists = {
    low: [stockRow("l1"), stockRow("l2")],
    out: [stockRow("o1")],
    controlledLow: [stockRow("cl1")],
    controlledOut: [stockRow("co1"), stockRow("co2")],
    nearExpiry: [{ id: "b1" } as BatchRow],
  };

  it("merges controlled low and out without duplicating product ids", () => {
    const both = stockItemsForFilter(
      {
        ...lists,
        controlledLow: [stockRow("shared")],
        controlledOut: [stockRow("shared"), stockRow("only-out")],
      },
      "controlled",
    );
    expect(both.map((r) => (r as StockRow).productId)).toEqual([
      "shared",
      "only-out",
    ]);
  });

  it("matches chip count lists for each stock filter", () => {
    expect(stockListForChipCount(lists, "low_stock").length).toBe(2);
    expect(stockListForChipCount(lists, "out_of_stock").length).toBe(1);
    expect(stockListForChipCount(lists, "controlled").length).toBe(3);
    expect(stockListForChipCount(lists, "near_expiry").length).toBe(1);
  });
});