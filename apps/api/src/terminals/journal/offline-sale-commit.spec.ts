import { decideStockPosting, fromMinor } from "./offline-sale-commit";

/** P5 #51, approved D1: an offline sale posts all of its stock or none of it. */
describe("decideStockPosting", () => {
  const sold = (batchId: string, quantity: number) => ({ batchId, productId: "p", quantity });

  it("posts the whole sale when every batch has the units and none is under review", () => {
    const result = decideStockPosting([sold("a", 2), sold("b", 1), sold("a", 1)], new Map([["a", 3], ["b", 1]]), new Set());
    expect(result.posts).toBe(true);
    expect(result.batches).toEqual([
      { batchId: "a", productId: "p", soldQuantity: 3, availableQuantityAtSync: 3, shortfallQuantity: 0, reason: null },
      { batchId: "b", productId: "p", soldQuantity: 1, availableQuantityAtSync: 1, shortfallQuantity: 0, reason: null },
    ]);
  });

  it("the contract's partition: 10 in the snapshot, 7 sold online, 5 offline leaves a 2-unit shortfall", () => {
    const result = decideStockPosting([sold("a", 5)], new Map([["a", 3]]), new Set());
    expect(result.posts).toBe(false);
    expect(result.batches).toEqual([
      { batchId: "a", productId: "p", soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall" },
    ]);
  });

  it("holds every batch of a sale when one falls short: never a partial posting", () => {
    const result = decideStockPosting([sold("a", 5), sold("b", 1)], new Map([["a", 0], ["b", 9]]), new Set());
    expect(result.posts).toBe(false);
    expect(result.batches.map((b) => [b.batchId, b.reason, b.shortfallQuantity])).toEqual([["a", "shortfall", 5], ["b", "sale_pending", 0]]);
  });

  it("does not post into a batch an open case already holds, even with units to spare", () => {
    const result = decideStockPosting([sold("a", 1)], new Map([["a", 3]]), new Set(["a"]));
    expect(result.posts).toBe(false);
    expect(result.batches[0]).toMatchObject({ reason: "batch_under_review", shortfallQuantity: 0, availableQuantityAtSync: 3 });
  });

  it("reads a negative or missing balance as nothing available, never a negative quantity", () => {
    const result = decideStockPosting([sold("a", 2), sold("b", 1)], new Map([["a", -4]]), new Set());
    expect(result.batches.map((b) => [b.availableQuantityAtSync, b.shortfallQuantity])).toEqual([[0, 2], [0, 1]]);
  });

  it("converts minor units exactly", () => {
    expect(fromMinor(1829).toFixed(2)).toBe("18.29");
    expect(fromMinor(1).toFixed(2)).toBe("0.01");
  });
});
