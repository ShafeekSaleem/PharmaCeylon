import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../db/migrations";
import { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import { installOfflineAuthority } from "../terminal/offline-authority";
import {
  authority,
  copyInThisThread,
  copyInWorker,
  expected,
  identity,
  NOW,
  seedDevice,
  seedPin,
  sellOffline,
  windowsUser,
} from "./backup.kit";
import {
  BACKUP_CHECK_MS,
  BACKUP_MAX_AGE_MS,
  backupsToKeep,
  KEEP_NEWEST,
  listStoreBackups,
  openCipherFile,
  readWrappedKey,
  sha256File,
  startStoreBackups,
  StoreBackupError,
  takeStoreBackup,
  takeStoreBackupOffThread,
  type StoreBackup,
} from "./store-backup";

/** P5 #51: backups of the counter's encrypted store (decisions of 2026-11-10). */

const thisUser = windowsUser("cashier-pc\\pos");
const otherUser = windowsUser("other-pc\\someone");

let root: string;
let dataDir: string;
let backupsDir: string;
let local: LocalStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pos-store-backup-"));
  dataDir = join(root, "data");
  backupsDir = join(root, "backups");
  local = openLocalStore(dataDir, thisUser, migrations);
});
afterEach(() => {
  local.db.close();
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

const backup = (now = NOW) =>
  takeStoreBackup(local.db, {
    keyPath: local.keyPath,
    backupsDir,
    protector: thisUser,
    appVersion: "1.2.3",
    reason: "scheduled",
    now: () => now,
  });

describe("a store backup", () => {
  it("is the whole store under a key of its own, with no PIN verifier, unreadable to anyone else", () => {
    seedDevice(local.db);
    seedPin(local.db);
    const installed = authority(1, NOW - 60_000);
    expect(installOfflineAuthority(local.db, installed, expected(NOW))).toBe(
      "installed",
    );
    const sold = sellOffline(local.db, installed, 2);

    const { dir, manifest } = backup();
    expect(manifest).toMatchObject({
      format: 1,
      reason: "scheduled",
      appVersion: "1.2.3",
      schemaVersion: migrations.length,
      enrollmentId: identity.enrollmentId,
      counterLabel: "Till 1",
      branchName: "Kandy",
      journalHead: { sequence: 2 },
      acceptedWatermark: { sequence: 0, hash: null },
      outageActive: true,
      sha256: sha256File(join(dir, "pos.db")),
    });
    expect(manifest.journalHead.hash).toHaveLength(64);

    // The store's own key does not open it: it has its own, wrapped for this Windows user only.
    const liveKey = readWrappedKey(local.keyPath, thisUser);
    expect(() => openCipherFile(join(dir, "pos.db"), liveKey)).toThrow(
      StoreBackupError,
    );
    expect(() => readWrappedKey(join(dir, "pos.db.key"), otherUser)).toThrow(
      /Windows user/,
    );
    const copy = openCipherFile(
      join(dir, "pos.db"),
      readWrappedKey(join(dir, "pos.db.key"), thisUser),
      { readonly: true },
    );
    try {
      // Everything a restore needs is there: the enrollment and its key, the journal, the pair.
      expect(new DeviceStore(copy).key()?.publicKeyHex).toBe(
        new DeviceStore(local.db).key()?.publicKeyHex,
      );
      const journal = copy
        .prepare(
          "SELECT command_id FROM offline_journal_command ORDER BY sequence",
        )
        .all();
      expect(journal).toEqual(
        sold.map((s) => ({ command_id: s.payload.commandId })),
      );
      expect(
        copy.prepare("SELECT version FROM offline_authority").get(),
      ).toEqual({ version: 1 });
      // No PIN verifier in any form; the live store keeps its own.
      expect(
        copy.prepare("SELECT COUNT(*) AS n FROM staff_credential").get(),
      ).toEqual({ n: 0 });
    } finally {
      copy.close();
    }
    expect(
      local.db.prepare("SELECT COUNT(*) AS n FROM staff_credential").get(),
    ).toEqual({ n: 1 });
    // Plain text never reaches the file: neither the SQLite header nor the counter's name.
    const bytes = readFileSync(join(dir, "pos.db"));
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("Kandy"))).toBe(false);
    expect(
      listStoreBackups(backupsDir).map((b) => b.manifest.backupId),
    ).toEqual([manifest.backupId]);
  });

  it("is listed only when whole: a partial folder or a broken manifest is skipped", () => {
    seedDevice(local.db);
    const { dir } = backup();
    const second = backup(NOW + 1_000);
    writeFileSync(join(second.dir, "backup.json"), "{");
    rmSync(join(dir, "pos.db.key"));
    expect(listStoreBackups(backupsDir)).toEqual([]);
  });
});

