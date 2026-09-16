import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stock may only change through `StockService`.
 *
 * It locks the batch rows, checks availability and keeps `batch_stock` in step with the ledger
 * in one transaction. A write that goes around it gets none of that: it can oversell under
 * concurrency, and it silently makes the running totals disagree with the ledger. This check
 * fails the lint step when a ledger, batch-total or reservation write appears anywhere else.
 */

const apiRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(apiRoot, "src");

const ALLOWED = new Map([
  [
    "src/inventory/stock/stock.service.ts",
    "The stock service itself.",
  ],
  [
    "src/product-import/product-import.service.ts",
    "Import undo deletes an import's ledger rows together with the batches they created; batch_stock rows cascade with the batch.",
  ],
]);

const WRITE = /\.(stockLedger|batchStock|stockReservation)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) files.push(path);
  }
  return files;
}

const violations = [];
for (const path of sourceFiles(sourceRoot)) {
  const rel = relative(apiRoot, path).replaceAll("\\", "/");
  if (ALLOWED.has(rel)) continue;
  const source = readFileSync(path, "utf8");
  let match;
  while ((match = WRITE.exec(source)) !== null) {
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${rel}:${line} writes ${match[1]} directly (${match[2]})`);
  }
}

if (violations.length > 0) {
  console.error("Stock write check failed:\n");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error("\nMove stock through StockService (src/inventory/stock/stock.service.ts).");
  process.exit(1);
}

console.log(`Stock write check passed: only ${ALLOWED.size} reviewed files write stock tables.`);
