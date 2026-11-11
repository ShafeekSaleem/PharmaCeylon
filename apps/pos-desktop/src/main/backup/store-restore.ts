import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { OfflineCounterRestoreReport } from "@pharmaceylon/shared";
import { openEncryptedDatabase, type PosDatabase } from "../db/database";
import type { SecretProtector } from "../db/key-store";
import { runMigrations, type Migration } from "../db/migrator";
import { DeviceStore } from "../device/device-store";
import { readInstalledOfflineAuthority } from "../terminal/offline-authority";
import { activeOutage, localJournalHead } from "../terminal/offline-journal";
import { resetJournalUsageForEnrollment } from "../terminal/offline-journal-writer";
import { readAcceptedWatermark } from "../terminal/reconnect-drain";
import {
  openCipherFile,
  authoritativeBackupTakenAt,
  readStoreFacts,
  readWrappedKey,
  sha256File,
  StoreBackupError,
  type StoreBackup,
} from "./store-backup";

/**
 * P5 #51: restoring this counter's store from one of its own backups (decisions of 2026-11-10).
 *
 * **Who and when.** Anyone at this computer, but only onto a store that cannot be opened or holds
 * no counter (`liveStoreState`): never over a working store, whose journal a restore would throw
 * away. No PIN can be checked then anyway — the store holding the verifiers is the one that is
 * broken — and nothing a restore brings back can sell offline until the counter has reconciled
 * online and a person has acknowledged the restore in the back office.
 *
 * **What it keeps.** Everything the backup held: the enrollment and its signing key, the journal
 * with its sequence and hashes, the accepted watermark, checkout drafts and signed actions still
 * to confirm, shifts, D11 recovery state. The store it replaces is moved aside to
 * `data/set-aside/<time>/`, never deleted: it may hold the very sales the backup lacks.
 *
 * **What it removes**, in one transaction with the restore record (`applyRestoreGuards`):
 *
 * - the installed offline grant and snapshot, and any pending renewal request, whose replay could
 *   hand back a version the server superseded while this backup was all the computer had;
 * - the batch usage counted against that snapshot (a fresh pair includes what the server has);
 * - staff PIN verifiers (the backup has none anyway) and any staff session left open in it.
 *
 * Then the counter reports the restore (device-signed) on its first connection and may not start
 * or continue an outage until the restore is acknowledged and a pair issued after that is
 * installed (`store-restore-sync.ts`). If its journal is behind or apart from the server's, D11
 * recovery (`journal-recovery.ts`) brings it onto the server's chain first; it never writes at a
 * sequence the server accepted.
 */

export type LiveStoreState =
  /** No database file: a deleted data folder, or a computer never set up. */
  | "missing"
  /** It opens and checks, and holds no counter and no journal: nothing a restore could lose. */
  | "empty"
  /** It opens and holds a counter: never restored over. */
  | "working"
  /** Its key or its pages cannot be read. */
  | "unusable";

export class StoreRestoreError extends Error {
  constructor(
    readonly code:
      | "STORE_IN_USE"
      | "BACKUP_DAMAGED"
      | "BACKUP_UNREADABLE"
      | "BACKUP_NEWER_THAN_APP"
      | "BACKUP_HAS_NO_COUNTER"
      | "KEY_UNREADABLE"
      /** It began replacing the store and could not finish: nothing may open the store until it does. */
      | "RESTORE_INTERRUPTED",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StoreRestoreError";
  }
}

const LIVE_FILES = ["pos.db", "pos.db-wal", "pos.db-shm"] as const;
const STAGING = "restore-staging";
const INTENT = "restore.json";
const SET_ASIDE = /^set-aside[\\/]\d{8}T\d{9}Z-[0-9a-f]{8}$/;

type RestoreIntent = { restoreId: string; setAside: string; startedAt: number };

/** Windows refuses a move while antivirus or indexing holds the file just written: wait it out. */
const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const RENAME_WAITS_MS = [100, 200, 400, 800];
const pause = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { code?: unknown }).code
    : undefined;
}

function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const wait = RENAME_WAITS_MS[attempt];
      if (wait === undefined || !BUSY_CODES.has(String(errorCode(error))))
        throw error;
      pause(wait);
    }
  }
}

/**
 * Writes `path` whole or not at all: a temporary file, flushed to disk, then renamed over it. A
 * power cut can leave the temporary file, never a truncated `path`.
 */
function writeDurably(path: string, data: string | Buffer): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, "w");
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameRetrying(temp, path);
}

/**
 * Only these say the store itself cannot be read: no SQLite database under this key, damaged
 * pages, or a key this Windows user cannot unwrap. A file that is only busy or locked (antivirus,
 * roaming-profile sync at logon, a disk error) is not a broken store, and must never lead to a
 * restore over it: that error (the one that says what happened) is thrown for start-up to show.
 */
