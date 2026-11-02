import type { ActionResult } from "../../shared/ipc-contract";

/**
 * Calls a bridge action and always comes back with a result. Main rejects instead of answering
 * when input fails its checks ("Invalid request."), the sender isn't trusted, or a handler fails
 * unexpectedly; any of those would otherwise leave a button that silently does nothing.
 */
export async function invoke<T>(
  action: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch (error) {
    const invalid = error instanceof Error && error.message.includes("Invalid request.");
    return {
      ok: false,
      error: invalid
        ? {
            code: "INVALID_INPUT",
            message: "Check what you entered (amounts, quantities, PINs) and try again.",
          }
        : {
            code: "UNEXPECTED",
            message: "Something went wrong. Please try again.",
          },
    };
  }
}

/** Money as typed at the counter: digits with at most two decimals. */
export function moneyInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole!;
}
