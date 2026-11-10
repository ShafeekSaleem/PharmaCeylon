import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretProtector } from "../key-store";
import { currentSchemaVersion } from "../migrator";
import { openLocalStore } from "../../local-store";
import { migrations } from "./index";

const protector: SecretProtector = {
  isAvailable: () => true,
  protect: (p) => Buffer.from(p),
  unprotect: (b) => b.toString(),
};

/** Matches PR #136 at version 13 (`device-enrollment-display`) before journal tables land at 14. */
const migrationsThroughPr136 = migrations.filter((m) => m.version <= 13);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-migrations-offline-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("offline journal migrations with PR #136", () => {
  it("applies a fresh database through the latest version with device-enrollment-display at 13", () => {
    const store = openLocalStore(dir, protector, migrations);
    expect(store.schemaVersion).toBe(migrations.length);
    expect(
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'offline_journal%' ORDER BY name",
        )
        .all()
        .map((r) => (r as { name: string }).name),
    ).toEqual([
      "offline_journal_batch_usage",
      "offline_journal_command",
      "offline_journal_online_sale_record",
      "offline_journal_recovery",
      "offline_journal_set_aside",
      "offline_journal_staff_sign_in",
      "offline_journal_state",
      "offline_journal_sync",
    ]);
    const cols = store.db
      .prepare("PRAGMA table_info(offline_journal_batch_usage)")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["snapshot_id", "snapshot_version", "batch_id", "qty_sold"]),
    );
    store.db.close();
  });

  it("upgrades from PR #136 schema v13 through the journal migrations", () => {
    const first = openLocalStore(dir, protector, migrationsThroughPr136);
    expect(first.schemaVersion).toBe(13);
    expect(
      first.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_journal_state'")
        .get(),
    ).toBeUndefined();
    first.db.close();

    const second = openLocalStore(dir, protector, migrations);
    expect(second.schemaVersion).toBe(migrations.length);
    expect(currentSchemaVersion(second.db)).toBe(migrations.length);
    second.db.close();
  });

  it("upgrades a v15 journal through the sync migration (v16) with its entries still waiting to upload (P5 #51)", () => {
    const first = openLocalStore(dir, protector, migrations.filter((m) => m.version <= 15));
    first.db
      .prepare(
        `INSERT INTO offline_journal_command (
          command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status, created_at
        ) VALUES ('c1', 'e1', 1, NULL, ?, '{}', 'pending', '2026-11-10T00:00:00.000Z')`,
      )
      .run("a".repeat(64));
    first.db.close();

    const second = openLocalStore(dir, protector, migrations);
    expect(second.schemaVersion).toBe(migrations.length);
    expect(second.db.prepare("SELECT sync_status, acknowledgement_json, last_error_code FROM offline_journal_command").get())
      .toEqual({ sync_status: "pending", acknowledgement_json: null, last_error_code: null });
    // The watermark and its hash are set together, or not at all.
    expect(() =>
      second.db
        .prepare("INSERT INTO offline_journal_sync (enrollment_id, accepted_through_sequence, updated_at) VALUES ('e1', 3, 'x')")
        .run(),
    ).toThrow(/CHECK/);
    second.db.close();
  });

  it("upgrades a v16 journal through the recovery migration (v17), nothing set aside (P5 #51, D11)", () => {
    const first = openLocalStore(dir, protector, migrations.filter((m) => m.version <= 16));
    first.db
      .prepare(
        `INSERT INTO offline_journal_command (
          command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status, created_at
        ) VALUES ('c1', 'e1', 1, NULL, ?, '{}', 'synced', '2026-11-10T00:00:00.000Z')`,
      )
      .run("a".repeat(64));
    first.db.close();

    const second = openLocalStore(dir, protector, migrations);
    expect(second.schemaVersion).toBe(migrations.length);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM offline_journal_command").get()).toEqual({ n: 1 });
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM offline_journal_set_aside").get()).toEqual({ n: 0 });
    // A recovery the server has not answered has no server ID; an applied one has its completion.
    expect(() =>
      second.db
        .prepare(
          `INSERT INTO offline_journal_recovery (enrollment_id, report_id, report_envelope, status, server_head_sequence,
             common_sequence, local_head_sequence, updated_at) VALUES ('e1', 'r1', '{}', 'awaiting_approval', 2, 1, 1, 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      second.db
        .prepare(
          `INSERT INTO offline_journal_recovery (enrollment_id, report_id, report_envelope, recovery_id, status,
             server_head_sequence, common_sequence, local_head_sequence, updated_at)
           VALUES ('e1', 'r1', '{}', 'x', 'applied', 2, 1, 1, 'x')`,
        )
        .run(),
    ).toThrow(/CHECK/);
    second.db.close();
  });

  it("upgrades a v17 store through the store-restore migration (v18): no restore recorded, records kept (P5 #51)", () => {
    const first = openLocalStore(dir, protector, migrations.filter((m) => m.version <= 17));
    first.db.close();

    const second = openLocalStore(dir, protector, migrations);
    expect(second.schemaVersion).toBe(18);
    expect(second.db.prepare("SELECT COUNT(*) AS n FROM store_restore").get()).toEqual({ n: 0 });
    const insert = (status: string, acknowledged: boolean) =>
      second.db
        .prepare(
          `INSERT INTO store_restore (restore_id, enrollment_id, backup_id, backup_taken_at, restored_at,
             journal_head_sequence, accepted_sequence, outage_active, report_envelope, status, updated_at,
             latest_grant_version, acknowledged_at)
           VALUES (?, 'e1', 'b1', 1, 2, 0, 0, 0, '{}', ?, 'x', ?, ?)`,
        )
        .run(`r-${status}-${acknowledged}`, status, acknowledged ? 3 : null, acknowledged ? "x" : null);
    // Acknowledged needs the server's latest version and the time; reporting needs neither.
    expect(() => insert("acknowledged", false)).toThrow(/CHECK/);
    insert("reporting", false);
    insert("acknowledged", true);
    expect(() => second.db.prepare("DELETE FROM store_restore").run()).toThrow(/kept/);
    expect(() => second.db.prepare("UPDATE store_restore SET report_envelope = 'other'").run()).toThrow(/keeps/);
    second.db.close();
  });
});
