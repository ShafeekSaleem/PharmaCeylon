/** Server-side offline sale sync on an accepted `sale` row (W4 #66 Phase D). */
export const OFFLINE_SALE_SYNC_STATES = [
  "accepted",
  "pending_stock_posting",
  "held",
] as const;

export type OfflineSaleSyncState = (typeof OFFLINE_SALE_SYNC_STATES)[number];

/** Filter chips for sales history (mutually exclusive server states). */
export const OFFLINE_SALE_SYNC_STATE_OPTIONS = [
  { value: "accepted" as const, label: "Synced — stock posted" },
  { value: "pending_stock_posting" as const, label: "Synced — stock pending" },
  { value: "held" as const, label: "Stock case open" },
] as const;