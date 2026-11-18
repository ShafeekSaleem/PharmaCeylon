import type { OfflineModeState, OfflineStaff } from "../../shared/ipc-contract";
import { time } from "./format";
import { minor } from "./sell-model";

/** P4 #50: what the offline counter shows. Pure, so the wording is tested without a screen. */

export type OfflineStockLine = {
  snapshotLineId: string;
  productId: string;
  batchId: string;
  remaining: number;
  unitPriceMinor: number;
  sellBefore: number;
  blocked: OfflineBlockReason | null;
  display: {
    name: string;
    strength: string | null;
    barcode: string | null;
    batchNo: string;
  } | null;
};

export type OfflineBlockReason =
  | "NOT_SOLD_OFFLINE"
  | "STOCK_REVIEW"
  | "EXPIRED"
  | "NOT_ENOUGH_STOCK";

export const OFFLINE_MAX_RESULTS = 20;

/** The name a line is shown by: the snapshot's, or its batch when the snapshot has none. */
export function offlineLineName(
  line: Pick<OfflineStockLine, "display" | "batchId">,
): string {
  if (!line.display) return `Batch ${line.batchId.slice(0, 8)}`;
  return line.display.strength
    ? `${line.display.name} ${line.display.strength}`
    : line.display.name;
}

/**
 * Lines matching a search: an exact barcode first, then names containing every word. A product
 * with several batches is listed once per batch, soonest to expire first, because the cashier
 * sells the batch in their hand and the snapshot prices and counts each one.
 */
export function findOfflineLines(
  lines: OfflineStockLine[],
  query: string,
): OfflineStockLine[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scanned = lines.filter(
    (l) => l.display?.barcode && l.display.barcode.toLowerCase() === q,
  );
  if (scanned.length) return byExpiry(scanned);
  const words = q.split(/\s+/);
  const hits = lines.filter((l) => {
    const hay = [
      offlineLineName(l),
      l.display?.batchNo ?? "",
      l.display?.barcode ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
  return byExpiry(hits).slice(0, OFFLINE_MAX_RESULTS);
}

const byExpiry = (lines: OfflineStockLine[]) =>
  [...lines].sort(
    (a, b) =>
      Number(Boolean(a.blocked)) - Number(Boolean(b.blocked)) ||
      offlineLineName(a).localeCompare(offlineLineName(b)) ||
      a.sellBefore - b.sellBefore,
  );

/** Why a line can't go on an offline sale. Stock under review says no more than that (Q3). */
export function blockedText(
  reason: OfflineBlockReason,
  remaining?: number | null,
): string {
  switch (reason) {
    case "NOT_SOLD_OFFLINE":
      return "Needs an online check";
    case "STOCK_REVIEW":
      return "Stock under review";
    case "EXPIRED":
      return "Past its sell-by date";
    case "NOT_ENOUGH_STOCK":
      return remaining && remaining > 0
        ? `Only ${remaining} left (last-known)`
        : "None left (last-known)";
  }
}

/** "18 left · last-known". */
export const remainingText = (remaining: number) =>
  `${remaining} left · last-known`;

/** "Expires Aug 2027", from the batch's sell-before time. */
export function expiryText(sellBefore: number): string {
  return `Exp ${new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
  }).format(new Date(sellBefore))}`;
}

/**
 * The banner over offline Sell: what the stock is and when offline selling ends. "Today" and
 * "tomorrow" are the counter's own days.
 */
export function sellingBanner(mode: OfflineModeState, now: Date): string {
  const parts: string[] = [];
  if (mode.snapshotGeneratedAt) {
    const at = new Date(mode.snapshotGeneratedAt);
    const before =
      mode.outageStartedAt &&
      Math.round(
        (new Date(mode.outageStartedAt).getTime() - at.getTime()) / 60_000,
      );
    parts.push(
      `Stock as of ${time(at)} ${dayWord(at, now)}${
        typeof before === "number" && before >= 0
          ? ` (${before} min before this outage)`
          : ""
      }.`,
    );
  }
  if (mode.grantExpiresAt) {
    const until = new Date(mode.grantExpiresAt);
    parts.push(
      `Offline permission ends ${time(until)} ${dayWord(until, now)}.`,
    );
  }
  return parts.join(" ");
}

function dayWord(at: Date, now: Date): string {
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(at);
}

/**
 * Why this counter can't sell while the server is unreachable, when it isn't selling offline.
 * Null while it is online, or selling offline.
 */
export function cannotSellOffline(
  mode: OfflineModeState | null,
): { title: string; text: string } | null {
  if (!mode || mode.mode === "online" || mode.mode === "offline") return null;
  if (mode.mode === "draining")
    return {
      title: "Finishing this counter's offline sales",
      text: "New sales wait until the saved sales are on the server and fresh stock is installed. It carries on by itself.",
    };
  const title = "This counter can't sell while the server is unreachable";
  switch (mode.reason) {
    case "NO_OFFLINE_AUTHORITY":
    case "NOT_ENROLLED":
      return {
        title,
        text: "It isn't the branch's offline counter. Wait for the connection, or move the customer to the counter set up for offline selling.",
      };
    case "TERMINAL_REVOKED":
      return { title, text: "This counter has been switched off on the web." };
    case "GRANT_EXPIRED":
      return {
        title,
        text: "Its offline selling permission has run out. Sales saved here are kept and upload when the server is back.",
      };
    case "SNAPSHOT_STALE":
      return {
        title,
        text: "Its saved stock is too old to sell from. Sales saved here are kept and upload when the server is back.",
      };
    case "CLOCK_UNTRUSTED":
      return {
        title,
        text:
          mode.clock === "NEW_BOOT"
            ? "The computer restarted during the outage, so it can't vouch for the time. Sales saved here are kept; new sales wait for the connection."
            : "It can't vouch for the time without the server. Sales saved here are kept; new sales wait for the connection.",
      };
    case "RECONCILIATION_REQUIRED":
    case "SYNC_PAUSED":
      return {
        title,
        text: "A manager must review an offline sale the server refused first. Sales saved here are kept.",
      };
    default:
      return {
        title,
        text: "Wait for the connection. The sale on screen is kept.",
      };
  }
}

/** What the after-hours state means for selling right now (D8). */
export function hoursBlock(hours: OfflineStaff["hours"]): string | null {
  if (!hours) return null;
  if (hours.status === "needs_acknowledgement")
    return "It's outside selling hours. A prepared manager must acknowledge it before more sales.";
  if (hours.status === "closed")
    return "The branch is closed now. Offline sales can't be made.";
  return null;
}

export type PayMethod = "cash" | "card" | "split";

/** What goes on the card: all of it, the part typed for a split (never more than the total), or none. */
export function cardAmount(
  method: PayMethod,
  totalMinor: number,
  cardIn: string,
): number {
  if (method === "card") return totalMinor;
  if (method === "split")
    return Math.min(totalMinor, Math.max(0, (cardIn ? minor(cardIn) : 0) || 0));
  return 0;
}
