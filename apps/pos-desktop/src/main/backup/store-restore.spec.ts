import { createPublicKey, verify } from "node:crypto";
import fs, {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  terminalSigningText,
  type OfflineCounterRestoreReport,
  type Signed,
} from "@pharmaceylon/shared";
import { migrations } from "../db/migrations";
import { openLocalStore, type LocalStore } from "../local-store";
import {
  installOfflineAuthority,
  readInstalledOfflineAuthority,
} from "../terminal/offline-authority";
import { activeOutage, localJournalHead } from "../terminal/offline-journal";
import { readJournalSyncView } from "../terminal/offline-journal-sync";
import { OfflineJournalWriter } from "../terminal/offline-journal-writer";
import {
  checkoutSyncPause,
  recordAcceptedWatermark,
} from "../terminal/reconnect-drain";
import {
  createStoreRestoreSync,
  RESTORE_POLL_MS,
  restoresAwaitingAcknowledgement,
  storeRestoreBlocksOffline,
} from "../terminal/store-restore-sync";
import {
  authority,
  deviceKey,
  expected,
  identity,
  NOW,
  positionOf,
  seedDevice,
  seedPin,
  sellOffline,
  staff,
  windowsUser,
} from "./backup.kit";
import { openStoreAtStartup, type RestorePrompt } from "./startup-restore";
import {
  listStoreBackups,
  takeStoreBackup,
  type StoreBackup,
} from "./store-backup";
import {
  finishInterruptedRestore,
  liveStoreState,
  restoreStoreBackup,
  StoreRestoreError,
} from "./store-restore";

/**
 * P5 #51: restoring the counter's store from one of its own backups (decisions of 2026-11-10):
 * only over a broken or empty store, never reviving superseded offline authority, never resetting
 * the journal, and no offline selling until the back office acknowledges it and a pair issued
 * after that is installed.
 */

const thisUser = windowsUser("cashier-pc\\pos");
const otherUser = windowsUser("other-pc\\someone");