function unreadableOrThrow(error: unknown): "unusable" {
  let unreadable = false;
  let e: unknown = error;
  for (let depth = 0; e && depth < 8; depth += 1) {
    const code = String(errorCode(e) ?? "");
    if (/^SQLITE_(NOTADB|CORRUPT)/.test(code)) unreadable = true;
    // Any other SQLite or file-system code: busy, locked, cannot open, an I/O error.
    else if (/^SQLITE_|^E[A-Z]+$/.test(code)) throw e;
    // The key or the database could not be read, for a reason its cause (if any) says.
    else if (e instanceof StoreBackupError) unreadable = true;
    e = (e as { cause?: unknown }).cause;
  }
  if (unreadable) return "unusable";
  throw error;
}

function holdsCounter(db: PosDatabase): boolean {
  const has = (table: string) =>
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined;
  if (
    has("device_identity") &&
    db.prepare("SELECT 1 FROM device_identity LIMIT 1").get()
  )
    return true;
  return (
    has("offline_journal_command") &&
    db.prepare("SELECT 1 FROM offline_journal_command LIMIT 1").get() !==
      undefined
  );
}

/**
 * What is in `dataDir` now. Opens the store (read-write, as the app would: a read-only open of a
 * WAL database can fail where the app's own would not, and must never make a working store look
 * broken), reads it and closes it again without writing. Throws, rather than answer "unusable",
 * when the store could not be read for a reason that is not the store's (`unreadableOrThrow`).
 */
export function liveStoreState(
  dataDir: string,
  protector: SecretProtector,
): LiveStoreState {
  const databasePath = join(dataDir, "pos.db");
  const keyPath = join(dataDir, "pos.db.key");
  if (!existsSync(databasePath)) return "missing";
  if (!existsSync(keyPath)) return "unusable";
  let db: PosDatabase | null = null;
  try {
    const key = readWrappedKey(keyPath, protector);
    db = openCipherFile(databasePath, key);
    if (db.pragma("quick_check", { simple: true }) !== "ok") return "unusable";
    return holdsCounter(db) ? "working" : "empty";
  } catch (error) {
    return unreadableOrThrow(error);
  } finally {
    db?.close();
  }
}

/**
 * Checks a backup before anything is moved: its file is the one that was written, its key opens
 * it here, its pages check, it holds a counter, and this app knows its schema.
 */
export function verifyStoreBackup(
  backup: StoreBackup,
  protector: SecretProtector,
  migrations: readonly Migration[],
): {
  key: string;
  facts: ReturnType<typeof readStoreFacts>;
  backupTakenAt: number;
} {
  const file = join(backup.dir, "pos.db");
  if (sha256File(file) !== backup.manifest.sha256)
    throw new StoreRestoreError(
      "BACKUP_DAMAGED",
      "This backup has changed since it was taken.",
    );
  let key: string;
  try {
    key = readWrappedKey(join(backup.dir, "pos.db.key"), protector);
  } catch (cause) {
    throw new StoreRestoreError(
      "KEY_UNREADABLE",
      "This backup can only be opened by the Windows user that took it, on this computer.",
      { cause },
    );
  }
  let db: PosDatabase;
  try {
    db = openCipherFile(file, key, { readonly: true });
  } catch (cause) {
    throw new StoreRestoreError(
      "BACKUP_UNREADABLE",
      "This backup could not be opened.",
      { cause },
    );
  }
  try {
    if (db.pragma("quick_check", { simple: true }) !== "ok")
      throw new StoreRestoreError(
        "BACKUP_DAMAGED",
        "This backup failed its integrity check.",
      );
    const facts = readStoreFacts(db);
    if (!facts.enrollmentId)
      throw new StoreRestoreError(
        "BACKUP_HAS_NO_COUNTER",
        "This backup holds no counter.",
      );
    if (facts.schemaVersion > migrations.length)
      throw new StoreRestoreError(
        "BACKUP_NEWER_THAN_APP",
        "This backup was taken by a newer version of the app.",
      );
    return {
      key,
      facts,
      backupTakenAt: authoritativeBackupTakenAt(db, backup.manifest.takenAt),
    };
  } finally {
    db.close();
  }
}

export type AppliedRestore = {
  restoreId: string;
  enrollmentId: string;
  journalHead: { sequence: number; hash: string | null };
  removedGrantVersion: number | null;
};

/**
 * The restore's local guards and its record, in one immediate transaction on the restored store
 * (already migrated to this app's schema). Returns null when the store holds no enrollment.
 */
