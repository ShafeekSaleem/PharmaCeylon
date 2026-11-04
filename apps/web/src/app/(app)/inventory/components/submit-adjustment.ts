import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";
import { randomUuid } from "@/lib/idempotency";

/**
 * One `Idempotency-Key` per write-off as entered. A second click, or saving again after a lost
 * reply, sends the same entry with the same key, so the server holds it once; changing the
 * entry starts a new key, because the server refuses a key reused for a different write-off.
 */
export function writeOffRequestKeys(newKey: () => string = randomUuid) {
  let last: { body: string; key: string } | null = null;
  return (body: Record<string, unknown>): string => {
    const text = JSON.stringify(body);
    if (last?.body !== text)
      last = { body: text, key: `write-off-${newKey()}` };
    return last.key;
  };
}

/**
 * Posts an adjustment now, or sends the write-off for approval. Posting is counter work; a
 * write-off that needs a second pair of eyes is refused before anything moves
 * (WRITE_OFF_APPROVAL_REQUIRED) and goes to the approvers as a request instead, under
 * `requestKey` (from `writeOffRequestKeys`).
 */
export async function submitAdjustment(
  body: Record<string, unknown>,
  requestKey: string,
): Promise<{ held: boolean }> {
  const send = (path: string, headers: Record<string, string> = {}) =>
    apiJson<{ held: boolean }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    return await send("/inventory/adjustments");
  } catch (err) {
    if (err instanceof ApiError && err.code === "WRITE_OFF_APPROVAL_REQUIRED")
      return send("/inventory/adjustment-requests", {
        "Idempotency-Key": requestKey,
      });
    throw err;
  }
}
