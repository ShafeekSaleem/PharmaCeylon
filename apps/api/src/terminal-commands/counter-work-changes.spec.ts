import { describeMaterialChanges } from "./counter-work-changes";

describe("what changed since approval, in words", () => {
  it("is empty when only key order differs", () => {
    expect(describeMaterialChanges({ qty: 2, kind: "lost" }, { kind: "lost", qty: 2 })).toEqual([]);
  });

  it("names changed fields in counter words", () => {
    expect(describeMaterialChanges({ qty: 2, expectedOn: null, unitCost: "1.00" }, { qty: 3, expectedOn: "2026-11-05", unitCost: "2.00" }))
      .toEqual(["expected date", "quantity", "unit cost"]);
  });

  it("counts changed, added and removed lines by id", () => {
    const before = { items: [{ id: "a", qty: 1 }, { id: "b", qty: 2 }, { id: "c", qty: 3 }] };
    const after = { items: [{ id: "a", qty: 1 }, { id: "b", qty: 5 }, { id: "d", qty: 1 }] };
    expect(describeMaterialChanges(before, after)).toEqual(["lines: 1 line changed, 1 line added, 1 line removed"]);
  });

  it("looks inside a delivery for its lines", () => {
    const before = { delivery: { invoiceNo: "A", lines: [{ productId: "p", receivedQty: 2 }] } };
    const after = { delivery: { invoiceNo: "B", lines: [{ productId: "p", receivedQty: 3 }] } };
    expect(describeMaterialChanges(before, after)).toEqual(["the delivery lines: 1 line changed", "the delivery"]);
  });
});