let root: string;
let dataDir: string;
let backupsDir: string;
let local: LocalStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pos-store-restore-"));
  dataDir = join(root, "data");
  backupsDir = join(root, "backups");
  local = openLocalStore(dataDir, thisUser, migrations);
  seedDevice(local.db);
  seedPin(local.db);
});
afterEach(() => {
  try {
    local.db.close();
  } catch {
    // already closed by the test
  }
  jest.restoreAllMocks();
  rmSync(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

function mkdtempSync(prefix: string): string {
  return fs.mkdtempSync(prefix);
}

const takeBackup = (now: number): StoreBackup =>
  takeStoreBackup(local.db, {
    keyPath: local.keyPath,
    backupsDir,
    protector: thisUser,
    appVersion: "1",
    reason: "scheduled",
    now: () => now,
  });

/** The store breaks the way a lost DPAPI key or a deleted key file breaks it. */
function breakStore(): void {
  local.db.close();
  rmSync(join(dataDir, "pos.db.key"));
}

function reopen(): LocalStore {
  local = openLocalStore(dataDir, thisUser, migrations);
  return local;
}

const journal = (db: LocalStore["db"]) =>
  db
    .prepare(
      "SELECT sequence, payload_hash, command_id FROM offline_journal_command ORDER BY sequence",
    )
    .all();

describe("who may restore, and over what", () => {
  it("never restores over a working store", () => {
    const backup = takeBackup(NOW);
    local.db.close();
    expect(liveStoreState(dataDir, thisUser)).toBe("working");
    expect(() =>
      restoreStoreBackup({ dataDir, backup, protector: thisUser, migrations }),
    ).toThrow(expect.objectContaining({ code: "STORE_IN_USE" }));
    // Nothing moved.
    expect(readdirSync(dataDir).sort()).toEqual(
      ["pos.db", "pos.db.key"].sort(),
    );
    reopen();
  });

  it("refuses a backup that changed, or that only another Windows user can open", () => {
    const backup = takeBackup(NOW);
    breakStore();
    expect(liveStoreState(dataDir, thisUser)).toBe("unusable");
    expect(() =>
      restoreStoreBackup({ dataDir, backup, protector: otherUser, migrations }),
    ).toThrow(expect.objectContaining({ code: "KEY_UNREADABLE" }));
    const file = join(backup.dir, "pos.db");
    const bytes = readFileSync(file);
    bytes.writeUInt8(bytes.readUInt8(bytes.length - 1) ^ 1, bytes.length - 1);
    writeFileSync(file, bytes);
    expect(() =>
      restoreStoreBackup({ dataDir, backup, protector: thisUser, migrations }),
    ).toThrow(expect.objectContaining({ code: "BACKUP_DAMAGED" }));
    expect(existsSync(join(dataDir, "pos.db"))).toBe(true);
    expect(existsSync(join(dataDir, "set-aside"))).toBe(false);
  });

  it("refuses a backup taken by a newer app", () => {
    const backup = takeBackup(NOW);
    breakStore();
    expect(() =>
      restoreStoreBackup({
        dataDir,
        backup,
        protector: thisUser,
        migrations: migrations.slice(0, 17),
      }),
    ).toThrow(expect.objectContaining({ code: "BACKUP_NEWER_THAN_APP" }));
  });
});

describe("restoring an older store against a server that has moved on", () => {
  /**
   * The backup holds pair v1 and two offline sales nobody had uploaded, plus a renewal request
   * whose answer was lost. After it was taken the original computer sold three more times,
   * uploaded all five (the server accepted them) and renewed to v3. Then its store broke.
   */
  function scenario() {
    const v1 = authority(1, NOW - 60_000);
    expect(installOfflineAuthority(local.db, v1, expected(NOW))).toBe(
      "installed",
    );
    const early = sellOffline(local.db, v1, 2);
    local.db
      .prepare(
        "INSERT INTO offline_authority_request (enrollment_id, request_id) VALUES (?, ?)",
      )
      .run(identity.enrollmentId, "11111111-1111-4111-8111-111111111111");
    const before = journal(local.db);
    const backup = takeBackup(NOW + 5_000);

    const late = sellOffline(local.db, v1, 3, NOW + 10_000);
    const serverHead = positionOf(late[2]!);
    recordAcceptedWatermark(
      local.db,
      identity.enrollmentId,
      serverHead,
      new Date(NOW + 20_000).toISOString(),
    );
    breakStore();
    return { v1, early, late, before, backup, serverHead };
  }

  it("keeps the journal and every other record, removes the old authority and PINs, and records the restore", () => {
    const { before, backup } = scenario();
    const applied = restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    expect(applied).toMatchObject({
      enrollmentId: identity.enrollmentId,
      journalHead: { sequence: 2 },
      removedGrantVersion: 1,
    });

    // The broken store is kept for support, never deleted.
    const setAside = readdirSync(join(dataDir, "set-aside"));
    expect(setAside).toHaveLength(1);
    expect(existsSync(join(dataDir, "set-aside", setAside[0]!, "pos.db"))).toBe(
      true,
    );
    // The backup is still a backup.
    expect(listStoreBackups(backupsDir)).toHaveLength(1);

    const { db } = reopen();
    // The journal is the backup's, sequence and hashes unchanged: nothing reset, nothing renumbered.
    expect(journal(db)).toEqual(before);
    expect(localJournalHead(db, identity.enrollmentId).sequence).toBe(2);
    // No offline authority from before, and no request that could replay a superseded version.
    expect(readInstalledOfflineAuthority(db, identity.enrollmentId)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM offline_authority_request").get(),
    ).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM offline_journal_batch_usage").get(),
    ).toEqual({ n: 0 });
    // No PIN verifier and no staff session from the backup.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM staff_credential").get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT close_reason FROM staff_session_log WHERE work_session_id = ?",
        )
        .get(staff.workSessionId),
    ).toEqual({
      close_reason: "restored",
    });

    // The restore, device-signed, ready to report.
    const row = db.prepare("SELECT * FROM store_restore").get() as {
      report_envelope: string;
      status: string;
      set_aside_path: string;
    };
    expect(row.status).toBe("reporting");
    expect(row.set_aside_path).toBe(join("set-aside", setAside[0]!));
    const envelope = JSON.parse(
      row.report_envelope,
    ) as Signed<OfflineCounterRestoreReport>;
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(deviceKey.publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        null,
        Buffer.from(terminalSigningText("command", envelope.payload)),
        publicKey,
        Buffer.from(envelope.signature, "base64url"),
      ),
    ).toBe(true);
    expect(envelope.payload).toMatchObject({
      kind: "offline_counter_restore_report",
      identity,
      backupId: backup.manifest.backupId,
      backupTakenAt: NOW + 5_000,
      restoredAt: NOW + 60_000,
      journalHead: { sequence: 2 },
      acceptedWatermark: { sequence: 0, hash: null },
      outageActive: true,
      removedGrantVersion: 1,
    });
  });

  it("sells nothing offline, not even in the backup's own outage, and installs nothing until acknowledged", () => {
    const { backup, serverHead } = scenario();
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    const { db } = reopen();
    const writer = new OfflineJournalWriter({
      db,
      now: () => new Date(NOW + 61_000),
    });
    // The backup was taken mid-outage; it is still "active" in the store, and still refused.
    expect(activeOutage(db, identity.enrollmentId)).not.toBeNull();
    expect(() =>
      writer.ensureOfflineOutageSession(identity.enrollmentId, NOW + 61_000),
    ).toThrow("RECONCILIATION_REQUIRED");
    expect(storeRestoreBlocksOffline(db, identity.enrollmentId)).toBe(true);
    expect(readJournalSyncView(db, identity.enrollmentId).issue).toMatchObject({
      code: "STORE_RESTORED",
    });
    // So online checkout stays paused by that outage's drain (D12), which ends only with a fresh
    // pair: a backup taken mid-outage sells nothing at all until the restore is acknowledged.
    expect(checkoutSyncPause(db, identity.enrollmentId)).toMatchObject({
      reason: "draining",
    });
    // Even an authentic fresh pair waits for the back office.
    expect(
      installOfflineAuthority(
        db,
        authority(4, NOW + 60_000, localJournalHead(db, identity.enrollmentId)),
        expected(NOW + 61_000),
      ),
    ).toBe("restore_unacknowledged");
    // A pair rebased over the server's journal names entries this computer lost: D11's recovery.
    expect(
      installOfflineAuthority(
        db,
        authority(4, NOW + 60_000, serverHead),
        expected(NOW + 61_000),
      ),
    ).toBe("restore_unacknowledged");
  });

  it("reports once, waits for the back office, then refuses every pair at or below the server's latest version", async () => {
    const { backup, serverHead } = scenario();
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    const { db } = reopen();
    let clock = NOW + 61_000;
    let acknowledged = false;
    const received: Array<{ path: string; body: unknown }> = [];
    const api = {
      request: jest.fn(
        async (
          _method: string,
          path: string,
          init: { body: Record<string, unknown> },
        ) => {
          received.push({ path, body: init.body });
          const report = path.endsWith("/report")
            ? (init.body.report as Signed<OfflineCounterRestoreReport>)
            : null;
          const restoreId =
            report?.payload.restoreId ?? (init.body.restoreId as string);
          return acknowledged
            ? {
                restoreId,
                status: "acknowledged",
                acknowledgedAt: clock - 1_000,
                latestGrantVersion: 3,
              }
            : {
                restoreId,
                status: "awaiting_acknowledgement",
                acknowledgedAt: null,
                latestGrantVersion: 3,
              };
        },
      ),
    };
    const sync = createStoreRestoreSync({
      db,
      api: api as never,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
      report: jest.fn(),
      now: () => clock,
    });
    expect(await sync.tick()).toBe("waiting");
    expect(received.map((r) => r.path)).toEqual([
      "/terminals/offline-journal/restore/report",
    ]);
    const sent = (received[0]!.body as { report: unknown }).report;
    expect(sent).toEqual(
      JSON.parse(
        (
          db.prepare("SELECT report_envelope FROM store_restore").get() as {
            report_envelope: string;
          }
        ).report_envelope,
      ),
    );
    expect(
      restoresAwaitingAcknowledgement(db, identity.enrollmentId)[0],
    ).toMatchObject({
      status: "awaiting_acknowledgement",
      latestGrantVersion: 3,
    });
    expect(await sync.tick()).toBe("waiting");
    expect(received).toHaveLength(1);

    clock += RESTORE_POLL_MS;
    acknowledged = true;
    expect(await sync.tick()).toBe("acknowledged");
    expect(received[1]!.path).toBe("/terminals/offline-journal/restore/status");
    expect(restoresAwaitingAcknowledgement(db, identity.enrollmentId)).toEqual(
      [],
    );
    expect(readJournalSyncView(db, identity.enrollmentId).issue).toBeNull();
    // Acknowledged, but still no offline selling until a pair issued since is installed.
    expect(storeRestoreBlocksOffline(db, identity.enrollmentId)).toBe(true);

    const head = localJournalHead(db, identity.enrollmentId);
    // v2 and v3 were issued while the backup was all this computer had: superseded, never installed.
    for (const version of [1, 2, 3])
      expect(
        installOfflineAuthority(
          db,
          authority(version, clock - 1_000, head),
          expected(clock),
        ),
      ).toBe("superseded");
    // The server moved on: a pair rebased over its journal names entries this computer lost.
    expect(
      installOfflineAuthority(
        db,
        authority(4, clock - 1_000, serverHead),
        expected(clock),
      ),
    ).toBe("journal_mismatch");
    expect(readInstalledOfflineAuthority(db, identity.enrollmentId)).toBeNull();
    expect(await sync.tick()).toBe("none");
  });
});

