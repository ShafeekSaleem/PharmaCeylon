import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Maintenance writers stay out of the running application (P1 #47).
 *
 * Some modules write data with no user, request or terminal authority at all: they rebuild
 * stock totals from the ledger or convert legacy stock state, for seeds and repair scripts run
 * by an operator against a database. Reachable from a controller, service or worker they would
 * be an operational write that skips every authority check. This fails the lint step when
 * anything under `src/` imports one; seeds (`prisma/`), scripts and tests may.
 */

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(apiRoot, "src");

const MAINTENANCE_ONLY = new Map([
  [
    "src/inventory/stock/stock-projection.ts",
    "rebuildBatchStock / convertLegacyStockState: seed and repair only, no authority.",
  ],
]);

const IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](\.[^"']+)["']/g;

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) files.push(path);
  }
  return files;
}

const normalize = (path) => relative(apiRoot, path).replaceAll("\\", "/");
const violations = [];
for (const path of sourceFiles(sourceRoot)) {
  const rel = normalize(path);
  if (MAINTENANCE_ONLY.has(rel)) continue;
  const source = readFileSync(path, "utf8");
  let match;
  while ((match = IMPORT.exec(source)) !== null) {
    const target = normalize(resolve(dirname(path), match[1])).replace(/(\.js|\.ts)?$/, ".ts");
    if (!MAINTENANCE_ONLY.has(target)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${rel}:${line} imports maintenance-only ${target}`);
  }
}

if (violations.length > 0) {
  console.error("Maintenance entry-point check failed:\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nOperational code must write through its domain service with live authority. " +
      "Maintenance modules are for prisma/ seeds, scripts/ and tests only.",
  );
  process.exit(1);
}

console.log(
  `Maintenance entry-point check passed: ${MAINTENANCE_ONLY.size} maintenance-only module(s) unreachable from src/.`,
);
