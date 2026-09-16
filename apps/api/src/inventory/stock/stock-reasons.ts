/**
 * Why stock was held back. Stored on the ledger row as `reasonCode`; the free-text `reason` a
 * person typed sits next to it. A code rather than only free text so "how much did we lose to
 * expiry vs damage" is a query, not a reading exercise.
 */
export const QUARANTINE_REASON_CODES = [
  "expired",
  "damaged",
  "recall",
  "inspection",
  "other",
] as const;

export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];

export const QUARANTINE_REASON_LABELS: Record<QuarantineReasonCode, string> = {
  expired: "Expired",
  damaged: "Damaged",
  recall: "Recall",
  inspection: "Awaiting inspection",
  other: "Other",
};

/** Reference type for quarantine and release pairs, which have no parent document. */
export const QUARANTINE_REFERENCE_TYPE = "batch_quarantine";

/** Reservation source for an approved transfer. */
export const TRANSFER_RESERVATION_SOURCE = "transfer";
