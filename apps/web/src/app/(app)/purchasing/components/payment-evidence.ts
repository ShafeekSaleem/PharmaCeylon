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
/** Leading zeros are harmless here: what is sent is always re-formatted with `toFixed(2)`. */
export function paymentCents(value: string): number {
  const match = /^0*(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match)
    throw new Error(
      "Use an amount of at most 12 digits and two decimal places.",
    );
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
export function isPaymentAmount(value: string): boolean {
  try {
    return paymentCents(value) > 0;
  } catch {
    return false;
  }
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
