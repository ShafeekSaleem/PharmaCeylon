import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = fileURLToPath(new URL("../../", import.meta.url));

// No shell interpolation, no dotenv parser, and no rendered secrets in output.
// Compose itself resolves .env.docker and shell overrides on every platform.
export function compose(args, { capture = true, input, files = [] } = {}) {
  const result = spawnSync("docker", [
    "compose", "--env-file", ".env.docker", "-f", "compose.yaml",
    ...files.flatMap((file) => ["-f", file]), ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    input,
    stdio: capture ? "pipe" : "inherit",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("Docker was not found. Install/start Docker Desktop and reopen your terminal.");
  }
  if (result.error || result.status !== 0) {
    // Captured config/errors may include connection strings. Do not echo them.
    throw new Error(`Docker Compose ${args[0]} failed (exit ${result.status ?? "unknown"}). Check Docker Desktop, .env.docker, and npm run docker:ps / docker:logs.`);
  }
  return result.stdout?.trim() ?? "";
}

export function parseServices(output) {
  if (!output.trim()) return [];
  // Compose releases emit either a JSON array or newline-delimited objects.
  const text = output.trim();
  return text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/).map((line) => JSON.parse(line));
}

export function validateServices(services) {
  for (const name of ["db", "migrate", "api", "web"]) {
    const entries = services.filter((entry) => entry.Service === name);
    if (entries.length !== 1) throw new Error(`Expected one ${name} container; found ${entries.length}. Run npm run docker:up.`);
    const service = entries[0];
    if (name === "migrate") {
      if (service.State !== "exited" || Number(service.ExitCode) !== 0 || service.ExitCode == null) {
        throw new Error("migrate must be Exited (0). Inspect npm run docker:logs -- migrate; do not bypass failed migrations.");
      }
    } else if (service.State !== "running" || service.Health !== "healthy") {
      throw new Error(`${name} is not running and healthy. Inspect npm run docker:ps and npm run docker:logs -- ${name}.`);
    }
  }
}

export function hostOrigin(config, service, port) {
  const mapping = config.services?.[service]?.ports?.find((entry) => Number(entry.target) === port);
  if (!mapping || mapping.host_ip !== "127.0.0.1" || !/^\d+$/.test(String(mapping.published))) {
    throw new Error(`${service} must publish ${port} on 127.0.0.1 for this local check.`);
  }
  return `http://localhost:${mapping.published}`;
}

export function validateBrowserConfig(config) {
  const origin = hostOrigin(config, "web", 3000);
  const args = config.services.web.build?.args ?? {};
  if (args.NEXT_PUBLIC_API_BASE_URL !== `${origin}/api/v1`) {
    throw new Error("NEXT_PUBLIC_API_BASE_URL must match http://localhost:WEB_PORT/api/v1. Correct .env.docker and rebuild web.");
  }
  if (args.API_PROXY_TARGET !== "http://api:3001") {
    throw new Error("API_PROXY_TARGET must be http://api:3001 inside Docker. Correct .env.docker and rebuild web.");
  }
  const origins = (config.services.api.environment.WEB_ORIGINS ?? "").split(",").map((value) => value.trim());
  if (!origins.includes(origin)) throw new Error("WEB_ORIGINS must include the browser's http://localhost:WEB_PORT origin. Recreate api after correcting it.");
  return origin;
}

export async function checkEndpoint(url, kind, request = fetch) {
  let response;
  try {
    response = await request(url, { signal: AbortSignal.timeout(5_000), redirect: kind === "page" ? "follow" : "error" });
  } catch {
    throw new Error(`${url} did not respond within 5 seconds. Check ports, health, and proxy settings.`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}.`);
  if (kind === "page") {
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error(`${url} did not return an HTML page.`);
    await response.body?.cancel();
    return;
  }
  let body;
  try { body = await response.json(); } catch { throw new Error(`${url} did not return health JSON.`); }
  if (body.ok !== true || (kind === "ready" ? body.database !== true : typeof body.service !== "string")) {
    throw new Error(`${url} did not confirm ${kind === "ready" ? "database readiness" : "API liveness"}.`);
  }
}

export async function checkStack() {
  const config = JSON.parse(compose(["config", "--format", "json"]));
  const web = validateBrowserConfig(config);
  const api = hostOrigin(config, "api", 3001);
  validateServices(parseServices(compose(["ps", "--all", "--format", "json"])));
  console.log("PASS: db/api/web healthy; migrate exited 0.");
  // Use IPv4 because the published ports intentionally bind only to 127.0.0.1.
  for (const [url, kind] of [
    [`${web}/`, "page"],
    [`${api}/api/v1/health`, "live"],
    [`${api}/api/v1/health/ready`, "ready"],
    [`${web}/api/v1/health`, "live"],
    [`${web}/api/v1/health/ready`, "ready"],
  ]) {
    await checkEndpoint(url.replace("localhost", "127.0.0.1"), kind);
    console.log(`PASS: ${url}`);
  }
  console.log(`Stack checks passed. Open ${web}. Login, checkout, and imports still need manual testing.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkStack().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
