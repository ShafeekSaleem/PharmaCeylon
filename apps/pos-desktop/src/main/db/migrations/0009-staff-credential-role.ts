import type { Migration } from "../migrator";

/**
 * The role a prepared person holds at this counter's branch, kept for the lock screen's staff
 * list. Display only: the server decides what anyone may do, at sign-in and on every request.
 */
export const staffCredentialRole: Migration = {
  version: 9,
  name: "staff-credential-role",
  up(db) {
    db.exec("ALTER TABLE staff_credential ADD COLUMN role TEXT");
  },
};