describe("a restore that lost nothing", () => {
  it("clears once acknowledged and a fresh pair is installed, and the next outage continues the chain", async () => {
    const v1 = authority(1, NOW - 60_000);
    expect(installOfflineAuthority(local.db, v1, expected(NOW))).toBe(
      "installed",
    );
    const sold = sellOffline(local.db, v1, 2);
    const backup = takeBackup(NOW + 5_000);
    breakStore();
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    const { db } = reopen();
    db.prepare(
      "UPDATE store_restore SET status = 'acknowledged', latest_grant_version = 1, acknowledged_at = ?, updated_at = ?",
    ).run(new Date(NOW + 90_000).toISOString(), "x");

    // The server accepted both sales and rebased v2 over them: installing it ends the outage too.
    const clock = NOW + 120_000;
    const fresh = authority(2, clock - 1_000, positionOf(sold[1]!));
    expect(installOfflineAuthority(db, fresh, expected(clock))).toBe(
      "installed",
    );
    expect(storeRestoreBlocksOffline(db, identity.enrollmentId)).toBe(false);
    expect(
      (
        db.prepare("SELECT status FROM store_restore").get() as {
          status: string;
        }
      ).status,
    ).toBe("cleared");
    expect(activeOutage(db, identity.enrollmentId)).toBeNull();
    expect(checkoutSyncPause(db, identity.enrollmentId)).toBeNull();
    const next = sellOffline(db, fresh, 1, clock);
    expect(next[0]!.payload).toMatchObject({
      sequence: 3,
      previousCommandHash: positionOf(sold[1]!).hash,
    });
  });
});

