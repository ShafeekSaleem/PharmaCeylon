import type { PosDatabase } from "../db/database";

/**
 * Local tables that carry enrollment-scoped journal data. Used to ensure new journal tables are
 * registered when added (`offline-authority.spec.ts`). Whether they block installing a newer pair
 * is decided from the journal itself (`journalCoverage`), not from which tables hold rows.
 */
export const OFFLINE_USAGE_TABLES: readonly string[] = [
  "offline_journal_state",
  "offline_journal_staff_sign_in",
  "offline_journal_command",
  "offline_journal_batch_usage",
  "offline_journal_online_sale_record",
  "offline_support_record",
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

/**
 * P4 #50: support records (sale incidents, external-card attempt events) this computer has written
 * that the server does not yet hold: never acknowledged, or refused because the server already
 * holds other content under their ID. D12 resumes online checkout only when there are none.
 *
 * `received` counts as delivered even though the server keeps incidents and card events "for
 * review" and never marks them accepted: it holds the evidence, and a person checks it online.
 */
export function undeliveredSupportRecords(db: PosDatabase, enrollmentId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM offline_support_record WHERE enrollment_id = ? AND sync_status <> 'received'",
      )
      .get(enrollmentId) as { n: number }
  ).n;
}

/** Support records the server refused for good: it already holds other content under their ID. */
export function refusedSupportRecords(db: PosDatabase, enrollmentId: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM offline_support_record WHERE enrollment_id = ? AND sync_status = 'refused'",
      )
      .get(enrollmentId) as { n: number }
  ).n;
}

/**
 * External-card attempts whose latest event leaves the money unsettled: `prepared` and `uncertain`
 * (the charge may or may not have happened; the original card-machine result has to be checked)
 * and `approved` with no sale linked yet. `declined` and `linked_to_sale` are settled. D12 resumes
 * online checkout only when there are none.
 */
export function unresolvedCardAttempts(db: PosDatabase, enrollmentId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM offline_support_record r
         WHERE r.enrollment_id = ? AND r.kind = 'external_card_attempt'
           AND r.card_state IN ('prepared', 'uncertain', 'approved')
           AND r.rowid = (
             SELECT MAX(rowid) FROM offline_support_record
             WHERE enrollment_id = r.enrollment_id AND attempt_id = r.attempt_id
           )`,
      )
      .get(enrollmentId) as { n: number }
  ).n;
}
