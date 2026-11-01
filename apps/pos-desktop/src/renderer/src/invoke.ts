import type { ActionResult } from "../../shared/ipc-contract";

/**
 * Calls a bridge action and always comes back with a result. Main rejects input that fails its
 * checks (and a sender it doesn't trust) instead of answering, which would otherwise leave a
 * button that silently does nothing.
 */
export async function invoke<T>(
  action: () => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  try {
    return await action();
  } catch {
    return {
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Check what you entered (amounts, quantities, PINs) and try again.",
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
