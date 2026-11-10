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

/** P2: GET/POST `/terminals/counters`. A counter is a branch register with its own till. */
export type TerminalCounterView = Readonly<{
  registerId: string;
  tillId: string;
  label: string;
  isActive: boolean;
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
 * P5 #51: GET `/terminals/offline-journal/sync-status`. How far one enrollment's offline journal
 * has reached the server, read from the server's own tables only. The server sees what a counter
 * has sent, never what it still holds: a counter cut off right now may have entries it has not
 * uploaded yet.
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
  /** The last upload that brought the server something: an entry, accepted or not, or a staff
   * sign-in. An upload with nothing new leaves no trace, so this can be older than the counter's
   * own "confirmed" time. */
  lastUploadAt: number | null;
  /** Entries past the head held back until the counter sends what they wait on (a gap, a staff
   * sign-in, a manager's after-hours approval), or because the key was revoked. */
  waiting: number;
  /** Entries past the head that were rejected or conflict with the accepted journal. Nothing
   * after them can be accepted until someone reviews them. */
  needsReview: number;
  /** The first entry past the head that needs review: where this journal stops. */
  stuck: Readonly<{
    sequence: number;
    outcome: "rejected" | "conflict";
    errorCode: string;
    since: number;
  }> | null;
  /** Accepted offline sales from this enrollment whose stock waits on an open stock case. */
  openStockCases: number;
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
