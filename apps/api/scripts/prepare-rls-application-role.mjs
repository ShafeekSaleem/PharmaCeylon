import assert from "node:assert/strict";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
const applicationRole = process.env.APP_DATABASE_ROLE;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
assert.match(
  applicationRole ?? "",
  /^[a-z_][a-z0-9_]*$/,
  "APP_DATABASE_ROLE must be an existing simple PostgreSQL login role",
);
if (process.env.RLS_APP_ROLE_GRANT_ACK !== applicationRole) {
  throw new Error(
    "Set RLS_APP_ROLE_GRANT_ACK to the exact APP_DATABASE_ROLE before granting privileges",
  );
}

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const roleIdentifier = quoteIdentifier(applicationRole);
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  const roleResult = await client.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = $1`,
    [applicationRole],
  );
  assert.deepEqual(roleResult.rows, [
    {
      rolname: applicationRole,
      rolcanlogin: true,
      rolsuper: false,
      rolbypassrls: false,
    },
  ]);

  const ownership = await client.query(
    `SELECT count(*)::int AS owned_table_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND pg_get_userbyid(c.relowner) = $1`,
    [applicationRole],
  );
  assert.equal(
    ownership.rows[0]?.owned_table_count,
    0,
    "Application role must not own application tables",
  );

  const database = await client.query(
    "SELECT current_database() AS database_name",
  );
  const databaseIdentifier = quoteIdentifier(database.rows[0].database_name);

  await client.query("BEGIN");
  try {
    await client.query(
      `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${roleIdentifier}`,
    );
    await client.query(
      `GRANT USAGE ON SCHEMA public TO ${roleIdentifier}`,
    );
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE
         ON ALL TABLES IN SCHEMA public TO ${roleIdentifier}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleIdentifier}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roleIdentifier}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
         GRANT USAGE, SELECT ON SEQUENCES TO ${roleIdentifier}`,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  console.log(
    `Application role ${applicationRole} is NOBYPASSRLS, owns no tables, and has runtime DML privileges.`,
  );
} finally {
  await client.end();
}
