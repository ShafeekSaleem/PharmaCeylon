import type { Signed, TerminalIdentity } from "./terminal-contracts";

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
