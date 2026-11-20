/** How a sale was rung up, for back-office history (W4 #66 Phase B). */
export type SaleChannel = "web_legacy" | "desktop_online" | "offline" | "fallback";

export const SALE_CHANNELS: readonly SaleChannel[] = [
  "web_legacy",
  "desktop_online",
  "offline",
  "fallback",
] as const;

/** Minimal branch columns needed to label a web sale. Mirrors API `POS_ROLLOUT_SELECT`. */
export type SaleChannelBranchRollout = Readonly<{
  desktopPosRollout: "not_live" | "live";
  desktopPosLiveAt: Date | string | null;
  posFallbackStartedAt: Date | string | null;
  posFallbackEndsAt: Date | string | null;
}>;

export type SaleChannelAttribution = Readonly<{
  terminalId: string | null;
  offlineCommandId: string | null;
  soldAt: Date | string;
}>;

export type FallbackWindow = Readonly<{ startedAt: Date; endsAt: Date }>;

function at(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function inWindow(soldAt: Date, window: FallbackWindow): boolean {
  return soldAt >= window.startedAt && soldAt < window.endsAt;
}

function clipWindow(start: Date, end: Date, liveAt: Date): FallbackWindow | null {
  const clippedStart = start < liveAt ? liveAt : start;
  return clippedStart < end ? { startedAt: clippedStart, endsAt: end } : null;
}

/**
 * Fallback intervals that count for labelling and filtering: only on a live branch, never before
 * `desktopPosLiveAt`, from current branch columns plus historical audit windows.
 */
export function effectiveFallbackWindows(
  branch: SaleChannelBranchRollout,
  historical: readonly FallbackWindow[] = [],
): FallbackWindow[] {
  if (branch.desktopPosRollout !== "live") return [];
  const liveAt = branch.desktopPosLiveAt ? at(branch.desktopPosLiveAt) : null;
  if (!liveAt) return [];

  const windows: FallbackWindow[] = [];
  if (branch.posFallbackStartedAt && branch.posFallbackEndsAt) {
    const clipped = clipWindow(at(branch.posFallbackStartedAt), at(branch.posFallbackEndsAt), liveAt);
    if (clipped) windows.push(clipped);
  }
  for (const window of historical) {
    const clipped = clipWindow(at(window.startedAt), at(window.endsAt), liveAt);
    if (clipped) windows.push(clipped);
  }
  return windows;
}

export function isFallbackWebSale(
  soldAt: Date | string,
  branch: SaleChannelBranchRollout,
  historical: readonly FallbackWindow[] = [],
): boolean {
  return effectiveFallbackWindows(branch, historical).some((window) => inWindow(at(soldAt), window));
}

/**
 * Derives the sales channel from persisted attribution and branch rollout, without a stored column.
 */
export function deriveSaleChannel(
  sale: SaleChannelAttribution,
  branch: SaleChannelBranchRollout,
  historicalFallbacks: readonly FallbackWindow[] = [],
): SaleChannel {
  if (sale.offlineCommandId) return "offline";
  if (sale.terminalId) return "desktop_online";

  const soldAt = at(sale.soldAt);
  if (branch.desktopPosRollout !== "live") return "web_legacy";

  const liveAt = branch.desktopPosLiveAt ? at(branch.desktopPosLiveAt) : null;
  if (!liveAt || soldAt < liveAt) return "web_legacy";

  if (isFallbackWebSale(soldAt, branch, historicalFallbacks)) return "fallback";

  return "web_legacy";
}