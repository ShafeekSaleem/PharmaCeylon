import { describe, expect, it } from "@jest/globals";
import { formatDisplayDateTime } from "@pharmaceylon/shared";
import {
  renderSaleReceiptHtml,
  renderSupplierCashPayoutReceiptHtml,
  type ReceiptSale,
} from "./receipt-html";

const sale: ReceiptSale = {
  invoiceNo: "C1R-000186",
  soldAt: "2026-11-19T09:41:00.000Z",
  subtotal: "96.00",
  discountTotal: "0.00",
  taxTotal: "0.00",
  grandTotal: "96.00",
  amountPaid: "100.00",
  changeDue: "4.00",
  sellerName: "Ana Perera",
  lines: [
    {
      name: "Panadol 500mg Tablets",
      qty: 1,
      unitPrice: "96.00",
      lineTotal: "96.00",
    },
  ],
  payments: [{ method: "cash", amount: "100.00", reference: null }],
};
const place = { branchName: "Kollupitiya", counterLabel: "Counter 2" };

describe("sale receipt", () => {
  it("writes the date day-first and the time 24-hour, whatever Windows is set to", () => {
    // Jest runs in UTC (jest.config.js); a US-English Windows printed 11/19/2026, 9:41:00 AM.
    const html = renderSaleReceiptHtml(sale, place);
    expect(html).toContain("19 Nov 2026, 09:41");
    expect(html).not.toContain("11/19/2026");
  });

  it("prints the original with no reprint mark", () => {
    expect(renderSaleReceiptHtml(sale, place)).not.toContain("REPRINT");
  });

  it("marks a copy of a receipt already printed, with the same invoice number", () => {
    const html = renderSaleReceiptHtml(sale, place, { reprint: true });
    expect(html).toContain("REPRINT");
    expect(html).toContain("C1R-000186");
  });

  it("draws the header in the pharmacy's accent", () => {
    const html = renderSaleReceiptHtml(sale, { ...place, accent: "#1D5FA8" });
    expect(html).toContain(
      '<header class="brand" style="color: #1d5fa8; border-bottom: 2px solid #1d5fa8;">',
    );
    expect(html).toContain("<h1>Kollupitiya</h1>");
  });

  it("leaves anything but a plain colour out of the header style", () => {
    const html = renderSaleReceiptHtml(sale, {
      ...place,
      accent: 'red;" onload="x',
    });
    expect(html).toContain('<header class="brand">');
    expect(html).not.toContain("onload");
  });
});

describe("supplier cash payout receipt", () => {
  const payout = {
    payoutNumber: "SCP-0042",
    amountMinor: 1_250_000,
    supplierPaymentId: "44444444-4444-4444-8444-444444444444",
    supplierPaymentNo: "SP-0012",
    supplierName: "Hemas",
    movementReason: "Supplier payout · SCP-0042",
    executedAt: "2026-11-14T12:30:00.000Z",
  };

  it("prints the supplier payment number and applied time", () => {
    const html = renderSupplierCashPayoutReceiptHtml(payout, place);
    expect(html).toContain("SP-0012");
    expect(html).toContain(formatDisplayDateTime(payout.executedAt));
    expect(html).not.toContain("44444444-4444");
  });

  it("falls back to the payment id prefix when supplierPaymentNo is absent", () => {
    const html = renderSupplierCashPayoutReceiptHtml(
      { ...payout, supplierPaymentNo: null },
      place,
    );
    expect(html).toContain("44444444");
    expect(html).not.toContain("SP-0012");
  });
});
