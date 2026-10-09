import { PaymentMethod, Prisma } from "@prisma/client";
import { allocateRefund } from "./refund-allocation";

const d = (v: string) => new Prisma.Decimal(v);
const show = (rows: ReturnType<typeof allocateRefund>) =>
  rows.map((row) => [row.method, row.amount.toFixed(2)]);

describe("allocateRefund", () => {
  it("refunds a card sale to card", () => {
    expect(show(allocateRefund([{ method: PaymentMethod.card, amount: d("780") }], d("0"), d("260")))).toEqual([
      ["card", "260.00"],
    ]);
  });

  it("refunds cash net of the change given", () => {
    // 1,000 tendered for a 780 bill: 220 change, so cash kept 780.
    expect(show(allocateRefund([{ method: PaymentMethod.cash, amount: d("1000") }], d("220"), d("780")))).toEqual([
      ["cash", "780.00"],
    ]);
  });

  it("puts a split sale back on card first and cash last", () => {
    const payments = [
      { method: PaymentMethod.cash, amount: d("300") },
      { method: PaymentMethod.card, amount: d("500") },
    ];
    expect(show(allocateRefund(payments, d("0"), d("650")))).toEqual([
      ["card", "500.00"],
      ["cash", "150.00"],
    ]);
  });

  it("accounts for refunds already made to a method", () => {
    const payments = [
      { method: PaymentMethod.card, amount: d("500") },
      { method: PaymentMethod.card, amount: d("-400") },
      { method: PaymentMethod.cash, amount: d("300") },
    ];
    expect(show(allocateRefund(payments, d("0"), d("200")))).toEqual([
      ["card", "100.00"],
      ["cash", "100.00"],
    ]);
  });
});