describe("keeping backups", () => {
  const at = (takenAt: number, i: number): StoreBackup => ({
    dir: "",
    manifest: {
      backupId: `b${String(i).padStart(4, "0")}`,
      takenAt,
    } as StoreBackup["manifest"],
  });

  it("keeps the newest twelve and the last of each of the past seven days", () => {
    const hour = 60 * 60_000;
    // One every hour for ten days, newest first.
    const backups = Array.from({ length: 240 }, (_, i) =>
      at(NOW - i * hour, 240 - i),
    );
    const keep = backupsToKeep(backups, NOW);
    for (const b of backups.slice(0, KEEP_NEWEST))
      expect(keep.has(b.manifest.backupId)).toBe(true);
    const days = new Set(
      backups
        .filter((b) => keep.has(b.manifest.backupId))
        .map((b) => new Date(b.manifest.takenAt).toISOString().slice(0, 10)),
    );
    expect(days.size).toBe(8); // today and the seven days before it
    expect(keep.size).toBeLessThan(KEEP_NEWEST + 8);
  });
});

describe("the backup schedule", () => {
  it("backs up a counter's store at start, after journal changes, and hourly after other writes", async () => {
    let clock = NOW;
    const report = jest.fn();
    // No counter yet: nothing is backed up, so an empty store never crowds out real backups.
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      runCopy: copyInThisThread,
      report,
      now: () => clock,
      timer: false,
    });
    await schedule.idle();
    expect(listStoreBackups(backupsDir)).toHaveLength(0);

    seedDevice(local.db);
    expect((await schedule.tick())?.manifest.reason).toBe("startup");
    clock += BACKUP_CHECK_MS;
    expect(await schedule.tick()).toBeNull();

    const installed = authority(1, clock - 60_000);
    expect(installOfflineAuthority(local.db, installed, expected(clock))).toBe(
      "installed",
    );
    sellOffline(local.db, installed, 1, clock);
    clock += BACKUP_CHECK_MS;
    expect((await schedule.tick())?.manifest.reason).toBe("journal_changed");

    local.db
      .prepare("UPDATE device_identity SET counter_label = 'Till 2'")
      .run();
    clock += BACKUP_CHECK_MS;
    expect(await schedule.tick()).toBeNull();
    clock += BACKUP_MAX_AGE_MS;
    expect((await schedule.tick())?.manifest).toMatchObject({
      reason: "scheduled",
      counterLabel: "Till 2",
    });
    clock += BACKUP_MAX_AGE_MS;
    expect(await schedule.tick()).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toHaveLength(3);
  });

  it("reports a failed backup and keeps the till running", async () => {
    seedDevice(local.db);
    const report = jest.fn();
    rmSync(local.keyPath);
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      runCopy: copyInThisThread,
      report,
      timer: false,
    });
    expect(await schedule.idle()).toBeNull();
    expect(await schedule.tick()).toBeNull();
    expect(report).toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toEqual([]);
  });

  it("reports a store it cannot even read, at start and on every check, and never throws", async () => {
    seedDevice(local.db);
    const report = jest.fn();
    // A failing disk: reading what the store holds throws before any backup starts.
    const failing = {
      prepare: () => {
        throw Object.assign(new Error("disk I/O error"), {
          code: "SQLITE_IOERR",
        });
      },
    } as unknown as LocalStore["db"];
    let schedule: ReturnType<typeof startStoreBackups> | undefined;
    expect(() => {
      schedule = startStoreBackups({
        db: failing,
        keyPath: local.keyPath,
        backupsDir,
        protector: thisUser,
        appVersion: "1",
        runCopy: copyInThisThread,
        report,
        timer: false,
      });
    }).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(await schedule!.tick()).toBeNull();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toMatchObject({ code: "SQLITE_IOERR" });
  });
});

