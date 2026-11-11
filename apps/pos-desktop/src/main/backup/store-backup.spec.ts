import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../db/migrations";
import { DeviceStore } from "../device/device-store";
import { openLocalStore, type LocalStore } from "../local-store";
import { installOfflineAuthority } from "../terminal/offline-authority";
import {
  authority,
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
  it("backs up a counter's store at start, after journal changes, and hourly after other writes", () => {
    let clock = NOW;
    const report = jest.fn();
    // No counter yet: nothing is backed up, so an empty store never crowds out real backups.
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      report,
      now: () => clock,
      timer: false,
    });
    expect(listStoreBackups(backupsDir)).toHaveLength(0);

    seedDevice(local.db);
    expect(schedule.tick()?.manifest.reason).toBe("startup");
    clock += BACKUP_CHECK_MS;
    expect(schedule.tick()).toBeNull();

    const installed = authority(1, clock - 60_000);
    expect(installOfflineAuthority(local.db, installed, expected(clock))).toBe(
      "installed",
    );
    sellOffline(local.db, installed, 1, clock);
    clock += BACKUP_CHECK_MS;
    expect(schedule.tick()?.manifest.reason).toBe("journal_changed");

    local.db
      .prepare("UPDATE device_identity SET counter_label = 'Till 2'")
      .run();
    clock += BACKUP_CHECK_MS;
    expect(schedule.tick()).toBeNull();
    clock += BACKUP_MAX_AGE_MS;
    expect(schedule.tick()?.manifest).toMatchObject({
      reason: "scheduled",
      counterLabel: "Till 2",
    });
    clock += BACKUP_MAX_AGE_MS;
    expect(schedule.tick()).toBeNull();
    expect(report).not.toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toHaveLength(3);
  });

  it("reports a failed backup and keeps the till running", () => {
    seedDevice(local.db);
    const report = jest.fn();
    rmSync(local.keyPath);
    const schedule = startStoreBackups({
      db: local.db,
      keyPath: local.keyPath,
      backupsDir,
      protector: thisUser,
      appVersion: "1",
      report,
      timer: false,
    });
    expect(schedule.tick()).toBeNull();
    expect(report).toHaveBeenCalled();
    expect(listStoreBackups(backupsDir)).toEqual([]);
  });

  it("reports a store it cannot even read, at start and on every check, and never throws", () => {
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
        report,
        timer: false,
      });
    }).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
    expect(schedule!.tick()).toBeNull();
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[1]![0]).toMatchObject({ code: "SQLITE_IOERR" });
  });
});
