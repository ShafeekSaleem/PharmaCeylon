import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkEndpoint, hostOrigin, parseServices, validateBrowserConfig, validateServices } from "./check-stack.mjs";

const healthy = () => [
  { Service: "db", State: "running", Health: "healthy", ExitCode: 0 },
  { Service: "migrate", State: "exited", Health: "", ExitCode: 0 },
  { Service: "api", State: "running", Health: "healthy", ExitCode: 0 },
  { Service: "web", State: "running", Health: "healthy", ExitCode: 0 },
];
const config = () => ({ services: {
  web: { ports: [{ target: 3000, published: "3002", host_ip: "127.0.0.1" }], build: { args: {
    NEXT_PUBLIC_API_BASE_URL: "http://localhost:3002/api/v1", API_PROXY_TARGET: "http://api:3001",
  } } },
  api: { ports: [{ target: 3001, published: "3003", host_ip: "127.0.0.1" }], environment: { WEB_ORIGINS: "http://localhost:3000, http://localhost:3002" } },
} });

test("accepts both Compose JSON formats, including CRLF", () => {
  assert.deepEqual(parseServices(JSON.stringify(healthy())), healthy());
  assert.deepEqual(parseServices(healthy().map((value) => JSON.stringify(value)).join("\r\n")), healthy());
  assert.deepEqual(parseServices("\n"), []);
  assert.throws(() => parseServices("not json"));
});
test("accepts a completed migration alongside healthy long-running services", () => {
  validateServices(healthy());
});
test("rejects missing, failed, running, or ambiguous migrations", () => {
  assert.throws(() => validateServices(healthy().filter((entry) => entry.Service !== "migrate")), /migrate/);
  for (const patch of [{ State: "running" }, { ExitCode: 42 }, { ExitCode: undefined }]) {
    const services = healthy(); Object.assign(services[1], patch);
    assert.throws(() => validateServices(services), /migrate/);
  }
  assert.throws(() => validateServices([...healthy(), healthy()[1]]), /migrate/);
});
test("rejects unhealthy or stopped services", () => {
  for (const name of ["api", "web", "db"]) {
    const services = healthy(); services.find((entry) => entry.Service === name).Health = "unhealthy";
    assert.throws(() => validateServices(services), new RegExp(name));
  }
  const services = healthy(); services[0].State = "exited";
  assert.throws(() => validateServices(services), /db/);
});
test("uses effective custom ports rather than hardcoded host ports", () => {
  assert.equal(validateBrowserConfig(config()), "http://localhost:3002");
  assert.equal(hostOrigin(config(), "api", 3001), "http://localhost:3003");
});
test("rejects mismatched browser port, Docker-only browser URL, proxy, and CORS", () => {
  for (const value of ["http://localhost:3000/api/v1", "http://api:3001/api/v1"]) {
    const valueConfig = config(); valueConfig.services.web.build.args.NEXT_PUBLIC_API_BASE_URL = value;
    assert.throws(() => validateBrowserConfig(valueConfig), /NEXT_PUBLIC/);
  }
  const proxyConfig = config(); proxyConfig.services.web.build.args.API_PROXY_TARGET = "http://localhost:3001";
  assert.throws(() => validateBrowserConfig(proxyConfig), /API_PROXY/);
  const corsConfig = config(); corsConfig.services.api.environment.WEB_ORIGINS = "http://localhost:3000";
  assert.throws(() => validateBrowserConfig(corsConfig), /WEB_ORIGINS/);
});
test("requires loopback-only published ports", () => {
  const valueConfig = config(); valueConfig.services.web.ports[0].host_ip = "0.0.0.0";
  assert.throws(() => hostOrigin(valueConfig, "web", 3000), /127.0.0.1/);
});
test("accepts health JSON and HTML, using bounded requests", async () => {
  const request = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, "error");
    return Response.json({ ok: true, database: true, service: "PharmaCeylon-api" });
  };
  await checkEndpoint("http://localhost/health", "live", request);
  await checkEndpoint("http://localhost/ready", "ready", request);
  await checkEndpoint("http://localhost/", "page", async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
});
test("rejects 200 responses without database proof, HTML on health, and HTTP failures", async () => {
  for (const body of [{ ok: true }, { ok: true, database: false }, { ok: false, database: true }]) {
    await assert.rejects(checkEndpoint("http://localhost/ready", "ready", async () => Response.json(body)), /readiness/);
  }
  await assert.rejects(checkEndpoint("http://localhost/health", "live", async () => new Response("<html>")), /JSON/);
  await assert.rejects(checkEndpoint("http://localhost/health", "live", async () => new Response("", { status: 503 })), /503/);
  await assert.rejects(checkEndpoint("http://localhost/ready", "ready", async () => { throw new Error("timeout"); }), /did not respond/);
});

test("lifecycle test refuses missing CI, project, or acknowledgement before invoking Docker", () => {
  const script = fileURLToPath(new URL("./test-stack-lifecycle.mjs", import.meta.url));
  const allowed = { GITHUB_ACTIONS: "true", COMPOSE_PROJECT_NAME: "pharmaceylon-ci-123-1", DOCKER_LIFECYCLE_TEST_ACK: "ephemeral-compose-project" };
  for (const patch of [
    { GITHUB_ACTIONS: "false" },
    { COMPOSE_PROJECT_NAME: "pharmaceylon" },
    { DOCKER_LIFECYCLE_TEST_ACK: "" },
  ]) {
    const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, ...allowed, ...patch } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Refusing lifecycle test/);
  }
});
