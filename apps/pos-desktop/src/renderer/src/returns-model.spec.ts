import { describe, expect, it } from "@jest/globals";
import type { ReturnLine, ReturnSale } from "../../shared/ipc-contract";
import {
  aroundAmount,
  defaultDisposition,
  everything,
  initialChoices,
  lineKey,
  methodOptions,
  overLimit,
  refundLines,
  refundTotalMinor,
} from "./returns-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, over: Partial<ReturnLine> = {}): ReturnLine => ({
  productId: id(n), batchId: id(100 + n), name: `Item ${n}`, sku: "", batchNo: "", expiryDate: null, unit: null,
  soldQty: 3, remainingQty: 3, paidTotal: "100.00", isControlled: false, requiresPrescription: false, ...over,
});
const sale = (over: Partial<ReturnSale> = {}): ReturnSale => ({
  saleId: id(1), invoiceNo: "INV-1", status: "posted", soldAt: "2026-11-01T05:00:00.000Z", grandTotal: "100.00",
  sellerName: null, customer: null, payments: [{ method: "cash", amount: "100.00", reference: null }],
  needsPharmacist: false, refundLimit: null, earlierRefunds: [], lines: [line(1)], ...over,
});

describe("returns model", () => {
  it("defaults prescription and controlled lines to quarantine, the rest to restock", () => {
    expect(defaultDisposition(line(1, { requiresPrescription: true }))).toBe("quarantine");
    expect(defaultDisposition(line(1, { isControlled: true }))).toBe("quarantine");
    expect(defaultDisposition(line(1))).toBe("restock");
  });

  it("prices part of a line at what the customer paid per unit, and rounds the total once", () => {
    const s = sale({ lines: [line(1), line(2)] });
    const choices = { [lineKey(s.lines[0]!)]: { qty: 1, disposition: "restock" as const },
      [lineKey(s.lines[1]!)]: { qty: 1, disposition: "restock" as const } };
    // 100 / 3 twice = 66.666… → 66.67, as the server's Decimal total rounds.
    expect(refundTotalMinor(s, choices)).toBe(6667);
  });

  it("returns everything still returnable, keeping each line's place", () => {
    const s = sale({ lines: [line(1, { remainingQty: 2, requiresPrescription: true }), line(2, { remainingQty: 0 })] });
    const all = everything(s, initialChoices(s));
    expect(refundLines(s, all)).toEqual([
      { productId: id(1), batchId: id(101), qty: 2, disposition: "quarantine" },
    ]);
  });

  it("treats the limit as inclusive, and no limit as none", () => {
    expect(overLimit(sale({ refundLimit: "5000.00" }), 500000)).toBe(true);
    expect(overLimit(sale({ refundLimit: "5000.00" }), 499999)).toBe(false);
    expect(overLimit(sale({ refundLimit: null }), 10_000_000)).toBe(false);
    expect(overLimit(sale({ refundLimit: "0.00" }), 0)).toBe(false);
  });

  it("offers as-paid first and cash from the drawer, but only cash for a cash sale", () => {
    expect(methodOptions(sale()).map((m) => m.label)).toEqual(["Cash"]);
    const card = sale({ payments: [{ method: "card", amount: "100.00", reference: "Visa •• 4417" }] });
    expect(methodOptions(card)).toEqual([
      expect.objectContaining({ method: undefined, label: "Card", detail: "Visa •• 4417, as paid" }),
      expect.objectContaining({ method: "cash", label: "Cash", detail: "From the drawer" }),
    ]);
  });

  it("reads an amount the customer remembers as a range around it", () => {
    expect(aroundAmount("7000")).toEqual({ minTotal: "6650.00", maxTotal: "7350.00" });
    expect(aroundAmount("100")).toEqual({ minTotal: "90.00", maxTotal: "110.00" });
    expect(aroundAmount("")).toBeNull();
  });
});
