import type {
  TerminalIdentity,
  WorkSessionIdentity,
} from "./terminal-contracts";

/** Server-issued payloads; desktop main signs with terminalSigningText("command", payload).
 * Enrollment proves key possession. Independently verified local attendance is still required.
 * Neither payload nominates an offline seller or opens/posts a financial till shift.
 */
export type TerminalEnrollmentCommand = Readonly<{
  contractVersion: 1;
  kind: "terminal_enrollment";
  identity: TerminalIdentity;
  requestedByUserId: string;
  registerId: string;
  tillId: string;
  label: string;
  publicKeyHex: string;
  issuedAt: number;
  expiresAt: number;
  serverNonce: string;
}>;

export type TerminalSessionCommand = Readonly<{
  contractVersion: 1;
  kind: "terminal_session";
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  tokenVersion: number;
  issuedAt: number;
  expiresAt: number;
  serverNonce: string;
}>;

/** D-W5 PIN sign-in, step 1: nobody is signed in, so the enrolled key alone asks for a challenge
 * for one person prepared on this counter. `requestedAt` is the device clock, only bounded. */
export type TerminalPinSessionRequest = Readonly<{
  contractVersion: 1;
  kind: "terminal_pin_session_request";
  identity: TerminalIdentity;
  staffUserId: string;
  requestedAt: number;
}>;

/** D-W5 PIN sign-in, step 2: the challenge the device signs back with that person's PIN. One
 * challenge allows one PIN attempt, right or wrong. */
export type TerminalPinSessionCommand = Readonly<{
  contractVersion: 1;
  kind: "terminal_pin_session";
  identity: TerminalIdentity;
  session: WorkSessionIdentity;
  pinVersion: number;
  tokenVersion: number;
  issuedAt: number;
  expiresAt: number;
  serverNonce: string;
}>;
