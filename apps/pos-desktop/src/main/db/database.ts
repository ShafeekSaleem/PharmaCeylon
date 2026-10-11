import Database from "better-sqlite3-multiple-ciphers";

export type PosDatabase = Database.Database;

export class DatabaseOpenError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseOpenError";
  }
}

const KEY_HEX = /^[0-9a-f]{64}$/;

/**
 * Opens (or creates) the local database with SQLCipher 4 whole-file
 * encryption. There is no unencrypted mode: a missing or wrong key fails here.
 */
export function openEncryptedDatabase(path: string, keyHex: string): PosDatabase {
  if (!KEY_HEX.test(keyHex)) {
    throw new DatabaseOpenError("Database key must be 32 bytes of hex.");
  }

  const db = new Database(path);
  try {
    db.pragma("cipher = 'sqlcipher'");
    db.pragma("legacy = 4");
    db.pragma(`key = "x'${keyHex}'"`);
    // The key is only checked when a page is first read.
    db.prepare("SELECT count(*) FROM sqlite_master").get();

    db.pragma("journal_mode = WAL");
    // FULL, not NORMAL: a sale the cashier saw complete must survive a power
    // cut, and NORMAL in WAL mode can lose the last commits.
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch (cause) {
    db.close();
    throw new DatabaseOpenError("The local database could not be opened with the stored key.", { cause });
  }
}
