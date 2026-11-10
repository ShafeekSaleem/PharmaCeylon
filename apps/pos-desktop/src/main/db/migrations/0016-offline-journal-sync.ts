import type { Migration } from "../migrator";

/**
 * P5 #51: uploading the offline journal (P4's `offline_journal_command`) and finishing the
 * reconnect drain.
 *
 * Each journal entry keeps the server's signed acknowledgement once it is accepted, or the code of
 * the last refusal while it waits (`held`) or after it was refused for good (`rejected`, then
 * `sync_status = 'failed'`). Nothing is deleted: an accepted entry stays as local evidence.
 *
 * `offline_journal_sync` is per enrollment: the server-confirmed watermark (the highest
 * contiguous accepted sequence and its hash, from a signed response or a rebased snapshot), when
 * the server last confirmed the whole local journal, what is stopping that now, and the last
 * outage whose drain finished.
 */
export const offlineJournalSync: Migration = {
  version: 16,
  name: "offline-journal-sync",
  up(db) {
    db.exec(`
      ALTER TABLE offline_journal_command ADD COLUMN acknowledgement_json TEXT;
      ALTER TABLE offline_journal_command ADD COLUMN acknowledged_at TEXT;
      ALTER TABLE offline_journal_command ADD COLUMN last_error_code TEXT;

      CREATE TABLE offline_journal_sync (
        enrollment_id              TEXT PRIMARY KEY,
        accepted_through_sequence  INTEGER NOT NULL DEFAULT 0 CHECK (accepted_through_sequence >= 0),
        accepted_through_hash      TEXT CHECK (accepted_through_hash IS NULL OR length(accepted_through_hash) = 64),
        last_attempt_at            TEXT,
        last_success_at            TEXT,
        issue_code                 TEXT,
        issue_message              TEXT,
        issue_sequence             INTEGER,
        issue_at                   TEXT,
        drained_outage_id          TEXT,
        drained_outage_started_at  INTEGER,
        drained_at                 TEXT,
        updated_at                 TEXT NOT NULL,
        CHECK ((accepted_through_sequence = 0) = (accepted_through_hash IS NULL))
      ) STRICT;
    `);
  },
};
