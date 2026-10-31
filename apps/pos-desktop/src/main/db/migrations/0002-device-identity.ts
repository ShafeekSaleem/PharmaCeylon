import type { Migration } from "../migrator";

/**
 * The counter's enrollment. At most one row. `pending` is written before the server is asked
 * to finish enrolling, so a crash or lost response never strands a server-side enrollment whose
 * private key this device has thrown away; the next sign-in asks the server how it ended.
 */
export const deviceIdentity: Migration = {
  version: 2,
  name: "device-identity",
  up(db) {
    db.exec(`
      CREATE TABLE device_identity (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        status              TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'retired')),
        api_base_url        TEXT NOT NULL,
        tenant_id           TEXT NOT NULL,
        branch_id           TEXT NOT NULL,
        branch_name         TEXT NOT NULL,
        terminal_id         TEXT NOT NULL,
        enrollment_id       TEXT NOT NULL,
        key_id              TEXT NOT NULL,
        register_id         TEXT NOT NULL,
        till_id             TEXT NOT NULL,
        counter_label       TEXT NOT NULL,
        label               TEXT NOT NULL,
        public_key_hex      TEXT NOT NULL CHECK (length(public_key_hex) = 64),
        private_key_pkcs8   BLOB NOT NULL,
        enrolled_by_user_id TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        enrolled_at         TEXT,
        status_checked_at   TEXT
      ) STRICT
    `);
    db.exec(`
      CREATE TABLE staff_session_log (
        work_session_id TEXT PRIMARY KEY,
        staff_user_id   TEXT NOT NULL,
        staff_name      TEXT NOT NULL,
        enrollment_id   TEXT NOT NULL,
        opened_at       TEXT NOT NULL,
        closed_at       TEXT,
        close_reason    TEXT
      ) STRICT
    `);
  },
};
