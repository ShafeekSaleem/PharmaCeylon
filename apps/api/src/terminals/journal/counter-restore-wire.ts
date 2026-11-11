import type {
  CounterRestoreStatusRequest,
  OfflineCounterRestoreReport,
  Signed,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import {
  boundedCanonical,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  uuid,
} from "../terminal-wire";
import { parsePosition } from "./journal-recovery-wire";

/**
 * P5 #51, store restore (decisions of 2026-11-10): strict parsers for what a restored counter
 * sends. Anything malformed refuses the request (400 INVALID_COMMAND) before any signature or
 * database check; the device signature is the caller's to verify against the pinned key.
 */

function safe(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}

export function parseCounterRestoreReport(
  raw: unknown,
): OfflineCounterRestoreReport {
  const r = object(raw, [
    "contractVersion",
    "kind",
    "restoreId",
    "identity",
    "reportedAt",
    "backupId",
    "backupTakenAt",
    "restoredAt",
    "journalHead",
    "acceptedWatermark",
    "outageActive",
    "removedGrantVersion",
  ]);
  if (r.contractVersion !== 1 || r.kind !== "offline_counter_restore_report")
    invalid();
  if (
    typeof r.backupId !== "string" ||
    !/^[0-9A-Za-z-]{1,64}$/.test(r.backupId)
  )
    invalid();
  if (typeof r.outageActive !== "boolean") invalid();
  const report: OfflineCounterRestoreReport = {
    contractVersion: 1,
    kind: "offline_counter_restore_report",
    restoreId: uuid(r.restoreId),
    identity: parseIdentity(r.identity) as TerminalIdentity,
    reportedAt: safe(r.reportedAt),
    backupId: r.backupId,
    backupTakenAt: safe(r.backupTakenAt),
    restoredAt: safe(r.restoredAt),
    journalHead: parsePosition(r.journalHead),
    acceptedWatermark: parsePosition(r.acceptedWatermark),
    outageActive: r.outageActive,
    removedGrantVersion:
      r.removedGrantVersion === null ? null : safe(r.removedGrantVersion, 1),
  };
  // The server confirms nothing past the journal. The two times are not compared: both are the
  // counter's own clock, which a computer back from repair often has wrong (a reset CMOS clock, or a
  // fast one corrected since the backup). Refusing would block the restore, and offline selling,
  // for good; the back office is shown the disagreement instead (`clockSkew`).
  if (report.acceptedWatermark.sequence > report.journalHead.sequence)
    invalid();
  // Parsing validates; it must not have changed a signed value.
  if (boundedCanonical(report) !== boundedCanonical(raw)) invalid();
  return report;
}

/** `POST /terminals/offline-journal/restore/report`: `{ report }`, one device-signed envelope. */
export function parseCounterRestoreUpload(
  raw: unknown,
): Signed<OfflineCounterRestoreReport> {
  const body = object(raw, ["report"]);
  const envelope = parseEnvelope(
    body.report,
  ) as Signed<OfflineCounterRestoreReport>;
  const report = parseCounterRestoreReport(envelope.payload);
  if (envelope.keyId !== report.identity.keyId) invalid();
  return { ...envelope, payload: report };
}

export function parseCounterRestoreStatusRequest(
  raw: unknown,
): CounterRestoreStatusRequest {
  const body = object(raw, ["identity", "restoreId"]);
  return {
    identity: parseIdentity(body.identity) as TerminalIdentity,
    restoreId: uuid(body.restoreId),
  };
}
