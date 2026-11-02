import {
  paymentAllocations,
  paymentCents,
  evidenceFileProblem,
} from "./payment-evidence";
import type { InvoiceRow } from "../ledger-types";
const row = (id: string, balance: string, dueDate: string) =>
  ({ id, balance, dueDate, invoiceDate: dueDate }) as InvoiceRow;
it("allocates exact cents oldest first and never exceeds balances", () => {
  expect(
    paymentAllocations(
      [row("b", "20.20", "2026-02-01"), row("a", "10.10", "2026-01-01")],
      "20.20",
    ),
  ).toEqual([
    { invoiceId: "a", amount: "10.10" },
    { invoiceId: "b", amount: "10.10" },
  ]);
});
it.each(["1.001", "-1", "NaN", "1e3", "1000000000000", ""])(
  "rejects invalid amount %s",
  (value) => expect(() => paymentCents(value)).toThrow(),
);
it("refuses under-allocation, unknown invoices and over-allocation", () => {
  const rows = [row("a", "10.00", "2026-01-01")];
  expect(() => paymentAllocations(rows, "11.00")).toThrow();
  expect(() => paymentAllocations(rows, "5.00", { missing: "5.00" })).toThrow();
  expect(() => paymentAllocations(rows, "11.00", { a: "11.00" })).toThrow();
});
it("refuses unsafe or empty attachments", () => {
  expect(
    evidenceFileProblem(new File(["html"], "x.html", { type: "text/html" })),
  ).toBeTruthy();
  expect(
    evidenceFileProblem(new File([], "x.pdf", { type: "application/pdf" })),
  ).toBeTruthy();
});
