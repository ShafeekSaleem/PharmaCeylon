import type { Migration } from "../migrator";

/**
 * P2b #103: this counter's copy of its till shifts (D7b's work sessions), and the cash postings
 * behind its own running expected-cash figure.
 *
 * A shift row is written before the server is asked: `opening` before an open is sent, `closing`
 * (with the count and the close's command ID) before a close is sent. So a restart mid-close finds
 * the close still here and resends it under the same command ID, which the server replays. `sync`
 * says whether the server has confirmed the latest step. No PIN is ever stored.
 *
 * The running figure moves only with a posting row, in one SQLite transaction keyed by the sale or
 * refund, so a confirmed resend of the same sale can't count its cash twice.
 */
export const tillShifts: Migration = {
  version: 11,
  name: "till-shifts",
  up(db) {
    db.exec(`
      CREATE TABLE till_shift (
        work_session_id                  TEXT PRIMARY KEY,
        shift_number                     TEXT,
        enrollment_id                    TEXT NOT NULL,
        branch_id                        TEXT NOT NULL,
        till_id                          TEXT,
        staff_user_id                    TEXT NOT NULL,
        staff_name                       TEXT NOT NULL,
        opened_at                        TEXT NOT NULL,
        opening_cash_minor               INTEGER NOT NULL CHECK (opening_cash_minor >= 0),
        opening_count_json               TEXT NOT NULL,
        previous_closed_work_session_id  TEXT,
        state                            TEXT NOT NULL CHECK (state IN ('opening', 'open', 'closing', 'closed')),
        expected_cash_minor              INTEGER NOT NULL,
        close_command_id                 TEXT UNIQUE,
        closing_cash_count_minor         INTEGER CHECK (closing_cash_count_minor >= 0),
        closing_count_json               TEXT,
        counter_expected_at_close_minor  INTEGER,
        variance_note                    TEXT,
        assistance_reason                TEXT,
        closed_by_user_id                TEXT,
        closed_by_name                   TEXT,
        closed_at                        TEXT,
        server_expected_cash_minor       INTEGER,
        variance_minor                   INTEGER,
        sync                             TEXT NOT NULL CHECK (sync IN ('pending', 'synced', 'failed')),
        error_code                       TEXT,
        error_message                    TEXT,
        summary_json                     TEXT,
        summary_at                       TEXT,
        updated_at                       TEXT NOT NULL,
        CHECK ((state = 'closing' OR state = 'closed') = (close_command_id IS NOT NULL))
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX till_shift_by_state ON till_shift (enrollment_id, state, opened_at);

      CREATE TABLE till_shift_posting (
        id               TEXT PRIMARY KEY,
        work_session_id  TEXT NOT NULL REFERENCES till_shift (work_session_id),
        kind             TEXT NOT NULL CHECK (kind IN ('sale', 'refund')),
        cash_in_minor    INTEGER NOT NULL CHECK (cash_in_minor >= 0),
        change_minor     INTEGER NOT NULL CHECK (change_minor >= 0),
        cash_out_minor   INTEGER NOT NULL CHECK (cash_out_minor >= 0),
        at               TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
  },
};
