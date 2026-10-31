import type { Signed, TerminalIdentity } from "./terminal-contracts";
import type { TerminalEnrollmentCommand } from "./terminal-online-protocol";

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
export type TerminalSessionChallengeRequest = Readonly<{ identity: TerminalIdentity }>;

/** GET `/terminals/enrollments/:enrollmentId`. */
export type TerminalEnrollmentStatusView = Readonly<{
  enrollmentId: string;
  terminalId: string;
  registerId: string | null;
  tillId: string | null;
  label: string;
  status: "active" | "revoked" | "retired";
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
export type TerminalEnrollmentCodeIssueRequest = Readonly<{ registerId: string; expiresInMinutes?: number }>;

/** The issue response: show `code` to the manager once (formatted `XXXXX-XXXXX`). */
export type TerminalEnrollmentCodeIssued = Readonly<{ code: string; view: TerminalEnrollmentCodeView }>;

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