describe("a backup off the main process (#166)", () => {
  // A worker thread starts by loading TypeScript through tsx here; the app loads built JS.
  jest.setTimeout(60_000);

  const offThread = (runCopy = copyInWorker) =>
    takeStoreBackupOffThread({
      storePath: local.databasePath,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1.2.3",
      reason: "journal_changed",
      runCopy,
      now: () => NOW,
    });

  /** Enough rows that copying them takes a moment (about 10 MB). */
  function fillStore(): void {
    const insert = local.db.prepare(
      "INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)",
    );
    local.db.transaction(() => {
      for (let i = 0; i < 5_000; i++)
        insert.run(`fill-${i}`, "x".repeat(2_000), new Date(NOW).toISOString());
    })();
  }

  it("writes a usable encrypted copy in a worker thread while the till keeps writing", async () => {
    seedDevice(local.db);
    seedPin(local.db);
    const installed = authority(1, NOW - 60_000);
    installOfflineAuthority(local.db, installed, expected(NOW));
    const sold = sellOffline(local.db, installed, 2);
    fillStore();

    const taking = offThread();
    let finished = false;
    void taking.result.finally(() => (finished = true));
    // The till's own connection writes while the worker copies: nothing waits, nothing fails.
    const write = local.db.prepare(
      "INSERT INTO app_meta (key, value, updated_at) VALUES (?, 'sale', ?)",
    );
    let writes = 0;
    while (!finished) {
      write.run(`during-${writes++}`, new Date(NOW).toISOString());
      await new Promise((resolve) => setImmediate(resolve));
    }
    const { dir, manifest } = await taking.result;
    expect(writes).toBeGreaterThan(1);
    expect(manifest).toMatchObject({
      reason: "journal_changed",
      enrollmentId: identity.enrollmentId,
      journalHead: { sequence: 2 },
      outageActive: true,
      sha256: sha256File(join(dir, "pos.db")),
    });
    expect(readdirSync(backupsDir)).toEqual([manifest.backupId]);

    // Under its own key, wrapped for this Windows user only; the store's key does not open it.
    const liveKey = readWrappedKey(local.keyPath, thisUser);
    expect(() => openCipherFile(join(dir, "pos.db"), liveKey)).toThrow(
      StoreBackupError,
    );
    const copy = openCipherFile(
      join(dir, "pos.db"),
      readWrappedKey(join(dir, "pos.db.key"), thisUser),
      { readonly: true },
    );
    try {
      expect(
        copy
          .prepare(
            "SELECT command_id FROM offline_journal_command ORDER BY sequence",
          )
          .all(),
      ).toEqual(sold.map((s) => ({ command_id: s.payload.commandId })));
      expect(
        copy.prepare("SELECT COUNT(*) AS n FROM staff_credential").get(),
      ).toEqual({ n: 0 });
      expect(copy.pragma("quick_check", { simple: true })).toBe("ok");
      // The same schema, object for object (tables, indexes, the append-only triggers), plus the
      // backup's own time.
      const schema = (db: typeof copy) =>
        db
          .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE name <> 'store_backup_meta' ORDER BY type, name",
          )
          .all();
      expect(schema(copy)).toEqual(schema(local.db));
      expect(
        copy
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'",
          )
          .get(),
      ).toEqual({ n: 6 });
    } finally {
      copy.close();
    }
    // Every write the till made while it ran is in the live store.
    expect(
      local.db
        .prepare("SELECT COUNT(*) AS n FROM app_meta WHERE key LIKE 'during-%'")
        .get(),
    ).toEqual({ n: writes });
    const bytes = readFileSync(join(dir, "pos.db"));
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("Kandy"))).toBe(false);
  });

  it("reports a copy that failed in the worker without either key, and leaves no partial folder", async () => {
    seedDevice(local.db);
    const liveKey = readWrappedKey(local.keyPath, thisUser);
    rmSync(local.databasePath + "-missing", { force: true });
    const taking = takeStoreBackupOffThread({
      storePath: local.databasePath + "-missing",
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      reason: "scheduled",
      runCopy: copyInWorker,
    });
    const error = (await taking.result.catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: "SQLITE_CANTOPEN" });
    expect(String(error.message)).not.toContain(liveKey);
    expect(JSON.stringify(error)).not.toContain(liveKey);
    expect(readdirSync(backupsDir)).toEqual([]);
  });

  it("is abandoned when the app stops, without a report, and its partial folder is pruned later", async () => {
    seedDevice(local.db);
    fillStore();
    const report = jest.fn();
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      runCopy: copyInWorker,
      report,
      timer: false,
    });
    schedule.stop();
    expect(await schedule.idle()).toBeNull();
    expect(await schedule.tick()).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toEqual([]);
    // Whatever the stopped worker left is a partial folder, never a listed backup.
    for (const name of existsSync(backupsDir) ? readdirSync(backupsDir) : [])
      expect(name.startsWith(".partial-")).toBe(true);
  });

  it("runs one backup at a time: a check while one runs skips", async () => {
    seedDevice(local.db);
    const report = jest.fn();
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      runCopy: copyInWorker,
      report,
      timer: false,
    });
    const startup = schedule.idle();
    expect(await schedule.tick()).toBeNull();
    expect((await startup)?.manifest.reason).toBe("startup");
    expect(report).not.toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toHaveLength(1);
    schedule.stop();
  });
});
