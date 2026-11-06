import { randomUUID } from "node:crypto";
import {
  allocateMovementLinks,
  checkCounts,
  countCorrection,
  normalizeLinks,
  parseKind,
  resolutionMaterial,
  timelineDigest,
} from "./stock-case-plan";

const [a, b] = [randomUUID(), randomUUID()].sort();

describe("offline stock case plans (P5 #51)", () => {
  it("accepts only the three resolution kinds", () => {
    expect(parseKind("count_and_correct")).toBe("count_and_correct");
    expect(() => parseKind("write_off")).toThrow("Resolution must be one of");
  });

  it("needs exactly one valid link per batch for link_existing_settlement, and none otherwise", () => {
    const stocktakeId = randomUUID();
    const ledgerId = randomUUID();
    expect(normalizeLinks("link_existing_settlement", [
      { batchId: b, source: "movements", ledgerEntryIds: [ledgerId] },
      { batchId: a, source: "stocktake", stocktakeId },
    ], [a, b])).toEqual([
      { batchId: a, source: "stocktake", stocktakeId },
      { batchId: b, source: "movements", ledgerEntryIds: [ledgerId] },
    ]);
    expect(() => normalizeLinks("link_existing_settlement", [{ batchId: a, source: "stocktake", stocktakeId }], [a, b]))
      .toThrow("a link for every batch");
    expect(() => normalizeLinks("link_existing_settlement", [
      { batchId: a, source: "stocktake", stocktakeId }, { batchId: a, source: "stocktake", stocktakeId },
    ], [a, b])).toThrow("linked once");
    expect(() => normalizeLinks("link_existing_settlement", [{ batchId: randomUUID(), source: "stocktake", stocktakeId }], [a]))
      .toThrow("batch of this case");
    expect(() => normalizeLinks("link_existing_settlement", [{ batchId: a, source: "movements", ledgerEntryIds: [ledgerId, ledgerId] }], [a]))
      .toThrow("named once");
    expect(() => normalizeLinks("post_now", [{ batchId: a, source: "stocktake", stocktakeId }], [a])).toThrow("Only link_existing_settlement");
    expect(normalizeLinks("count_and_correct", undefined, [a])).toEqual([]);
  });

  it("binds the approval to the case, the plan and the other open cases on each batch", () => {
    const base = {
      caseId: randomUUID(), saleId: randomUUID(), commandId: randomUUID(), kind: "post_now" as const, links: [],
      lines: [
        { batchId: b, productId: "p", soldQuantity: 2, availableQuantityAtSync: 9, shortfallQuantity: 0, reason: "sale_pending" },
        { batchId: a, productId: "p", soldQuantity: 5, availableQuantityAtSync: 3, shortfallQuantity: 2, reason: "shortfall" },
      ],
      otherOpenCases: [],
    };
    const material = resolutionMaterial(base);
    expect((material.items as Array<{ batchId: string }>).map((i) => i.batchId)).toEqual([a, b]);
    const another = resolutionMaterial({ ...base, otherOpenCases: [{ batchId: a, caseId: randomUUID(), soldQuantity: 1 }] });
    expect(JSON.stringify(another)).not.toBe(JSON.stringify(material));
    expect(JSON.stringify(resolutionMaterial({ ...base, kind: "count_and_correct" }))).not.toBe(JSON.stringify(material));
  });

  it("takes one whole, non-negative count per batch, only for count_and_correct", () => {
    expect([...checkCounts("count_and_correct", [{ batchId: a, countedQty: 0 }, { batchId: b, countedQty: 4 }], [a, b])])
      .toEqual([[a, 0], [b, 4]]);
    expect(() => checkCounts("count_and_correct", [{ batchId: a, countedQty: 1 }], [a, b])).toThrow("Count every batch");
    expect(() => checkCounts("count_and_correct", [{ batchId: a, countedQty: -1 }], [a])).toThrow("whole number");
    expect(() => checkCounts("count_and_correct", [{ batchId: a, countedQty: 1.5 }], [a])).toThrow("whole number");
    expect(() => checkCounts("post_now", [{ batchId: a, countedQty: 1 }], [a])).toThrow("Only count_and_correct");
  });

  it("corrects to the count plus every pending unit, so posting the sale lands on the count", () => {
    // Contract example: snapshot 10, 7 sold online (central 3), 5 sold offline; the shelf is empty.
    expect(countCorrection({ countedQty: 0, pendingOnBatch: 5, onHandBefore: 3 })).toEqual({ target: 5, correctionQty: 2 });
    // More on the shelf than central thinks after the sale: the correction is smaller.
    expect(countCorrection({ countedQty: 4, pendingOnBatch: 5, onHandBefore: 3 }).correctionQty).toBe(6);
    // Central holds more than the shelf: units come off.
    expect(countCorrection({ countedQty: 0, pendingOnBatch: 2, onHandBefore: 6 }).correctionQty).toBe(-4);
    // Another open case's 3 pending units are already off the shelf too: they stay on central
    // until that case posts them, so nothing is deducted twice.
    const { target } = countCorrection({ countedQty: 1, pendingOnBatch: 5 + 3, onHandBefore: 3 });
    expect(target - 5).toBe(1 + 3);
  });

  it("links movement units at most once, and never partly", () => {
    const [x, y] = [randomUUID(), randomUUID()];
    expect(allocateMovementLinks(5, [{ ledgerEntryId: x, remaining: 3 }, { ledgerEntryId: y, remaining: 4 }]))
      .toEqual([{ ledgerEntryId: x, quantity: 3 }, { ledgerEntryId: y, quantity: 2 }]);
    expect(allocateMovementLinks(5, [{ ledgerEntryId: x, remaining: 3 }, { ledgerEntryId: y, remaining: 0 }])).toBeNull();
  });

  it("digests a batch timeline independently of read order", () => {
    const e1 = { id: "1", occurredAt: "2026-11-06T10:00:00.000Z", movementType: "sale_out", bucket: "sellable", qtyDelta: -7, referenceType: "sale", referenceId: "s" };
    const e2 = { ...e1, id: "2", occurredAt: "2026-11-06T11:00:00.000Z", qtyDelta: 1 };
    expect(timelineDigest(a, [e1, e2])).toBe(timelineDigest(a, [e2, e1]));
    expect(timelineDigest(a, [e1])).not.toBe(timelineDigest(a, [e1, e2]));
    expect(timelineDigest(a, [e1])).toMatch(/^[0-9a-f]{64}$/);
  });
});
