import "dotenv/config";
import { execSync } from "node:child_process";
import { Client } from "pg";
import { integrationDatabaseUrl } from "./database-url";

/** Recreate the integration database and apply every migration to it. */
export default async function globalSetup(): Promise<void> {
  const target = integrationDatabaseUrl();
  const databaseName = new URL(target).pathname.slice(1);

  const admin = new URL(target);
  admin.pathname = "/postgres";
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await client.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await client.end();
  }

  execSync("npx prisma migrate deploy", {
    cwd: `${__dirname}/../..`,
    env: { ...process.env, DATABASE_URL: target },
    stdio: "pipe",
  });
  process.env.INTEGRATION_DATABASE_URL = target;
}
