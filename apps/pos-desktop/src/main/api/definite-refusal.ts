import { ApiError } from "./api-client";

/**
 * Refusals the server can give before it looks up an earlier attempt: authentication, permission
 * and the co-sign checks (401/403), branch setup, and throttling. On a resend these say nothing
 * about whether the first attempt landed.
 */
const BEFORE_REPLAY_CODES = new Set(["BRANCH_SETUP_INCOMPLETE"]);

/**
 * 403s checkout gives only inside its transaction, after it has waited on the key's lock and found
 * no earlier attempt: the dispenser's SLMC registration (a co-signer's, or the seller's alone).
 * Kept pending, a sale whose co-signer's registration lapsed could never be confirmed or cleared.
 */
const AFTER_REPLAY_FORBIDDEN_CODES = new Set([
  "APPROVER_NOT_QUALIFIED",
  "SELLER_NOT_QUALIFIED",
]);

/**
 * Whether an error proves that a sent sale or command did not and will not take effect. A first
 * attempt carries a key the server has never seen, so any server refusal is definite. A resend may
 * be answered before the server finds the original, so only refusals given after that lookup
 * count; anything else keeps it pending, to be confirmed again.
 */
export function isDefiniteRefusal(error: unknown, resend: boolean): boolean {
  if (!(error instanceof ApiError) || error.uncertain) return false;
  if (!resend) return true;
  if (error.status === 403) return AFTER_REPLAY_FORBIDDEN_CODES.has(error.code);
  if (error.status === 401 || error.status === 429) return false;
  return !BEFORE_REPLAY_CODES.has(error.code);
}
