import {
  JOURNAL_CHAIN_PAGE_MAX,
  JOURNAL_RECOVERY_PAGE_MAX,
  type JournalPosition,
  type OfflineJournalChainRequest,
  type OfflineJournalRecoveryCompletion,
  type OfflineJournalRecoveryReport,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import {
  boundedCanonical,
  hex,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  uuid,
} from "../terminal-wire";

/**
 * P5 #51, D11 journal recovery: strict parsers for what a counter sends. Anything malformed
 * refuses the request (400 INVALID_COMMAND) before any signature or database check. Device
 * signatures are the caller's to verify, against the enrollment's pinned key.
 */

function safe(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}

/** A journal position: sequence 0 has no hash; every other position names a SHA-256 digest. */
export function parsePosition(raw: unknown): JournalPosition {
  const p = object(raw, ["sequence", "hash"]);
  const sequence = safe(p.sequence);
  if (sequence === 0) {
    if (p.hash !== null) invalid();
  } else hex(p.hash);
  return { sequence, hash: p.hash as string | null };
}

function exact<T>(parsed: T, raw: unknown): T {
  // Parsing validates; it must not have changed a signed value.
  if (boundedCanonical(parsed) !== boundedCanonical(raw)) invalid();
  return parsed;
}

export function parseRecoveryReport(
  raw: unknown,
): OfflineJournalRecoveryReport {
  const r = object(raw, [
    "contractVersion",
    "kind",
    "reportId",
    "identity",
    "reportedAt",
    "serverHead",
    "commonPrefix",
    "localHead",
  ]);
  if (r.contractVersion !== 1 || r.kind !== "offline_journal_recovery_report")
    invalid();
  const report: OfflineJournalRecoveryReport = {
    contractVersion: 1,
    kind: "offline_journal_recovery_report",
    reportId: uuid(r.reportId),
    identity: parseIdentity(r.identity) as TerminalIdentity,
    reportedAt: safe(r.reportedAt),
    serverHead: parsePosition(r.serverHead),
    commonPrefix: parsePosition(r.commonPrefix),
    localHead: parsePosition(r.localHead),
  };
  const { serverHead, commonPrefix, localHead } = report;
  // The common prefix is on both chains; a report says the two differ somewhere after it.
  if (
    commonPrefix.sequence > serverHead.sequence ||
    commonPrefix.sequence > localHead.sequence
  )
    invalid();
  if (
    localHead.sequence === serverHead.sequence &&
    localHead.hash === serverHead.hash
  )
    invalid();
  if (
    commonPrefix.sequence === localHead.sequence &&
    commonPrefix.hash !== localHead.hash
  )
    invalid();
  return exact(report, raw);
}

export function parseRecoveryCompletion(
  raw: unknown,
): OfflineJournalRecoveryCompletion {
  const c = object(raw, [
    "contractVersion",
    "kind",
    "recoveryId",
    "identity",
    "completedAt",
    "journalHead",
    "setAsideThrough",
    "offlineAuthorityRemoved",
  ]);
  if (
    c.contractVersion !== 1 ||
    c.kind !== "offline_journal_recovery_completion" ||
    c.offlineAuthorityRemoved !== true
  )
    invalid();
  return exact<OfflineJournalRecoveryCompletion>(
    {
      contractVersion: 1,
      kind: "offline_journal_recovery_completion",
      recoveryId: uuid(c.recoveryId),
      identity: parseIdentity(c.identity) as TerminalIdentity,
      completedAt: safe(c.completedAt),
      journalHead: parsePosition(c.journalHead),
      setAsideThrough: parsePosition(c.setAsideThrough),
      offlineAuthorityRemoved: true,
    },
    raw,
  );
}

/** The upload's outer shape; the report and each item stay unverified envelopes. */
export function parseRecoveryUpload(raw: unknown): {
  report: Signed<OfflineJournalRecoveryReport>;
  unmatched: unknown[];
  staffSignIns: unknown[];
} {
  const body = object(raw, ["report", "unmatched", "staffSignIns"]);
  const envelope = parseEnvelope(
    body.report,
  ) as Signed<OfflineJournalRecoveryReport>;
  const report = parseRecoveryReport(envelope.payload);
  if (envelope.keyId !== report.identity.keyId) invalid();
  const list = (value: unknown) => {
    if (!Array.isArray(value) || value.length > JOURNAL_RECOVERY_PAGE_MAX)
      invalid();
    return value as unknown[];
  };
  return {
    report: { ...envelope, payload: report },
    unmatched: list(body.unmatched),
    staffSignIns: list(body.staffSignIns),
  };
}

export function parseRecoveryCompletionEnvelope(
  raw: unknown,
): Signed<OfflineJournalRecoveryCompletion> {
  const body = object(raw, ["completion"]);
  const envelope = parseEnvelope(
    body.completion,
  ) as Signed<OfflineJournalRecoveryCompletion>;
  const completion = parseRecoveryCompletion(envelope.payload);
  if (envelope.keyId !== completion.identity.keyId) invalid();
  return { ...envelope, payload: completion };
}

export function parseChainRequest(raw: unknown): OfflineJournalChainRequest {
  const body = object(raw, ["identity", "afterSequence", "limit"]);
  const limit = safe(body.limit, 1);
  if (limit > JOURNAL_CHAIN_PAGE_MAX) invalid();
  return {
    identity: parseIdentity(body.identity) as TerminalIdentity,
    afterSequence: safe(body.afterSequence),
    limit,
  };
}

export function parseIdentityRequest(raw: unknown): TerminalIdentity {
  return parseIdentity(object(raw, ["identity"]).identity) as TerminalIdentity;
}
