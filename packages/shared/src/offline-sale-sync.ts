/** Server-side offline sale sync on an accepted `sale` row (W4 #66 Phase D). */
export const OFFLINE_SALE_SYNC_STATES = [
  "accepted",
  "pending_stock_posting",
  /** Reserved — not emitted until product defines it. */
  "held",
] as const;

export type OfflineSaleSyncState = (typeof OFFLINE_SALE_SYNC_STATES)[number];

/** Filter chips for sales history; `held` is omitted until it is emitted. */
export const OFFLINE_SALE_SYNC_STATE_OPTIONS = [
  { value: "accepted" as const, label: "Synced — stock posted" },
  { value: "pending_stock_posting" as const, label: "Synced — stock pending" },
] as const;