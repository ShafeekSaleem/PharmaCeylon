import {
  QUARANTINE_REASON_CODES,
  type QuarantineReasonCode,
} from "@pharmaceylon/shared";

export { QUARANTINE_REASON_CODES, type QuarantineReasonCode };

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
