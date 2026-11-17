import type { Migration } from "../migrator";

/**
 * P4 #50: till shifts opened or closed offline (D7b). They live in `till_shift` beside online ones,
 * so the Cash & shift page shows one list, but their open or close is a signed journal entry,
 * not a request to the server: these columns name that entry. The server learns of it through the
 * journal upload (P5), so the online refresh leaves such a row alone until the server has it.
 */
export const offlineTillShifts: Migration = {
  version: 23,
  name: "offline-till-shifts",
  up(db) {
    db.exec(`
      ALTER TABLE till_shift ADD COLUMN journal_open_command_id TEXT;
      ALTER TABLE till_shift ADD COLUMN journal_close_command_id TEXT;
      CREATE UNIQUE INDEX till_shift_journal_open ON till_shift (journal_open_command_id)
        WHERE journal_open_command_id IS NOT NULL;
      CREATE UNIQUE INDEX till_shift_journal_close ON till_shift (journal_close_command_id)
        WHERE journal_close_command_id IS NOT NULL;
    `);
  },
};
