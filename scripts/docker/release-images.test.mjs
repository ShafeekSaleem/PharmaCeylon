import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { releaseTag, assertImage } from "./release-images.mjs";
import { assertContainerImage, validateImageConfig } from "./images.mjs";
import { assessReport } from "./scan-images.mjs";
import { getApiBaseUrl } from "../../apps/web/src/lib/api-base.ts";

const revision = "a".repeat(40);
test("release tags identify the commit and cannot collide across CI reruns", () => {
  assert.equal(releaseTag(revision, "123", "1"), `sha-${revision}-run-123-1`);
  assert.notEqual(releaseTag(revision, "123", "1"), releaseTag(revision, "123", "2"));
  assert.throws(() => releaseTag("develop", "123", "1"));
  assert.throws(() => releaseTag(revision, "$(secret)", "1"));
});
test("image identity and public-URL checks reject mismatched or nonportable artifacts", () => {
  const info = { Os: "linux", Architecture: "amd64", Config: { Labels: {
    "org.opencontainers.image.revision": revision,
    "org.opencontainers.image.source": "https://github.com/ShafeekSaleem/PharmaCeylon",
    "io.pharmaceylon.api-base": "/api/v1",
  } } };
  assertImage(info, revision, "web");
  assert.throws(() => assertImage(info, "b".repeat(40), "web"));
  info.Config.Labels["io.pharmaceylon.api-base"] = "http://localhost:3000/api/v1";
  assert.throws(() => assertImage(info, revision, "web"));
  const container = { Image: "sha256:tested", Config: { Labels: { "io.pharmaceylon.expected-revision": revision } } };
  assertContainerImage(container, { Id: "sha256:tested" }, revision, "web");
  assert.throws(() => assertContainerImage(container, { Id: "sha256:older" }, revision, "web"));
  assert.throws(() => assertContainerImage(container, { Id: "sha256:tested" }, "b".repeat(40), "web"));
});
const imageConfig = () => ({ services: Object.fromEntries([
  ["api", "pharmaceylon-api"], ["migrate", "pharmaceylon-api-migrate"], ["web", "pharmaceylon-web"],
].map(([service, name]) => [service, {
  image: `ghcr.io/shafeeksaleem/${name}@sha256:${"b".repeat(64)}`,
  labels: { "io.pharmaceylon.expected-revision": revision },
  ports: [{ target: service === "web" ? 3000 : 3001, published: service === "web" ? "3006" : "3005", host_ip: "127.0.0.1" }],
  environment: { API_PROXY_TARGET: "http://api:3001", WEB_ORIGINS: "http://localhost:3006" },
}])) });
test("image-only configuration rejects source builds, mutable tags, and mixed releases", () => {
  assert.equal(validateImageConfig(imageConfig()), revision);
  for (const patch of [
    { build: { context: "." } }, { image: "ghcr.io/shafeeksaleem/pharmaceylon-api:latest" },
    { labels: { "io.pharmaceylon.expected-revision": "c".repeat(40) } },
  ]) {
    const config = imageConfig(); Object.assign(config.services.api, patch);
    assert.throws(() => validateImageConfig(config));
  }
});
test("scan policy blocks fixable high/critical findings and reports unfixed findings", () => {
  const report = { ArtifactName: "api:local", Results: [{ Vulnerabilities: [
    { Severity: "CRITICAL", FixedVersion: "2" }, { Severity: "HIGH", FixedVersion: "3" },
    { Severity: "HIGH", FixedVersion: "" }, { Severity: "LOW", FixedVersion: "4" },
  ] }] };
  assert.equal(assessReport(report, "api:local").blocking.length, 2);
  assert.equal(assessReport(report, "api:local").unfixed.length, 1);
  assert.throws(() => assessReport(report, "web:local"));
  assert.throws(() => assessReport({ ArtifactName: "api:local" }, "api:local"));
});
test("browser API URLs follow ports/domains and preserve explicit legacy configuration", () => {
  const saved = process.env.NEXT_PUBLIC_API_BASE_URL;
  try {
    process.env.NEXT_PUBLIC_API_BASE_URL = "/api/v1";
    for (const origin of ["http://localhost:3006", "https://pharmacy.example"]) {
      globalThis.window = { location: { origin } };
      assert.equal(getApiBaseUrl(), `${origin}/api/v1`);
      assert.equal(new URL(getApiBaseUrl()).origin, origin);
    }
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:3000/api/v1/";
    assert.equal(getApiBaseUrl(), "http://localhost:3000/api/v1");
    delete globalThis.window;
    process.env.NEXT_PUBLIC_API_BASE_URL = "/api/v1";
    assert.equal(getApiBaseUrl(), "/api/v1");
  } finally {
    delete globalThis.window;
    if (saved === undefined) delete process.env.NEXT_PUBLIC_API_BASE_URL;
    else process.env.NEXT_PUBLIC_API_BASE_URL = saved;
  }
});
test("publish entry point refuses PR events before touching Docker or GHCR", () => {
  const script = fileURLToPath(new URL("./release-images.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "publish"], { encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request" } });
  assert.equal(result.status, 1);
});
test("publish entry point refuses develop pushes before touching Docker or GHCR", () => {
  const script = fileURLToPath(new URL("./release-images.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "publish"], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/develop" },
  });
  assert.equal(result.status, 1);
});
