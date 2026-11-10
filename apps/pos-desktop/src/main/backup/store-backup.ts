import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
 * verifiers are removed from the copy (securely deleted before it is re-keyed), so a backup holds
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
    readonly code: "KEY_UNREADABLE" | "BACKUP_DAMAGED" | "BACKUP_UNREADABLE",
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

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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

function compactTime(at: number): string {
  // 20261110T104233123Z: sorts by time, safe in a folder name.
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

/**
 * Takes one backup of the open store. Synchronous from the copy to the rename, so nothing this
 * process writes can land between reading the facts and copying the pages; `VACUUM INTO` copies
 * one consistent read of the whole database, already encrypted under the store's key.
 */
export function takeStoreBackup(
  db: PosDatabase,
  options: {
    keyPath: string;
    backupsDir: string;
    protector: SecretProtector;
    appVersion: string;
    reason: BackupReason;
    now?: () => number;
  },
): StoreBackup {
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
  try {
    const copyPath = join(partial, "pos.db");
    const facts = readStoreFacts(db);
    db.prepare("VACUUM INTO ?").run(copyPath);

    const backupKey = randomBytes(32).toString("hex");
    const copy = openCipherFile(copyPath, liveKey);
    try {
      copy.pragma("journal_mode = DELETE");
      // No PIN verifier leaves the live store, not even as freed pages: secure delete zeroes the
      // cells, and the re-key below rewrites every page under the backup's own key.
      copy.pragma("secure_delete = ON");
      if (tableExists(copy, "staff_credential"))
        copy.prepare("DELETE FROM staff_credential").run();
      copy.exec("VACUUM");
      copy.pragma(`rekey = "x'${backupKey}'"`);
    } finally {
      copy.close();
    }
    const check = openCipherFile(copyPath, backupKey, { readonly: true });
    try {
      const ok = check.pragma("quick_check", { simple: true });
      if (ok !== "ok")
        throw new StoreBackupError(
          "BACKUP_DAMAGED",
          `The new backup failed its check: ${String(ok)}`,
        );
    } finally {
      check.close();
    }

    writeFileSync(
      join(partial, "pos.db.key"),
      options.protector.protect(backupKey),
    );
    const manifest: StoreBackupManifest = {
      format: BACKUP_FORMAT,
      backupId,
      takenAt,
      reason: options.reason,
      appVersion: options.appVersion,
      ...facts,
      sha256: sha256File(copyPath),
      bytes: statSync(copyPath).size,
    };
    writeFileSync(
      join(partial, "backup.json"),
      JSON.stringify(manifest, null, 2),
    );
    const dir = join(options.backupsDir, backupId);
    renameSync(partial, dir);
    return { dir, manifest };
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
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

export type StoreBackupSchedule = {
  /** One check: backs up if due. Never throws; failures are reported. */
  tick(): StoreBackup | null;
  stop(): void;
};

/**
 * Backs up on a timer: at once when started, then every `BACKUP_CHECK_MS` if the journal or the
 * outage moved since the last backup, or `BACKUP_MAX_AGE_MS` after it if anything else was
 * written (`total_changes()` counts this connection's writes, and the app is the only writer).
 * Only a store that holds a counter is backed up.
 */
export function startStoreBackups(options: {
  db: PosDatabase;
  keyPath: string;
  backupsDir: string;
  protector: SecretProtector;
  appVersion: string;
  report: (error: unknown) => void;
  onBackup?: (backup: StoreBackup) => void;
  now?: () => number;
  timer?: boolean;
}): StoreBackupSchedule {
  const now = options.now ?? Date.now;
  let last: { at: number; fingerprint: string; changes: number } | null = null;

  function take(reason: BackupReason): StoreBackup | null {
    try {
      const backup = takeStoreBackup(options.db, { ...options, reason, now });
      const changes = (
        options.db.prepare("SELECT total_changes() AS n").get() as { n: number }
      ).n;
      last = {
        at: backup.manifest.takenAt,
        fingerprint: journalFingerprint(backup.manifest),
        changes,
      };
      pruneStoreBackups(options.backupsDir, now());
      options.onBackup?.(backup);
      return backup;
    } catch (error) {
      options.report(error);
      return null;
    }
  }

  function due(): BackupReason | null {
    const facts = readStoreFacts(options.db);
    // A store with no counter is not backed up: it has nothing to restore, and its backups would
    // push the real ones (of the counter this computer had before) out of the retention.
    if (!facts.enrollmentId) return null;
    if (!last) return "startup";
    if (journalFingerprint(facts) !== last.fingerprint)
      return "journal_changed";
    const changes = (
      options.db.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
    if (changes !== last.changes && now() - last.at >= BACKUP_MAX_AGE_MS)
      return "scheduled";
    return null;
  }

  function tick(): StoreBackup | null {
    let reason: BackupReason | null;
    try {
      reason = due();
    } catch (error) {
      // A failing disk is what backups exist for: report it, never throw out of a timer or into
      // start-up.
      options.report(error);
      return null;
    }
    return reason ? take(reason) : null;
  }

  tick();
  let interval: ReturnType<typeof setInterval> | null = null;
  if (options.timer !== false) {
    interval = setInterval(() => tick(), BACKUP_CHECK_MS);
    interval.unref();
  }
  return {
    tick,
    stop: () => {
      if (interval) clearInterval(interval);
    },
  };
}
