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

/**
 * Derives the sales channel from persisted attribution and branch rollout, without a stored column.
 * Offline replay wins over counter attribution; counter over web; web splits legacy vs fallback from
 * go-live and fallback windows (current branch columns plus optional historical audit windows).
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

  const started = branch.posFallbackStartedAt ? at(branch.posFallbackStartedAt) : null;
  const ends = branch.posFallbackEndsAt ? at(branch.posFallbackEndsAt) : null;
  if (started && ends && inWindow(soldAt, { startedAt: started, endsAt: ends })) return "fallback";

  if (historicalFallbacks.some((window) => inWindow(soldAt, window))) return "fallback";

  return "web_legacy";
}