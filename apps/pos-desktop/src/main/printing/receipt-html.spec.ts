import { describe, expect, it } from "@jest/globals";
import { renderSaleReceiptHtml, type ReceiptSale } from "./receipt-html";

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
