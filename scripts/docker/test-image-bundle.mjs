import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function testBundle(bundle) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Bundle lifecycle testing is CI-only");
  assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? "", /^\d+$/);
  assert.ok(!existsSync(path.join(bundle, "apps")), "Test a source-free bundle");
  copyFileSync(path.join(bundle, ".env.docker.example"), path.join(bundle, ".env.docker"));
  copyFileSync(path.join(bundle, "release.env"), path.join(bundle, ".env.images"));
  const env = { ...process.env,
    COMPOSE_PROJECT_NAME: `pharmaceylon-ci-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-images`,
    POSTGRES_PORT: "5434", API_PORT: "3005", WEB_PORT: "3004", WEB_ORIGINS: "http://localhost:3004",
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: bundle, env, stdio: "inherit", timeout: 600_000, shell: false });
    assert.equal(result.status, 0, `${command} ${args[0]} failed`);
  };
  const compose = ["compose", "--env-file", ".env.docker", "--env-file", ".env.images", "-f", "compose.yaml", "-f", "compose.images.yaml"];
  try {
    run(process.execPath, ["scripts/docker/images.mjs", "up"]);
    // Same digest, another browser port, without source or rebuilding.
    env.WEB_PORT = "3006"; env.WEB_ORIGINS = "http://localhost:3006";
    run(process.execPath, ["scripts/docker/images.mjs", "up"]);
    console.log("PASS: digest-pinned source-free bundle runs on two browser ports without rebuilding.");
  } finally {
    // This project name was generated above, never supplied by a local operator.
    spawnSync("docker", [...compose, "logs", "--no-color", "--tail", "60"], { cwd: bundle, env, stdio: "inherit" });
    run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { testBundle(path.resolve(process.argv[2])); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
