/**
 * Soft patient / Rx matching for the counter — never a hard clinical oracle.
 * Hard blocks stay in SalesService (expired Rx, missing Rx, customerId clash).
 */

export function normalizePersonName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Token Jaccard on normalized names — tolerant of order / middle names. */
export function nameSimilarity(a: string, b: string): number {
  const left = new Set(normalizePersonName(a).split(" ").filter(Boolean));
  const right = new Set(normalizePersonName(b).split(" ").filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let inter = 0;
  for (const t of left) if (right.has(t)) inter += 1;
  const union = left.size + right.size - inter;
  return union === 0 ? 0 : inter / union;
}

export type RxMatchWarning = {
  code: "patient_name_mismatch" | "customer_rx_unlinked";
  message: string;
};

/**
 * Advisory only. Returns warnings the till can show before PIN / complete.
 * Does not throw.
 */
export function softRxMatchWarnings(input: {
  patientName: string;
  customerName?: string | null;
  prescriptionCustomerId?: string | null;
  saleCustomerId?: string | null;
}): RxMatchWarning[] {
  const warnings: RxMatchWarning[] = [];
  const customerName = input.customerName?.trim();
  if (customerName) {
    const score = nameSimilarity(customerName, input.patientName);
    if (score < 0.34) {
      warnings.push({
        code: "patient_name_mismatch",
        message: `Patient on Rx (“${input.patientName}”) does not closely match customer (“${customerName}”). Confirm identity before dispensing.`,
      });
    }
  }
  if (
    input.saleCustomerId &&
    input.prescriptionCustomerId &&
    input.saleCustomerId !== input.prescriptionCustomerId
  ) {
    warnings.push({
      code: "customer_rx_unlinked",
      message:
        "Linked prescription belongs to a different registered customer. Confirm before dispensing.",
    });
  }
  return warnings;
}
