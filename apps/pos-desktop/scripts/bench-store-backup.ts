/**
 * #166: how long a store backup takes on a realistic counter, step by step, and how long a
 * checkout-sized write waits while one runs. Not part of the test suite; run it by hand:
 *
 *   npx tsx scripts/bench-store-backup.ts [days] [salesPerDay]
 *
 * It seeds a fresh encrypted store under the OS temp folder with `days` of trading at
 * `salesPerDay` online sales a day (a checkout draft and its signed command each), a tenth of that
 * as offline journal entries, and a 15 000-line stock snapshot, then times each step of a backup
 * as the main process used to run it, and the whole backup in the worker (loaded through tsx
 * here, so its start-up is a little slower than the app's built worker). Nothing in the store is
 * ever pruned, so a counter that has traded for a year carries a year of rows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  copyInWorker,
  identity,
  seedDevice,
  seedPin,
  windowsUser,
} from "../src/main/backup/backup.kit";
import {
  openCipherFile,
  readStoreFacts,
  readWrappedKey,
  startStoreBackups,
} from "../src/main/backup/store-backup";
import { migrations } from "../src/main/db/migrations";
import { openLocalStore } from "../src/main/local-store";

const days = Number(process.argv[2] ?? 365);
const salesPerDay = Number(process.argv[3] ?? 400);
const sales = days * salesPerDay;
const journal = Math.round(sales / 10);
const protector = windowsUser("bench\\pos");

const root = mkdtempSync(join(tmpdir(), "pos-backup-bench-"));
const dataDir = join(root, "data");
const local = openLocalStore(dataDir, protector, migrations);
const db = local.db;

/** Roughly the size of the JSON a real sale carries (5 lines, a signature, ids). */
const blob = (bytes: number) =>
  randomBytes(Math.ceil(bytes * 0.75)).toString("base64");
const iso = (i: number) =>
  new Date(Date.UTC(2025, 10, 1) + i * 60_000).toISOString();

function seed(): void {
  seedDevice(db);
  seedPin(db);
  const draft = db.prepare(
    `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, sale_id, invoice_no, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1000, 'completed', ?, ?, ?, ?)`,
  );
  const command = db.prepare(
    `INSERT INTO signed_command (command_id, operation, staff_user_id, envelope_json, attendance_proof_id, status, receipt_json, created_at, updated_at)
     VALUES (?, 'checkout.complete', ?, ?, ?, 'receipted', ?, ?, ?)`,
  );
  const entry = db.prepare(
    `INSERT INTO offline_journal_command (command_id, enrollment_id, sequence, previous_hash, payload_hash, envelope_json, sync_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'synced', ?)`,
  );
  const staffId = randomUUID();
  const session = randomUUID();
  const batch = 5_000;
  for (let start = 0; start < sales; start += batch) {
    db.transaction(() => {
      for (let i = start; i < Math.min(sales, start + batch); i++) {
        const at = iso(i);
        draft.run(
          randomUUID(),
          session,
          staffId,
          blob(1_500),
          randomUUID(),
          `INV-${i}`,
          at,
          at,
        );
        command.run(
          randomUUID(),
          staffId,
          blob(2_000),
          randomUUID(),
          blob(800),
          at,
          at,
        );
      }
    })();
  }
  let previous: string | null = null;
  db.transaction(() => {
    for (let i = 1; i <= journal; i++) {
      const hash = randomBytes(32).toString("hex");
      entry.run(
        randomUUID(),
        identity.enrollmentId,
        i,
        previous,
        hash,
        blob(2_000),
        iso(i),
      );
      previous = hash;
    }
  })();
  db.prepare(
    "INSERT INTO offline_authority (enrollment_id, version, grant_envelope, snapshot_envelope) VALUES (?, 1, ?, ?)",
  ).run(identity.enrollmentId, blob(4_000), blob(15_000 * 250));
  db.pragma("wal_checkpoint(TRUNCATE)");
}

