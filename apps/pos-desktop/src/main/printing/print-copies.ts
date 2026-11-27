import type { PrintResult } from "../../shared/ipc-contract";

/**
 * Prints several copies of one document in order and stops at the first failure, saying which
 * copies did print. A retry can then ask for only the missing ones instead of printing a second
 * copy of one the rep already has.
 */
export async function printCopies<C extends string>(
  copies: readonly C[],
  printOne: (copy: C) => Promise<PrintResult>,
): Promise<PrintResult & { printed: C[] }> {
  const printed: C[] = [];
  for (const copy of copies) {
    const result = await printOne(copy);
    if (!result.ok) return { ok: false, error: result.error, printed };
    printed.push(copy);
  }
  return { ok: true, error: null, printed };
}
