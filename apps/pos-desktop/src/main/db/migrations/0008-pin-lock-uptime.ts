import type { Migration } from "../migrator";

/**
 * Local PIN lockouts measured in app uptime instead of a wall-clock deadline (a clock change
 * could end one), and a count of lockouts so repeated guessing waits longer each time.
 */
export const pinLockUptime: Migration = {
  version: 8,
  name: "pin-lock-uptime",
  up(db) {
    db.exec(
      "ALTER TABLE staff_credential ADD COLUMN lock_remaining_ms INTEGER NOT NULL DEFAULT 0 CHECK (lock_remaining_ms >= 0)",
    );
    db.exec(
      "ALTER TABLE staff_credential ADD COLUMN lockouts INTEGER NOT NULL DEFAULT 0 CHECK (lockouts >= 0)",
    );
  },
};
