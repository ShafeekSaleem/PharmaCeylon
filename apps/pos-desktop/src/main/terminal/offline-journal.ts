import type { PosDatabase } from "../db/database";

/**
 * Local tables that record offline use of an installed authority pair: offline sales, shifts,
 * PIN sign-ins, D8 acknowledgements, support records, and the journal and outage state that
 * carries them to the server. Each has an `enrollment_id` column.
 *
 * Nothing sells offline yet, so the list is empty. **P4 adds every table it writes offline
 * here**, in the same change that creates it; `offline-journal.spec.ts` fails for a table with an
 * `offline_` or `journal` name that is not listed, so one cannot be forgotten.
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

/**
 * Whether this enrollment has used offline authority locally: any row in any offline usage
 * table, whether or not it has been uploaded. While it has, the installed pair is the baseline
 * that journal was written against, so a new version may not replace it until P5 reconciles
 * the journal and rebases the snapshot. Call inside the installer's transaction, so the check
 * and the replacement are one step against P4's writers.
 */
export function hasLocalOfflineUsage(
  db: PosDatabase,
  enrollmentId: string,
  tables: readonly string[] = OFFLINE_USAGE_TABLES,
): boolean {
  return tables.some((table) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid offline usage table: ${table}`);
    return db.prepare(`SELECT 1 FROM ${table} WHERE enrollment_id = ? LIMIT 1`).get(enrollmentId) !== undefined;
  });
}
