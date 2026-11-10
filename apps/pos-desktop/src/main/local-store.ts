import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openEncryptedDatabase, type PosDatabase } from "./db/database";
import { loadOrCreateDatabaseKey, type SecretProtector } from "./db/key-store";
import { currentSchemaVersion, runMigrations, type Migration } from "./db/migrator";

export type LocalStore = { db: PosDatabase; schemaVersion: number; databasePath: string; keyPath: string };

/**
 * Key → open → migrate, in that order and before any window exists. If any
 * step throws, the caller must not show the POS.
 *
 * `beforeUpgrade` runs once the store is open and before a store that already has a schema is
 * upgraded (P5 #51: a backup is taken there, so a failed upgrade never costs the journal).
 */
export function openLocalStore(
  dataDir: string,
  protector: SecretProtector,
  migrations: readonly Migration[],
  options: { beforeUpgrade?: (store: Omit<LocalStore, "schemaVersion"> & { from: number }) => void } = {},
): LocalStore {
  mkdirSync(dataDir, { recursive: true });
  const databasePath = join(dataDir, "pos.db");
  const keyPath = join(dataDir, "pos.db.key");

  const key = loadOrCreateDatabaseKey({ keyPath, databasePath, protector });
  const db = openEncryptedDatabase(databasePath, key);
  try {
    const from = currentSchemaVersion(db);
    if (options.beforeUpgrade && from > 0 && from < migrations.length)
      options.beforeUpgrade({ db, databasePath, keyPath, from });
    const { to } = runMigrations(db, migrations);
    return { db, schemaVersion: to, databasePath, keyPath };
  } catch (error) {
    db.close();
    throw error;
  }
}
