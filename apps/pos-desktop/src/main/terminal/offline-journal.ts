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

/** Tables whose names say "offline" but record no offline use: authority itself. */
export const NOT_OFFLINE_USAGE = ["offline_authority", "offline_authority_request"] as const;

function hasRowInTable(db: PosDatabase, table: string, enrollmentId: string): boolean {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid offline usage table: ${table}`);
  return db.prepare(`SELECT 1 FROM ${table} WHERE enrollment_id = ? LIMIT 1`).get(enrollmentId) !== undefined;
}

/**
 * Whether this enrollment still has unreconciled **offline** journal evidence against the
 * installed authority pair. While true, a newer grant/snapshot may not replace the installed pair
 * (P5 must reconcile first).
 *
 * Online-only bookkeeping — consumption watermarks, per-sale dedupe rows, staff sign-in envelopes,
 * and idle journal state without an outage — does **not** block renewal. Appended offline journal
 * commands and an active offline outage session do.
 */
export function hasLocalOfflineUsage(
  db: PosDatabase,
  enrollmentId: string,
  tables?: readonly string[],
): boolean {
  if (tables) {
    return tables.some((table) => hasRowInTable(db, table, enrollmentId));
  }
  if (hasRowInTable(db, "offline_journal_command", enrollmentId)) return true;
  const outage = db
    .prepare(
      `SELECT 1 FROM offline_journal_state
       WHERE enrollment_id = ? AND offline_session_id IS NOT NULL
       LIMIT 1`,
    )
    .get(enrollmentId);
  return outage !== undefined;
}
