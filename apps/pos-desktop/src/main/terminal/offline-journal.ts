import type { PosDatabase } from "../db/database";

/**
 * Local tables that carry enrollment-scoped journal data. Used to ensure new journal tables are
 * registered when added (`offline-authority.spec.ts`). Not every table here blocks authority
 * renewal — see `hasLocalOfflineUsage`.
 */
export const OFFLINE_USAGE_TABLES: readonly string[] = [
  "offline_journal_state",
  "offline_journal_staff_sign_in",
  "offline_journal_command",
  "offline_journal_batch_usage",
  "offline_journal_online_sale_record",
];

/**
 * Tables whose names say "offline" but record no offline use: authority itself, P5's upload
 * bookkeeping (the server-confirmed watermark and the last drain), which only ever describes the
 * journal tables above, and D11's journal recovery: its state, and the entries a recovery set
 * aside, which the server already holds as evidence and which never become journal entries again.
 */
export const NOT_OFFLINE_USAGE = [
  "offline_authority",
  "offline_authority_request",
  "offline_journal_sync",
  "offline_journal_recovery",
  "offline_journal_set_aside",
] as const;

function hasRowInTable(db: PosDatabase, table: string, enrollmentId: string): boolean {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid offline usage table: ${table}`);
  return db.prepare(`SELECT 1 FROM ${table} WHERE enrollment_id = ? LIMIT 1`).get(enrollmentId) !== undefined;
}

/** A journal position: a sequence and the hash of the entry at it (null at 0, the empty journal). */
export type JournalPosition = { sequence: number; hash: string | null };

/** The last entry of this enrollment's local journal (P4's `offline_journal_command`). */
export function localJournalHead(db: PosDatabase, enrollmentId: string): JournalPosition {
  const row = db
    .prepare(
      `SELECT sequence, payload_hash FROM offline_journal_command
       WHERE enrollment_id = ? ORDER BY sequence DESC LIMIT 1`,
    )
    .get(enrollmentId) as { sequence: number; payload_hash: string } | undefined;
  return row ? { sequence: row.sequence, hash: row.payload_hash } : { sequence: 0, hash: null };
}

/** The local entry's hash at `sequence` (null at 0); undefined when this computer has none there. */
export function localJournalHashAt(db: PosDatabase, enrollmentId: string, sequence: number): string | null | undefined {
  if (sequence === 0) return null;
  const row = db
    .prepare("SELECT payload_hash FROM offline_journal_command WHERE enrollment_id = ? AND sequence = ?")
    .get(enrollmentId, sequence) as { payload_hash: string } | undefined;
  return row?.payload_hash;
}

/**
 * How a server-signed watermark (a snapshot's `includedThrough…`, a sync response's
 * `committedThrough…`) relates to this computer's journal. The journal is a hash chain, so a
 * watermark that names an entry's exact hash includes every entry before it.
 *
 * - `covered`: it names the local head, so the server has every entry recorded here.
 * - `behind`: it names an earlier local entry; later ones are still to be accepted.
 * - `mismatch`: it names an entry this computer doesn't have, or one with other content. The
 *   server holds offline records from this enrollment that this computer has lost (a restored
 *   backup, a damaged journal) or never wrote. Never install or resume on it.
 */
export type JournalCoverage = "covered" | "behind" | "mismatch";

export function journalCoverage(
  db: PosDatabase,
  enrollmentId: string,
  watermark: JournalPosition,
): JournalCoverage {
  if (!Number.isSafeInteger(watermark.sequence) || watermark.sequence < 0) return "mismatch";
  const local = localJournalHashAt(db, enrollmentId, watermark.sequence);
  if (local === undefined || local !== watermark.hash) return "mismatch";
  return watermark.sequence === localJournalHead(db, enrollmentId).sequence ? "covered" : "behind";
}

/** The outage P4 started and P5's drain has not finished yet, if any. */
export function activeOutage(
  db: PosDatabase,
  enrollmentId: string,
): { offlineSessionId: string; offlineStartedAt: number } | null {
  const row = db
    .prepare(
      `SELECT offline_session_id, offline_started_at FROM offline_journal_state
       WHERE enrollment_id = ? AND offline_session_id IS NOT NULL`,
    )
    .get(enrollmentId) as { offline_session_id: string; offline_started_at: number | null } | undefined;
  return row ? { offlineSessionId: row.offline_session_id, offlineStartedAt: row.offline_started_at ?? 0 } : null;
}

/** The journal watermark of the installed snapshot, read directly (no import cycle with offline-authority). */
function installedWatermark(db: PosDatabase, enrollmentId: string): number | null {
  const row = db.prepare("SELECT snapshot_envelope FROM offline_authority WHERE enrollment_id = ?").get(enrollmentId) as
    | { snapshot_envelope: string }
    | undefined;
  if (!row) return null;
  const sequence = (JSON.parse(row.snapshot_envelope) as { payload?: { includedThroughSequence?: unknown } }).payload
    ?.includedThroughSequence;
  return typeof sequence === "number" ? sequence : null;
}

/**
 * Whether this enrollment holds offline journal evidence that the installed authority does not
 * include yet: an outage whose drain has not finished, or journal entries past the installed
 * snapshot's watermark. While true the counter is not reconciled with the server (P5 #51).
 *
 * Online-only bookkeeping — consumption watermarks, per-sale dedupe rows, staff sign-in envelopes
 * and idle journal state — never counts. Accepted entries the installed snapshot was rebased over
 * don't either: they stay on this computer as evidence.
 *
 * Renewal itself no longer uses this as a veto: the rebasing installer compares the new pair's
 * own watermark with the local journal (`journalCoverage`), and installing a pair that covers it
 * is how a drain finishes.
 */
export function hasLocalOfflineUsage(
  db: PosDatabase,
  enrollmentId: string,
  tables?: readonly string[],
): boolean {
  if (tables) {
    return tables.some((table) => hasRowInTable(db, table, enrollmentId));
  }
  if (activeOutage(db, enrollmentId)) return true;
  const head = localJournalHead(db, enrollmentId);
  if (head.sequence === 0) return false;
  const watermark = installedWatermark(db, enrollmentId);
  return watermark === null || watermark < head.sequence;
}
