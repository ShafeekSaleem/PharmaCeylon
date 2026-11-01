import { ApiError } from "@/lib/api-error";
import { apiJson } from "@/lib/auth-client";

/**
 * Posts an adjustment now, or sends the write-off for approval. Posting is counter work; a
 * write-off that needs a second pair of eyes is refused before anything moves
 * (WRITE_OFF_APPROVAL_REQUIRED) and goes to the approvers as a request instead.
 */
export async function submitAdjustment(body: Record<string, unknown>): Promise<{ held: boolean }> {
  const send = (path: string) =>
    apiJson<{ held: boolean }>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    return await send("/inventory/adjustments");
  } catch (err) {
    if (err instanceof ApiError && err.code === "WRITE_OFF_APPROVAL_REQUIRED")
      return send("/inventory/adjustment-requests");
    throw err;
  }
}