describe("restoring at start-up", () => {
  const prompt = (choose: "first" | "none" = "first") => {
    const p = {
      afterFailure: jest.fn((_e: unknown, backups: readonly StoreBackup[]) =>
        choose === "first" ? backups[0]! : null,
      ),
      forEmptyStore: jest.fn((backups: readonly StoreBackup[]) =>
        choose === "first" ? backups[0]! : null,
      ),
    };
    return p satisfies RestorePrompt;
  };
  const start = (p: RestorePrompt, list = migrations) =>
    openStoreAtStartup({
      dataDir,
      backupsDir,
      protector: thisUser,
      migrations: list,
      appVersion: "1",
      prompt: p,
      report: jest.fn(),
    });

  it("offers the backups when the store cannot be opened, and opens the restored one next time", () => {
    takeBackup(NOW);
    breakStore();
    const p = prompt();
    const first = start(p);
    expect(first.kind).toBe("restored");
    expect(p.afterFailure).toHaveBeenCalledTimes(1);
    const second = start(prompt());
    expect(second.kind).toBe("open");
    if (second.kind === "open") {
      local = second.store;
      expect(storeRestoreBlocksOffline(local.db, identity.enrollmentId)).toBe(
        true,
      );
    }
  });

  it("offers the backups when the data folder was emptied, and carries on as new if declined", () => {
    takeBackup(NOW);
    local.db.close();
    rmSync(dataDir, { recursive: true, force: true });
    const declined = prompt("none");
    const outcome = start(declined);
    expect(declined.forEmptyStore).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("open");
    if (outcome.kind === "open") outcome.store.db.close();
    const accepted = prompt();
    expect(start(accepted).kind).toBe("restored");
    const opened = start(prompt());
    expect(opened.kind).toBe("open");
    if (opened.kind === "open") local = opened.store;
  });

  it("never offers a restore over a store that holds a counter this app cannot open", () => {
    takeBackup(NOW);
    local.db.close();
    const p = prompt();
    const outcome = start(p, migrations.slice(0, 17));
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(p.afterFailure).not.toHaveBeenCalled();
    reopen();
  });

  it("finishes a restore interrupted after it began replacing the store", () => {
    const backup = takeBackup(NOW);
    breakStore();
    const real = fs.renameSync;
    let moves = 0;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // The power goes after the old store moved aside and the key moved in.
      if (
        String(from).endsWith(join("restore-staging", "pos.db")) &&
        ++moves === 1
      )
        throw new Error("power cut");
      real(from, to);
    });
    expect(() =>
      restoreStoreBackup({ dataDir, backup, protector: thisUser, migrations }),
    ).toThrow(
      expect.objectContaining({
        code: "RESTORE_INTERRUPTED",
        cause: expect.objectContaining({ message: "power cut" }),
      }),
    );
    expect(existsSync(join(dataDir, "pos.db"))).toBe(false);
    jest.restoreAllMocks();
    expect(finishInterruptedRestore(dataDir)).toBe("finished");
    const { db } = reopen();
    expect(
      restoresAwaitingAcknowledgement(db, identity.enrollmentId),
    ).toHaveLength(1);
    expect(existsSync(join(dataDir, "restore-staging"))).toBe(false);
  });

  it("drops a restore interrupted before it touched the store", () => {
    local.db.close();
    mkdirSync(join(dataDir, "restore-staging"));
    writeFileSync(join(dataDir, "restore-staging", "pos.db"), "partial");
    expect(finishInterruptedRestore(dataDir)).toBe("discarded");
    expect(liveStoreState(dataDir, thisUser)).toBe("working");
    reopen();
  });

  it("drops an intent cut off before it was committed: the swap never started", () => {
    local.db.close();
    mkdirSync(join(dataDir, "restore-staging"));
    writeFileSync(join(dataDir, "restore-staging", "pos.db"), "staged");
    // The power went while the intent's temporary file was being written.
    writeFileSync(join(dataDir, "restore.json.tmp"), '{"restoreId":"a1');
    expect(finishInterruptedRestore(dataDir)).toBe("discarded");
    expect(readdirSync(dataDir).sort()).toEqual(["pos.db", "pos.db.key"]);
    expect(liveStoreState(dataDir, thisUser)).toBe("working");
    reopen();
  });

  it("shows an error, and opens nothing, when an interrupted restore's record is damaged", () => {
    takeBackup(NOW);
    local.db.close();
    writeFileSync(join(dataDir, "restore.json"), '{"restoreId":"a1b2c3d4-');
    const p = prompt();
    const outcome = start(p);
    expect(outcome).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ code: "RESTORE_INTERRUPTED" }),
    });
    expect(p.afterFailure).not.toHaveBeenCalled();
    expect(p.forEmptyStore).not.toHaveBeenCalled();
    expect(() => finishInterruptedRestore(dataDir)).toThrow(
      expect.objectContaining({ code: "RESTORE_INTERRUPTED" }),
    );
    // Nothing was moved or opened on a guess.
    expect(readdirSync(dataDir).sort()).toEqual(
      ["pos.db", "pos.db.key", "restore.json"].sort(),
    );
    rmSync(join(dataDir, "restore.json"));
    reopen();
  });

  const busy = () =>
    Object.assign(new Error("EBUSY: resource busy or locked, rename"), {
      code: "EBUSY",
    });

  it("waits out a file held for a moment while it replaces the store", () => {
    const backup = takeBackup(NOW);
    breakStore();
    const real = fs.renameSync;
    let held = 2;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      // Antivirus scans the restored file just written, twice.
      if (
        String(from).endsWith(join("restore-staging", "pos.db")) &&
        held-- > 0
      )
        throw busy();
      real(from, to);
    });
    restoreStoreBackup({ dataDir, backup, protector: thisUser, migrations });
    expect(held).toBe(-1);
    jest.restoreAllMocks();
    const { db } = reopen();
    expect(
      restoresAwaitingAcknowledgement(db, identity.enrollmentId),
    ).toHaveLength(1);
  });

  it("opens nothing when a held file stops the swap, and finishes it at the next start", () => {
    const backup = takeBackup(NOW);
    local.db.close();
    // The data folder was emptied; the person restores at start-up.
    rmSync(dataDir, { recursive: true, force: true });
    const real = fs.renameSync;
    jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(join("restore-staging", "pos.db")))
        throw busy();
      real(from, to);
    });
    const report = jest.fn();
    const outcome = openStoreAtStartup({
      dataDir,
      backupsDir,
      protector: thisUser,
      migrations,
      appVersion: "1",
      prompt: prompt(),
      report,
    });
    expect(outcome).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ code: "RESTORE_INTERRUPTED" }),
    });
    expect(report).toHaveBeenCalledWith(
      "store_restore.failed",
      expect.anything(),
    );
    // No new store was created under the restored key: the intent and the staged store wait.
    expect(existsSync(join(dataDir, "pos.db"))).toBe(false);
    expect(existsSync(join(dataDir, "restore.json"))).toBe(true);
    expect(existsSync(join(dataDir, "restore-staging", "pos.db"))).toBe(true);

    // Next start, the file is free: the restore finishes before anything opens the store.
    jest.restoreAllMocks();
    const next = start(prompt("none"));
    expect(next.kind).toBe("open");
    if (next.kind === "open") {
      local = next.store;
      expect(
        restoresAwaitingAcknowledgement(local.db, identity.enrollmentId),
      ).toHaveLength(1);
      expect(localJournalHead(local.db, identity.enrollmentId)).toEqual(
        backup.manifest.journalHead,
      );
    }
  });

  it("never restores over a store that is only busy, and says why it cannot start", () => {
    takeBackup(NOW);
    local.db.close();
    const real = fs.readFileSync;
    jest.spyOn(fs, "readFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      // Roaming-profile sync holds the key file at logon.
      if (String(path).endsWith("pos.db.key")) throw busy();
      return real(path, options as never);
    }) as typeof fs.readFileSync);
    expect(() => liveStoreState(dataDir, thisUser)).toThrow(/EBUSY/);
    const p = prompt();
    expect(start(p)).toMatchObject({ kind: "failed" });
    expect(p.afterFailure).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(liveStoreState(dataDir, thisUser)).toBe("working");
    expect(existsSync(join(dataDir, "set-aside"))).toBe(false);
    reopen();
  });
});

