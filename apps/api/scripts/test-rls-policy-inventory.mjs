import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const apiRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(join(apiRoot, "prisma", "schema.prisma"), "utf8");

function tenantOwnedTables(source) {
  const tables = [];
  for (const match of source.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, model, body] = match;
    if (!/^\s*tenantId\s+/m.test(body)) continue;
    const mapped = body.match(/@@map\("([^"]+)"\)/)?.[1];
    tables.push({
      model,
      table: mapped ?? model,
      hasBranch: /^\s*branchId\s+/m.test(body),
    });
  }
  return tables.sort((left, right) => left.table.localeCompare(right.table));
}

const expected = tenantOwnedTables(schema);
const expectedTables = expected.map(({ table }) => table);
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const flags = await pool.query(
    `SELECT c.relname AS table_name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [expectedTables],
  );

  assert.equal(
    flags.rows.length,
    expected.length,
    "Every tenant-owned Prisma model must map to a deployed PostgreSQL table",
  );
  assert.ok(
    flags.rows.every((row) => !row.rls_enabled && !row.rls_forced),
    "Schema-wide policies must remain disabled until controlled staging rollout",
  );

  const policies = await pool.query(
    `SELECT tablename, policyname, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename, policyname`,
    [expectedTables],
  );

  const policiesByTable = new Map();
  for (const policy of policies.rows) {
    const existing = policiesByTable.get(policy.tablename) ?? [];
    existing.push(policy);
    policiesByTable.set(policy.tablename, existing);
  }

  const violations = [];
  for (const { model, table, hasBranch } of expected) {
    const tenantPolicies = (policiesByTable.get(table) ?? []).filter(
      (policy) =>
        /app\.tenant_id/.test(policy.qual ?? "") &&
        /app\.tenant_id/.test(policy.with_check ?? ""),
    );
    if (tenantPolicies.length === 0) {
      violations.push(`${model} (${table}) has no tenant USING/WITH CHECK policy`);
      continue;
    }

    if (["batch", "sale"].includes(table)) {
      const branchPolicy = tenantPolicies.find(
        (policy) =>
          /app\.branch_id/.test(policy.qual ?? "") &&
          /app\.branch_id/.test(policy.with_check ?? ""),
      );
      if (!branchPolicy) {
        violations.push(`${model} (${table}) has no branch-aware canary policy`);
      }
    } else if (hasBranch) {
      // Branch-bearing models intentionally start tenant-only. Their workflow
      // semantics must be approved before branch conditions are activated.
      const staged = tenantPolicies.some(
        (policy) => policy.policyname === "pc_tenant_isolation",
      );
      if (!staged) {
        violations.push(`${model} (${table}) has no staged tenant policy`);
      }
    }
  }

  assert.deepEqual(violations, []);
  console.log(
    `RLS policy inventory passed for ${expected.length} tenant-owned Prisma models; all policies remain disabled.`,
  );
} finally {
  await pool.end();
}
