import type {
  OfflineJournalCommand,
  OfflineStaffSignIn,
  Signed,
  TerminalIdentity,
} from "./terminal-contracts";

/**
 * P5 #51, approved D11 (decisions of 2026-11-10): journal recovery and the missing-journal
 * sign-off that lets another counter take over offline selling.
 *
 * A journal is a hash chain: entry `n` names entry `n - 1`'s hash, so a position (a sequence and
 * the hash of the entry there) commits to every entry before it. The server's accepted chain is
 * authoritative; a counter never writes an entry at a sequence the server has accepted.
 */

/** A journal position. Sequence 0 with a null hash is the empty journal. */
export type JournalPosition = Readonly<{
  sequence: number;
  hash: string | null;
}>;

/**
 * Device-signed (purpose `command`) by a counter whose journal is not the server's
 * (`JOURNAL_MISMATCH`: a restored backup, a damaged journal). Uploaded with every local entry the
 * server never accepted, and the sign-ins they cite. Reporting changes nothing centrally; the
 * owner or a delegated manager approves the recovery in the back office.
 */
export type OfflineJournalRecoveryReport = Readonly<{
  contractVersion: 1;
  kind: "offline_journal_recovery_report";
  /** Client-generated: resending the same report returns the same recovery. */
  reportId: string;
  identity: TerminalIdentity;
  reportedAt: number;
  /**
   * The server's accepted head, as this computer verified it: it read the accepted chain from its
   * own accepted watermark and checked every entry against its own key and the chain.
   */
  serverHead: JournalPosition;
  /** The last entry this computer and the server agree on. */
  commonPrefix: JournalPosition;
  /**
   * This computer's last entry. The entries after the common prefix through this one were never
   * accepted (the unmatched entries); the chain fixes exactly which they are.
   */
  localHead: JournalPosition;
}>;

/**
 * `POST /terminals/offline-journal/recovery/report`. The same signed report is sent with each
 * page of unmatched entries, oldest first, each page continuing from the last one received, with
 * the sign-ins that page cites; an empty page just reports (or re-reads) the recovery.
 */
export type OfflineJournalRecoveryUpload = Readonly<{
  report: Signed<OfflineJournalRecoveryReport>;
  unmatched: ReadonlyArray<Signed<OfflineJournalCommand>>;
  staffSignIns: ReadonlyArray<Signed<OfflineStaffSignIn>>;
}>;
export const JOURNAL_RECOVERY_PAGE_MAX = 25;

/**
 * Device-signed once the counter has, in one local transaction, set its unmatched entries aside
 * (kept, never deleted), restored the server's accepted entries, moved its journal head to the
 * approved server head and removed its installed offline grant and snapshot. The server then
 * closes the recovery; only a fresh pair issued after that can sell offline here.
 */
export type OfflineJournalRecoveryCompletion = Readonly<{
  contractVersion: 1;
  kind: "offline_journal_recovery_completion";
  recoveryId: string;
  identity: TerminalIdentity;
  completedAt: number;
  /** The approved server head, now this computer's journal head. */
  journalHead: JournalPosition;
  /** The report's local head: every entry after the common prefix through it was set aside. */
  setAsideThrough: JournalPosition;
  offlineAuthorityRemoved: true;
}>;

/**
 * `awaiting_approval` → `approved` → `recovered` for a restored counter; a missing-journal
 * sign-off is created `approved`. `superseded`: replaced by a newer report or sign-off, or
 * stale because the server's journal or the counter's moved. `closed`: a restore the owner or a
 * delegated manager closed, with a reason, because it will not complete.
 */
export type OfflineJournalRecoveryStatus =
  | "awaiting_approval"
  | "approved"
  | "recovered"
  | "superseded"
  | "closed";
export type OfflineJournalRecoveryKind = "counter_restore" | "missing_journal";

/** What a counter is told about its own recovery (`POST /terminals/offline-journal/recovery/status`). */
export type CounterJournalRecovery = Readonly<{
  recoveryId: string;
  reportId: string;
  status: OfflineJournalRecoveryStatus;
  serverHead: JournalPosition;
  commonPrefix: JournalPosition;
  localHead: JournalPosition;
  /** Unmatched entries the report names, and how many of them the server holds as evidence. */
  unmatched: number;
  received: number;
  approvedAt: number | null;
}>;

/**
 * `POST /terminals/offline-journal/recovery/status`. `localHead` is this computer's journal head
 * now: an open recovery reported from another head is moot, and the server supersedes it.
 */
export type OfflineJournalRecoveryStatusRequest = Readonly<{
  identity: TerminalIdentity;
  localHead: JournalPosition;
}>;

/** `POST /terminals/offline-journal/recovery/chain`: accepted entries after `afterSequence`, oldest first. */
export type OfflineJournalChainRequest = Readonly<{
  identity: TerminalIdentity;
  afterSequence: number;
  limit: number;
}>;
export type OfflineJournalChainPage = Readonly<{
  /**
   * The accepted head now. The counter trusts it only once it has verified every entry up to it:
   * each one is signed by its own device key and chained from a position it already holds, so the
   * server can withhold entries but never invent them.
   */
  head: JournalPosition;
  entries: ReadonlyArray<Signed<OfflineJournalCommand>>;
  /** Every staff sign-in the entries cite. */
  staffSignIns: ReadonlyArray<Signed<OfflineStaffSignIn>>;
}>;
export const JOURNAL_CHAIN_PAGE_MAX = 100;

/** One entry the server accepted or one it never did, summarised for the reviewer. */
export type JournalRecoveryEntrySummary = Readonly<{
  sequence: number;
  commandId: string;
  hash: string;
  kind: OfflineJournalCommand["kind"];
  occurredAt: number;
  staffUserId: string | null;
  staffFullName: string | null;
  totalMinor: number | null;
  lineCount: number | null;
}>;

