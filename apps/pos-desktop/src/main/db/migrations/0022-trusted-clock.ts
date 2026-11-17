import type { Migration } from "../migrator";

/**
 * P4 #50: the counter's trusted clock. One row: the latest server-signed time this computer
 * received (a fresh offline-authority snapshot's `generatedAt`, or a verified journal sync reply's
 * `serverTime`), with Windows uptime at that moment and the boot it belongs to. Offline time is
 * that server time plus uptime elapsed since — never the Windows clock alone (POS_V1_CONTRACT,
 * "Trusted time"). `high_water_ms` is the latest trusted time handed out, so time never runs back.
 *
 * Decision of 2026-11-17: uptime restarts with Windows, so after a reboot or power cut there is
 * no trusted time until the counter is online again.
 *
 * `outage_reconnect` is also here: the outage state machine (`offline-mode.ts`) needs both.
 */
export const trustedClock: Migration = {
  version: 22,
  name: "trusted-clock",
  up(db) {
    db.exec(`
      CREATE TABLE trusted_clock_anchor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        server_time_ms INTEGER NOT NULL,
        uptime_ms INTEGER NOT NULL,
        boot_wall_ms INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('snapshot', 'sync_response')),
        high_water_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- The outage whose reconnect has held steady: from then on it is draining (D12) and never
      -- sells offline again, a dropped connection or an app restart included. The row names the
      -- outage it belongs to, so the next outage starts without one.
      CREATE TABLE outage_reconnect (
        enrollment_id TEXT PRIMARY KEY,
        offline_session_id TEXT NOT NULL,
        reconnected_at TEXT NOT NULL
      );
    `);
  },
};
