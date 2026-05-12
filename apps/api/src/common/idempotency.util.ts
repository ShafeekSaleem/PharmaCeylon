import { BadRequestException } from "@nestjs/common";

export function normalizeIdempotencyKey(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const k = raw.trim();
  if (k.length > 128) {
    throw new BadRequestException("Idempotency-Key must be at most 128 characters");
  }
  return k;
}

export function isPrismaUniqueFieldError(
  err: unknown,
  fieldSubstring: string,
): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { target?: string | string[] } };
  if (e.code !== "P2002") return false;
  const t = e.meta?.target;
  if (Array.isArray(t)) {
    return t.some((x) => typeof x === "string" && x.includes(fieldSubstring));
  }
  return typeof t === "string" && t.includes(fieldSubstring);
}
