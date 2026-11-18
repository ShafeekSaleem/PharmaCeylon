import type {
  JournalSync,
  OfflineJournalEntry,
  OfflineJournalQueue,
  OfflineModeState,
} from "../../shared/ipc-contract";
import { cannotSellOffline } from "./offline-sell-model";

/**
 * P4 #50, slice 4c: what the counter says about its offline sales once the connection is back
 * (`d-queue`, `d-drain`, `d-review`, `d-stock`, `d-clean` in docs/design/desktop-app/p4-offline-sale-v2).
 *
 * Decisions of 18 November 2026 (#50):
 * - Q3: the cashier sees only "Stock under review", never why.
 * - Q4, corrected: after a refused entry the counter stays paused until a manager settles it on
 *   the web. The journal is an ordered hash chain, so nothing after it can be accepted.
 */

/** What the upload queue is doing: waiting for the connection, sending, or stuck on a refusal. */
export type QueuePhase = "offline" | "draining" | "review";

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral";

const unsent = (e: OfflineJournalEntry) => e.status !== "accepted";

/** The refused entry everything else waits behind, if any (the oldest). */
export function refusedEntry(
  queue: OfflineJournalQueue | null,
): OfflineJournalEntry | null {
  const refused = queue?.entries.filter((e) => e.status === "refused") ?? [];
  return refused[refused.length - 1] ?? null;
}

export function queuePhase(
  mode: OfflineModeState | null,
  journal: JournalSync | null,
  queue: OfflineJournalQueue | null,
): QueuePhase | null {
  if (refusedEntry(queue) || (journal?.refused ?? 0) > 0) return "review";
  const waiting = queue
    ? queue.entries.filter(unsent).length
    : (journal?.waiting ?? 0);
  if (mode && (mode.mode === "offline" || !mode.connected))
    return waiting > 0 ? "offline" : null;
  if (waiting > 0 || journal?.pause) return "draining";
  return null;
}

