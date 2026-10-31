import type { Migration } from "../migrator";

/**
 * A reviewed checkout is written here before it is sent, keyed by the idempotency key the server
 * sees. A crash, timeout or lost response leaves it `uncertain`; resending the identical request
 * returns the original sale instead of charging or deducting twice.
 */
export const checkoutDrafts: Migration = {
  version: 4,
  name: "checkout-drafts",
  up(db) {
    db.exec(`
      CREATE TABLE checkout_draft (
        id              TEXT PRIMARY KEY,
        work_session_id TEXT NOT NULL,
        staff_user_id   TEXT NOT NULL,
        request_json    TEXT NOT NULL,
        total_minor     INTEGER NOT NULL CHECK (total_minor >= 0),
        status          TEXT NOT NULL CHECK (status IN ('submitted', 'completed', 'uncertain', 'refused')),
        sale_id         TEXT,
        invoice_no      TEXT,
        error_code      TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      ) STRICT, WITHOUT ROWID
    `);
    db.exec(
      "CREATE INDEX checkout_draft_status ON checkout_draft (status, created_at)",
    );
  },
};
