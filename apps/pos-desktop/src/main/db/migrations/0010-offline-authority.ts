import type { Migration } from "../migrator";

export const offlineAuthority: Migration = {
  version: 10,
  name: "offline-authority",
  up(db) {
    db.exec(`
      CREATE TABLE offline_authority (
        enrollment_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0),
        grant_envelope TEXT NOT NULL,
        snapshot_envelope TEXT NOT NULL
      );
      CREATE TABLE offline_authority_request (
        enrollment_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL
      );
    `);
  },
};
