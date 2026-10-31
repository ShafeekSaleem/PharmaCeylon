import { createHash, randomUUID } from "node:crypto";
import {
  terminalSigningText,
  type LocalAttendanceAttestation,
  type LocalAttendancePurpose,
  type OnlineTerminalCommand,
  type TerminalEnrollmentCommand,
  type TerminalSessionCommand,
  type WindowsSessionEvidence,
} from "@pharmaceylon/shared";

type Challenge = TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>;

/** The server's challenge digest: sha256 of the challenge's canonical command text. */
export function challengeDigest(challenge: unknown): string {
  return createHash("sha256").update(terminalSigningText("command", challenge), "utf8").digest("hex");
}

/**
 * Binds what this process saw of the Windows session to one server challenge. Built in the main
 * process from the challenge the server returned, never from renderer input.
 */
export function buildAttestation(input: {
  challenge: Challenge;
  purpose: LocalAttendancePurpose;
  actorUserId: string;
  windowsSession: WindowsSessionEvidence;
  appVersion: string;
  now: number;
  proofId?: string;
}): LocalAttendanceAttestation {
  const { challenge } = input;
  const counter =
    challenge.kind === "terminal_enrollment"
      ? { registerId: challenge.registerId, tillId: challenge.tillId }
      : { registerId: challenge.session.registerId, tillId: challenge.session.tillId };
  return {
    contractVersion: 1,
    kind: "local_attendance",
    proofId: input.proofId ?? randomUUID(),
    purpose: input.purpose,
    identity: challenge.identity,
    actorUserId: input.actorUserId,
    ...counter,
    payloadDigest: challengeDigest(challenge),
    windowsSession: input.windowsSession,
    appVersion: input.appVersion.slice(0, 64) || "0.0.0",
    observedAt: input.now,
  };
}
