import type { Migration } from "../migrator";

/**
 * P5 #51: this counter's store was restored from one of its own backups (decisions of
 * 2026-11-10). Written by the restore, in the same transaction that removes the restored offline
 * authority, and never deleted.
 *
 * The restored store is what the computer held when the backup was taken. Anything it recorded
 * after that and never uploaded is gone from it, so the restore is reported to the server
 * (`report_envelope`, device-signed at restore and resent unchanged until answered) and offline
 * selling stays off here until:
 *
 * 1. the owner or a delegated manager acknowledges it in the back office (`acknowledged`), and
 * 2. a pair the server issued after that is installed (`cleared`, in the install's transaction).
 *
 * `latest_grant_version` is the highest version the server had issued this enrollment when it
 * answered: no pair at or below it is installed again.
 */
export const storeRestore: Migration = {
  version: 18,
  name: "store-restore",
  up(db) {
    db.exec(`
      CREATE TABLE store_restore (
        restore_id              TEXT PRIMARY KEY,
        enrollment_id           TEXT NOT NULL,
        backup_id               TEXT NOT NULL,
        backup_taken_at         INTEGER NOT NULL,
        restored_at             INTEGER NOT NULL,
        journal_head_sequence   INTEGER NOT NULL CHECK (journal_head_sequence >= 0),
        journal_head_hash       TEXT,
        accepted_sequence       INTEGER NOT NULL CHECK (accepted_sequence >= 0),
        accepted_hash           TEXT,
        outage_active           INTEGER NOT NULL CHECK (outage_active IN (0, 1)),
        removed_grant_version   INTEGER,
        set_aside_path          TEXT,
        report_envelope         TEXT NOT NULL,
        status                  TEXT NOT NULL
          CHECK (status IN ('reporting', 'awaiting_acknowledgement', 'acknowledged', 'cleared')),
        latest_grant_version    INTEGER CHECK (latest_grant_version >= 0),
        acknowledged_at         TEXT,
        cleared_at              TEXT,
        updated_at              TEXT NOT NULL,
        CHECK ((status IN ('acknowledged', 'cleared')) = (acknowledged_at IS NOT NULL)),
        CHECK ((status = 'cleared') = (cleared_at IS NOT NULL)),
        CHECK (status = 'reporting' OR latest_grant_version IS NOT NULL)
      ) STRICT;
      CREATE INDEX store_restore_enrollment ON store_restore (enrollment_id, status);

      CREATE TRIGGER store_restore_kept BEFORE DELETE ON store_restore
      BEGIN SELECT RAISE(ABORT, 'store restore records are kept'); END;
      CREATE TRIGGER store_restore_fixed BEFORE UPDATE ON store_restore
      WHEN NEW.restore_id IS NOT OLD.restore_id OR NEW.enrollment_id IS NOT OLD.enrollment_id
        OR NEW.backup_id IS NOT OLD.backup_id OR NEW.report_envelope IS NOT OLD.report_envelope
        OR NEW.journal_head_sequence IS NOT OLD.journal_head_sequence
        OR NEW.journal_head_hash IS NOT OLD.journal_head_hash
      BEGIN SELECT RAISE(ABORT, 'a store restore keeps what it reported'); END;
    `);
  },
};
