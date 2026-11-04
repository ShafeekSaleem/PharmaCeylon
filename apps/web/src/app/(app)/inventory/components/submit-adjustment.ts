import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";
import { randomUuid } from "@/lib/idempotency";

/** The two `Idempotency-Key`s one adjustment as entered is sent under. */
export type AdjustmentKeys = Readonly<{
  /** `POST /inventory/adjustments` (scope `stock_adjustment`). */
  post: string;
  /** `POST /inventory/adjustment-requests` (scope `held_adjustment_request`). */
  request: string;
}>;

/**
 * Keys per adjustment as entered. A second click, or saving again after a lost reply, sends the
 * same entry with the same keys, so the server posts it, or holds the write-off, once. Changing
 * the entry starts new keys, because the server refuses a key reused for a different body. The
 * two keys stay distinct: a refused post leaves its key unused, and the request has its own.
 */
export function adjustmentKeys(newKey: () => string = randomUuid) {
  let last: { body: string; keys: AdjustmentKeys } | null = null;
  return (body: Record<string, unknown>): AdjustmentKeys => {
    const text = JSON.stringify(body);
    if (last?.body !== text)
      last = {
        body: text,
        keys: { post: `adjustment-${newKey()}`, request: `write-off-${newKey()}` },
      };
    return last.keys;
  };
}

/**
 * Posts an adjustment now, or sends the write-off for approval. Posting is counter work; a
 * write-off that needs a second pair of eyes is refused before anything moves
 * (WRITE_OFF_APPROVAL_REQUIRED) and goes to the approvers as a request instead. Each route gets
 * its own key from `adjustmentKeys`.
 */
export async function submitAdjustment(
  body: Record<string, unknown>,
  keys: AdjustmentKeys,
): Promise<{ held: boolean }> {
  const send = (path: string, idempotencyKey: string) =>
    apiJson<{ held: boolean }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body),
    });
  try {
    return await send("/inventory/adjustments", keys.post);
  } catch (err) {
    if (err instanceof ApiError && err.code === "WRITE_OFF_APPROVAL_REQUIRED")
      return send("/inventory/adjustment-requests", keys.request);
    throw err;
  }
}
