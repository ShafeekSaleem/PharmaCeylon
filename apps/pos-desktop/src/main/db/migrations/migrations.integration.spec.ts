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
  it("applies a fresh database through v15 with device-enrollment-display at 13", () => {
    const store = openLocalStore(dir, protector, migrations);
    expect(store.schemaVersion).toBe(15);
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
      "offline_journal_staff_sign_in",
      "offline_journal_state",
    ]);
    const cols = store.db
      .prepare("PRAGMA table_info(offline_journal_batch_usage)")
      .all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining(["snapshot_id", "snapshot_version", "batch_id", "qty_sold"]),
    );
    store.db.close();
  });

  it("upgrades from PR #136 schema v13 to journal v14 only", () => {
    const first = openLocalStore(dir, protector, migrationsThroughPr136);
    expect(first.schemaVersion).toBe(13);
    expect(
      first.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='offline_journal_state'")
        .get(),
    ).toBeUndefined();
    first.db.close();

    const second = openLocalStore(dir, protector, migrations);
    expect(second.schemaVersion).toBe(15);
    expect(currentSchemaVersion(second.db)).toBe(15);
    second.db.close();
  });
});
