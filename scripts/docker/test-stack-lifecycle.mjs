// Destructive lifecycle checks belong only in an isolated, disposable CI project.
// This is deliberately not exposed as an everyday npm command.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkStack, compose, hostOrigin, parseServices } from "./check-stack.mjs";

async function main() {
  const project = process.env.COMPOSE_PROJECT_NAME;
  if (process.env.GITHUB_ACTIONS !== "true" || !/^pharmaceylon-ci-\d+-\d+$/.test(project ?? "") ||
      process.env.DOCKER_LIFECYCLE_TEST_ACK !== "ephemeral-compose-project") {
    throw new Error("Refusing lifecycle test outside the acknowledged ephemeral GitHub CI project.");
  }
  const config = JSON.parse(compose(["config", "--format", "json"]));
  assert.equal(config.name, project, "Resolved Compose project must match the CI project");
  const web = hostOrigin(config, "web", 3000).replace("localhost", "127.0.0.1");
  const token = randomUUID();
  const filename = `docker-phase5-${token}.txt`;
  const sql = (input) => compose([
    "exec", "-T", "db", "sh", "-c",
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
  ], { input });
  const migrations = () => sql('SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;');

  await checkStack();
  compose(["exec", "-T", "api", "node", "-e", `
    const assert = require('node:assert/strict');
    (async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('ci-dependency-smoke', 4);
      assert.equal(await bcrypt.compare('ci-dependency-smoke', hash), true);
      assert.equal(await bcrypt.compare('wrong-password', hash), false);
      const XLSX = require('xlsx');
      const rows = [['sku', 'qty'], ['CI-SKU', 7]];
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Smoke');
      const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
      const read = XLSX.read(bytes, { type: 'buffer' });
      assert.deepEqual(XLSX.utils.sheet_to_json(read.Sheets.Smoke, { header: 1 }), rows);
      const sharp = require('sharp');
      const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
      const resized = await sharp(png).resize(1, 1).png().toBuffer();
      assert.equal((await sharp(resized).metadata()).width, 1);
      assert.equal(require('node:fs').existsSync('/usr/local/lib/node_modules/npm'), false);
    })().catch((error) => { console.error(error.message); process.exit(1); });
  `]);
  console.log("PASS: bcrypt hash verification, XLSX workbook round-trip, and sharp image processing.");
  const migrationCount = migrations();
  assert.ok(Number(migrationCount) > 0, "Empty DB must have been migrated by Compose");
  sql(`CREATE SCHEMA docker_phase5_probe;
CREATE TABLE docker_phase5_probe.marker (value text NOT NULL);
INSERT INTO docker_phase5_probe.marker VALUES ('${token}');`);
  compose(["exec", "-T", "api", "node", "-e",
    "if (process.getuid() === 0) process.exit(1); require('node:fs').writeFileSync('storage/uploads/' + process.argv[1], process.argv[2], { flag: 'wx' });",
    filename, token,
  ]);
  compose(["exec", "-T", "web", "node", "-e", "if (process.getuid() === 0) process.exit(1);"]);
  const verifyUpload = async () => {
    const response = await fetch(`${web}/uploads/${filename}`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
    assert.equal(response.status, 200, "Uploads must be reachable through Next's proxy");
    assert.equal(await response.text(), token);
  };
  await verifyUpload();
  console.log("PASS: non-root API/web; writable uploads volume; upload proxy.");

  compose(["run", "--rm", "migrate"], { capture: false });
  assert.equal(migrations(), migrationCount, "Migration rerun must not duplicate history");
  compose(["down"], { capture: false }); // No --volumes: deliberately preserve both markers.
  compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "180", "web"], { capture: false });
  await checkStack();
  assert.equal(sql("SELECT value FROM docker_phase5_probe.marker;"), token);
  assert.equal(migrations(), migrationCount);
  await verifyUpload();
  console.log("PASS: database/upload markers survived down/up; migrations remained idempotent.");

  // Negative control: a failed one-shot job must block API and web startup.
  // Stop existing containers first: depends_on does not stop already-running APIs.
  compose(["down"], { capture: false });
  const temp = mkdtempSync(path.join(os.tmpdir(), "pharmaceylon-migrate-failure-"));
  try {
    const override = path.join(temp, "failure.json");
    writeFileSync(override, JSON.stringify({ services: { migrate: { command: ["node", "-e", "process.exit(42)"] } } }));
    let failed = false;
    try { compose(["up", "-d", "--no-build", "web"], { files: [override] }); }
    catch { failed = true; }
    assert.ok(failed, "Compose must fail when migration exits 42");
    const services = parseServices(compose(["ps", "--all", "--format", "json"]));
    assert.equal(Number(services.find((entry) => entry.Service === "migrate")?.ExitCode), 42);
    assert.ok(!services.some((entry) => ["api", "web"].includes(entry.Service) && entry.State === "running"));
    console.log("PASS: failed migration blocked API/web startup (expected exit 42).");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
