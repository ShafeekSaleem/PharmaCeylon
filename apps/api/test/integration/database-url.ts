import "dotenv/config";

/**
 * The integration database lives next to the developer's own: same server and credentials,
 * `<name>_it` as the database. Refuses to run if that would be the same database.
 */
export function integrationDatabaseUrl(): string {
  if (process.env.INTEGRATION_DATABASE_URL) return process.env.INTEGRATION_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required for integration tests");
  const url = new URL(base);
  const name = url.pathname.slice(1) || "pharmaceylon";
  url.pathname = `/${name.endsWith("_it") ? name : `${name}_it`}`;
  if (url.toString() === base) {
    throw new Error("Integration tests must not run against DATABASE_URL itself");
  }
  return url.toString();
}
