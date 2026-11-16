import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3-multiple-ciphers";
import type { PosDatabase } from "../db/database";
import type { SecretProtector } from "../db/key-store";

/**
 * P5 #51: backups of this counter's encrypted store (decisions of 2026-11-10).
 *
 * **Where.** On this computer only, in the app's own `backups` folder beside `data`. Each backup is
 * a SQLCipher copy of the store under a key of its own, and that key is kept only wrapped by the
 * Windows credential store (DPAPI): only the same Windows user on this computer can open it. A
 * backup copied anywhere else is unreadable, so it never leaks the counter's signing key. Staff PIN
 * verifiers are never written to the copy (`staff_credential` is created empty), so a backup holds
 * no PIN in any form; staff sign in online again after a restore.
 *
 * **When.** Taken by the app itself, never by a person: before a schema upgrade, once at start-up,
 * then every few minutes while the offline journal or the outage state has changed since the last
 * backup, and at least hourly while anything else in the store has. The newest backups and the
 * last one of each recent day are kept.
 *
 * **What it is.** `<backupsDir>/<backupId>/pos.db` (the copy), `pos.db.key` (its wrapped key) and
 * `backup.json` (what was in it, for choosing one; a restore trusts only the copy itself). A
 * backup is written under `.partial-<id>` and renamed into place whole.
 */

export const BACKUP_FORMAT = 1;
export const BACKUP_CHECK_MS = 5 * 60_000;
/** A store that changed outside the journal is backed up at most this often. */
export const BACKUP_MAX_AGE_MS = 60 * 60_000;
/** The newest backups kept, plus the newest of each of the last `KEEP_DAYS` days. */
export const KEEP_NEWEST = 12;
export const KEEP_DAYS = 7;

const KEY_HEX = /^[0-9a-f]{64}$/;
const BACKUP_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
const PARTIAL_PREFIX = ".partial-";

export type BackupReason =
  | "before_upgrade"
  | "startup"
  | "journal_changed"
  | "scheduled";

export type JournalPosition = { sequence: number; hash: string | null };

/** What a backup held, for listing. Restore re-reads all of it from the copy. */
export type StoreBackupManifest = {
  format: typeof BACKUP_FORMAT;
  backupId: string;
  takenAt: number;
  reason: BackupReason;
  appVersion: string;
  schemaVersion: number;
  enrollmentId: string | null;
  counterLabel: string | null;
  branchName: string | null;
  journalHead: JournalPosition;
  acceptedWatermark: JournalPosition;
  outageActive: boolean;
  /** SHA-256 of `pos.db`, checked before a restore opens it. */
  sha256: string;
  bytes: number;
};

export type StoreBackup = { dir: string; manifest: StoreBackupManifest };

export class StoreBackupError extends Error {
  constructor(
    readonly code:
      | "KEY_UNREADABLE"
      | "BACKUP_DAMAGED"
      | "BACKUP_UNREADABLE"
      | "STORE_UNSUPPORTED",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StoreBackupError";
  }
}

/** Opens a SQLCipher file as the store does, without WAL: copies are single files. */
export function openCipherFile(
  path: string,
  keyHex: string,
  options: { readonly?: boolean } = {},
): PosDatabase {
  if (!KEY_HEX.test(keyHex))
    throw new StoreBackupError(
      "KEY_UNREADABLE",
      "Backup key must be 32 bytes of hex.",
    );
  const db = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: true,
  });
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.pragma(`key = "x'${keyHex}'"`);
    db.prepare("SELECT count(*) FROM sqlite_master").get();
    return db;
  } catch (cause) {
    db.close();
    throw new StoreBackupError(
      "BACKUP_UNREADABLE",
      "The backup could not be opened with its key.",
      { cause },
    );
  }
}

/** The live store's key, read back through the credential store (the store keeps no copy). */
export function readWrappedKey(
  keyPath: string,
  protector: SecretProtector,
): string {
  let key: string;
  try {
    key = protector.unprotect(readFileSync(keyPath));
  } catch (cause) {
    throw new StoreBackupError(
      "KEY_UNREADABLE",
      "This key can only be opened by the Windows user that created it on this computer.",
      { cause },
    );
  }
  if (!KEY_HEX.test(key))
    throw new StoreBackupError(
      "KEY_UNREADABLE",
      "The stored key is not valid.",
    );
  return key;
}

