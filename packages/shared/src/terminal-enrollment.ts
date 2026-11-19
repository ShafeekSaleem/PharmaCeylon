import type { LocalAttendanceAttestation } from "./terminal-attendance";
import type {
  Signed,
  TerminalIdentity,
  WorkSessionIdentity,
} from "./terminal-contracts";
import type {
  TerminalEnrollmentCommand,
  TerminalPinSessionCommand,
} from "./terminal-online-protocol";

/** P2: GET/POST/PATCH `/terminals/counters`. A counter is a branch register with its own till. */
export type TerminalCounterView = Readonly<{
  registerId: string;
  tillId: string;
  label: string;
  isActive: boolean;
  /** Anything records what happened here (computers, sign-ins, shifts, codes): it can be stopped but not deleted. */
  hasHistory: boolean;
  /** A shift is open on this counter's till, so it cannot be stopped yet. */
  hasOpenShift: boolean;
  /** The terminal currently occupying this counter (not retired), if any. */
  terminal: Readonly<{
    terminalId: string;
    label: string;
    /** Its active enrollment; null when every key has been revoked. */
    enrollmentId: string | null;
    enrolledAt: number | null;
  }> | null;
}>;

/**
 * P5 #51: one enrollment in GET `/terminals/offline-journal/sync-status`. How far its offline
 * journal has reached the server, read from the server's own tables only. The server sees what a
 * counter has sent, never what it still holds: a counter cut off right now may have entries it
 * has not uploaded yet, and the server can't tell how many follow an entry it refused.
 */
export type CounterJournalSyncView = Readonly<{
  enrollmentId: string;
  terminalId: string;
  terminalLabel: string;
  /** The counter the computer is (or was) on. */
  registerId: string | null;
  /** The counter's enrollment now: key not revoked and computer not retired. */
  current: boolean;
  revokedAt: number | null;
  retiredAt: number | null;
  /** The highest accepted journal entry, and when the server accepted it. Null: none yet. */
  head: Readonly<{ sequence: number; acceptedAt: number }> | null;
  /** The last time an upload brought the server something new: an entry, accepted or refused, or
   * a staff sign-in. An upload with nothing new leaves no trace, so a counter that has sold
   * nothing offline since shows an older time than its own "confirmed" one. */
  lastReceivedAt: number | null;
  /**
   * Where the journal stopped: the first entry past the head the server refused, or null. Intake
   * stops at the first refusal, so nothing after it reaches the server until it is resolved.
   * `held`: the counter repairs it by sending what it lacks (an earlier entry, a staff sign-in,
   * a manager's after-hours approval), or a revoked key's journal waits for recovery. `rejected`
   * or `conflict`: it will never be accepted as sent; someone must review it.
   */
  stoppedAt: Readonly<{
    sequence: number;
    outcome: "held" | "rejected" | "conflict";
    errorCode: string;
    /** When the server first refused it. */
    since: number;
  }> | null;
  /** Accepted offline sales from this enrollment whose stock waits on an open stock case. */
  openStockCases: number;
}>;

/** P5 #51: GET `/terminals/offline-journal/sync-status`. Times read in the branch's timezone. */
export type CounterJournalSyncStatus = Readonly<{
  timezone: string;
  enrollments: ReadonlyArray<CounterJournalSyncView>;
}>;

/**
 * P5 #51 item 11 (W10 #72 shows it): one branch in GET `/reports/offline-sync-freshness`, so a
 * sales or stock report can say what it may be missing. Counters that have never sent an offline
 * journal and have nothing outstanding are left out: they have nothing to be late with.
 */
export type ReportSyncFreshnessBranch = Readonly<{
  branchId: string;
  branchName: string;
  /** The branch's own timezone, for the times below. */
  timezone: string;
  /** Sales in the report's range that were accepted from an offline journal but whose stock has
   * not posted yet (`stockPosting = pending_reconciliation`): their sale and payment stand, but
   * stock reports don't show the units leaving until the stock case settles. */
  pendingStockSales: number;
  counters: ReadonlyArray<
    Readonly<{
      enrollmentId: string;
      terminalLabel: string;
      current: boolean;
      /** When the server accepted the counter's latest journal entry. Null: none yet. */
      lastAcceptedAt: number | null;
      lastReceivedAt: number | null;
      stoppedAt: CounterJournalSyncView["stoppedAt"];
      openStockCases: number;
    }>
  >;
}>;

/** P5 #51 item 11: GET `/reports/offline-sync-freshness?days=&scope=`. A caveat, not a figure:
 * nothing here changes a report's totals. `complete` is false while any branch in scope has a
 * stopped journal, an open stock case or a sale in range whose stock is pending. */
export type ReportSyncFreshness = Readonly<{
  days: number;
  asOf: number;
  complete: boolean;
  branches: ReadonlyArray<ReportSyncFreshnessBranch>;
}>;

