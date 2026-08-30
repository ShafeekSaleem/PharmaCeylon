/**
 * Creates a client mutation key that stays below the API's 128-character limit.
 * Callers must retain the returned value for every retry of the same logical
 * operation and replace it only after that operation succeeds.
 */
export function createIdempotencyKey(scope: string, resourceId: string): string {
  const nonce =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${scope}-${resourceId}-${nonce}`;
}
