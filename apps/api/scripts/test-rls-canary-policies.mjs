import assert from "node:assert/strict";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const flags = await pool.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = ANY($1::text[])
     ORDER BY c.relname
  `, [["batch", "product", "sale"]]);

  assert.deepEqual(flags.rows, [
    { table_name: "batch", rls_enabled: false, rls_forced: false },
    { table_name: "product", rls_enabled: false, rls_forced: false },
    { table_name: "sale", rls_enabled: false, rls_forced: false },
  ]);

  const policies = await pool.query(`
    SELECT tablename, policyname, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])
     ORDER BY tablename
  `, [["batch", "product", "sale"]]);

  assert.equal(policies.rows.length, 3);
  for (const policy of policies.rows) {
    assert.match(policy.qual, /app\.tenant_id/);
    assert.match(policy.with_check, /app\.tenant_id/);
    if (policy.tablename === "product") {
      assert.equal(policy.policyname, "pc_tenant_canary");
    } else {
      assert.equal(policy.policyname, "pc_tenant_branch_canary");
      assert.match(policy.qual, /app\.branch_id/);
      assert.match(policy.with_check, /app\.branch_id/);
    }
  }

  console.log(
    "Canary policy validation passed: Product, Batch, and Sale policies are staged and RLS remains disabled.",
  );
} finally {
  await pool.end();
}
