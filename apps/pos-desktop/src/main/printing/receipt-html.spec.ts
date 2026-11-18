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
});
