import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { root } from "./check-stack.mjs";

export const imageNames = { api: "pharmaceylon-api", migrate: "pharmaceylon-api-migrate", web: "pharmaceylon-web" };
export function docker(args, { capture = true } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", shell: false, stdio: capture ? "pipe" : "inherit", timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`docker ${args[0]} failed (exit ${r.status ?? "unknown"}).`);
  return r.stdout?.trim() ?? "";
}
export const inspect = (ref) => JSON.parse(docker(["image", "inspect", ref]))[0];
export function releaseTag(sha, run, attempt) {
  assert.match(sha ?? "", /^[a-f0-9]{40}$/, "A full commit SHA is required");
  assert.match(String(run), /^\d+$/, "A numeric CI run is required");
  assert.match(String(attempt), /^\d+$/, "A numeric CI attempt is required");
  // Reruns cannot silently repoint an earlier build's tag.
  return `sha-${sha}-run-${run}-${attempt}`;
}
export function assertImage(info, revision, service) {
  assert.equal(info.Os, "linux");
  assert.equal(info.Architecture, "amd64");
  assert.equal(info.Config.Labels?.["org.opencontainers.image.revision"], revision, `${service}: wrong image revision`);
  assert.equal(info.Config.Labels?.["org.opencontainers.image.source"], "https://github.com/ShafeekSaleem/PharmaCeylon");
  if (service === "web") assert.equal(info.Config.Labels?.["io.pharmaceylon.api-base"], "/api/v1", "Published web must use same-origin URLs");
}
export function exportImages(directory, revision, { archive = true } = {}) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  mkdirSync(directory, { recursive: true });
  const images = {};
  for (const [service, name] of Object.entries(imageNames)) {
    const local = `${name}:local`;
    const info = inspect(local);
    assertImage(info, revision, service);
    images[service] = { local, id: info.Id };
  }
  writeFileSync(path.join(directory, "image-set.json"), JSON.stringify({ revision, images }, null, 2));
  if (archive) docker(["image", "save", "-o", path.join(directory, "images.tar"), ...Object.values(images).map((i) => i.local)], { capture: false });
}
export function verifyImages(directory, revision) {
  const set = JSON.parse(readFileSync(path.join(directory, "image-set.json"), "utf8"));
  assert.equal(set.revision, revision);
  assert.deepEqual(Object.keys(set.images).sort(), Object.keys(imageNames).sort());
  for (const [service, name] of Object.entries(imageNames)) {
    assert.equal(set.images[service].local, `${name}:local`);
    const info = inspect(`${name}:local`);
    assert.equal(info.Id, set.images[service].id, "Only the tested/scanned image may be published");
    assertImage(info, revision, service);
  }
  return set;
}
export function makeBundle(directory) {
  const bundle = path.join(directory, "bundle");
  mkdirSync(bundle, { recursive: true });
  for (const file of ["compose.yaml", "compose.images.yaml", ".env.docker.example", "scripts/docker/check-stack.mjs", "scripts/docker/images.mjs", "scripts/docker/release-images.mjs", "docs/DOCKER_IMAGES.md"]) {
    mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(bundle, file));
  }
  copyFileSync(path.join(directory, "release.env"), path.join(bundle, "release.env"));
  copyFileSync(path.join(directory, "release.json"), path.join(bundle, "release.json"));
  writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ private: true, scripts:
    Object.fromEntries(["config", "pull", "up", "check", "ps", "logs", "stop", "down"].map((action) =>
      [`docker:images:${action}`, `node scripts/docker/images.mjs ${action}`])),
  }, null, 2));
  return bundle;
}
export function publishImages(directory, { revision, registry, run, attempt }) {
  // The only destinations supported by this project: GHCR, or CI's local registry.
  assert.ok(registry === "ghcr.io/shafeeksaleem" || (registry === "localhost:5000" && process.env.GITHUB_ACTIONS === "true"), "Unsupported registry destination");
  const tag = releaseTag(revision, run, attempt);
  const set = verifyImages(directory, revision);
  const images = {};
  for (const [service, name] of Object.entries(imageNames)) {
    const repo = `${registry}/${name}`;
    const tagged = `${repo}:${tag}`;
    docker(["image", "tag", set.images[service].local, tagged]);
    docker(["image", "push", tagged], { capture: false });
    docker(["image", "pull", tagged], { capture: false });
    const info = inspect(tagged);
    assert.equal(info.Id, set.images[service].id, "Registry returned a different image");
    const digest = info.RepoDigests?.find((ref) => ref.startsWith(`${repo}@sha256:`));
    assert.match(digest ?? "", /@sha256:[a-f0-9]{64}$/);
    images[service] = { tag: tagged, digest, id: info.Id };
  }
  // No release lock is emitted for a partial push. Existing digests are never deleted.
  writeFileSync(path.join(directory, "release.json"), JSON.stringify({ revision, tag, platform: "linux/amd64", images }, null, 2));
  writeFileSync(path.join(directory, "release.env"), `RELEASE_SHA=${revision}\nAPI_IMAGE=${images.api.digest}\nMIGRATE_IMAGE=${images.migrate.digest}\nWEB_IMAGE=${images.web.digest}\n`);
  makeBundle(directory);
  return images;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = path.join(root, "release");
    const revision = process.env.GITHUB_SHA;
    if (process.argv[2] === "export") exportImages(directory, revision);
    else if (process.argv[2] === "verify") verifyImages(directory, revision);
    else if (process.argv[2] === "publish") {
      assert.equal(process.env.GITHUB_EVENT_NAME, "push");
      assert.equal(process.env.GITHUB_REF, "refs/heads/develop");
      assert.equal(process.env.GITHUB_REPOSITORY, "ShafeekSaleem/PharmaCeylon");
      publishImages(directory, { revision, registry: "ghcr.io/shafeeksaleem", run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT });
    } else throw new Error("Expected export, verify, or publish");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
