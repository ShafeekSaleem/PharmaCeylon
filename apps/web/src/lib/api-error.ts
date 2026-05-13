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
