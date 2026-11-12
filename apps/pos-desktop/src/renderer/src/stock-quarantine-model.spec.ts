import { describe, expect, it } from "@jest/globals";
import {
  buildQuarantineBody,
  buildReleaseBody,
  mapStockCommandError,
  quarantinePrimaryEnabled,
  releasePrimaryEnabled,
} from "./stock-quarantine-model";
import type { StockBatch } from "../../shared/ipc-contract";

const batch = (): StockBatch =>
  ({
    batchId: "b1",
    batchNo: "AUG-7311",
    available: 6,
    onHand: 6,
    quarantined: 0,
    reserved: 0,
    expired: false,
    nearExpiry: true,
    needsExpiryReview: false,
    expiryDate: "2026-11-24",
    daysToExpiry: 13,
    costPrice: "10",
    isQuarantined: false,
    quarantineReason: null,
  }) as StockBatch;

describe("quarantine payloads", () => {
  it("sends qty null when all available is ticked", () => {
    expect(
      buildQuarantineBody("b1", { qtyText: "6", allQty: true, reasonCode: "damaged", reasonText: "" }, batch()),
    ).toEqual({ batchId: "b1", qty: null, reasonCode: "damaged", reason: null });
  });

  it("requires reason text for other", () => {
    const body = buildQuarantineBody(
      "b1",
      { qtyText: "2", allQty: false, reasonCode: "other", reasonText: "  damaged seal  " },
      batch(),
    );
    expect(body.reason).toBe("damaged seal");
  });
});

describe("release payloads", () => {
  it("sends qty null for all held", () => {
    expect(
      buildReleaseBody("b1", { qtyText: "4", allQty: true, reasonText: "" }),
    ).toEqual({ batchId: "b1", qty: null, reason: null });
  });
});

describe("primary button gates", () => {
  it("disables quarantine when other has no reason", () => {
    expect(
      quarantinePrimaryEnabled(
        { qtyText: "6", allQty: false, reasonCode: "other", reasonText: "" },
        batch(),
        true,
        true,
      ),
    ).toBe(false);
  });

  it("disables release when expired", () => {
    expect(
      releasePrimaryEnabled(
        { qtyText: "4", allQty: false },
        { ...batch(), expired: true, quarantined: 4 },
        true,
        true,
      ),
    ).toBe(false);
  });
});

describe("error mapping", () => {
  it("maps server validation copy", () => {
    expect(mapStockCommandError(undefined, "Describe why the stock is being held").kind).toBe(
      "validation",
    );
    expect(
      mapStockCommandError(undefined, "Only 6 available on batch AUG-7311 (20 requested).").kind,
    ).toBe("available");
  });
});
