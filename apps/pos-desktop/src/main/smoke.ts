import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ipcContract } from "../shared/ipc-contract";
import { openEncryptedDatabase } from "./db/database";
import type { SecretProtector } from "./db/key-store";
import { migrations } from "./db/migrations";
import { openLocalStore } from "./local-store";
import { createMainWindow } from "./window";

type Check = { name: string; ok: boolean; detail?: string };

const MARKER = "smoke-marker-7f3a9c";

function fileContains(path: string, needle: string): boolean {
  return existsSync(path) && readFileSync(path).includes(needle);
}

/**
 * `--smoke-test`: proves, in the real (ideally packaged) binary, the things a
 * unit test cannot — that the native SQLite binding loads, the database on
 * disk is actually encrypted, the key is protected by Windows, and the
 * renderer comes up sandboxed with only the contract's bridge.
 */
export async function runSmokeTest(opts: {
  dataDir: string;
  protector: SecretProtector;
  registerIpc: (schemaVersion: number) => void;
}): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  try {
    check("credential store available", opts.protector.isAvailable());

    const store = openLocalStore(opts.dataDir, opts.protector, migrations);
    check("migrations applied", store.schemaVersion === migrations.length, `schema ${store.schemaVersion}`);
    store.db
      .prepare("INSERT INTO app_meta (key, value, updated_at) VALUES ('smoke', ?, ?)")
      .run(MARKER, new Date().toISOString());
    // Checked before close, while the row is still in the WAL.
    check("WAL is encrypted", !fileContains(`${store.databasePath}-wal`, MARKER));
    store.db.close();

    const header = readFileSync(store.databasePath).subarray(0, 15).toString("latin1");
    check("database file is not plaintext SQLite", header !== "SQLite format 3");
    check("database file does not leak row data", !fileContains(store.databasePath, MARKER));

    const key = opts.protector.unprotect(readFileSync(store.keyPath));
    check("key file does not hold the raw key", !fileContains(store.keyPath, key));

    const reopened = openEncryptedDatabase(store.databasePath, key);
    const row = reopened.prepare("SELECT value FROM app_meta WHERE key = 'smoke'").get() as { value: string };
    check("data reads back after reopen", row.value === MARKER);
    reopened.close();

    let wrongKeyRejected = false;
    try {
      openEncryptedDatabase(store.databasePath, "0".repeat(64)).close();
    } catch {
      wrongKeyRejected = true;
    }
    check("wrong key is rejected", wrongKeyRejected);

    opts.registerIpc(store.schemaVersion);
    const window = createMainWindow({ devServerUrl: null, show: false });
    await new Promise<void>((resolve, reject) => {
      window.webContents.once("did-finish-load", () => resolve());
      window.webContents.once("did-fail-load", (_e, code, description) => reject(new Error(`${code} ${description}`)));
    });
    const page = (await window.webContents.executeJavaScript(`(async () => ({
      bridge: Object.keys(window.pos ?? {}).sort(),
      require: typeof require,
      process: typeof process,
      evalBlocked: (() => { try { new Function("return 1")(); return false; } catch { return true; } })(),
      rendered: document.getElementById("root").childElementCount > 0,
      info: await window.pos.getAppInfo(),
    }))()`)) as {
      bridge: string[];
      require: string;
      process: string;
      evalBlocked: boolean;
      rendered: boolean;
      info: { appVersion: string; schemaVersion: number };
    };
    window.destroy();

    const expectedBridge = Object.keys(ipcContract).sort();
    check("bridge exposes exactly the contract", JSON.stringify(page.bridge) === JSON.stringify(expectedBridge));
    check("renderer has no Node access", page.require === "undefined" && page.process === "undefined");
    check("CSP blocks eval", page.evalBlocked);
    check("renderer mounted", page.rendered);
    check("IPC round trip", page.info.appVersion === app.getVersion() && page.info.schemaVersion === migrations.length);
  } catch (error) {
    check("smoke test ran to completion", false, error instanceof Error ? error.message : String(error));
  }

  const result = { ok: checks.every((c) => c.ok), packaged: app.isPackaged, checks };
  writeFileSync(join(opts.dataDir, "..", "smoke-result.json"), JSON.stringify(result, null, 2));
  return result;
}
