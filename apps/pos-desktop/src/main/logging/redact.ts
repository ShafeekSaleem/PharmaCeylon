const REDACTED = "[REDACTED]";

/** Field names whose value is never written, whatever it holds. */
const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "pin",
  "secret",
  "token",
  "authorization",
  "cookie",
  "credential",
  "verifier",
  "pan",
  "cvv",
  "cvc",
  "track",
  "prescription",
]);

/** `key` alone is too common (idempotencyKey, sortKey); these qualifiers make it a secret. */
const SECRET_KEY_QUALIFIERS = new Set(["db", "database", "api", "private", "encryption", "device", "signing", "access"]);

function words(fieldName: string): string[] {
  return fieldName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

export function isSensitiveField(fieldName: string): boolean {
  const parts = words(fieldName);
  if (parts.some((part) => SENSITIVE_WORDS.has(part))) return true;
  if (parts.length === 1 && parts[0] === "key") return true;
  return parts.some((part, i) => part === "key" && i > 0 && SECRET_KEY_QUALIFIERS.has(parts[i - 1]!));
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Secrets that turn up inside free text: bearer tokens, JWTs, card numbers. */
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED)
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, (match) => (passesLuhn(match.replace(/\D/g, "")) ? REDACTED : match));
}

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, isSensitiveField(key) ? REDACTED : redact(item, seen)]),
  );
}
