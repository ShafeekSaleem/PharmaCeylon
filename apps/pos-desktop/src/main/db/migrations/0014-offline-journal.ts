import type { Migration } from "../migrator";

/**
 * P4 #50: durable offline journal producer (PR #137). Version 14 follows PR #136's 0013
 * device-enrollment-display. Batch usage is scoped to snapshot id/version; online sales are
 * recorded idempotently by sale id.
 */
export const offlineJournal: Migration = {
  version: 14,
  name: "offline-journal",
  up(db) {
    db.exec(`
      CREATE TABLE offline_journal_state (
        enrollment_id              TEXT PRIMARY KEY,
        journal_last_sequence      INTEGER NOT NULL DEFAULT 0 CHECK (journal_last_sequence >= 0),
        journal_last_hash          TEXT CHECK (journal_last_hash IS NULL OR length(journal_last_hash) = 64),
        offline_session_id         TEXT,
        offline_started_at         INTEGER CHECK (offline_started_at IS NULL OR offline_started_at >= 0),
        active_staff_sign_in_id    TEXT,
        active_staff_envelope_json TEXT,
        updated_at                 TEXT NOT NULL
      ) STRICT;

      CREATE TABLE offline_journal_staff_sign_in (
        staff_sign_in_id  TEXT PRIMARY KEY,
        enrollment_id     TEXT NOT NULL,
        envelope_json     TEXT NOT NULL,
        created_at        TEXT NOT NULL
      ) STRICT;
      CREATE INDEX offline_journal_staff_sign_in_enrollment ON offline_journal_staff_sign_in (enrollment_id);

      CREATE TABLE offline_journal_command (
        command_id        TEXT PRIMARY KEY,
        enrollment_id     TEXT NOT NULL,
        sequence          INTEGER NOT NULL CHECK (sequence >= 1),
        previous_hash     TEXT CHECK (previous_hash IS NULL OR length(previous_hash) = 64),
        payload_hash      TEXT NOT NULL CHECK (length(payload_hash) = 64),
        envelope_json     TEXT NOT NULL,
        sync_status       TEXT NOT NULL CHECK (sync_status IN ('pending', 'synced', 'failed')),
        created_at        TEXT NOT NULL,
        UNIQUE (enrollment_id, sequence)
      ) STRICT;
      CREATE INDEX offline_journal_command_enrollment_seq ON offline_journal_command (enrollment_id, sequence);

      CREATE TABLE offline_journal_batch_usage (
        enrollment_id      TEXT NOT NULL,
        snapshot_id          TEXT NOT NULL,
        snapshot_version     INTEGER NOT NULL CHECK (snapshot_version >= 1),
        batch_id             TEXT NOT NULL,
        qty_sold             INTEGER NOT NULL CHECK (qty_sold >= 0),
        PRIMARY KEY (enrollment_id, snapshot_id, snapshot_version, batch_id)
      ) STRICT;

      CREATE TABLE offline_journal_online_sale_record (
        enrollment_id TEXT NOT NULL,
        sale_id       TEXT NOT NULL,
        created_at    TEXT NOT NULL,
        PRIMARY KEY (enrollment_id, sale_id)
      ) STRICT;
      CREATE INDEX offline_journal_online_sale_enrollment ON offline_journal_online_sale_record (enrollment_id);
    `);
  },
};
