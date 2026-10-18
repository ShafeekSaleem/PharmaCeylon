import type { PosDatabase } from "./database";

export type Migration = {
  version: number;
  name: string;
  up(db: PosDatabase): void;
};

export type MigrationErrorCode = "INVALID_MIGRATION_LIST" | "SCHEMA_NEWER_THAN_APP" | "HISTORY_MISMATCH";

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

export type MigrationResult = { from: number; to: number; applied: number[] };

type AppliedRow = { version: number; name: string };

function readApplied(db: PosDatabase): AppliedRow[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT
  `);
  return db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as AppliedRow[];
}

export function currentSchemaVersion(db: PosDatabase): number {
  return readApplied(db).at(-1)?.version ?? 0;
}

/**
 * Forward-only, numbered migrations. Each one commits together with its
 * schema_migrations row, so a crash mid-upgrade leaves the database at a
 * whole version and the next start carries on from there.
 */
export function runMigrations(db: PosDatabase, migrations: readonly Migration[]): MigrationResult {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MigrationError(
        "INVALID_MIGRATION_LIST",
        `Migrations must be numbered 1..n in order; found ${migration.version} at position ${index + 1}.`,
      );
    }
  });

  const applied = readApplied(db);
  const from = applied.at(-1)?.version ?? 0;

  // An older app must not open a database a newer one has already upgraded.
  if (from > migrations.length) {
    throw new MigrationError(
      "SCHEMA_NEWER_THAN_APP",
      `Database is at schema ${from} but this app only knows up to ${migrations.length}.`,
    );
  }
  for (const row of applied) {
    const known = migrations[row.version - 1];
    if (!known || known.name !== row.name) {
      throw new MigrationError("HISTORY_MISMATCH", `Applied migration ${row.version} (${row.name}) is not in this app.`);
    }
  }

  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  const appliedNow: number[] = [];
  for (const migration of migrations.slice(from)) {
    db.transaction(() => {
      migration.up(db);
      record.run(migration.version, migration.name, new Date().toISOString());
    }).immediate();
    appliedNow.push(migration.version);
  }

  return { from, to: migrations.length, applied: appliedNow };
}
