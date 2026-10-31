import type { PosDatabase } from "./db/database";
import { ActionFailure } from "./terminal/terminal-service";

const KEY = "server_url";

/**
 * The API base URL, e.g. https://pos.example.lk/api/v1. A packaged counter only talks HTTPS; a
 * development build may also use plain HTTP on this machine.
 */
export function normalizeServerUrl(raw: string, packaged: boolean): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ActionFailure("SERVER_URL_INVALID", "Enter the full server address, starting with https://.");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && !packaged && local))
    throw new ActionFailure("SERVER_URL_INVALID", "The server address must start with https://.");
  if (url.username || url.password || url.search || url.hash)
    throw new ActionFailure("SERVER_URL_INVALID", "Enter only the server address.");
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/api/v1")) path = `${path}/api/v1`;
  return `${url.origin}${path}`;
}

export function readServerUrl(db: PosDatabase): string | null {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function writeServerUrl(db: PosDatabase, url: string, now: Date): void {
  db.prepare(
    `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KEY, url, now.toISOString());
}
