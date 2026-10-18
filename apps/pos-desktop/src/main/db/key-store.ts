import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * Whatever turns a secret into something only this Windows user on this
 * machine can read back. In the app that is Electron's safeStorage (DPAPI);
 * tests pass a fake.
 */
export interface SecretProtector {
  isAvailable(): boolean;
  protect(plain: string): Buffer;
  unprotect(blob: Buffer): string;
}

export type DatabaseKeyErrorCode = "PROTECTOR_UNAVAILABLE" | "KEY_MISSING" | "KEY_UNREADABLE";

export class DatabaseKeyError extends Error {
  constructor(
    readonly code: DatabaseKeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseKeyError";
  }
}

const KEY_HEX = /^[0-9a-f]{64}$/;

export function loadOrCreateDatabaseKey(opts: {
  keyPath: string;
  databasePath: string;
  protector: SecretProtector;
}): string {
  const { keyPath, databasePath, protector } = opts;

  // No plaintext fallback: without OS-backed protection the app does not start.
  if (!protector.isAvailable()) {
    throw new DatabaseKeyError("PROTECTOR_UNAVAILABLE", "The Windows credential store is not available.");
  }

  if (existsSync(keyPath)) {
    let key: string;
    try {
      key = protector.unprotect(readFileSync(keyPath));
    } catch {
      throw new DatabaseKeyError("KEY_UNREADABLE", "The database key could not be read by this Windows user.");
    }
    if (!KEY_HEX.test(key)) {
      throw new DatabaseKeyError("KEY_UNREADABLE", "The stored database key is not valid.");
    }
    return key;
  }

  // A database with no key is unreadable, but it may hold unsynchronised
  // sales. Minting a new key here would invite something to overwrite it, so
  // stop and leave the file for support to recover.
  if (existsSync(databasePath)) {
    throw new DatabaseKeyError("KEY_MISSING", "A local database exists but its key is missing.");
  }

  const key = randomBytes(32).toString("hex");
  const tmpPath = `${keyPath}.tmp`;
  writeFileSync(tmpPath, protector.protect(key));
  renameSync(tmpPath, keyPath);
  return key;
}
