/**
 * A random v4 UUID. `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost), so a
 * branch reaching the web over plain HTTP on its LAN builds one from `getRandomValues`, which
 * every browser has. The API checks UUID shape where one is required (payment evidence IDs).
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Creates a client mutation key that stays below the API's 128-character limit.
 * Callers must retain the returned value for every retry of the same logical
 * operation and replace it only after that operation succeeds.
 */
export function createIdempotencyKey(scope: string, resourceId: string): string {
  return `${scope}-${resourceId}-${randomUuid()}`;
}
