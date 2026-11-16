import type { Migration } from "../migrator";

/**
 * P5 #51 / #165: whether the restored backup's time was bounded by something inside the encrypted
 * copy (its `store_backup_meta` row or a journal entry). A copy from before the meta row with an
 * empty journal has only its editable `backup.json` time, and the counter says so on the restore
 * card. Earlier restores were all signed with a bounded or manifest time that was never flagged;
 * they keep the default (verified), as they were shown before.
 */
export const storeRestoreTimeVerified: Migration = {
  version: 21,
  name: "store-restore-time-verified",
  up(db) {
    db.exec(`
      ALTER TABLE store_restore ADD COLUMN backup_time_verified INTEGER NOT NULL DEFAULT 1
        CHECK (backup_time_verified IN (0, 1));

      DROP TRIGGER store_restore_fixed;
      CREATE TRIGGER store_restore_fixed BEFORE UPDATE ON store_restore
      WHEN NEW.restore_id IS NOT OLD.restore_id OR NEW.enrollment_id IS NOT OLD.enrollment_id
        OR NEW.backup_id IS NOT OLD.backup_id OR NEW.report_envelope IS NOT OLD.report_envelope
        OR NEW.journal_head_sequence IS NOT OLD.journal_head_sequence
        OR NEW.journal_head_hash IS NOT OLD.journal_head_hash
        OR NEW.backup_time_verified IS NOT OLD.backup_time_verified
      BEGIN SELECT RAISE(ABORT, 'a store restore keeps what it reported'); END;
    `);
  },
};
