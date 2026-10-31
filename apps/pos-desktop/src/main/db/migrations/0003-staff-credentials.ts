import type { Migration } from "../migrator";

/**
 * D-W5: this counter's own PIN verifiers, one per prepared person, bound to the server's PIN
 * version. Made only after the server confirmed the PIN here while online; never copied from or
 * to another device. Failed attempts persist so a restart does not reset the throttle.
 */
export const staffCredentials: Migration = {
  version: 3,
  name: "staff-credentials",
  up(db) {
    db.exec(`
      CREATE TABLE staff_credential (
        staff_user_id   TEXT PRIMARY KEY,
        staff_name      TEXT NOT NULL,
        enrollment_id   TEXT NOT NULL,
        pin_version     INTEGER NOT NULL CHECK (pin_version > 0),
        salt            BLOB NOT NULL,
        verifier        BLOB NOT NULL,
        prepared_at     TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        locked_until    TEXT
      ) STRICT, WITHOUT ROWID
    `);
  },
};
