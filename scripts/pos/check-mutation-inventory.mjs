import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inventoryPath = resolve(root, 'docs/POS_MUTATION_ROUTES.json');
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]);
}
const routes = [];
for (const file of walk(resolve(root, 'apps/api/src')).filter(f => f.endsWith('.controller.ts'))) {
  const source = readFileSync(file, 'utf8');
  const controllers = [...source.matchAll(/@Controller\(\s*(?:["']([^"']*)["'])?\s*\)/g)];
  if (!controllers.length) throw new Error(`Unrecognized controller: ${file}`);
  const decorators = [...source.matchAll(/@(Post|Put|Patch|Delete)\(\s*(?:["']([^"']*)["'])?\s*\)/g)];
  if (decorators.length !== [...source.matchAll(/@(Post|Put|Patch|Delete)\s*\(/g)].length) {
    throw new Error(`Unrecognized route decorator: ${file}`);
  }
  for (const match of decorators) {
    const controller = controllers.findLast(c => c.index < match.index);
    if (!controller) throw new Error(`Route without controller: ${file}`);
    const prefix = controller[1] ?? '';
    routes.push({
    method: match[1].toUpperCase(), path: `/api/v1/${[prefix, match[2]].filter(Boolean).join('/')}`,
    source: relative(root, file).replaceAll('\\', '/'),
    });
  }
}
routes.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`, 'en'));
if (process.argv.includes('--write')) {
  writeFileSync(inventoryPath, JSON.stringify(routes, null, 2) + '\n');
  console.log(`Wrote ${routes.length} mutation routes; review classifications in POS_OPERATIONAL_MUTATIONS.md.`);
} else {
  const saved = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  if (JSON.stringify(routes) !== JSON.stringify(saved)) {
    throw new Error('Mutation routes changed. Audit their P0 classification, then run node scripts/pos/check-mutation-inventory.mjs --write.');
  }
  console.log(`Mutation inventory matches all ${routes.length} POST/PUT/PATCH/DELETE routes.`);
}
