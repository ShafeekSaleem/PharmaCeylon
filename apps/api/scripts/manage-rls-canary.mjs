import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const action = process.argv[2] ?? "status";
if (!["status", "enable", "disable"].includes(action)) {
  throw new Error("Usage: node scripts/manage-rls-canary.mjs [status|enable|disable]");
}

const tables = ["product", "batch", "sale"];
const acknowledgement = "product,batch,sale";
if (
  action !== "status" &&
  process.env.RLS_CANARY_CHANGE_ACK !== acknowledgement
) {
  throw new Error(
    `Set RLS_CANARY_CHANGE_ACK=${acknowledgement} to change canary state`,
  );
}

const client = new Client({ connectionString: databaseUrl });

async function readState() {
  const result = await client.query(
    `SELECT c.relname AS table_name,
            pg_get_userbyid(c.relowner) AS owner_name,
            c.relrowsecurity AS rls_enabled,
            c.relforcerowsecurity AS rls_forced
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
      ORDER BY c.relname`,
    [tables],
  );
  return result.rows;
}

try {
  await client.connect();
  const before = await readState();
  assert.equal(before.length, tables.length, "Canary table inventory is incomplete");

  if (action === "status") {
    console.table(before);
    process.exitCode = before.every(
      (row) => row.rls_enabled && row.rls_forced,
    )
      ? 0
      : 2;
  } else {
    const currentRole = await client.query(
      "SELECT current_user AS role_name, rolsuper FROM pg_roles WHERE rolname = current_user",
    );
    const role = currentRole.rows[0];
    assert.ok(role, "Unable to resolve migration role");
    assert.ok(
      role.rolsuper || before.every((row) => row.owner_name === role.role_name),
      "Canary changes require the migration owner (or database administrator)",
    );

    if (action === "enable") {
      const applicationRole = process.env.APP_DATABASE_ROLE;
      assert.match(
        applicationRole ?? "",
        /^[a-z_][a-z0-9_]*$/,
        "APP_DATABASE_ROLE must be an existing simple PostgreSQL role name",
      );
      const applicationState = await client.query(
        `SELECT r.rolsuper,
                r.rolbypassrls,
                bool_or(pg_get_userbyid(c.relowner) = r.rolname) AS owns_canary_table,
                bool_and(has_table_privilege(r.rolname, c.oid, 'SELECT')) AS can_select
           FROM pg_roles r
           CROSS JOIN pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE r.rolname = $1
            AND n.nspname = 'public'
            AND c.relname = ANY($2::text[])
          GROUP BY r.rolsuper, r.rolbypassrls`,
        [applicationRole, tables],
      );
      assert.deepEqual(applicationState.rows, [
        {
          rolsuper: false,
          rolbypassrls: false,
          owns_canary_table: false,
          can_select: true,
        },
      ]);
    }

    await client.query("BEGIN");
    try {
      for (const table of tables) {
        if (action === "enable") {
          await client.query(
            `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
          );
          await client.query(
            `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
          );
        } else {
          await client.query(
            `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
          );
          await client.query(
            `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const after = await readState();
    const expected = action === "enable";
    assert.ok(
      after.every(
        (row) =>
          row.rls_enabled === expected && row.rls_forced === expected,
      ),
      `Canary tables did not reach requested ${action} state`,
    );
    console.table(after);
  }
} finally {
  await client.end();
}