/** A retained refusal (slice 1) past the accepted head: it never became part of the journal. */
export type JournalRecoveryRefusal = Readonly<{
  sequence: number | null;
  recordKind: "command" | "staff_sign_in";
  outcome: "held" | "rejected" | "conflict";
  errorCode: string;
  lastReceivedAt: number;
}>;

/** D11 authority cutoff (P3), as the back office shows it. */
export type JournalRecoveryCutoff = Readonly<{
  kind: "device_disabled" | "grants_expire" | "never_issued";
  at: number | null;
  lastGrantExpiresAt: number | null;
}>;

/** `GET /offline-journal-recoveries/:id`. Times are epoch milliseconds. */
export type OfflineJournalRecoveryView = Readonly<{
  recoveryId: string;
  kind: OfflineJournalRecoveryKind;
  status: OfflineJournalRecoveryStatus;
  terminalId: string;
  terminalLabel: string | null;
  enrollmentId: string;
  createdAt: number;
  serverHead: JournalPosition & Readonly<{ acceptedAt: number | null }>;
  /** Counter restore only. */
  localHead: JournalPosition | null;
  commonPrefix: JournalPosition | null;
  /** Accepted entries the restored computer gets back (counter restore). */
  restoredEntries: number;
  /** Entries on the restored computer the server never accepted: evidence, never sales. */
  unmatched: ReadonlyArray<JournalRecoveryEntrySummary>;
  /** Retained refusals past the accepted head for this enrollment. */
  refusals: ReadonlyArray<JournalRecoveryRefusal>;
  /** Missing-journal sign-off only. */
  nominationVersion: number | null;
  cutoff: JournalRecoveryCutoff | null;
  approval: Readonly<{
    approvedByUserId: string;
    approvedByFullName: string | null;
    approvedAt: number;
    reason: string;
    authority: "owner" | "delegated_manager";
  }> | null;
  completedAt: number | null;
  supersededAt: number | null;
  /** Counter restore closed without completing. */
  closure: Readonly<{
    closedByUserId: string;
    closedByFullName: string | null;
    closedAt: number;
    reason: string;
    authority: "owner" | "delegated_manager";
  }> | null;
  /**
   * Counter restore: when this counter can be issued offline authority again (D11): once every
   * grant issued before the restore finishes has expired, because the computer it was copied
   * from may still hold one. Null when nothing waits. Online selling is never held.
   */
  offlineResumesAt: number | null;
  /** The server's journal moved since this was reported or signed off: report or sign off again. */
  stale: boolean;
}>;

/**
 * The branch's offline counter as D11 replacement sees it (`GET /offline-journal-recoveries`).
 * `signOffAvailableAt`: when a missing-journal sign-off becomes possible — once the old counter's
 * last issued grant has expired, even if it was revoked or retired (2026-11-10).
 */
export type OfflineCounterReplacementView = Readonly<{
  terminalId: string;
  terminalLabel: string | null;
  enrollmentId: string;
  nominationVersion: number;
  revoked: boolean;
  cutoff: JournalRecoveryCutoff;
  serverHead: JournalPosition & Readonly<{ acceptedAt: number | null }>;
  refusals: ReadonlyArray<JournalRecoveryRefusal>;
  /** When a sign-off becomes possible; null: now (no grant was ever issued). */
  signOffAvailableAt: number | null;
  /** The current sign-off, if any, and whether it still covers the journal. */
  signOff: Readonly<{
    recoveryId: string;
    approvedAt: number;
    approvedByFullName: string | null;
    current: boolean;
  }> | null;
  /** Whether D11's journal half holds now: a sign-off that still covers the journal. */
  journalCleared: boolean;
}>;

export type OfflineJournalRecoveriesView = Readonly<{
  branchId: string;
  /** Open counter restores first, then the newest 20 others. */
  recoveries: ReadonlyArray<
    Pick<
      OfflineJournalRecoveryView,
      | "recoveryId"
      | "kind"
      | "status"
      | "terminalId"
      | "terminalLabel"
      | "enrollmentId"
      | "createdAt"
      | "stale"
    > &
      Readonly<{ unmatched: number }>
  >;
  offlineCounter: OfflineCounterReplacementView | null;
}>;

/** `POST /offline-journal-recoveries/:id/approve`: approve exactly what was shown. */
export type ApproveJournalRecoveryRequest = Readonly<{
  reason: string;
  expectedServerHeadSequence: number;
  expectedUnmatched: number;
}>;

/** `POST /offline-journal-recoveries/:id/close`: close a restore that will not complete. */
export type CloseJournalRecoveryRequest = Readonly<{ reason: string }>;

/** `POST /offline-journal-recoveries/missing-journal`: sign off the offline counter's journal. */
export type MissingJournalSignOffRequest = Readonly<{
  enrollmentId: string;
  expectedNominationVersion: number;
  expectedServerHeadSequence: number;
  reason: string;
}>;

/**
 * Whether `entries` continue the chain from `from`: contiguous sequences, each naming the
 * previous entry's hash. `hashes[i]` is the caller's own digest of `entries[i]`'s payload.
 * Signatures are the caller's to verify.
 */
export function continuesJournalChain(
  from: JournalPosition,
  entries: ReadonlyArray<
    Pick<OfflineJournalCommand, "sequence" | "previousCommandHash">
  >,
  hashes: ReadonlyArray<string>,
): boolean {
  if (entries.length !== hashes.length) return false;
  let previous = from;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (
      entry.sequence !== previous.sequence + 1 ||
      entry.previousCommandHash !== previous.hash
    )
      return false;
    previous = { sequence: entry.sequence, hash: hashes[i]! };
  }
  return true;
}
