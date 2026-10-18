// Launches the app with --smoke-test against a throwaway data directory and
// reports what it found. `--packaged` runs release/win-unpacked (after
// `npm run package`); without it, the built dist/ runs under the dev Electron.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const packaged = process.argv.includes("--packaged");

let command;
let args;
if (packaged) {
  const unpacked = join(appDir, "release", "win-unpacked");
  const exe = existsSync(unpacked) && readdirSync(unpacked).find((name) => name.endsWith(".exe"));
  if (!exe) {
    console.error("No packaged app in release/win-unpacked. Run `npm run package -w pos-desktop` first.");
    process.exit(2);
  }
  command = join(unpacked, exe);
  args = ["--smoke-test"];
} else {
  command = createRequire(import.meta.url)("electron");
  args = [appDir, "--smoke-test"];
}

const smokeDir = mkdtempSync(join(tmpdir(), "pos-smoke-"));
const env = { ...process.env, POS_SMOKE_DIR: smokeDir };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;

const run = spawnSync(command, args, { env, stdio: "inherit", timeout: 120_000 });

let exitCode = 1;
const resultPath = join(smokeDir, "smoke-result.json");
if (existsSync(resultPath)) {
  const result = JSON.parse(readFileSync(resultPath, "utf8"));
  for (const check of result.checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `  (${check.detail})` : ""}`);
  }
  console.log(`\n${result.packaged ? "Packaged" : "Unpackaged"} smoke test ${result.ok ? "passed" : "FAILED"}.`);
  if (result.ok && run.status === 0 && result.packaged === packaged) exitCode = 0;
} else {
  console.error(`Smoke test produced no result (exit ${run.status}, signal ${run.signal}).`);
}

rmSync(smokeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
process.exit(exitCode);