/** POST `/terminals/enrollments/challenge`. The desktop generates the Ed25519 key and keeps the
 * private half in its main process; `publicKeyHex` is the raw 32-byte key, lowercase hex. */
export type TerminalEnrollmentChallengeRequest = Readonly<{
  registerId: string;
  keyId: string;
  publicKeyHex: string;
  label: string;
}>;

/** POST `/terminals/enrollments` and `/terminals/sessions`: the challenge payload signed verbatim
 * with terminalSigningText("command", payload), plus a recorded attendance proof for it. */
export type TerminalSignedWithProof<T> = Readonly<{
  envelope: Signed<T>;
  attendanceProofId: string;
}>;

/** POST `/terminals/sessions/challenge`. */
export type TerminalSessionChallengeRequest = Readonly<{
  identity: TerminalIdentity;
}>;

/** POST `/terminals/pin-sessions`: the signed challenge, the signed attendance attestation for
 * it (purpose `pin_session`, actor = the person signing in) and their PIN. */
export type TerminalPinSignInRequest = Readonly<{
  envelope: Signed<TerminalPinSessionCommand>;
  attendance: Signed<LocalAttendanceAttestation>;
  pin: string;
}>;

/** The `/terminals/pin-sessions` result: a sign-in that works only at this counter, at its
 * branch, and only while the staff session it opened stays open. */
export type TerminalPinSignInResult = Readonly<{
  accessToken: string;
  refreshToken: string;
  user: Readonly<{
    id: string;
    tenantId: string;
    email: string;
    fullName: string;
    roles: string[];
    branchRoles: Array<Readonly<{ branchId: string; role: string }>>;
  }>;
  session: WorkSessionIdentity;
}>;

/** Offline nomination / assignment facts for the enrolled counter (epoch ms; null when N/A). */
export type TerminalEnrollmentOfflineBackup = Readonly<{
  authorizedAt: number | null;
  authorizedByUserId: string | null;
  authorizedByFullName: string | null;
  activatedAt: number | null;
  activatedByUserId: string | null;
  activatedByFullName: string | null;
}>;

/** GET `/terminals/enrollments/:enrollmentId`. */
export type TerminalEnrollmentStatusView = Readonly<{
  enrollmentId: string;
  terminalId: string;
  registerId: string | null;
  tillId: string | null;
  /** Device label on `OperationalTerminal` (unchanged). */
  label: string;
  /** Human till name from `TerminalCounter.label` (same meaning as enrollment-code `counterLabel`). */
  counterLabel: string | null;
  status: "active" | "revoked" | "retired";
  offlineBackup: TerminalEnrollmentOfflineBackup;
  /** The last test receipt confirmed at this enrollment (go-live evidence); null when none. */
  lastTestReceipt: TerminalTestReceiptFact | null;
}>;

/** A confirmed test receipt: when (epoch ms), who, and on which Windows printer. */
export type TerminalTestReceiptFact = Readonly<{
  confirmedAt: number;
  confirmedByName: string | null;
  printerName: string;
}>;

/** D-W5: GET `/terminals/sessions/:workSessionId/credential` (and the PIN set/prepare results).
 * The counter is prepared when `preparedVersion === pinVersion`; a PIN change makes it stale. */
export type TerminalStaffCredentialView = Readonly<{
  pinSet: boolean;
  pinVersion: number;
  /** Epoch ms while wrong PIN attempts have locked the PIN; otherwise null. */
  lockedUntil: number | null;
  preparedVersion: number | null;
}>;

/** P2 one-time enrollment codes (`/terminals/enrollment-codes`). The code itself is returned once,
 * at issue; afterwards only this view exists. */
export type TerminalEnrollmentCodeView = Readonly<{
  codeId: string;
  registerId: string;
  tillId: string;
  counterLabel: string;
  createdByUserId: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedByUserId: string | null;
  enrollmentId: string | null;
  revokedAt: number | null;
  status: "outstanding" | "used" | "revoked" | "expired";
}>;

/** POST `/terminals/enrollment-codes`. `expiresInMinutes` 5–1440, default 60. */
export type TerminalEnrollmentCodeIssueRequest = Readonly<{
  registerId: string;
  expiresInMinutes?: number;
}>;

/** The issue response: show `code` to the manager once (formatted `XXXXX-XXXXX`). */
export type TerminalEnrollmentCodeIssued = Readonly<{
  code: string;
  view: TerminalEnrollmentCodeView;
}>;

/** POST `/terminals/enrollments/code-challenge`: any branch staff member redeems a code. */
export type TerminalEnrollmentCodeChallengeRequest = Readonly<{
  code: string;
  keyId: string;
  publicKeyHex: string;
  label: string;
}>;

export type TerminalEnrollmentCodeChallenge = Readonly<{
  command: TerminalEnrollmentCommand;
  counterLabel: string;
}>;