/** Read in chunks: a year-old counter's copy is over a gigabyte. */
export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(4 * 2 ** 20);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function tableExists(db: PosDatabase, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/**
 * What the store holds that matters for choosing or restoring a backup. Works on any schema
 * version: a backup before an upgrade reads an older store.
 */
export function readStoreFacts(
  db: PosDatabase,
): Omit<
  StoreBackupManifest,
  | "format"
  | "backupId"
  | "takenAt"
  | "reason"
  | "appVersion"
  | "sha256"
  | "bytes"
> {
  const schemaVersion = tableExists(db, "schema_migrations")
    ? ((
        db.prepare("SELECT max(version) AS v FROM schema_migrations").get() as {
          v: number | null;
        }
      ).v ?? 0)
    : 0;
  const device = tableExists(db, "device_identity")
    ? (db
        .prepare(
          "SELECT enrollment_id, counter_label, branch_name FROM device_identity WHERE id = 1",
        )
        .get() as
        | { enrollment_id: string; counter_label: string; branch_name: string }
        | undefined)
    : undefined;
  const enrollmentId = device?.enrollment_id ?? null;
  let journalHead: JournalPosition = { sequence: 0, hash: null };
  let acceptedWatermark: JournalPosition = { sequence: 0, hash: null };
  let outageActive = false;
  if (enrollmentId && tableExists(db, "offline_journal_command")) {
    const head = db
      .prepare(
        "SELECT sequence, payload_hash FROM offline_journal_command WHERE enrollment_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(enrollmentId) as
      | { sequence: number; payload_hash: string }
      | undefined;
    if (head)
      journalHead = { sequence: head.sequence, hash: head.payload_hash };
    const outage = db
      .prepare(
        "SELECT 1 FROM offline_journal_state WHERE enrollment_id = ? AND offline_session_id IS NOT NULL",
      )
      .get(enrollmentId);
    outageActive = outage !== undefined;
  }
  if (enrollmentId && tableExists(db, "offline_journal_sync")) {
    const row = db
      .prepare(
        "SELECT accepted_through_sequence AS s, accepted_through_hash AS h FROM offline_journal_sync WHERE enrollment_id = ?",
      )
      .get(enrollmentId) as { s: number; h: string | null } | undefined;
    if (row) acceptedWatermark = { sequence: row.s, hash: row.h };
  }
  return {
    schemaVersion,
    enrollmentId,
    counterLabel: device?.counter_label ?? null,
    branchName: device?.branch_name ?? null,
    journalHead,
    acceptedWatermark,
    outageActive,
  };
}

/** Written only inside backup copies, before re-keying: the authoritative backup time on restore. */
export function writeStoreBackupMeta(db: PosDatabase, takenAt: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_backup_meta (
      taken_at INTEGER NOT NULL
    ) STRICT;
  `);
  db.prepare("DELETE FROM store_backup_meta").run();
  db.prepare("INSERT INTO store_backup_meta (taken_at) VALUES (?)").run(
    takenAt,
  );
}

export function readStoreBackupMetaTakenAt(db: PosDatabase): number | null {
  if (!tableExists(db, "store_backup_meta")) return null;
  const row = db
    .prepare("SELECT taken_at FROM store_backup_meta LIMIT 1")
    .get() as { taken_at: number } | undefined;
  return row?.taken_at ?? null;
}

/** Newest journal command time in the copy, if any (ISO `created_at` in the journal table). */
export function newestJournalTimestampMs(db: PosDatabase): number | null {
  if (!tableExists(db, "offline_journal_command")) return null;
  const row = db
    .prepare("SELECT max(created_at) AS latest FROM offline_journal_command")
    .get() as { latest: string | null } | undefined;
  if (!row?.latest) return null;
  const ms = Date.parse(row.latest);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The backup time to sign into a restore report. Prefer the in-copy meta row; cross-check with the
 * journal. An edited `backup.json` must never move this later and shrink what the back office must
 * check (never trust the manifest alone when the copy proves an earlier time).
 *
 * `verified` is false only for a copy taken before the meta row existed whose journal is empty:
 * nothing inside the encrypted copy bounds the time, so it is the editable manifest's alone and
 * the counter says so (#165).
 */
export function authoritativeBackupTakenAt(
  db: PosDatabase,
  manifestTakenAt: number,
): { at: number; verified: boolean } {
  const inCopy = readStoreBackupMetaTakenAt(db);
  const journalLatest = newestJournalTimestampMs(db);
  if (inCopy !== null) {
    if (manifestTakenAt > inCopy) {
      if (journalLatest !== null)
        return { at: Math.min(inCopy, journalLatest), verified: true };
      return { at: inCopy, verified: true };
    }
    return { at: Math.min(inCopy, manifestTakenAt), verified: true };
  }
  if (journalLatest !== null)
    return { at: Math.min(journalLatest, manifestTakenAt), verified: true };
  return { at: manifestTakenAt, verified: false };
}

function compactTime(at: number): string {
  // 20261110T104233123Z: sorts by time, safe in a folder name.
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

/** What a store backup's copy is made from: the live store, its key, and the copy's own key. */
export type BackupCopyJob = {
  /** The live store's file, opened afresh by whoever writes the copy. */
  storePath: string;
  liveKey: string;
  copyPath: string;
  backupKey: string;
  takenAt: number;
};

export type BackupCopyResult = {
  facts: ReturnType<typeof readStoreFacts>;
  sha256: string;
  bytes: number;
};

type SchemaObject = { type: string; name: string; sql: string };

/**
 * Rewrites a `CREATE ...` statement from `sqlite_master` to create the object in `schema`. Fails
 * closed on anything else (a virtual or FTS table, say): a migration that adds one must teach the
 * backup to copy it, and until then every backup fails with this, never with a copy missing it.
 */
function inSchema(object: SchemaObject, schema: string): string {
  const created =
    /^CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\s+/i.exec(object.sql);
  if (!created)
    throw new StoreBackupError(
      "STORE_UNSUPPORTED",
      `The store holds an object backups cannot copy yet (${object.type} "${object.name}"): ${object.sql.split("(")[0]!.trim()}.`,
    );
  return `${created[0]}${schema}.${object.sql.slice(created[0].length)}`;
}

const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Writes a backup copy of `source` (a writable connection to the live store, which it only reads)
 * to `job.copyPath`, already encrypted under the backup's own key, then checks it. The facts come
 * from the same read, so they describe exactly what the copy holds.
 *
 * One pass: the copy is attached under its own key and filled table by table inside one read
 * transaction (one consistent snapshot of the store). Staff PIN verifiers are never written to it:
 * `staff_credential` is created empty, so no verifier reaches the file in any page, and the copy
 * needs no `VACUUM` or `rekey` afterwards.
 *
 * #166: before, a backup was `VACUUM INTO`, then `VACUUM` and `rekey` of the copy (each a full
 * rewrite, the re-key through a rollback journal), then `quick_check`, all on the main process:
 * about 15 s on a 259 MB store and 142 s on a 1.4 GB one (`scripts/bench-store-backup.ts`). The app
 * now runs this in a worker thread (`backup-worker.ts`), and writing the copy once keeps the disk
 * free enough that the till's own writes (synchronous = FULL) are not starved meanwhile.
 */
export function writeBackupCopy(
  source: PosDatabase,
  job: Omit<BackupCopyJob, "storePath">,
): BackupCopyResult {
  let facts: BackupCopyResult["facts"] | undefined;
  // Enforcement is per connection; rows are copied table by table, so parents may come later.
  const foreignKeys = source.pragma("foreign_keys", { simple: true });
  source.pragma("foreign_keys = OFF");
  // An empty file is a new database; a connection opened with `fileMustExist` cannot create one.
  writeFileSync(job.copyPath, "", { flag: "wx" });
  source
    .prepare("ATTACH DATABASE ? AS backup_copy KEY ?")
    .run(job.copyPath, `x'${job.backupKey}'`);
  try {
    // A scratch file until it is checked and renamed: no journal; the meta write below syncs it.
    source.pragma("backup_copy.journal_mode = OFF");
    source.pragma("backup_copy.synchronous = OFF");
    source.transaction(() => {
      facts = readStoreFacts(source);
      const objects = source
        .prepare(
          "SELECT type, name, sql FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all() as SchemaObject[];
      const tables = objects.filter((o) => o.type === "table");
      for (const table of tables) source.exec(inSchema(table, "backup_copy"));
      for (const table of tables)
        if (table.name !== "staff_credential")
          source.exec(
            `INSERT INTO backup_copy.${quoteName(table.name)} SELECT * FROM main.${quoteName(table.name)}`,
          );
      if (tableExists(source, "sqlite_sequence"))
        source.exec(
          "DELETE FROM backup_copy.sqlite_sequence; INSERT INTO backup_copy.sqlite_sequence SELECT * FROM main.sqlite_sequence",
        );
      // Indexes after the rows (built once, not row by row), then triggers and views.
      for (const type of ["index", "trigger", "view"])
        for (const object of objects)
          if (object.type === type)
            source.exec(inSchema(object, "backup_copy"));
      const userVersion = source.pragma("main.user_version", {
        simple: true,
      }) as number;
      source.pragma(`backup_copy.user_version = ${Number(userVersion)}`);
    })();
  } finally {
    source.exec("DETACH DATABASE backup_copy");
    source.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }

  const copy = openCipherFile(job.copyPath, job.backupKey);
  try {
    writeStoreBackupMeta(copy, job.takenAt);
    const ok = copy.pragma("quick_check", { simple: true });
    if (ok !== "ok")
      throw new StoreBackupError(
        "BACKUP_DAMAGED",
        `The new backup failed its check: ${String(ok)}`,
      );
  } finally {
    copy.close();
  }
  return {
    facts: facts!,
    sha256: sha256File(job.copyPath),
    bytes: statSync(job.copyPath).size,
  };
}

type BackupOptions = {
  keyPath: string;
  backupsDir: string;
  protector: SecretProtector;
  appVersion: string;
  reason: BackupReason;
  now?: () => number;
};

type BegunBackup = {
  backupId: string;
  partial: string;
  job: Omit<BackupCopyJob, "storePath">;
};

/** The quick part before a copy, on the main process: the credential store is only there. */
function beginBackup(options: BackupOptions): BegunBackup {
  const now = options.now ?? Date.now;
  if (!options.protector.isAvailable())
    throw new StoreBackupError(
      "KEY_UNREADABLE",
      "The Windows credential store is not available.",
    );
  const liveKey = readWrappedKey(options.keyPath, options.protector);
  mkdirSync(options.backupsDir, { recursive: true });
  const takenAt = now();
  const backupId = `${compactTime(takenAt)}-${randomBytes(4).toString("hex")}`;
  const partial = join(options.backupsDir, `${PARTIAL_PREFIX}${backupId}`);
  mkdirSync(partial);
  return {
    backupId,
    partial,
    job: {
      liveKey,
      copyPath: join(partial, "pos.db"),
      backupKey: randomBytes(32).toString("hex"),
      takenAt,
    },
  };
}

/** The quick part after a copy: wrap its key for this Windows user, describe it, put it in place. */
function finishBackup(
  begun: BegunBackup,
  copied: BackupCopyResult,
  options: BackupOptions,
): StoreBackup {
  writeFileSync(
    join(begun.partial, "pos.db.key"),
    options.protector.protect(begun.job.backupKey),
  );
  const manifest: StoreBackupManifest = {
    format: BACKUP_FORMAT,
    backupId: begun.backupId,
    takenAt: begun.job.takenAt,
    reason: options.reason,
    appVersion: options.appVersion,
    ...copied.facts,
    sha256: copied.sha256,
    bytes: copied.bytes,
  };
  writeFileSync(
    join(begun.partial, "backup.json"),
    JSON.stringify(manifest, null, 2),
  );
  const dir = join(options.backupsDir, begun.backupId);
  renameSync(begun.partial, dir);
  return { dir, manifest };
}

function discardPartial(partial: string): void {
  try {
    rmSync(partial, { recursive: true, force: true });
  } catch {
    // Still held open (a worker being stopped): the next prune removes it.
  }
}

/**
 * Takes one backup of the open store, synchronously, on this connection. Only for when the till
 * is not open yet: before a schema upgrade, which must wait for it. The schedule that runs while
 * the till is open uses `takeStoreBackupOffThread`.
 */
export function takeStoreBackup(
  db: PosDatabase,
  options: BackupOptions,
): StoreBackup {
  const begun = beginBackup(options);
  try {
    return finishBackup(begun, writeBackupCopy(db, begun.job), options);
  } catch (error) {
    discardPartial(begun.partial);
    throw error;
  }
}

/** Writes a backup copy somewhere other than the calling thread; `cancel` abandons it. */
export type BackupCopyRunner = (job: BackupCopyJob) => {
  result: Promise<BackupCopyResult>;
  cancel(): void;
};

/** A copy that failed in the worker, as the worker described it (never with a key in it). */
type WorkerFailure = { name: string; message: string; code?: string };
export type BackupWorkerReply =
  | { ok: true; result: BackupCopyResult }
  | { ok: false; error: WorkerFailure };

function fromWorkerFailure(failure: WorkerFailure): Error {
  if (
    failure.name === "StoreBackupError" &&
    (failure.code === "KEY_UNREADABLE" ||
      failure.code === "BACKUP_DAMAGED" ||
      failure.code === "BACKUP_UNREADABLE" ||
      failure.code === "STORE_UNSUPPORTED")
  )
    return new StoreBackupError(failure.code, failure.message);
  return Object.assign(new Error(failure.message), {
    name: failure.name,
    code: failure.code,
  });
}

/**
 * Runs each copy in a fresh worker thread (`backup-worker.ts`, built beside the main bundle). Both
 * keys reach it only in `workerData`, in memory; nothing it reports back carries them.
 */
export function workerCopyRunner(
  filename: string,
  options: { eval?: boolean } = {},
): BackupCopyRunner {
  return (job) => {
    const worker = new Worker(filename, {
      workerData: job,
      eval: options.eval,
    });
    let cancelled = false;
    const result = new Promise<BackupCopyResult>((resolve, reject) => {
      let settled = false;
      const settle = (run: () => void) => {
        if (settled) return;
        settled = true;
        run();
      };
      worker.once("message", (reply: BackupWorkerReply) =>
        settle(() =>
          reply.ok
            ? resolve(reply.result)
            : reject(fromWorkerFailure(reply.error)),
        ),
      );
      worker.once("error", (error) => settle(() => reject(error)));
      worker.once("exit", (code) =>
        settle(() =>
          reject(
            new Error(
              cancelled
                ? "The backup was stopped."
                : `The backup worker stopped (exit ${code}) before finishing.`,
            ),
          ),
        ),
      );
    });
    return {
      result,
      cancel: () => {
        cancelled = true;
        void worker.terminate();
      },
    };
  };
}

/**
 * Takes one backup of the store at `storePath`, with the copy written by `runCopy` (a worker
 * thread, in the app). Only the key unwrap and wrap, the manifest and the rename run here.
 */
export function takeStoreBackupOffThread(
  options: BackupOptions & { storePath: string; runCopy: BackupCopyRunner },
): { result: Promise<StoreBackup>; cancel(): void } {
  let begun: BegunBackup;
  try {
    begun = beginBackup(options);
  } catch (error) {
    return { result: Promise.reject(error), cancel: () => undefined };
  }
  const running = options.runCopy({
    ...begun.job,
    storePath: options.storePath,
  });
  const result = running.result.then(
    (copied) => {
      try {
        return finishBackup(begun, copied, options);
      } catch (error) {
        discardPartial(begun.partial);
        throw error;
      }
    },
    (error: unknown) => {
      discardPartial(begun.partial);
      throw error;
    },
  );
  return { result, cancel: running.cancel };
}

function readManifest(
  dir: string,
  backupId: string,
): StoreBackupManifest | null {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dir, "backup.json"), "utf8"),
    ) as StoreBackupManifest;
    if (manifest.format !== BACKUP_FORMAT || manifest.backupId !== backupId)
      return null;
    if (
      !existsSync(join(dir, "pos.db")) ||
      !existsSync(join(dir, "pos.db.key"))
    )
      return null;
    return manifest;
  } catch {
    return null;
  }
}

/** Finished backups, newest first. Partial or unreadable folders are skipped (never deleted here). */
export function listStoreBackups(backupsDir: string): StoreBackup[] {
  if (!existsSync(backupsDir)) return [];
  const backups: StoreBackup[] = [];
  for (const name of readdirSync(backupsDir)) {
    if (!BACKUP_ID.test(name)) continue;
    const dir = join(backupsDir, name);
    const manifest = readManifest(dir, name);
    if (manifest) backups.push({ dir, manifest });
  }
  return backups.sort((a, b) =>
    a.manifest.backupId < b.manifest.backupId ? 1 : -1,
  );
}

/** Which backups to keep: the newest `KEEP_NEWEST`, and the newest of each of the last `KEEP_DAYS` days. */
export function backupsToKeep(
  backups: readonly StoreBackup[],
  now: number,
): Set<string> {
  const keep = new Set(
    backups.slice(0, KEEP_NEWEST).map((b) => b.manifest.backupId),
  );
  const days = new Set<string>();
  for (const backup of backups) {
    if (now - backup.manifest.takenAt > KEEP_DAYS * 24 * 60 * 60_000) continue;
    const day = new Date(backup.manifest.takenAt).toISOString().slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    keep.add(backup.manifest.backupId);
  }
  return keep;
}

/** Removes backups outside the retention, and partial folders left by an interrupted backup. */
export function pruneStoreBackups(backupsDir: string, now: number): string[] {
  if (!existsSync(backupsDir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(backupsDir))
    if (name.startsWith(PARTIAL_PREFIX)) {
      rmSync(join(backupsDir, name), { recursive: true, force: true });
      removed.push(name);
    }
  const backups = listStoreBackups(backupsDir);
  const keep = backupsToKeep(backups, now);
  for (const backup of backups)
    if (!keep.has(backup.manifest.backupId)) {
      rmSync(backup.dir, { recursive: true, force: true });
      removed.push(backup.manifest.backupId);
    }
  return removed;
}

/** What decides whether the store has changed enough since the last backup. */
function journalFingerprint(facts: ReturnType<typeof readStoreFacts>): string {
  return JSON.stringify([
    facts.enrollmentId,
    facts.journalHead,
    facts.acceptedWatermark,
    facts.outageActive,
  ]);
}

/** How backups are going, for the readiness checks (a failing disk must not look healthy). */
export type StoreBackupStatus = {
  /** The newest finished backup on this computer, from this run or an earlier one. */
  lastBackupAt: number | null;
  /** Backups (or checks whether one is due) that failed in a row since the last good one. */
  failures: number;
  failingSince: number | null;
};

export type StoreBackupSchedule = {
  /**
   * One check: starts a backup if one is due and none is running, and resolves with it once it is
   * in place (or null). Never rejects; failures are reported.
   */
  tick(): Promise<StoreBackup | null>;
  /** The backup running now, if any (null when none is). */
  idle(): Promise<StoreBackup | null>;
  /** Stops the timer and abandons a backup in progress (its partial folder is pruned later). */
  stop(): void;
  status(): StoreBackupStatus;
};

/**
 * Backs up on a timer: at once when started, then every `BACKUP_CHECK_MS` if the journal or the
 * outage moved since the last backup, or `BACKUP_MAX_AGE_MS` after it if anything else was
 * written (`total_changes()` counts this connection's writes, and the app is the only writer).
 * Only a store that holds a counter is backed up.
 *
 * #166: the copy is written by `runCopy` (a worker thread in the app) from its own connection, so
 * checkout keeps running, and writing, during a backup. Only the check whether one is due, the key
 * unwrap and wrap, and the manifest run here. One backup runs at a time; a check that finds one
 * still running skips.
 */
export function startStoreBackups(options: {
  db: PosDatabase;
  keyPath: string;
  backupsDir: string;
  protector: SecretProtector;
  appVersion: string;
  runCopy: BackupCopyRunner;
  report: (error: unknown) => void;
  onBackup?: (backup: StoreBackup) => void;
  now?: () => number;
  timer?: boolean;
}): StoreBackupSchedule {
  const now = options.now ?? Date.now;
  let last: { at: number; fingerprint: string; changes: number } | null = null;
  let running: {
    result: Promise<StoreBackup | null>;
    cancel(): void;
  } | null = null;
  let stopped = false;
  const status: StoreBackupStatus = {
    lastBackupAt: null,
    failures: 0,
    failingSince: null,
  };
  try {
    status.lastBackupAt =
      listStoreBackups(options.backupsDir)[0]?.manifest.takenAt ?? null;
  } catch {
    // An unreadable backups folder shows up as the first backup failing.
  }
  const failed = (error: unknown) => {
    status.failures += 1;
    status.failingSince ??= now();
    options.report(error);
  };

  const totalChanges = () =>
    (options.db.prepare("SELECT total_changes() AS n").get() as { n: number })
      .n;

  function take(reason: BackupReason): Promise<StoreBackup | null> {
    // Counted before the copy starts: a write that lands while it runs makes the next check see a
    // change, at worst one backup more than needed, never one fewer.
    const changes = totalChanges();
    const taking = takeStoreBackupOffThread({
      ...options,
      storePath: options.db.name,
      reason,
      now,
    });
    const result = taking.result.then(
      (backup) => {
        last = {
          at: backup.manifest.takenAt,
          fingerprint: journalFingerprint(backup.manifest),
          changes,
        };
        status.lastBackupAt = backup.manifest.takenAt;
        status.failures = 0;
        status.failingSince = null;
        try {
          pruneStoreBackups(options.backupsDir, now());
        } catch (error) {
          options.report(error);
        }
        options.onBackup?.(backup);
        return backup;
      },
      (error: unknown) => {
        if (!stopped) failed(error);
        return null;
      },
    );
    const current = { result, cancel: taking.cancel };
    running = current;
    void result.finally(() => {
      if (running === current) running = null;
    });
    return result;
  }

  function due(): BackupReason | null {
    const facts = readStoreFacts(options.db);
    // A store with no counter is not backed up: it has nothing to restore, and its backups would
    // push the real ones (of the counter this computer had before) out of the retention.
    if (!facts.enrollmentId) return null;
    if (!last) return "startup";
    if (journalFingerprint(facts) !== last.fingerprint)
      return "journal_changed";
    if (totalChanges() !== last.changes && now() - last.at >= BACKUP_MAX_AGE_MS)
      return "scheduled";
    return null;
  }

  function tick(): Promise<StoreBackup | null> {
    if (stopped || running) return Promise.resolve(null);
    let reason: BackupReason | null;
    try {
      reason = due();
    } catch (error) {
      // A failing disk is what backups exist for: report it, never throw out of a timer or into
      // start-up.
      failed(error);
      return Promise.resolve(null);
    }
    return reason ? take(reason) : Promise.resolve(null);
  }

  void tick();
  let interval: ReturnType<typeof setInterval> | null = null;
  if (options.timer !== false) {
    interval = setInterval(() => void tick(), BACKUP_CHECK_MS);
    interval.unref();
  }
  return {
    tick,
    idle: () => running?.result ?? Promise.resolve(null),
    stop: () => {
      stopped = true;
      if (interval) clearInterval(interval);
      running?.cancel();
    },
    status: () => ({ ...status }),
  };
}
