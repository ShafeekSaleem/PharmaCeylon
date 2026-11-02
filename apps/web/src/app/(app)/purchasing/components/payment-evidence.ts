import type { InvoiceRow } from "../ledger-types";

export const EVIDENCE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];
export const EVIDENCE_LIMIT = 5 * 1024 * 1024;
export function evidenceFileProblem(file: File): string | null {
  if (!EVIDENCE_TYPES.includes(file.type))
    return "Choose a PDF, JPEG, PNG or WebP document.";
  if (!file.size || file.size > EVIDENCE_LIMIT)
    return "Choose a non-empty document up to 5 MB.";
  return null;
}
export function paymentCents(value: string): number {
  if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value))
    throw new Error("Use an amount with at most two decimal places.");
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function paymentAllocations(
  rows: InvoiceRow[],
  amount: string,
  chosen?: Record<string, string>,
) {
  let remaining = paymentCents(amount);
  if (!Number.isSafeInteger(remaining) || remaining <= 0)
    throw new Error("Enter a valid payment amount.");
  const result: { invoiceId: string; amount: string }[] = [];
  const sorted = [...rows].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.invoiceDate.localeCompare(b.invoiceDate) ||
      a.id.localeCompare(b.id),
  );
  for (const row of sorted) {
    const balance = paymentCents(row.balance);
    const cents = chosen
      ? paymentCents(chosen[row.id] || "0")
      : Math.min(remaining, balance);
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > balance)
      throw new Error("Check the amount allocated to each invoice.");
    if (cents > 0)
      result.push({ invoiceId: row.id, amount: (cents / 100).toFixed(2) });
    remaining -= cents;
  }
  if (remaining !== 0 || !result.length || result.length > 250)
    throw new Error(
      "Allocate the full payment to up to 250 outstanding invoices.",
    );
  return result;
}
