import type { OfflineSaleSyncState, SaleChannel } from "@pharmaceylon/shared";

/**
 * W10 #72: the counter, shift and channel a sales report can be narrowed to. The API applies them
 * on the sales reports and, while one is set, on the profit reports those pages also read (see
 * `docs/API_CONTRACT.md`, "Sales reports"). An empty object is the whole branch, as before.
 */
export type SalesDimensions = Readonly<{
  registerId?: string;
  shiftId?: string;
  channel?: SaleChannel;
  offlineSyncState?: OfflineSaleSyncState;
}>;

export const NO_DIMENSIONS: SalesDimensions = {};

/** Reports whose every figure comes from an endpoint that takes the dimensions. */
export const DIMENSION_REPORTS: ReadonlySet<string> = new Set([
  "sales-summary",
  "category-sales",
  "cashier-performance",
  "payment-methods",
  "returns-discounts",
]);

export function dimensionsActive(dims: SalesDimensions | undefined): boolean {
  return Boolean(dims && (dims.registerId || dims.shiftId || dims.channel || dims.offlineSyncState));
}

/** `&registerId=…&channel=…` for the set dimensions, or "" when none are. */
export function dimensionsQs(dims: SalesDimensions | undefined): string {
  if (!dims) return "";
  const qs = new URLSearchParams();
  if (dims.registerId) qs.set("registerId", dims.registerId);
  if (dims.shiftId) qs.set("shiftId", dims.shiftId);
  if (dims.channel) qs.set("channel", dims.channel);
  if (dims.offlineSyncState) qs.set("offlineSyncState", dims.offlineSyncState);
  const s = qs.toString();
  return s ? `&${s}` : "";
}

/** How each channel reads in a report: where the sale was rung up, and in what state. */
export const REPORT_CHANNEL_LABELS: Record<SaleChannel, string> = {
  desktop_online: "Counter (online)",
  offline: "Counter (offline)",
  fallback: "Web fallback",
  web_legacy: "Web",
};

export const REPORT_CHANNEL_NOTES: Record<SaleChannel, string> = {
  desktop_online: "Sold on a counter computer while it was online",
  offline: "Sold while the counter was offline, dated when it happened",
  fallback: "Sold on the web while the branch's counters were down",
  web_legacy: "Sold on the web at a branch not yet on counter computers",
};
