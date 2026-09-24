import { Prisma, SupplierInvoiceStatus } from "@prisma/client";
import {
  allocateOldestFirst,
  invoiceLineNet,
  invoiceStatus,
  invoiceTotals,
  threeWayMatch,
} from "./supplier-ledger.math";

const d = (v: string | number) => new Prisma.Decimal(v);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("supplier ledger maths", () => {
  describe("invoice lines and totals", () => {
    it("takes the line discount off before tax", () => {
      expect(invoiceLineNet({ qty: 10, unitCost: "100", discountPercent: 5 }).toString()).toBe("950");
    });

    it("works tax out from line rates when the invoice doesn't state it", () => {
      const totals = invoiceTotals({
        lines: [
          { qty: 10, unitCost: "100", taxPercent: 18 },
          { qty: 1, unitCost: "50", taxPercent: 0 },
        ],
        shippingAmount: "200",
      });
      expect(totals.subtotal.toString()).toBe("1050");
      expect(totals.tax.toString()).toBe("180");
      expect(totals.total.toString()).toBe("1430");
    });

    it("uses the tax printed on the invoice when one is given", () => {
      // The supplier's own rounding is the figure that will be argued over.
      const totals = invoiceTotals({
        lines: [{ qty: 3, unitCost: "33.33", taxPercent: 18 }],
        taxAmount: "18.00",
      });
      expect(totals.tax.toString()).toBe("18");
      expect(totals.total.toString()).toBe("117.99");
    });
  });

  describe("invoiceStatus", () => {
    it("follows what has been settled", () => {
      expect(invoiceStatus(SupplierInvoiceStatus.open, d(100), d(0))).toBe("open");
      expect(invoiceStatus(SupplierInvoiceStatus.open, d(100), d(40))).toBe("partial");
      expect(invoiceStatus(SupplierInvoiceStatus.partial, d(100), d(100))).toBe("paid");
    });

    it("goes back to open when a payment is voided", () => {
      expect(invoiceStatus(SupplierInvoiceStatus.paid, d(100), d(0))).toBe("open");
    });

    it("never revives a voided invoice", () => {
      expect(invoiceStatus(SupplierInvoiceStatus.voided, d(100), d(100))).toBe("voided");
    });
  });

  describe("allocateOldestFirst", () => {
    const invoices = [
      { id: "b", dueDate: day("2026-10-15"), invoiceDate: day("2026-09-15"), balance: d(300) },
      { id: "a", dueDate: day("2026-10-01"), invoiceDate: day("2026-09-01"), balance: d(500) },
      { id: "c", dueDate: day("2026-11-01"), invoiceDate: day("2026-10-01"), balance: d(200) },
    ];

    it("clears the oldest due first", () => {
      const { allocations, unplaced } = allocateOldestFirst(d(650), invoices);
      expect(allocations.map((a) => [a.invoiceId, a.amount.toString()])).toEqual([
        ["a", "500"],
        ["b", "150"],
      ]);
      expect(unplaced.toString()).toBe("0");
    });

    it("says how much could not be placed when more is paid than owed", () => {
      const { unplaced } = allocateOldestFirst(d(1200), invoices);
      expect(unplaced.toString()).toBe("200");
    });

    it("skips invoices with nothing left on them", () => {
      const { allocations } = allocateOldestFirst(d(100), [
        { id: "z", dueDate: day("2026-09-01"), invoiceDate: day("2026-08-01"), balance: d(0) },
        ...invoices,
      ]);
      expect(allocations[0]!.invoiceId).toBe("a");
    });
  });

  describe("threeWayMatch", () => {
    const p = "prod-1";

    it("matches when ordered, received and billed agree", () => {
      const result = threeWayMatch({
        ordered: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
        received: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
        billed: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
      });
      expect(result.matched).toBe(true);
      expect(result.valueAtStake).toBe("0.00");
    });

    it("catches being billed for goods that never arrived, and prices it", () => {
      const result = threeWayMatch({
        ordered: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
        received: [{ productId: p, product: "Panadol", qty: 90, unitCost: d(10) }],
        billed: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
      });
      expect(result.matched).toBe(false);
      expect(result.lines[0]).toMatchObject({
        status: "billed_more_than_received",
        qtyDifference: 10,
        valueAtStake: "100.00",
      });
    });

    it("catches a price nobody agreed to", () => {
      const result = threeWayMatch({
        ordered: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
        received: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(10) }],
        billed: [{ productId: p, product: "Panadol", qty: 100, unitCost: d(12) }],
      });
      expect(result.lines[0]).toMatchObject({
        status: "price_differs",
        priceDifference: "2.00",
        valueAtStake: "200.00",
      });
    });

    it("flags a billed line with no delivery behind it", () => {
      const result = threeWayMatch({
        ordered: [],
        received: [],
        billed: [{ productId: null, product: "Delivery charge", qty: 1, unitCost: d(500) }],
      });
      expect(result.lines[0]!.status).toBe("billed_not_received");
    });

    it("flags goods that arrived but were not billed", () => {
      const result = threeWayMatch({
        ordered: [{ productId: p, product: "Panadol", qty: 10, unitCost: d(10) }],
        received: [{ productId: p, product: "Panadol", qty: 10, unitCost: d(10) }],
        billed: [],
      });
      expect(result.lines[0]!.status).toBe("received_not_billed");
      // Under-billing is not money at risk for the pharmacy.
      expect(result.valueAtStake).toBe("0.00");
    });
  });
});
