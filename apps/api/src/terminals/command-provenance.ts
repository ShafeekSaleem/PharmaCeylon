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
  /** The SLMC registration a clinical operation relied on (P1 #47); null for non-clinical ones. */
  pharmacistRegistrationId: string | null;
  /** Whose registration that is: the session's staff member dispensing alone, or the pharmacist
   * who co-signed by PIN. Null for non-clinical operations. */
  pharmacistUserId: string | null;
  /** The PIN co-sign the command spent; null when nobody co-signed. */
  pharmacistEvidenceId: string | null;
}>;
