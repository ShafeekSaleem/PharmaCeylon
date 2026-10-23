import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  terminalSigningText,
  type OnlineTerminalCommand,
  type Signed,
  type TerminalErrorCode,
  type OperationPolicyErrorCode,
} from "@pharmaceylon/shared";

export const CHALLENGE_LIFETIME_MS = 120_000;
export type BodyParser<T> = (body: unknown) => T;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const sha256 = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
export const commandText = (value: unknown) =>
  terminalSigningText("command", value);
export function invalid(): never {
  throw new BadRequestException({
    code: "INVALID_COMMAND",
    message: "Invalid terminal command",
  });
}
export function denied(
  code: TerminalErrorCode | OperationPolicyErrorCode,
): never {
  throw new ForbiddenException({
    code,
    message: "Terminal authorization failed",
  });
}

export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.keys(descriptors).length !== keys.length ||
    keys.some(
      (key) =>
        !descriptors[key] ||
        !descriptors[key].enumerable ||
        !("value" in descriptors[key]),
    )
  )
    invalid();
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) invalid();
  return value;
}
export function text(value: unknown, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    invalid();
  return value;
}
export function hex(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

/** Bound depth, total values, key/string lengths and encoded bytes before crypto or DTO work. */
export function boundedCanonical(value: unknown): string {
  let count = 0;
  function visit(v: unknown, depth: number): void {
    if (depth > 16 || ++count > 10_000) invalid();
    if (typeof v === "string" && v.length > 32_768) invalid();
    if (v && typeof v === "object") {
      if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)
        invalid();
      const descriptors = Object.getOwnPropertyDescriptors(v);
      if (Object.getOwnPropertySymbols(v).length) invalid();
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(v) && key === "length") continue;
        if (
          key.length > 128 ||
          !descriptor.enumerable ||
          !("value" in descriptor)
        )
          invalid();
        visit(descriptor.value, depth + 1);
      }
    }
  }
  visit(value, 0);
  let encoded: string;
  try {
    encoded = commandText(value);
  } catch {
    return invalid();
  }
  if (Buffer.byteLength(encoded, "utf8") > 131_072) invalid();
  return encoded;
}

export function parseEnvelope(raw: unknown): Signed<unknown> {
  boundedCanonical(raw);
  const envelope = object(raw, ["algorithm", "keyId", "payload", "signature"]);
  if (envelope.algorithm !== "Ed25519") invalid();
  text(envelope.keyId);
  if (
    typeof envelope.signature !== "string" ||
    !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature) ||
    Buffer.from(envelope.signature, "base64url").toString("base64url") !==
      envelope.signature
  )
    invalid();
  return envelope as Signed<unknown>;
}

export function parseIdentity(raw: unknown) {
  const i = object(raw, [
    "tenantId",
    "branchId",
    "terminalId",
    "enrollmentId",
    "keyId",
  ]);
  for (const k of [
    "tenantId",
    "branchId",
    "terminalId",
    "enrollmentId",
  ] as const)
    uuid(i[k]);
  text(i.keyId);
  return i as OnlineTerminalCommand<unknown>["identity"];
}
export function parseSession(raw: unknown) {
  const s = object(raw, [
    "registerId",
    "tillId",
    "workSessionId",
    "staffUserId",
  ]);
  for (const k of Object.keys(s)) uuid(s[k]);
  return s as OnlineTerminalCommand<unknown>["session"];
}
export function times(payload: Record<string, unknown>, now: number): void {
  if (
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt) ||
    (payload.issuedAt as number) > now ||
    (payload.expiresAt as number) <= now ||
    (payload.expiresAt as number) - (payload.issuedAt as number) >
      CHALLENGE_LIFETIME_MS ||
    (payload.issuedAt as number) < 0
  )
    denied("CHALLENGE_EXPIRED");
  hex(payload.serverNonce);
}

export function parseOnlineCommand<T>(
  raw: unknown,
  parseBody: BodyParser<T>,
): Signed<OnlineTerminalCommand<T>> {
  const envelope = parseEnvelope(raw);
  const p = object(envelope.payload, [
    "contractVersion",
    "kind",
    "commandId",
    "identity",
    "session",
    "operation",
    "issuedAt",
    "expiresAt",
    "serverNonce",
    "body",
    "approvalEvidenceId",
    "pharmacistEvidenceId",
    "operatingHoursExceptionId",
  ]);
  if (p.contractVersion !== 1 || p.kind !== "online_operation") invalid();
  uuid(p.commandId);
  parseIdentity(p.identity);
  parseSession(p.session);
  text(p.operation, 160);
  if (!Number.isSafeInteger(p.issuedAt) || !Number.isSafeInteger(p.expiresAt))
    invalid();
  hex(p.serverNonce);
  for (const k of [
    "approvalEvidenceId",
    "pharmacistEvidenceId",
    "operatingHoursExceptionId",
  ])
    if (p[k] !== null) uuid(p[k]);
  const parsedBody = parseBody(p.body);
  // Domain parsing may validate but must not strip unknown fields or coerce signed values.
  if (boundedCanonical(parsedBody) !== boundedCanonical(p.body)) invalid();
  return envelope as Signed<OnlineTerminalCommand<T>>;
}

export function verifySignature(
  envelope: Signed<unknown>,
  publicKeyHex: string,
): void {
  hex(publicKeyHex);
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(publicKeyHex, "hex"),
    ]),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(boundedCanonical(envelope.payload)),
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  )
    denied("INVALID_SIGNATURE");
}
