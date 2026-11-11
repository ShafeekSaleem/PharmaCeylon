/** Why units were held back from sale (counter signed quarantine + web quarantine). */
export const QUARANTINE_REASON_CODES = [
  "expired",
  "damaged",
  "recall",
  "inspection",
  "other",
] as const;

export type QuarantineReasonCode = (typeof QUARANTINE_REASON_CODES)[number];
