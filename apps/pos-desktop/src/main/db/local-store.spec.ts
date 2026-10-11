import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLocalStore } from "../local-store";
import { DatabaseOpenError, openEncryptedDatabase } from "./database";
import { DatabaseKeyError, loadOrCreateDatabaseKey, type SecretProtector } from "./key-store";
import { MigrationError, runMigrations, type Migration } from "./migrator";
import { migrations } from "./migrations";

/** Stands in for DPAPI: reversible, but the stored bytes are not the key. */
const fakeProtector: SecretProtector = {
  isAvailable: () => true,
  protect: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
  unprotect: (blob) => blob.toString("utf8").split("").reverse().join(""),
};

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pos-db-spec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("openEncryptedDatabase", () => {
  it("writes nothing readable to disk", () => {
    const path = join(dir, "pos.db");
    const db = openEncryptedDatabase(path, KEY_A);
    db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('plaintext-canary')");
    expect(readFileSync(`${path}-wal`).includes("plaintext-canary")).toBe(false);
    db.close();

    const raw = readFileSync(path);
    expect(raw.subarray(0, 15).toString("latin1")).not.toBe("SQLite format 3");
    expect(raw.includes("plaintext-canary")).toBe(false);
  });

  it("reads its own data back with the same key", () => {
    const path = join(dir, "pos.db");
    const first = openEncryptedDatabase(path, KEY_A);
    first.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    first.close();

    const second = openEncryptedDatabase(path, KEY_A);
    expect(second.prepare("SELECT v FROM t").get()).toEqual({ v: "kept" });
    second.close();
  });

  it("refuses the wrong key", () => {
    const path = join(dir, "pos.db");
    const db = openEncryptedDatabase(path, KEY_A);
    db.exec("CREATE TABLE t (v TEXT)");
    db.close();

    expect(() => openEncryptedDatabase(path, KEY_B)).toThrow(DatabaseOpenError);
  });

  it("refuses a key that is not 32 bytes of hex", () => {
    expect(() => openEncryptedDatabase(join(dir, "pos.db"), "short")).toThrow(DatabaseOpenError);
    expect(existsSync(join(dir, "pos.db"))).toBe(false);
  });

  it("is durable and enforces foreign keys", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2); // FULL
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});

describe("loadOrCreateDatabaseKey", () => {
  const paths = () => ({ keyPath: join(dir, "pos.db.key"), databasePath: join(dir, "pos.db") });

  it("creates a key once and returns the same one afterwards", () => {
    const first = loadOrCreateDatabaseKey({ ...paths(), protector: fakeProtector });
    const second = loadOrCreateDatabaseKey({ ...paths(), protector: fakeProtector });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(readFileSync(paths().keyPath).includes(first)).toBe(false);
  });

  it("does not start without OS-backed protection", () => {
    const unavailable = { ...fakeProtector, isAvailable: () => false };
    expect(() => loadOrCreateDatabaseKey({ ...paths(), protector: unavailable })).toThrow(
      expect.objectContaining({ code: "PROTECTOR_UNAVAILABLE" }),
    );
    expect(existsSync(paths().keyPath)).toBe(false);
  });

  it("never mints a new key over an existing database", () => {
    writeFileSync(paths().databasePath, "pretend this holds unsynchronised sales");
    expect(() => loadOrCreateDatabaseKey({ ...paths(), protector: fakeProtector })).toThrow(
      expect.objectContaining({ code: "KEY_MISSING" }),
    );
    expect(existsSync(paths().keyPath)).toBe(false);
  });

  it("reports a key another Windows user cannot decrypt", () => {
    loadOrCreateDatabaseKey({ ...paths(), protector: fakeProtector });
    const otherUser: SecretProtector = {
      ...fakeProtector,
      unprotect: () => {
        throw new Error("DPAPI: key not valid for use in specified state");
      },
    };
    expect(() => loadOrCreateDatabaseKey({ ...paths(), protector: otherUser })).toThrow(DatabaseKeyError);
  });

  it("rejects a corrupted key file", () => {
    writeFileSync(paths().keyPath, fakeProtector.protect("not-a-key"));
    expect(() => loadOrCreateDatabaseKey({ ...paths(), protector: fakeProtector })).toThrow(
      expect.objectContaining({ code: "KEY_UNREADABLE" }),
    );
  });
});

