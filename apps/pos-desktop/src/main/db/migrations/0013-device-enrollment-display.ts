import type { Migration } from "../migrator";

/** Snapshot branch code and enroller display name at/after enrollment for This counter metadata. */
export const deviceEnrollmentDisplay: Migration = {
  version: 13,
  name: "device-enrollment-display",
  up(db) {
    db.exec(`
      ALTER TABLE device_identity ADD COLUMN branch_code TEXT NOT NULL DEFAULT '';
      ALTER TABLE device_identity ADD COLUMN enrolled_by_name TEXT;
    `);
  },
};
