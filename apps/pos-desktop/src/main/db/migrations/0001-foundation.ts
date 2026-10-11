import type { Migration } from "../migrator";

export const foundation: Migration = {
  version: 1,
  name: "foundation",
  up(db) {
    db.exec(`
      CREATE TABLE app_meta (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT, WITHOUT ROWID
    `);
  },
};
