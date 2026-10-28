/** Verified signed-command identity, supplied only by TerminalCommandExecutor after
 * OperationAuthorizationService has verified the command in the same transaction. Domain
 * cores copy it into their success audit; it is never read from a request body or header.
 */
export type CommandProvenance = Readonly<{
  commandId: string;
  requestDigest: string;
  terminalId: string;
  enrollmentId: string;
  keyId: string;
  registerId: string;
  tillId: string;
  workSessionId: string;
  attendanceId: string;
}>;
