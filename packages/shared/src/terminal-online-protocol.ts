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
