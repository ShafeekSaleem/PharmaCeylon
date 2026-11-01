import "dotenv/config";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** PostgreSQL truncates identifiers longer than this, so two long names could collide. */
const MAX_DATABASE_NAME = 63;

/**
 * The integration database lives next to the developer's own: same server and credentials,
 * `<name>_it_<checkout>` as the database, where `<checkout>` is a short hash of this checkout's
 * path. Global setup drops and recreates it, so two worktrees running the suite at once must not
 * share one. `INTEGRATION_DATABASE_URL` overrides the whole URL. Refuses to run against
 * `DATABASE_URL` itself.
 */
export function integrationDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  checkoutDir: string = resolve(__dirname, "../.."),
): string {
  if (env.INTEGRATION_DATABASE_URL) return env.INTEGRATION_DATABASE_URL;
  const base = env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is required for integration tests");
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.slice(1)) || "pharmaceylon";
  const suffix = `_it_${checkoutHash(checkoutDir)}`;
  url.pathname = `/${encodeURIComponent(name.slice(0, MAX_DATABASE_NAME - suffix.length) + suffix)}`;
  if (url.toString() === base) {
    throw new Error("Integration tests must not run against DATABASE_URL itself");
  }
  return url.toString();
}

function checkoutHash(dir: string): string {
  // Windows paths are case-insensitive: `D:\Repo` and `d:\repo` are the same checkout.
  const key = process.platform === "win32" ? dir.toLowerCase() : dir;
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}
