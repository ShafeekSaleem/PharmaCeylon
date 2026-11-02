import type { Migration } from "../migrator";

/**
 * Signed online commands (P1 executor) this counter has sent. The signed envelope and its
 * attendance proof are kept until a receipt or a definite refusal, so a lost response is resolved
 * by resending the identical bytes, which the server answers with the original receipt.
 */
export const signedCommands: Migration = {
  version: 5,
  name: "signed-commands",
  up(db) {
    db.exec(`
      CREATE TABLE signed_command (
        command_id          TEXT PRIMARY KEY,
        operation           TEXT NOT NULL,
        staff_user_id       TEXT NOT NULL,
        envelope_json       TEXT NOT NULL,
        attendance_proof_id TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('sent', 'receipted', 'uncertain', 'refused')),
        receipt_json        TEXT,
        error_code          TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL
      ) STRICT, WITHOUT ROWID
    `);
  },
};