export function applyRestoreGuards(
  db: PosDatabase,
  input: {
    restoreId: string;
    backupId: string;
    backupTakenAt: number;
    restoredAt: number;
    setAsidePath: string | null;
  },
): AppliedRestore | null {
  return db
    .transaction((): AppliedRestore | null => {
      const devices = new DeviceStore(db);
      // No PIN verifier and no staff session survives a restore, whatever the backup held.
      db.prepare("DELETE FROM staff_credential").run();
      const at = new Date(input.restoredAt).toISOString();
      db.prepare(
        "UPDATE staff_session_log SET closed_at = ?, close_reason = 'restored' WHERE closed_at IS NULL",
      ).run(at);
      const device = devices.read();
      const key = devices.key();
      if (!device || !key) return null;
      const { identity } = device;
      const enrollmentId = identity.enrollmentId;
      const removedGrantVersion =
        readInstalledOfflineAuthority(db, enrollmentId)?.version ?? null;
      db.prepare("DELETE FROM offline_authority").run();
      db.prepare("DELETE FROM offline_authority_request").run();
      resetJournalUsageForEnrollment(db, enrollmentId);

      const journalHead = localJournalHead(db, enrollmentId);
      const acceptedWatermark = readAcceptedWatermark(db, enrollmentId);
      const outageActive = activeOutage(db, enrollmentId) !== null;
      const report: OfflineCounterRestoreReport = {
        contractVersion: 1,
        kind: "offline_counter_restore_report",
        restoreId: input.restoreId,
        identity,
        reportedAt: input.restoredAt,
        backupId: input.backupId,
        backupTakenAt: input.backupTakenAt,
        restoredAt: input.restoredAt,
        journalHead,
        acceptedWatermark,
        outageActive,
        removedGrantVersion,
      };
      db.prepare(
        `INSERT INTO store_restore (restore_id, enrollment_id, backup_id, backup_taken_at, restored_at,
           journal_head_sequence, journal_head_hash, accepted_sequence, accepted_hash, outage_active,
           removed_grant_version, set_aside_path, report_envelope, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reporting', ?)`,
      ).run(
        input.restoreId,
        enrollmentId,
        input.backupId,
        input.backupTakenAt,
        input.restoredAt,
        journalHead.sequence,
        journalHead.hash,
        acceptedWatermark.sequence,
        acceptedWatermark.hash,
        outageActive ? 1 : 0,
        removedGrantVersion,
        input.setAsidePath,
        JSON.stringify(key.sign(report, "command")),
        at,
      );
      return {
        restoreId: input.restoreId,
        enrollmentId,
        journalHead,
        removedGrantVersion,
      };
    })
    .immediate();
}

function moveIfPresent(from: string, to: string): void {
  if (existsSync(from)) renameRetrying(from, to);
}

/**
 * The file moves of a restore, safe to run again after a crash at any point: the live store goes
 * aside first, then the staged key and database take its place. Each step is decided by whether
 * the staged file is still there, so a rerun never moves the restored files aside.
 */
function finishMoves(dataDir: string, intent: RestoreIntent): void {
  const staging = join(dataDir, STAGING);
  const setAside = join(dataDir, intent.setAside);
  const stagedDb = join(staging, "pos.db");
  const stagedKey = join(staging, "pos.db.key");
  mkdirSync(setAside, { recursive: true });
  if (existsSync(stagedDb))
    for (const name of LIVE_FILES)
      moveIfPresent(join(dataDir, name), join(setAside, name));
  if (existsSync(stagedKey)) {
    moveIfPresent(join(dataDir, "pos.db.key"), join(setAside, "pos.db.key"));
    renameRetrying(stagedKey, join(dataDir, "pos.db.key"));
  }
  if (existsSync(stagedDb)) renameRetrying(stagedDb, join(dataDir, "pos.db"));
  rmSync(join(dataDir, INTENT), { force: true });
  rmSync(staging, { recursive: true, force: true });
}

/**
 * Finishes the moves, or says plainly that it could not. Until it does, the store is half moved
 * and nothing may open it: opening would create a new, empty store under the restored key, which
 * the next start would then move aside without its own key.
 */
function completeMoves(dataDir: string, intent: RestoreIntent): void {
  try {
    finishMoves(dataDir, intent);
  } catch (cause) {
    throw new StoreRestoreError(
      "RESTORE_INTERRUPTED",
      "The restore could not finish replacing this computer's store, because a file was in use. Restart the computer and open PharmaCeylon POS again: it finishes the restore before anything else. Do not delete or move any files.",
      { cause },
    );
  }
}

