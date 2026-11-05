import { describe, expect, it } from "@jest/globals";
import type { StockBatch, StockRow } from "../../shared/ipc-contract";
import {
  bandText,
  batchStatus,
  expiryWhen,
  movementLine,
  packText,
  rowNote,
  sellFirstBatch,
  writeOffCheck,
} from "./stock-model";

let n = 0;
function batch(overrides: Partial<StockBatch> = {}): StockBatch {
  n += 1;
  return {
    batchId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    batchNo: `B-${n}`,
    expiryDate: "2027-02-01",
    daysToExpiry: 90,
    expired: false,
    nearExpiry: false,
    needsExpiryReview: false,
    isQuarantined: false,
    quarantineReason: null,
    onHand: 10,
    available: 10,
    reserved: 0,
    quarantined: 0,
    sellingPrice: "145.00",
    costPrice: "103.00",
    ...overrides,
  };
}

describe("Sell first: the batch checkout's FEFO pick takes", () => {
  it("is the earliest in-date batch with stock to sell", () => {
    const later = batch({ expiryDate: "2027-12-01" });
    const sooner = batch({ expiryDate: "2027-02-01" });
    expect(sellFirstBatch([later, sooner])).toBe(sooner);
  });

  it("skips what checkout skips: expired, wholly quarantined and unconfirmed-expiry batches", () => {
    const expired = batch({ expiryDate: "2026-08-01", expired: true, available: 0 });
    const held = batch({ expiryDate: "2026-11-24", isQuarantined: true, available: 0 });
    const review = batch({ expiryDate: "2026-12-01", needsExpiryReview: true, available: 0 });
    const next = batch({ expiryDate: "2027-02-01" });
    expect(sellFirstBatch([expired, held, review, next])).toBe(next);
  });

  it("skips a batch whose units are all promised to a transfer or partly held", () => {
    const promised = batch({ expiryDate: "2027-01-01", reserved: 10, available: 0 });
    const next = batch({ expiryDate: "2027-03-01" });
    expect(sellFirstBatch([promised, next])).toBe(next);
  });

  it("still sells from a batch with only some units in quarantine", () => {
    const partly = batch({ expiryDate: "2027-01-01", quarantined: 4, available: 6 });
    expect(sellFirstBatch([partly, batch({ expiryDate: "2027-06-01" })])).toBe(partly);
  });

  it("keeps the server's order between batches that expire the same day", () => {
    const first = batch({ expiryDate: "2027-01-01" });
    const second = batch({ expiryDate: "2027-01-01" });
    expect(sellFirstBatch([first, second])).toBe(first);
  });

  it("is none when nothing can be sold", () => {
    expect(sellFirstBatch([batch({ expired: true, available: 0 })])).toBeNull();
  });
});

describe("a batch's status and action", () => {
  it("draws the mockup's four rows", () => {
    expect(
      batchStatus(batch({ expired: true, quarantined: 4, isQuarantined: true }), false),
    ).toEqual({ label: "Quarantined · expired", tone: "warn", action: "write-off" });
    expect(batchStatus(batch({ nearExpiry: true }), false)).toEqual({
      label: "Expiring · sell or hold",
      tone: "bad",
      action: "quarantine",
    });
    expect(batchStatus(batch(), true)).toEqual({ label: "Sell first", tone: "info", action: "adjust" });
    expect(batchStatus(batch(), false)).toEqual({ label: "Good", tone: "ok", action: "adjust" });
  });

  it("says Sell first on an expiring batch when checkout would sell it next", () => {
    expect(batchStatus(batch({ nearExpiry: true }), true)).toEqual({
      label: "Sell first · expiring",
      tone: "bad",
      action: "quarantine",
    });
  });

  it("says when an expired batch is still on the shelf", () => {
    expect(batchStatus(batch({ expired: true }), false).label).toBe("Expired · not for sale");
  });
});

describe("wording", () => {
  it("says how far off an expiry is", () => {
    expect(expiryWhen(23)).toBe("In 23 days");
    expect(expiryWhen(92)).toBe("In 3 months");
    expect(expiryWhen(-92)).toBe("Expired 3 months ago");
    expect(expiryWhen(0)).toBe("Expires today");
  });

  it("writes the pack as the mockup does", () => {
    expect(packText({ manufacturer: "GSK", unitsPerPack: 14, packLabel: null })).toBe("GSK · pack of 14");
    expect(packText({ manufacturer: null, unitsPerPack: 1, packLabel: null })).toBe("");
  });

  it("names a movement and its sign", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000999",
      occurredAt: "2026-11-01T08:35:00.000Z",
      batchNo: "AUG-6904",
      actorName: "Sachini R.",
    };
    expect(
      movementLine({ ...base, movementType: "sale_out", qtyDelta: -14, quarantineDelta: 0 }),
    ).toMatchObject({ what: "Sold", qty: "−14", tone: "out" });
    expect(
      movementLine({ ...base, movementType: "quarantine_hold", qtyDelta: 0, quarantineDelta: 4 }),
    ).toMatchObject({ what: "Quarantined", qty: "4", tone: "hold" });
    expect(
      movementLine({ ...base, movementType: "purchase_in", qtyDelta: 98, quarantineDelta: 0 }),
    ).toMatchObject({ what: "Received", qty: "+98", tone: "in" });
  });

  it("puts the most urgent thing on a result", () => {
    const row = {
      stockStatus: "low",
      reorderLevel: 8,
      expiredBatchCount: 0,
      quarantined: 0,
      available: 5,
      nearExpiryBatchCount: 0,
      nextExpiry: "2027-06-30",
    } as StockRow;
    expect(rowNote(row)).toEqual({ text: "Below reorder (8)", tone: "warn" });
    expect(rowNote({ ...row, stockStatus: "ok" })).toEqual({ text: "Exp 06/2027", tone: "neutral" });
    expect(rowNote({ ...row, expiredBatchCount: 1 }).tone).toBe("bad");
  });
});

describe("the write-off limit, as the server applies it", () => {
  it("is over at or above the limit, at cost", () => {
    const b = batch({ costPrice: "103.00" });
    expect(writeOffCheck(b, 4, "10000.00")).toEqual({ valueMinor: 41200, limitMinor: 1000000, overLimit: false });
    expect(writeOffCheck(b, 100, "10300.00").overLimit).toBe(true);
  });

  it("can't tell without the cost, and never applies without a limit", () => {
    expect(writeOffCheck(batch({ costPrice: null }), 4, "10000.00").overLimit).toBeNull();
    expect(writeOffCheck(batch({ costPrice: null }), 4, null).overLimit).toBe(false);
  });
});

describe("another branch's band", () => {
  it("is a word and a tone, never a number", () => {
    expect(bandText("in_stock")).toEqual({ text: "In stock", tone: "ok" });
    expect(bandText("low")).toEqual({ text: "Low", tone: "warn" });
    expect(bandText("out")).toEqual({ text: "Out", tone: "bad" });
    expect(bandText("ask_pharmacist")).toEqual({ text: "Ask the pharmacist", tone: "ask" });
  });
});
