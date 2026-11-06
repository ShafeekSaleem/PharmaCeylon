import type {
  OfflineJournalCommand,
  OfflinePayment,
  OfflineSaleCommand,
  OfflineShiftCloseCommand,
  OfflineShiftOpenCommand,
  OfflineStaffSignIn,
  OrdinarySaleLine,
  Signed,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { parseStaffSignIn } from "../held-evidence-verification";
import {
  boundedCanonical,
  commandText,
  hex,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  parseSession,
  sha256,
  text,
  uuid,
} from "../terminal-wire";

/**
 * Per-request limits. The API's JSON body limit (100 kB) is the outer bound; a counter with more
 * to upload sends it in pages, each continuing from the previous response's watermark.
 */
export const MAX_SYNC_COMMANDS = 25;
export const MAX_SYNC_SIGN_INS = 25;
export const MAX_SYNC_SUPPORT_RECORDS = 25;
const MAX_SALE_LINES = 100;
const MAX_SALE_PAYMENTS = 4;
const MAX_PROVIDER_REFERENCE_LENGTH = 64;
const MAX_APPROVAL_CODE_LENGTH = 32;
const MAX_ASSISTANCE_REASON_LENGTH = 500;

/** The outer `SyncRequest`, with every item still an unverified envelope. */
export type ParsedSyncRequest = Readonly<{
  identity: TerminalIdentity;
  staffSignIns: ReadonlyArray<unknown>;
  commands: ReadonlyArray<unknown>;
  supportRecords: ReadonlyArray<unknown>;
}>;

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}

/** Exact keys on the request itself; each item is then parsed with `parse*Envelope`. Any item
 * that fails the strict parse refuses the whole request (400 INVALID_COMMAND) before any
 * signature or policy check, as the contract requires: the counter must repair or upgrade. */
export function parseSyncRequest(raw: unknown): ParsedSyncRequest {
  const body = object(raw, ["contractVersion", "identity", "staffSignIns", "commands", "supportRecords"]);
  if (body.contractVersion !== 1) invalid();
  return {
    identity: parseIdentity(body.identity),
    staffSignIns: list(body.staffSignIns, MAX_SYNC_SIGN_INS),
    commands: list(body.commands, MAX_SYNC_COMMANDS),
    supportRecords: list(body.supportRecords, MAX_SYNC_SUPPORT_RECORDS),
  };
}

function safe(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}
function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}
/** Trimmed, bounded free text. */
function evidenceText(value: unknown, max: number): string {
  const result = text(value, max);
  if (result.trim() !== result) invalid();
  return result;
}

const CONTEXT_KEYS = [
  "contractVersion",
  "commandId",
  "identity",
  "session",
  "staffSignInId",
  "sequence",
  "previousCommandHash",
  "occurredAt",
  "grantId",
  "grantVersion",
  "nominationVersion",
  "offlineSessionId",
  "offlineStartedAt",
  "businessHoursAcknowledgementId",
] as const;

function parseContext(p: Record<string, unknown>): void {
  if (p.contractVersion !== 1) invalid();
  for (const key of ["commandId", "staffSignInId", "grantId", "offlineSessionId"] as const) uuid(p[key]);
  parseIdentity(p.identity);
  parseSession(p.session);
  const sequence = safe(p.sequence, 1);
  // The chain starts with null at sequence 1 and links every later command to its predecessor.
  if (sequence === 1 ? p.previousCommandHash !== null : typeof p.previousCommandHash !== "string") invalid();
  if (p.previousCommandHash !== null) hex(p.previousCommandHash);
  safe(p.occurredAt);
  safe(p.grantVersion, 1);
  safe(p.nominationVersion, 1);
  safe(p.offlineStartedAt);
  nullableUuid(p.businessHoursAcknowledgementId);
}

function parseSaleLine(raw: unknown): OrdinarySaleLine {
  const line = object(raw, ["snapshotLineId", "quantity", "unitPriceMinor", "discountMinor", "taxMinor"]);
  text(line.snapshotLineId);
  safe(line.quantity, 1);
  safe(line.unitPriceMinor);
  safe(line.discountMinor);
  safe(line.taxMinor);
  return line as OrdinarySaleLine;
}

