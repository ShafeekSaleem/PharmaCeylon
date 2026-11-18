import type { SyncAcknowledgement } from "@pharmaceylon/shared";
import type {
  OfflineJournalEntry,
  OfflineJournalQueue,
} from "../../shared/ipc-contract";
import type { PosDatabase } from "../db/database";

/**
 * P4 #50, slice 4c: this counter's offline journal as the title bar's upload queue lists it
 * (`d-queue`, `d-drain`, `d-review`). Read from the local store alone, so it answers while
 * offline or locked, and never sent anywhere.
 *
 * Which entries: every one the server has not accepted yet, plus the rest of the latest outage
 * (the one the newest entry was written in), newest first. Earlier outages' accepted entries are
 * history, not a queue.
 *
 * Each entry's status:
 * - `accepted`: the server's signed acknowledgement is kept with it (`committed`, `duplicate`, or
 *   `reviewed` once a manager settled it). `stockReview` says the sale's stock waits on a
 *   manager's review (`pending_reconciliation`); the cashier is never told why (Q3).
 * - `refused`: refused for good (`sync_status = 'failed'`).
 * - `waiting`: behind a refused entry. The journal is an ordered hash chain, so nothing after a
 *   refused entry can be accepted until a manager settles it on the web (Q4, corrected).
 * - `sending` while the counter is connected, `queued` while it is not.
 */

/** The most entries the queue lists; the counter shows that more exist. */
export const QUEUE_LIMIT = 100;

type Row = {
  command_id: string;
  sequence: number;
  envelope_json: string;
  sync_status: "pending" | "synced" | "failed";
  acknowledgement_json: string | null;
  last_error_code: string | null;
  receipt_command_id: string | null;
};

type Payload = {
  kind?: unknown;
  occurredAt?: unknown;
  offlineSessionId?: unknown;
  receiptNumber?: unknown;
  totalMinor?: unknown;
};

function payloadOf(envelopeJson: string): Payload {
  try {
    const envelope = JSON.parse(envelopeJson) as { payload?: unknown };
    return typeof envelope.payload === "object" && envelope.payload !== null
      ? (envelope.payload as Payload)
      : {};
  } catch {
    return {};
  }
}

function ackOf(json: string | null): SyncAcknowledgement | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as SyncAcknowledgement;
  } catch {
    return null;
  }
}

const KINDS: Record<string, OfflineJournalEntry["kind"]> = {
  ordinary_sale: "sale",
  shift_open: "shift_open",
  shift_close: "shift_close",
};

export function readOfflineJournalQueue(
  db: PosDatabase,
  enrollmentId: string,
  options: { connected: boolean; limit?: number },
): OfflineJournalQueue {
  const limit = options.limit ?? QUEUE_LIMIT;
  const firstRefused = (
    db
      .prepare(
        "SELECT MIN(sequence) AS s FROM offline_journal_command WHERE enrollment_id = ? AND sync_status = 'failed'",
      )
      .get(enrollmentId) as { s: number | null }
  ).s;
  // One more than the limit, to know whether there are more.
  const rows = db
    .prepare(
      `SELECT c.command_id, c.sequence, c.envelope_json, c.sync_status, c.acknowledgement_json,
              c.last_error_code, r.command_id AS receipt_command_id
       FROM offline_journal_command c
       LEFT JOIN offline_sale_receipt r ON r.command_id = c.command_id
       WHERE c.enrollment_id = ?
       ORDER BY c.sequence DESC`,
    )
    .iterate(enrollmentId) as IterableIterator<Row>;

  const entries: OfflineJournalEntry[] = [];
  let latestOutage: unknown = undefined;
  let more = false;
  for (const row of rows) {
    const payload = payloadOf(row.envelope_json);
    if (latestOutage === undefined)
      latestOutage = payload.offlineSessionId ?? null;
    const unsent = row.sync_status !== "synced";
    if (!unsent && payload.offlineSessionId !== latestOutage) {
      // An accepted entry from an earlier outage. Everything before it is accepted too (the
      // watermark is contiguous), so nothing further down belongs in the queue.
      break;
    }
    if (entries.length === limit) {
      more = true;
      break;
    }
    const ack = ackOf(row.acknowledgement_json);
    const kind = KINDS[String(payload.kind)] ?? "sale";
    const status: OfflineJournalEntry["status"] =
      row.sync_status === "synced"
        ? "accepted"
        : row.sync_status === "failed"
          ? "refused"
          : firstRefused !== null && row.sequence > firstRefused
            ? "waiting"
            : options.connected
              ? "sending"
              : "queued";
    const occurredAt =
      typeof payload.occurredAt === "number" &&
      Number.isFinite(payload.occurredAt)
        ? new Date(payload.occurredAt).toISOString()
        : null;
    entries.push({
      commandId: row.command_id,
      sequence: row.sequence,
      kind,
      at: occurredAt,
      receiptNumber:
        kind === "sale" && typeof payload.receiptNumber === "string"
          ? payload.receiptNumber
          : null,
      totalMinor:
        kind === "sale" &&
        typeof payload.totalMinor === "number" &&
        Number.isSafeInteger(payload.totalMinor)
          ? payload.totalMinor
          : null,
      status,
      stockReview: Boolean(
        ack &&
        "stockPosting" in ack &&
        ack.stockPosting === "pending_reconciliation",
      ),
      notHonoured: Boolean(
        ack &&
        ack.status === "reviewed" &&
        "decision" in ack &&
        ack.decision === "not_honoured",
      ),
      refusalCode: status === "refused" ? row.last_error_code : null,
      printable: row.receipt_command_id !== null,
    });
  }
  return { entries, more };
}

/** Nothing to list: not enrolled, or the store isn't open. */
export const EMPTY_JOURNAL_QUEUE: OfflineJournalQueue = {
  entries: [],
  more: false,
};
