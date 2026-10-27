import type { OperationPolicyErrorCode } from "@pharmaceylon/shared";

/**
 * The counter boundary's stable refusal codes, each with the one message the web shows for it
 * (WEB_BACKOFFICE_TARGET.md, "Copy patterns"). The API sends these with a generic message such
 * as "Terminal authorization failed"; what the person needs to hear is where to go instead.
 */
export const COUNTER_BOUNDARY_MESSAGES = {
  TERMINAL_REQUIRED:
    "This is done at the counter. Open PharmaCeylon POS at the branch to finish it.",
  REMOTE_SESSION_DENIED: "This needs someone at the counter in person.",
  APPROVAL_REQUIRED: "This needs approval first.",
  APPROVAL_INVALID: "This approval doesn't match the document. Ask for a new approval.",
  APPROVAL_STALE: "This changed after it was approved. It needs fresh approval.",
  SELF_APPROVAL_DENIED: "You raised this, so someone else needs to approve it.",
  PAYMENT_EVIDENCE_REQUIRED: "Attach the payment evidence to record this payment.",
  PHARMACIST_REQUIRED: "A pharmacist has to verify this at the counter.",
} as const satisfies Partial<Record<OperationPolicyErrorCode, string>>;

export type CounterBoundaryCode = keyof typeof COUNTER_BOUNDARY_MESSAGES;

export function isCounterBoundaryCode(code: unknown): code is CounterBoundaryCode {
  return (
    typeof code === "string" &&
    Object.prototype.hasOwnProperty.call(COUNTER_BOUNDARY_MESSAGES, code)
  );
}

/** The web's message for a counter-boundary refusal, or null for any other code. */
export function counterBoundaryMessage(code: unknown): string | null {
  return isCounterBoundaryCode(code) ? COUNTER_BOUNDARY_MESSAGES[code] : null;
}

/**
 * Parses a NestJS-style error response body into a clean, user-facing message.
 *
 * NestJS validation pipe returns JSON like:
 *   { "message": ["field error 1", "field error 2"], "error": "Bad Request", "statusCode": 400 }
 *
 * Auth / business errors return:
 *   { "message": "Invalid credentials", "statusCode": 401 }
 *
 * A counter-boundary refusal (`{ "code": "TERMINAL_REQUIRED", ... }`) always reads as its copy
 * from `COUNTER_BOUNDARY_MESSAGES`, so every caller that shows an API error gets it for free.
 */
export function parseApiError(body: string, fallback: string): string {
  try {
    const json = JSON.parse(body);
    const boundary = counterBoundaryMessage(json?.code);
    if (boundary) return boundary;
    const msg = json?.message;
    if (Array.isArray(msg)) {
      return msg.map(capitalise).join(". ") + ".";
    }
    if (typeof msg === "string" && msg.length > 0) {
      return capitalise(msg);
    }
  } catch {
    if (body.trim().length > 0) {
      return body.trim();
    }
  }
  return fallback;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * A failed API call, with the response body kept.
 *
 * Most callers only want the message and carry on treating this as an `Error`. Some refusals
 * are a question rather than a dead end — "this batch is already in stock at a different cost,
 * which do you want?" — and the page can only ask it if the structured body survives the throw.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The server's machine-readable reason, when it sent one (e.g. "COST_CONFLICT"). */
  get code(): string | null {
    const body = this.body as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  }

  /** A named list from the body, e.g. the conflicting batches — empty when absent. */
  detail<T>(key: string): T[] {
    const body = this.body as Record<string, unknown> | null;
    const value = body?.[key];
    return Array.isArray(value) ? (value as T[]) : [];
  }
}

export function parseApiErrorBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