/** Approved D5: cash, or an externally approved card; no wallet or credit. No card numbers. */
function parsePayment(raw: unknown): OfflinePayment {
  const method = raw && typeof raw === "object" ? (raw as Record<string, unknown>).method : undefined;
  if (method === "cash") {
    const p = object(raw, ["method", "amountMinor", "tenderedMinor", "changeMinor"]);
    safe(p.amountMinor, 1);
    safe(p.tenderedMinor, 1);
    safe(p.changeMinor);
    return p as OfflinePayment;
  }
  if (method === "external_card") {
    const p = object(raw, ["method", "amountMinor", "providerReference", "approvalCode", "approvedAt"]);
    safe(p.amountMinor, 1);
    evidenceText(p.providerReference, MAX_PROVIDER_REFERENCE_LENGTH);
    evidenceText(p.approvalCode, MAX_APPROVAL_CODE_LENGTH);
    safe(p.approvedAt);
    return p as OfflinePayment;
  }
  return invalid();
}

/** Strict exact-key parser for the three `OfflineJournalCommand` kinds. */
export function parseJournalCommand(raw: unknown): OfflineJournalCommand {
  const kind = raw && typeof raw === "object" ? (raw as Record<string, unknown>).kind : undefined;
  if (kind === "ordinary_sale") {
    const p = object(raw, [
      ...CONTEXT_KEYS,
      "kind",
      "snapshotId",
      "snapshotVersion",
      "currency",
      "lines",
      "payments",
      "totalMinor",
    ]);
    parseContext(p);
    uuid(p.snapshotId);
    safe(p.snapshotVersion, 1);
    if (p.currency !== "LKR") invalid();
    const lines = list(p.lines, MAX_SALE_LINES);
    const payments = list(p.payments, MAX_SALE_PAYMENTS);
    if (!lines.length || !payments.length) invalid();
    lines.forEach(parseSaleLine);
    payments.forEach(parsePayment);
    safe(p.totalMinor);
    return p as OfflineSaleCommand;
  }
  if (kind === "shift_open") {
    const p = object(raw, [...CONTEXT_KEYS, "kind", "currency", "openingCashMinor", "previousClosedWorkSessionId"]);
    parseContext(p);
    if (p.currency !== "LKR") invalid();
    safe(p.openingCashMinor);
    nullableUuid(p.previousClosedWorkSessionId);
    return p as OfflineShiftOpenCommand;
  }
  if (kind === "shift_close") {
    const p = object(raw, [
      ...CONTEXT_KEYS,
      "kind",
      "currency",
      "closingCashCountMinor",
      "expectedCashMinor",
      "assistance",
    ]);
    parseContext(p);
    if (p.currency !== "LKR") invalid();
    safe(p.closingCashCountMinor);
    // Expected cash is the counter's running figure; it may be below zero after paid-outs.
    if (!Number.isSafeInteger(p.expectedCashMinor)) invalid();
    if (p.assistance !== null) {
      const a = object(p.assistance, ["managerSignInId", "reason"]);
      uuid(a.managerSignInId);
      evidenceText(a.reason, MAX_ASSISTANCE_REASON_LENGTH);
    }
    return p as OfflineShiftCloseCommand;
  }
  return invalid();
}

/** A parsed, not yet signature-checked journal item and the hash of its signed bytes. */
export type JournalItem<T> = Readonly<{ envelope: Signed<T>; payload: T; hash: string }>;

/**
 * The SHA-256 of the exact domain-separated bytes the device signed (`command` purpose), which
 * is also what the next command's `previousCommandHash` must name.
 */
export function journalHash(payload: unknown): string {
  return sha256(commandText(payload));
}

export function parseCommandEnvelope(raw: unknown): JournalItem<OfflineJournalCommand> {
  const envelope = parseEnvelope(raw) as Signed<OfflineJournalCommand>;
  const payload = parseJournalCommand(envelope.payload);
  // Parsing validates; it must not have changed a signed value.
  if (boundedCanonical(payload) !== boundedCanonical(envelope.payload)) invalid();
  if (envelope.keyId !== payload.identity.keyId) invalid();
  return { envelope, payload, hash: journalHash(payload) };
}

export function parseSignInEnvelope(raw: unknown): JournalItem<OfflineStaffSignIn> {
  const envelope = parseEnvelope(raw) as Signed<OfflineStaffSignIn>;
  const payload = parseStaffSignIn(envelope.payload);
  if (envelope.keyId !== payload.identity.keyId) invalid();
  return { envelope, payload, hash: journalHash(payload) };
}
