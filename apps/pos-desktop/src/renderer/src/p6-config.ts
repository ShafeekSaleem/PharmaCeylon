/** Shafeek decisions for #173 (12 Nov 2026). Counter-only quarantine/release; expiry review opens this sheet. */
export const P6_QUARANTINE_COUNTER_ONLY = true;
export const P6_EXPIRY_REVIEW_OPENS_QUARANTINE_SHEET = true;

/**
 * When `GET /counter-work` includes awaiting/rejected held write-offs (John follow-up if missing),
 * the counter shows them read-only per w-pending / w-rejected mockups.
 */
export const P6_HELD_WRITE_OFF_READ_ONLY_STATUSES = [
  "awaiting_approval",
  "rejected",
] as const;