describe("backup time in the encrypted copy", () => {
  it("uses the in-copy time when backup.json was edited to date the backup later", () => {
    const backup = takeBackup(NOW);
    const manifestPath = join(backup.dir, "backup.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      takenAt: number;
    };
    manifest.takenAt = NOW + 24 * 60 * 60_000;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    breakStore();
    restoreStoreBackup({
      dataDir,
      backup: { dir: backup.dir, manifest: { ...backup.manifest, ...manifest } },
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    const { db } = reopen();
    const signed = JSON.parse(
      (db.prepare("SELECT report_envelope FROM store_restore").get() as {
        report_envelope: string;
      }).report_envelope,
    ) as Signed<OfflineCounterRestoreReport>;
    expect(signed.payload.backupTakenAt).toBe(NOW);
    expect(signed.payload.backupTakenAt).toBeLessThan(manifest.takenAt);
    db.close();
  });
});

describe("a computer whose clock is wrong", () => {
  it("still restores when its clock is behind the backup, and reports both times as they are", () => {
    const backup = takeBackup(NOW);
    breakStore();
    // A dead CMOS battery: the computer believes it is 1 January 2000.
    const resetClock = Date.UTC(2000, 0, 1);
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => resetClock,
    });
    const { db } = reopen();
    const { report_envelope } = db
      .prepare("SELECT report_envelope FROM store_restore")
      .get() as { report_envelope: string };
    const signed = JSON.parse(
      report_envelope,
    ) as Signed<OfflineCounterRestoreReport>;
    // The server records the disagreement and shows it; the counter never hides it.
    expect(signed.payload).toMatchObject({
      backupTakenAt: NOW,
      restoredAt: resetClock,
    });
    expect(signed.payload.backupTakenAt).toBeGreaterThan(
      signed.payload.restoredAt,
    );
    expect(storeRestoreBlocksOffline(db, identity.enrollmentId)).toBe(true);

    // Restored again at the very same (reset) time: each restore sets its store aside in a folder
    // of its own, so the first one set aside is never moved over.
    db.close();
    rmSync(join(dataDir, "pos.db.key"));
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => resetClock,
    });
    const asides = readdirSync(join(dataDir, "set-aside"));
    expect(asides).toHaveLength(2);
    for (const aside of asides)
      expect(readdirSync(join(dataDir, "set-aside", aside))).toContain(
        "pos.db",
      );
    reopen();
  });
});

