import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(apiRoot, "tenant-data-entrypoints.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "migrations") continue;
      files.push(...sourceFiles(path));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".mjs")) &&
      !entry.endsWith(".spec.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

function relativePath(path) {
  return relative(apiRoot, path).replaceAll("\\", "/");
}

function approvedPaths(entries) {
  return entries.map(({ path }) => path).sort();
}

function compareInventory(name, discovered, approved, violations) {
  const actual = [...new Set(discovered)].sort();
  const expected = [...new Set(approved)].sort();
  const missingReview = actual.filter((path) => !expected.includes(path));
  const staleApproval = expected.filter((path) => !actual.includes(path));

  for (const path of missingReview) {
    violations.push(`${name}: ${path} requires an inventory classification`);
  }
  for (const path of staleApproval) {
    violations.push(`${name}: ${path} is approved but no longer matches the entry-point scan`);
  }
}

const files = [
  ...sourceFiles(join(apiRoot, "src")),
  ...sourceFiles(join(apiRoot, "prisma")),
  ...sourceFiles(join(apiRoot, "scripts")),
];
const contents = new Map(
  files.map((path) => [relativePath(path), readFileSync(path, "utf8")]),
);
const violations = [];

const directDatabaseClients = [];
const publicControllers = [];
const backgroundWorkers = [];
const rawSqlReview = [];

for (const [path, source] of contents) {
  if (
    /\bnew\s+PrismaClient\s*\(/.test(source) ||
    /\bnew\s+PrismaPg\s*\(/.test(source) ||
    /(?:from\s+|require\s*\()(["'])pg\1/.test(source)
  ) {
    directDatabaseClients.push(path);
  }
  if (/@Public\s*\(/.test(source)) publicControllers.push(path);
  if (
    /@(Cron|Interval|Timeout|Processor|Process)\s*\(/.test(source) ||
    /\bnew\s+Worker\s*\(/.test(source)
  ) {
    backgroundWorkers.push(path);
  }
  if (/\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)\b/.test(source)) {
    rawSqlReview.push(path);
  }
}

compareInventory(
  "Direct database client",
  directDatabaseClients,
  approvedPaths(manifest.directDatabaseClients),
  violations,
);
compareInventory(
  "Public controller",
  publicControllers,
  approvedPaths(manifest.publicControllers),
  violations,
);
compareInventory(
  "Background worker",
  backgroundWorkers,
  approvedPaths(manifest.backgroundWorkers),
  violations,
);
compareInventory(
  "Raw SQL",
  rawSqlReview,
  approvedPaths(manifest.rawSqlReview),
  violations,
);

for (const section of [
  "publicControllers",
  "preContextServices",
  "directDatabaseClients",
  "backgroundWorkers",
  "rawSqlReview",
]) {
  for (const entry of manifest[section]) {
    const source = contents.get(entry.path);
    if (source == null) {
      violations.push(`${section}: ${entry.path} does not exist`);
      continue;
    }
    if (!entry.mode || !entry.reason?.trim()) {
      violations.push(`${section}: ${entry.path} requires mode and reason`);
    }
  }
}

for (const entry of manifest.preContextServices) {
  const source = contents.get(entry.path) ?? "";
  if (!/\bPrismaService\b/.test(source)) {
    violations.push(
      `Pre-context service: ${entry.path} no longer accesses PrismaService`,
    );
  }
}

const runtimeRoots = manifest.directDatabaseClients.filter(
  ({ mode }) => mode === "runtime-root",
);
if (
  runtimeRoots.length !== 1 ||
  runtimeRoots[0].path !== "src/prisma/prisma.service.ts"
) {
  violations.push(
    "Exactly one runtime-root database client is allowed: src/prisma/prisma.service.ts",
  );
}

if (violations.length > 0) {
  console.error("Tenant data entry-point check failed:\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nClassify every public, pre-context, background, raw-SQL, or direct-client path in tenant-data-entrypoints.json with a reviewable reason.",
  );
  process.exit(1);
}

console.log(
  `Tenant data entry-point check passed: ${directDatabaseClients.length} direct clients, ${publicControllers.length} public controllers, ${manifest.preContextServices.length} pre-context services, ${backgroundWorkers.length} workers, and ${rawSqlReview.length} raw-SQL paths are classified.`,
);