function readIntent(intentPath: string): RestoreIntent {
  let intent: Partial<RestoreIntent> | null = null;
  try {
    intent = JSON.parse(
      readFileSync(intentPath, "utf8"),
    ) as Partial<RestoreIntent>;
  } catch {
    // Damaged: refused below.
  }
  if (
    !intent ||
    typeof intent.restoreId !== "string" ||
    typeof intent.startedAt !== "number" ||
    typeof intent.setAside !== "string" ||
    !SET_ASIDE.test(intent.setAside)
  )
    throw new StoreRestoreError(
      "RESTORE_INTERRUPTED",
      "A restore of this computer's store was interrupted, and its record of what to move is damaged. Do not delete or move any files in the app's data folder. Contact support.",
    );
  return intent as RestoreIntent;
}

/** A restore began replacing the store and has not finished: the store must not be opened. */
export function restoreInProgress(dataDir: string): boolean {
  return existsSync(join(dataDir, INTENT));
}

/**
 * Run before the store is opened at start-up. Finishes a restore that was interrupted after it
 * decided to replace the store, or drops one interrupted before (the live store untouched).
 * Throws `RESTORE_INTERRUPTED` when it can do neither; the store must then stay closed.
 */
export function finishInterruptedRestore(
  dataDir: string,
): "finished" | "discarded" | "none" {
  const intentPath = join(dataDir, INTENT);
  if (existsSync(intentPath)) {
    completeMoves(dataDir, readIntent(intentPath));
    return "finished";
  }
  // An intent never committed (cut off before its rename) moved nothing.
  const uncommitted = existsSync(`${intentPath}.tmp`);
  rmSync(`${intentPath}.tmp`, { force: true });
  if (existsSync(join(dataDir, STAGING))) {
    rmSync(join(dataDir, STAGING), { recursive: true, force: true });
    return "discarded";
  }
  return uncommitted ? "discarded" : "none";
}

/**
 * Restores `backup` into `dataDir`. The store there must be missing, empty or unusable, and must
 * not be open. The backup is copied (never moved: it stays a backup), re-keyed under a new store
 * key, upgraded, guarded and recorded while it is still staged; only then is the old store moved
 * aside and the restored one put in its place.
 */
export function restoreStoreBackup(options: {
  dataDir: string;
  backup: StoreBackup;
  protector: SecretProtector;
  migrations: readonly Migration[];
  now?: () => number;
}): AppliedRestore | null {
  const now = options.now ?? Date.now;
  const { dataDir, backup, protector } = options;
  if (!protector.isAvailable())
    throw new StoreRestoreError(
      "KEY_UNREADABLE",
      "The Windows credential store is not available.",
    );
  mkdirSync(dataDir, { recursive: true });
  finishInterruptedRestore(dataDir);
  if (liveStoreState(dataDir, protector) === "working")
    throw new StoreRestoreError(
      "STORE_IN_USE",
      "This computer's store opens and holds a counter. A backup is restored only over a store that is broken or empty.",
    );
  const { key: backupKey, backupTakenAt } = verifyStoreBackup(
    backup,
    protector,
    options.migrations,
  );

  const restoredAt = now();
  const restoreId = randomUUID();
  const staging = join(dataDir, STAGING);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const stagedDb = join(staging, "pos.db");
  copyFileSync(join(backup.dir, "pos.db"), stagedDb);
  const storeKey = randomBytes(32).toString("hex");
  const rekey = openCipherFile(stagedDb, backupKey);
  try {
    rekey.pragma("journal_mode = DELETE");
    rekey.pragma(`rekey = "x'${storeKey}'"`);
  } finally {
    rekey.close();
  }
  // On disk before the intent is: once the swap starts, this key is the only way into the store.
  writeDurably(join(staging, "pos.db.key"), protector.protect(storeKey));

  // The restore's own ID beside the time: a clock set back must never land on an earlier
  // restore's folder and move this store over the one set aside there.
  const stamp = new Date(restoredAt).toISOString().replace(/[-:.]/g, "");
  const intent: RestoreIntent = {
    restoreId,
    setAside: join("set-aside", `${stamp}-${restoreId.slice(0, 8)}`),
    startedAt: restoredAt,
  };
  let applied: AppliedRestore | null;
  const db = openEncryptedDatabase(stagedDb, storeKey);
  try {
    runMigrations(db, options.migrations);
    applied = applyRestoreGuards(db, {
      restoreId,
      backupId: backup.manifest.backupId,
      backupTakenAt,
      restoredAt,
      setAsidePath: existsSync(join(dataDir, "pos.db"))
        ? relative(dataDir, join(dataDir, intent.setAside))
        : null,
    });
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  // Whole or absent (a power cut leaves only its temporary file): from here the swap is decided.
  writeDurably(join(dataDir, INTENT), JSON.stringify(intent));
  completeMoves(dataDir, intent);
  return applied;
}

export { StoreBackupError };