function time<T>(label: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  console.log(
    `  ${label.padEnd(34)} ${(performance.now() - started).toFixed(0).padStart(7)} ms`,
  );
  return result;
}

/** The steps `takeStoreBackup` ran on the main process before #166, each timed. */
function stepsOnMainProcess(): void {
  const dir = mkdtempSync(join(root, "steps-"));
  const copyPath = join(dir, "pos.db");
  const liveKey = readWrappedKey(local.keyPath, protector);
  time("readStoreFacts", () => readStoreFacts(db));
  time("VACUUM INTO (live store)", () =>
    db.prepare("VACUUM INTO ?").run(copyPath),
  );
  const copy = openCipherFile(copyPath, liveKey);
  time("DELETE staff_credential + meta", () => {
    copy.pragma("journal_mode = DELETE");
    copy.pragma("secure_delete = ON");
    copy.prepare("DELETE FROM staff_credential").run();
  });
  time("VACUUM (copy)", () => copy.exec("VACUUM"));
  const backupKey = randomBytes(32).toString("hex");
  time("rekey (copy)", () => copy.pragma(`rekey = "x'${backupKey}'"`));
  copy.close();
  const check = openCipherFile(copyPath, backupKey, { readonly: true });
  time("quick_check (copy)", () =>
    check.pragma("quick_check", { simple: true }),
  );
  check.close();
  rmSync(dir, { recursive: true, force: true });
}

/** A checkout-sized write every 20 ms while the worker backs up; reports how long each waited. */
async function writesDuringWorkerBackup(): Promise<void> {
  const write = db.prepare(
    `INSERT INTO checkout_draft (id, work_session_id, staff_user_id, request_json, total_minor, status, created_at, updated_at)
     VALUES (?, 'bench', 'bench', ?, 1000, 'submitted', ?, ?)`,
  );
  const latencies: number[] = [];
  let lastTick = performance.now();
  const loopStalls: number[] = [];
  const ticker = setInterval(() => {
    const at = performance.now();
    loopStalls.push(at - lastTick - 20);
    lastTick = at;
    const started = performance.now();
    write.run(randomUUID(), blob(1_500), iso(0), iso(0));
    latencies.push(performance.now() - started);
  }, 20);
  const started = performance.now();
  const backups = startStoreBackups({
    db,
    keyPath: local.keyPath,
    backupsDir: join(root, "backups"),
    protector,
    appVersion: "bench",
    runCopy: copyInWorker,
    report: (error) => console.error(error),
    timer: false,
  });
  const backup = await backups.idle().finally(() => clearInterval(ticker));
  backups.stop();
  const sorted = [...latencies].sort((a, b) => a - b);
  const stalls = [...loopStalls].sort((a, b) => a - b);
  console.log(
    `  whole backup in the worker         ${(performance.now() - started).toFixed(0).padStart(7)} ms`,
  );
  console.log(
    `  copy written                       ${backup ? (backup.manifest.bytes / 2 ** 20).toFixed(0) : "none"} MB`,
  );
  console.log(
    `  ${latencies.length} writes meanwhile: p50 ${sorted[Math.floor(sorted.length / 2)]?.toFixed(1)} ms, max ${sorted.at(-1)?.toFixed(1)} ms; ` +
      `event-loop lateness max ${stalls.at(-1)?.toFixed(0)} ms`,
  );
}

async function main(): Promise<void> {
  console.log(
    `Seeding ${days} days x ${salesPerDay} sales (${sales} drafts + ${sales} signed commands, ${journal} journal entries)...`,
  );
  time("seed", seed);
  const bytes = statSync(join(dataDir, "pos.db")).size;
  console.log(
    `Store: ${(bytes / 2 ** 20).toFixed(0)} MB\nSteps as they ran on the main process:`,
  );
  stepsOnMainProcess();
  console.log("Backup in the worker, with checkout writes running:");
  await writesDuringWorkerBackup();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
