import type { Migration } from "../migrator";

/** Last live enrollment status from the server (till name and offline-backup facts) for offline restarts. */
export const enrollmentStatusCache: Migration = {
  version: 15,
  name: "enrollment-status-cache",
  up(db) {
    db.exec(`
      ALTER TABLE device_identity ADD COLUMN enrollment_status_fetched_at TEXT;
      ALTER TABLE device_identity ADD COLUMN enrollment_status_counter_label TEXT;
      ALTER TABLE device_identity ADD COLUMN enrollment_offline_backup_json TEXT;
      ALTER TABLE device_identity ADD COLUMN enrollment_status_enrollment_id TEXT;
    `);
  },
};