describe("asking the server about a restore it has no record of", () => {
  it("reports again when the status answer is empty, as the server's null arrives", async () => {
    const backup = takeBackup(NOW);
    breakStore();
    restoreStoreBackup({
      dataDir,
      backup,
      protector: thisUser,
      migrations,
      now: () => NOW + 60_000,
    });
    const { db } = reopen();
    let clock = NOW + 61_000;
    const paths: string[] = [];
    const report = jest.fn();
    const api = {
      request: jest.fn(
        async (
          _method: string,
          path: string,
          init: { body: Record<string, unknown> },
        ) => {
          paths.push(path);
          if (path.endsWith("/status")) return undefined;
          const sent = init.body.report as Signed<OfflineCounterRestoreReport>;
          return {
            restoreId: sent.payload.restoreId,
            status: "awaiting_acknowledgement",
            acknowledgedAt: null,
            latestGrantVersion: 1,
          };
        },
      ),
    };
    const sync = createStoreRestoreSync({
      db,
      api: api as never,
      terminal: {
        current: () => ({ identity, staff, key: deviceKey }),
      } as never,
      report,
      now: () => clock,
    });
    expect(await sync.tick()).toBe("waiting");
    clock += RESTORE_POLL_MS;
    // The server lost it: an empty body, never an "unexpected reply" and a back-off.
    expect(await sync.tick()).toBe("waiting");
    expect(paths).toEqual([
      "/terminals/offline-journal/restore/report",
      "/terminals/offline-journal/restore/status",
      "/terminals/offline-journal/restore/report",
    ]);
    expect(report).not.toHaveBeenCalled();
  });
});

it("keeps StoreRestoreError codes stable", () => {
  expect(new StoreRestoreError("STORE_IN_USE", "x").code).toBe("STORE_IN_USE");
});