/** The title bar's count: "4 to send", "3 need review". Null when there is nothing to say. */
export function queueChip(
  phase: QueuePhase | null,
  journal: JournalSync | null,
  queue: OfflineJournalQueue | null,
): string | null {
  if (!phase) return null;
  if (phase === "review") {
    const stuck = queue
      ? queue.entries.filter(
          (e) => e.status === "refused" || e.status === "waiting",
        ).length
      : (journal?.refused ?? 0);
    return stuck > 0 ? `${stuck} need review` : null;
  }
  const waiting = queue
    ? queue.entries.filter(unsent).length
    : (journal?.waiting ?? 0);
  return waiting > 0 ? `${waiting} to send` : null;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** The popover's heading, summary and closing note. */
export function queueHeading(
  phase: QueuePhase,
  journal: JournalSync | null,
  queue: OfflineJournalQueue | null,
): { title: string; text: string; footer: string } {
  const entries = queue?.entries ?? [];
  const waiting = entries.filter(unsent);
  if (phase === "review") {
    const refused = refusedEntry(queue);
    return {
      title: "Needs a manager review",
      text: `${
        refused
          ? `The server refused journal entry ${refused.sequence}.`
          : "The server refused an offline record."
      } Nothing after it can be accepted until a manager settles it on the web.`,
      footer:
        "This counter keeps the sales and stays paused until then. A cashier can't retry a refused entry. Other online counters can keep selling.",
    };
  }
  if (phase === "offline") {
    const sales = waiting.filter((e) => e.kind === "sale").length;
    const shifts = waiting.length - sales;
    const parts = [
      sales > 0 ? plural(sales, "sale", "sales") : null,
      shifts > 0 ? plural(shifts, "shift record", "shift records") : null,
    ].filter(Boolean);
    return {
      title: "Waiting to upload",
      text: `${parts.join(" and ") || "Nothing"} saved on this counter, waiting for the connection.`,
      footer:
        "Uploads start by themselves when this counter is back online. You don't need to retry a queued sale.",
    };
  }
  const cards = journal?.pause?.holds.cards ?? 0;
  const count = queue ? waiting.length : (journal?.waiting ?? 0);
  return {
    title: "Synchronising offline sales",
    text: `${count > 0 ? `${plural(count, "record", "records")} to send.` : "Every record is on the server."} ${
      cards > 0
        ? `${plural(cards, "card payment", "card payments")} still to be settled.`
        : "No unconfirmed card payments."
    }`,
    footer:
      "Checkout stays paused on this counter until this list is clear and a fresh stock snapshot is installed.",
  };
}

/** The word on an entry's chip, and its colour. */
export function entryStatus(
  entry: OfflineJournalEntry,
  mode: "list" | "last" = "list",
): { label: string; tone: Tone } {
  switch (entry.status) {
    case "queued":
      return { label: "Queued", tone: "neutral" };
    case "sending":
      return { label: "Sending", tone: "info" };
    case "refused":
      return { label: "Needs review", tone: "bad" };
    case "waiting":
      return { label: "Waiting", tone: "warn" };
    default:
      if (entry.stockReview)
        return { label: "Stock under review", tone: "warn" };
      if (entry.notHonoured)
        return { label: "Settled by a manager", tone: "neutral" };
      return {
        label: mode === "last" ? "Uploaded" : "Accepted",
        tone: "neutral",
      };
  }
}

export function entryTitle(entry: OfflineJournalEntry): string {
  const what =
    entry.kind === "sale"
      ? "Sale"
      : entry.kind === "shift_open"
        ? "Shift open"
        : "Shift close";
  return `${what} · journal #${entry.sequence}`;
}

/** The newest offline sale in the list: the one a cashier may still need to reprint. */
export function lastOfflineSale(
  queue: OfflineJournalQueue | null,
): OfflineJournalEntry | null {
  return queue?.entries.find((e) => e.kind === "sale") ?? null;
}

/**
 * The sale the banner over Sell shows: one whose stock is under review (`d-stock`), else the
 * newest offline sale.
 */
export function noticeSale(
  queue: OfflineJournalQueue | null,
): OfflineJournalEntry | null {
  return (
    queue?.entries.find((e) => e.kind === "sale" && e.stockReview) ??
    lastOfflineSale(queue)
  );
}

export type ReconnectNotice = {
  tone: Tone;
  title: string;
  text: string;
  /** Can be put away: the outage is over and nothing waits on anyone. */
  dismissible: boolean;
};

/** How long after a drain the "all accepted" banner stays on Sell, unless put away first. */
export const DRAIN_NOTICE_MS = 12 * 60 * 60_000;

/**
 * The banner over Sell (or inside the synchronisation block while new sales wait): `d-drain`,
 * `d-review`, `d-stock`, `d-clean`. Null when the counter has nothing to say about offline sales.
 */
export function reconnectNotice(
  journal: JournalSync | null,
  queue: OfflineJournalQueue | null,
  now = Date.now(),
): ReconnectNotice | null {
  if (!journal) return null;
  const entries = queue?.entries ?? [];
  const refused = refusedEntry(queue);
  if (refused || journal.refused > 0) {
    const stuck = entries.filter(
      (e) => e.status === "refused" || e.status === "waiting",
    );
    const sales = stuck.filter((e) => e.kind === "sale").length;
    const what =
      stuck.length === 0
        ? "An offline record needs"
        : sales === stuck.length
          ? `${plural(sales, "sale needs", "sales need")}`
          : `${plural(stuck.length, "offline record needs", "offline records need")}`;
    const which = refused
      ? `Entry ${refused.sequence}${refused.receiptNumber ? ` (receipt ${refused.receiptNumber})` : ""} was refused${
          refused.refusalCode ? ` (${refused.refusalCode})` : ""
        }.`
      : "The server refused an offline record.";
    return {
      tone: "warn",
      title: `${what} a manager review`,
      text: `${which} This counter keeps its sales and stays paused until a manager settles it on the web: nothing after it can be accepted until then. Other online counters can keep selling.`,
      dismissible: false,
    };
  }
  if (journal.pause) {
    const waiting = journal.pause.waiting;
    return {
      tone: "info",
      title: "Waiting to finish offline sales",
      text:
        waiting > 0
          ? `New sales on this counter pause until the ${plural(waiting, "saved record is", "saved records are")} accepted, any uncertain card payments are settled, and fresh stock is installed. Other online counters can keep selling.`
          : "The saved records are on the server. New sales on this counter pause until any uncertain card payments are settled and fresh stock is installed. Other online counters can keep selling.",
      dismissible: false,
    };
  }
  // The outage is over. Say so for a while after the drain, for the outage just finished.
  if (!journal.lastDrainAt) return null;
  if (now - Date.parse(journal.lastDrainAt) > DRAIN_NOTICE_MS) return null;
  const sales = entries.filter((e) => e.kind === "sale");
  if (sales.length === 0 || entries.some(unsent)) return null;
  const reviewed = sales.filter((e) => e.stockReview);
  if (reviewed.length > 0) {
    const receipts = reviewed
      .map((e) => e.receiptNumber)
      .filter(Boolean)
      .join(", ");
    return {
      tone: "warn",
      title: "All offline sales were accepted · Stock under review",
      text: `A manager is reviewing the stock for ${
        receipts ? `receipt ${receipts}` : "an offline sale"
      }. Checkout is open again; there's nothing to do at the counter.`,
      dismissible: true,
    };
  }
  const last = sales[0]!;
  return {
    tone: "ok",
    title: "All offline sales were accepted",
    text: `Fresh stock is installed. Checkout is open again.${
      last.receiptNumber ? ` Receipt ${last.receiptNumber} is unchanged.` : ""
    }`,
    dismissible: true,
  };
}

/**
 * Why the server block covers Sell (#212 note 4). The nominated counter switches to its offline
 * screen once the connection has been down for a few checks, and the online cart is not carried
 * over to it, so it must not promise "the sale on screen is kept".
 */
export function serverBlockReason(
  mode: OfflineModeState | null,
): { title: string; text: string } | null {
  const reason = cannotSellOffline(mode);
  if (reason) return reason;
  if (
    mode?.mode === "online" &&
    mode.grantExpiresAt &&
    mode.snapshotGeneratedAt
  )
    return {
      title: "The server can't be reached",
      text: "If the connection stays down, this counter switches to offline selling in a few seconds. The sale on screen isn't carried over: add its items again on the offline screen.",
    };
  return null;
}
