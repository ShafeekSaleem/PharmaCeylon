import { describe, expect, it } from "@jest/globals";
import type { CounterWorkReturnDetail, CounterWorkReturnLine } from "@pharmaceylon/shared";
import { handOverIssue, lineValue, returnQtyLabel, returnSummary, rs } from "./supplier-return-model";

const line = (overrides: Partial<CounterWorkReturnLine>) =>
  ({ itemId: "i", productName: "P", unitsPerPack: 1, qty: 1, quarantined: false, unitPrice: null, ...overrides }) as CounterWorkReturnLine;

describe("supplier return", () => {
  it("writes whole packs as packs and units, anything else as units", () => {
    expect(returnQtyLabel(line({ unitsPerPack: 14, qty: 28 }))).toBe("2 packs · 28");
    expect(returnQtyLabel(line({ unitsPerPack: 100, qty: 100 }))).toBe("1 pack · 100");
    expect(returnQtyLabel(line({ unitsPerPack: 14, qty: 30 }))).toBe("30");
    expect(returnQtyLabel(line({ unitsPerPack: 1, qty: 1200 }))).toBe("1,200");
  });

  it("prices a line in minor units", () => {
    expect(lineValue(line({ unitPrice: "0.10", qty: 3 }))).toBe("Rs 0.30");
    expect(lineValue(line({ unitPrice: null }))).toBeNull();
    expect(rs("6210")).toBe("Rs 6,210.00");
  });

  it("splits the units by where they are and says whether a debit note is raised", () => {
    const detail = {
      amount: "6210.00",
      notes: [{ label: "Reason", text: "Expired", by: null, at: null }],
      lines: [line({ qty: 12, quarantined: true }), line({ qty: 28, quarantined: true }), line({ qty: 600 })],
    } as unknown as CounterWorkReturnDetail;
    expect(returnSummary(detail)).toEqual({
      lines: 3,
      units: 640,
      fromQuarantine: 40,
      fromShelf: 600,
      amount: "6210.00",
      raisesDebitNote: true,
      reason: "Expired",
    });
    expect(returnSummary({ ...detail, amount: "0.00" }).raisesDebitNote).toBe(false);
    expect(returnSummary({ ...detail, amount: null }).raisesDebitNote).toBeNull();
  });

  it("waits for the server, the counter, the approval and every line packed, in that order", () => {
    const ok = { lines: 3, packed: 3, online: true, canPost: true, approvalState: "matches" as const };
    expect(handOverIssue(ok)).toBeNull();
    expect(handOverIssue({ ...ok, online: false })).toMatch(/offline/);
    expect(handOverIssue({ ...ok, canPost: false })).toMatch(/waiting at this counter/);
    expect(handOverIssue({ ...ok, approvalState: "changed" })).toMatch(/approved again/);
    expect(handOverIssue({ ...ok, lines: 0, packed: 0 })).toMatch(/no lines/);
    expect(handOverIssue({ ...ok, packed: 2 })).toBe("Pack the last line first.");
  });
});
