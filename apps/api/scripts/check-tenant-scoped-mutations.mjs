import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = join(apiRoot, "prisma", "schema.prisma");
const sourceRoot = join(apiRoot, "src");

function tenantOwnedDelegates(schema) {
  const delegates = new Set();
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    if (/^\s*tenantId\s+/m.test(match[2])) {
      delegates.add(match[1][0].toLowerCase() + match[1].slice(1));
    }
  }
  return delegates;
}

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      files.push(path);
    }
  }
  return files;
}

function matchingDelimiter(source, start, opening, closing) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    if (char === closing && --depth === 0) return index;
  }

  return -1;
}

function whereObject(call) {
  const where = /\bwhere\s*:\s*/.exec(call);
  if (!where) return null;

  const start = where.index + where[0].length;
  if (call[start] !== "{") return null;

  const end = matchingDelimiter(call, start, "{", "}");
  return end < 0 ? null : call.slice(start, end + 1);
}

function approvedException(source, mutationIndex) {
  const precedingLines = source.slice(0, mutationIndex).split("\n").slice(-3).join("\n");
  return /tenant-scope:\s*(system-auth|verified-parent)\s+—\s+\S/.test(precedingLines);
}

const delegates = tenantOwnedDelegates(readFileSync(schemaPath, "utf8"));
const violations = [];

for (const path of sourceFiles(sourceRoot)) {
  const source = readFileSync(path, "utf8");
  const mutation = /\.(\w+)\.(updateMany|deleteMany|update|delete)\s*\(/g;
  let match;

  while ((match = mutation.exec(source)) !== null) {
    const [, delegate, operation] = match;
    if (!delegates.has(delegate)) continue;

    const callStart = source.indexOf("(", match.index);
    const callEnd = matchingDelimiter(source, callStart, "(", ")");
    if (callEnd < 0) continue;

    const scopedWhere = whereObject(source.slice(callStart + 1, callEnd));
    if (/\btenantId\b/.test(scopedWhere ?? "") || approvedException(source, match.index)) {
      continue;
    }

    const line = source.slice(0, match.index).split("\n").length;
    violations.push(
      `${relative(apiRoot, path)}:${line} ${delegate}.${operation} must scope its where clause by tenantId`,
    );
  }
}

if (violations.length > 0) {
  console.error("Tenant-isolation mutation check failed:\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nAdd tenantId to the final mutation filter. Only verified system-auth or already tenant-verified parent flows may use a documented tenant-scope exception.",
  );
  process.exit(1);
}

console.log(
  `Tenant-isolation mutation check passed for ${delegates.size} tenant-owned Prisma delegates.`,
);
