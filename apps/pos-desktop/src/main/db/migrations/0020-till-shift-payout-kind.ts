import type { Migration } from "../migrator";

/** Supplier cash payouts leave the drawer like refunds, but with their own posting kind. */
export const tillShiftPayoutKind: Migration = {
  version: 20,
  name: "till-shift-payout-kind",
  up(db) {
    db.exec(`
      CREATE TABLE till_shift_posting_new (
        id               TEXT PRIMARY KEY,
        work_session_id  TEXT NOT NULL REFERENCES till_shift (work_session_id),
        kind             TEXT NOT NULL CHECK (kind IN ('sale', 'refund', 'payout')),
        cash_in_minor    INTEGER NOT NULL CHECK (cash_in_minor >= 0),
        change_minor     INTEGER NOT NULL CHECK (change_minor >= 0),
        cash_out_minor   INTEGER NOT NULL CHECK (cash_out_minor >= 0),
        at               TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      INSERT INTO till_shift_posting_new SELECT * FROM till_shift_posting;
      DROP TABLE till_shift_posting;
      ALTER TABLE till_shift_posting_new RENAME TO till_shift_posting;
    `);
  },
};