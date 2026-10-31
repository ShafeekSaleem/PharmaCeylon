import type { TerminalIdentity } from "./terminal-contracts";

/** What a local-attendance proof is for; matches the server challenge it binds. */
export type LocalAttendancePurpose = "enrollment" | "session" | "command";

/** How the desktop's trusted main process saw the current Windows session.
 * `console` is the physical console session; `rdp` is a Remote Desktop session; anything the
 * process cannot positively identify is `unknown`. Only `console` with `remoteSession: false`
 * is accepted. Third-party remote-control tools that drive the console session look local to
 * Windows and are a documented limitation (docs/API_CONTRACT.md), not something this detects.
 */
export type WindowsSessionEvidence = Readonly<{
  sessionId: number;
  protocol: "console" | "rdp" | "unknown";
  remoteSession: boolean;
}>;

/** P2 attendance attestation, built and signed by desktop main with
 * terminalSigningText("attendance", payload). Enrollment proofs are signed with the candidate
 * key from the enrollment challenge; session and command proofs with the enrolled key.
 * `payloadDigest` is the challenge digest (sha256 of the challenge's canonical command text).
 * `proofId` is client-generated: resending the same signed attestation returns the same proof;
 * reusing the ID for different content is 409 `REPLAY_CONFLICT`.
 */
export type LocalAttendanceAttestation = Readonly<{
  contractVersion: 1;
  kind: "local_attendance";
  proofId: string;
  purpose: LocalAttendancePurpose;
  identity: TerminalIdentity;
  actorUserId: string;
  registerId: string;
  tillId: string;
  payloadDigest: string;
  windowsSession: WindowsSessionEvidence;
  appVersion: string;
  observedAt: number;
}>;

/** POST `/terminals/attendance-proofs` response. */
export type LocalAttendanceProofReceipt = Readonly<{
  proofId: string;
  purpose: LocalAttendancePurpose;
  expiresAt: number;
}>;

/** Accept only the positively identified physical console session. */
export function isLocalConsoleSession(session: WindowsSessionEvidence): boolean {
  return session.protocol === "console" && session.remoteSession === false;
}
