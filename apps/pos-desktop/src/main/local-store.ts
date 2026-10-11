import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEncryptedDatabase, type PosDatabase } from "./db/database";
import { loadOrCreateDatabaseKey, type SecretProtector } from "./db/key-store";
import { runMigrations, type Migration } from "./db/migrator";

export type LocalStore = { db: PosDatabase; schemaVersion: number; databasePath: string; keyPath: string };

/**
 * Key → open → migrate, in that order and before any window exists. If any
 * step throws, the caller must not show the POS.
 */
export function openLocalStore(dataDir: string, protector: SecretProtector, migrations: readonly Migration[]): LocalStore {
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, "pos.db");
  const keyPath = join(dataDir, "pos.db.key");

  const key = loadOrCreateDatabaseKey({ keyPath, databasePath, protector });
  const db = openEncryptedDatabase(databasePath, key);
  try {
    const { to } = runMigrations(db, migrations);
    return { db, schemaVersion: to, databasePath, keyPath };
  } catch (error) {
    db.close();
    throw error;
  }
}
