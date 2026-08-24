import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the RLS proof-of-concept test");
}

const suffix = randomUUID().replaceAll("-", "");
const schema = `rls_probe_${suffix}`;
const role = `rls_probe_role_${suffix}`;
const password = `p_${suffix}`;
const quotedSchema = `"${schema}"`;
const quotedRole = `"${role}"`;
const table = `${quotedSchema}."tenant_record"`;

const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
let appPool;

function applicationUrl() {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  url.searchParams.delete("schema");
  return url.toString();
}

async function setup() {
  await adminPool.query(`CREATE ROLE ${quotedRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
  await adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
  await adminPool.query(`
    CREATE TABLE ${table} (
      "id" text PRIMARY KEY,
      "tenantId" text NOT NULL,
      "payload" text NOT NULL
    )
  `);
  await adminPool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
  await adminPool.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
  await adminPool.query(`
    CREATE POLICY "tenant_isolation" ON ${table}
      USING (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
      )
      WITH CHECK (
        "tenantId" = nullif(current_setting('app.tenant_id', true), '')
      )
  `);
  await adminPool.query(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${quotedRole}`);
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${quotedRole}`,
  );
  await adminPool.query(
    `INSERT INTO ${table} ("id", "tenantId", "payload")
     VALUES ('a-1', 'tenant-a', 'A'), ('b-1', 'tenant-b', 'B')`,
  );

  appPool = new Pool({ connectionString: applicationUrl(), max: 1 });
}

async function proveIsolation() {
  const first = await appPool.connect();
  let firstBackendPid;
  try {
    await first.query("BEGIN");
    firstBackendPid = (await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    const before = await first.query(
      "SELECT current_setting('app.tenant_id', true) AS tenant_id",
    );
    assert.ok(before.rows[0].tenant_id == null || before.rows[0].tenant_id === "");

    await first.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.branch_id', $2, true)",
      ["tenant-a", "branch-a"],
    );

    const visible = await first.query(
      `SELECT "id", "tenantId" FROM ${table} ORDER BY "id"`,
    );
    assert.deepEqual(visible.rows, [{ id: "a-1", tenantId: "tenant-a" }]);

    await first.query("SAVEPOINT cross_tenant_write");
    try {
      await first.query(
        `INSERT INTO ${table} ("id", "tenantId", "payload") VALUES ('b-2', 'tenant-b', 'blocked')`,
      );
      assert.fail("Cross-tenant insert unexpectedly succeeded");
    } catch (error) {
      assert.equal(error.code, "42501");
      await first.query("ROLLBACK TO SAVEPOINT cross_tenant_write");
    }

    await first.query(
      `INSERT INTO ${table} ("id", "tenantId", "payload") VALUES ('a-2', 'tenant-a', 'allowed')`,
    );
    await first.query("COMMIT");
  } finally {
    first.release();
  }

  const reused = await appPool.connect();
  try {
    await reused.query("BEGIN");
    const secondBackendPid = (await reused.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.equal(secondBackendPid, firstBackendPid, "Expected the pool to reuse one connection");

    const cleared = await reused.query(
      `SELECT
         current_setting('app.tenant_id', true) AS tenant_id,
         current_setting('app.branch_id', true) AS branch_id`,
    );
    assert.ok(cleared.rows[0].tenant_id == null || cleared.rows[0].tenant_id === "");
    assert.ok(cleared.rows[0].branch_id == null || cleared.rows[0].branch_id === "");

    const visibleWithoutContext = await reused.query(`SELECT count(*)::int AS count FROM ${table}`);
    assert.equal(visibleWithoutContext.rows[0].count, 0);

    await reused.query("SELECT set_config('app.tenant_id', $1, true)", ["tenant-b"]);
    const tenantB = await reused.query(
      `SELECT "id", "tenantId" FROM ${table} ORDER BY "id"`,
    );
    assert.deepEqual(tenantB.rows, [{ id: "b-1", tenantId: "tenant-b" }]);
    await reused.query("COMMIT");
  } finally {
    reused.release();
  }
}

async function cleanup() {
  if (appPool) await appPool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
  await adminPool.query(`DROP ROLE IF EXISTS ${quotedRole}`);
  await adminPool.end();
}

try {
  await setup();
  await proveIsolation();
  console.log(
    "RLS proof passed: cross-tenant access was blocked and transaction-local pool context was cleared.",
  );
} finally {
  await cleanup();
}
