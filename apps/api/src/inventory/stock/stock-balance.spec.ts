import { StockBucket } from "@prisma/client";
import {
  applyBucketDeltas,
  isWhollyQuarantined,
  planIssue,
  toBalance,
} from "./stock-balance";

const sellable = (qtyDelta: number) => ({ bucket: StockBucket.sellable, qtyDelta });
const held = (qtyDelta: number) => ({ bucket: StockBucket.quarantine, qtyDelta });

describe("batch quantities", () => {
  it("derives sellable and available from on hand, quarantined and reserved", () => {
    expect(toBalance({ onHand: 100, quarantined: 5, reserved: 10 })).toEqual({
      onHand: 100,
      quarantined: 5,
      reserved: 10,
      sellable: 95,
      available: 85,
    });
  });

  it("lets a sale take available units but not reserved ones", () => {
    const current = { onHand: 10, quarantined: 0, reserved: 4 };
    expect(applyBucketDeltas(current, [sellable(-6)]).violation).toBeNull();
    expect(applyBucketDeltas(current, [sellable(-7)]).violation).toEqual({
      kind: "insufficient_available",
      available: 6,
      requested: 7,
    });
  });

  it("lets a stocktake shortfall eat into reserved units, but never below zero sellable", () => {
    const current = { onHand: 10, quarantined: 0, reserved: 4 };
    const opts = { allowReservedShortfall: true };
    expect(applyBucketDeltas(current, [sellable(-8)], opts).violation).toBeNull();
    expect(applyBucketDeltas(current, [sellable(-11)], opts).violation).not.toBeNull();
  });

  it("treats quarantining as a pair that leaves on hand alone", () => {
    const { next, violation } = applyBucketDeltas(
      { onHand: 100, quarantined: 0, reserved: 0 },
      [sellable(-5), held(5)],
    );
    expect(violation).toBeNull();
    expect(next).toEqual({ onHand: 100, quarantined: 5, reserved: 0 });
  });

  it("refuses to quarantine units that are already promised", () => {
    const { violation } = applyBucketDeltas(
      { onHand: 10, quarantined: 0, reserved: 8 },
      [sellable(-3), held(3)],
    );
    expect(violation).toEqual(expect.objectContaining({ kind: "insufficient_available" }));
  });

  it("refuses to take more out of quarantine than is held", () => {
    expect(
      applyBucketDeltas({ onHand: 10, quarantined: 2, reserved: 0 }, [held(-3), sellable(3)])
        .violation,
    ).toEqual({ kind: "insufficient_quarantined", quarantined: 2, requested: 3 });
  });

  it("always allows movements that only add stock", () => {
    expect(
      applyBucketDeltas({ onHand: 0, quarantined: 0, reserved: 5 }, [sellable(3)]).violation,
    ).toBeNull();
  });

  it("sends held units back to the supplier before sellable ones", () => {
    const balance = toBalance({ onHand: 10, quarantined: 3, reserved: 0 });
    expect(planIssue(balance, 5, "quarantine_first")).toEqual([held(-3), sellable(-2)]);
    expect(planIssue(balance, 2, "quarantine_first")).toEqual([held(-2)]);
  });

  it("takes a stocktake shortfall from sellable stock first", () => {
    const balance = toBalance({ onHand: 10, quarantined: 3, reserved: 0 });
    expect(planIssue(balance, 9, "sellable_first")).toEqual([sellable(-7), held(-2)]);
  });

  it("calls a batch quarantined only when every unit on it is held", () => {
    expect(isWhollyQuarantined({ onHand: 5, quarantined: 5, reserved: 0 })).toBe(true);
    expect(isWhollyQuarantined({ onHand: 5, quarantined: 4, reserved: 0 })).toBe(false);
    expect(isWhollyQuarantined({ onHand: 0, quarantined: 0, reserved: 0 })).toBe(false);
  });
});
