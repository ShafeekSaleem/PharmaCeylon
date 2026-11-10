import type { Migration } from "../migrator";

/**
 * P5 #51, approved D11: recovering a journal the server says is not its own (`JOURNAL_MISMATCH`:
 * a restored backup, a damaged journal).
 *
 * `offline_journal_recovery` is the counter's side of its current recovery: the signed report it
 * sent (resent unchanged until the server answers, so a lost reply never opens a second
 * recovery), the server's recovery ID and status, and — once applied — the signed completion it
 * confirms with. One row per enrollment; a later recovery replaces it.
 *
 * `offline_journal_set_aside` keeps every local entry the server never accepted, exactly as it
 * was in `offline_journal_command`, once an approved recovery moves the journal onto the server's
 * chain. Nothing is ever deleted from it: those entries are evidence of sales the server holds
 * only as evidence too, never as sales.
 */
export const offlineJournalRecovery: Migration = {
  version: 17,
  name: "offline-journal-recovery",
  up(db) {
    db.exec(`
      CREATE TABLE offline_journal_recovery (
        enrollment_id         TEXT PRIMARY KEY,
        report_id             TEXT NOT NULL,
        report_envelope       TEXT NOT NULL,
        recovery_id           TEXT,
        status                TEXT NOT NULL
          CHECK (status IN ('reporting', 'awaiting_approval', 'approved', 'applied', 'recovered')),
        server_head_sequence  INTEGER NOT NULL CHECK (server_head_sequence >= 0),
        server_head_hash      TEXT,
        common_sequence       INTEGER NOT NULL CHECK (common_sequence >= 0),
        common_hash           TEXT,
        local_head_sequence   INTEGER NOT NULL CHECK (local_head_sequence >= 0),
        local_head_hash       TEXT,
        completion_envelope   TEXT,
        applied_at            TEXT,
        completed_at          TEXT,
        updated_at            TEXT NOT NULL,
        CHECK ((status IN ('applied', 'recovered')) = (completion_envelope IS NOT NULL)),
        CHECK (status = 'reporting' OR recovery_id IS NOT NULL)
      ) STRICT;

      CREATE TABLE offline_journal_set_aside (
        command_id            TEXT NOT NULL,
        enrollment_id         TEXT NOT NULL,
        recovery_id           TEXT NOT NULL,
        report_id             TEXT NOT NULL,
        sequence              INTEGER NOT NULL CHECK (sequence >= 1),
        previous_hash         TEXT,
        payload_hash          TEXT NOT NULL CHECK (length(payload_hash) = 64),
        envelope_json         TEXT NOT NULL,
        sync_status           TEXT NOT NULL,
        acknowledgement_json  TEXT,
        last_error_code       TEXT,
        created_at            TEXT NOT NULL,
        set_aside_at          TEXT NOT NULL,
        PRIMARY KEY (enrollment_id, recovery_id, command_id)
      ) STRICT;
      CREATE INDEX offline_journal_set_aside_enrollment ON offline_journal_set_aside (enrollment_id, recovery_id, sequence);

      CREATE TRIGGER offline_journal_set_aside_kept BEFORE DELETE ON offline_journal_set_aside
      BEGIN SELECT RAISE(ABORT, 'set-aside journal entries are kept'); END;
      CREATE TRIGGER offline_journal_set_aside_fixed BEFORE UPDATE ON offline_journal_set_aside
      BEGIN SELECT RAISE(ABORT, 'set-aside journal entries are kept'); END;
    `);
  },
};
