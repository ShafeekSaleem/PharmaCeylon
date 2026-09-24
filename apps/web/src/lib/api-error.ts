/**
 * Parses a NestJS-style error response body into a clean, user-facing message.
 *
 * NestJS validation pipe returns JSON like:
 *   { "message": ["field error 1", "field error 2"], "error": "Bad Request", "statusCode": 400 }
 *
 * Auth / business errors return:
 *   { "message": "Invalid credentials", "statusCode": 401 }
 */
export function parseApiError(body: string, fallback: string): string {
  try {
    const json = JSON.parse(body);
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