describe("runMigrations", () => {
  const one: Migration = { version: 1, name: "one", up: (db) => db.exec("CREATE TABLE a (id INTEGER PRIMARY KEY)") };
  const two: Migration = { version: 2, name: "two", up: (db) => db.exec("CREATE TABLE b (id INTEGER PRIMARY KEY)") };
  const tables = (db: ReturnType<typeof openEncryptedDatabase>) =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );

  it("applies pending migrations in order and only once", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    expect(runMigrations(db, [one])).toEqual({ from: 0, to: 1, applied: [1] });
    expect(runMigrations(db, [one, two])).toEqual({ from: 1, to: 2, applied: [2] });
    expect(runMigrations(db, [one, two])).toEqual({ from: 2, to: 2, applied: [] });
    expect(tables(db)).toEqual(["a", "b", "schema_migrations"]);
    db.close();
  });

  it("rolls a failed migration back completely and keeps the earlier ones", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    const broken: Migration = {
      version: 2,
      name: "broken",
      up: (d) => {
        d.exec("CREATE TABLE half_done (id INTEGER PRIMARY KEY)");
        throw new Error("boom");
      },
    };
    expect(() => runMigrations(db, [one, broken])).toThrow("boom");
    expect(tables(db)).toEqual(["a", "schema_migrations"]);

    // The fixed build picks up where the failed one stopped.
    expect(runMigrations(db, [one, two])).toEqual({ from: 1, to: 2, applied: [2] });
    db.close();
  });

  it("refuses a database that a newer app has already upgraded", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    runMigrations(db, [one, two]);
    expect(() => runMigrations(db, [one])).toThrow(expect.objectContaining({ code: "SCHEMA_NEWER_THAN_APP" }));
    db.close();
  });

  it("refuses a database whose history is not this app's", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    runMigrations(db, [one]);
    const renamed = { ...one, name: "something-else" };
    expect(() => runMigrations(db, [renamed, two])).toThrow(expect.objectContaining({ code: "HISTORY_MISMATCH" }));
    expect(tables(db)).toEqual(["a", "schema_migrations"]);
    db.close();
  });

  it("refuses a migration list with a gap", () => {
    const db = openEncryptedDatabase(join(dir, "pos.db"), KEY_A);
    expect(() => runMigrations(db, [one, { ...two, version: 3 }])).toThrow(MigrationError);
    expect(tables(db)).toEqual([]);
    db.close();
  });

  it("keeps the shipped migration list contiguous", () => {
    expect(migrations.map((migration) => migration.version)).toEqual(migrations.map((_, index) => index + 1));
  });
});

describe("openLocalStore", () => {
  it("survives a restart: same key, same data, no re-migration", () => {
    const first = openLocalStore(dir, fakeProtector, migrations);
    first.db.prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('k', 'v', 'now')").run();
    first.db.close();

    const second = openLocalStore(dir, fakeProtector, migrations);
    expect(second.schemaVersion).toBe(migrations.length);
    expect(second.db.prepare("SELECT value FROM app_meta WHERE key = 'k'").get()).toEqual({ value: "v" });
    second.db.close();
  });

  it("does not replace a lost key", () => {
    const store = openLocalStore(dir, fakeProtector, migrations);
    store.db.close();
    rmSync(store.keyPath);

    expect(() => openLocalStore(dir, fakeProtector, migrations)).toThrow(
      expect.objectContaining({ code: "KEY_MISSING" }),
    );
    expect(existsSync(store.databasePath)).toBe(true);
  });
});
