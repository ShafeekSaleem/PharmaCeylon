import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  isLocalConsoleSession,
  terminalSigningText,
  type LocalAttendanceAttestation,
  type LocalAttendanceProofReceipt,
  type LocalAttendancePurpose,
  type WindowsSessionEvidence,
} from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  boundedCanonical,
  denied,
  hex,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  sha256,
  text,
  uuid,
  verifySignature,
} from "./terminal-wire";

type Tx = Prisma.TransactionClient;
const PURPOSES: readonly LocalAttendancePurpose[] = ["enrollment", "session", "command"];
const PROTOCOLS: readonly WindowsSessionEvidence["protocol"][] = ["console", "rdp", "unknown"];

function parseAttestation(raw: unknown) {
  const envelope = parseEnvelope(raw);
  const p = object(envelope.payload, [
    "contractVersion",
    "kind",
    "proofId",
    "purpose",
    "identity",
    "actorUserId",
    "registerId",
    "tillId",
    "payloadDigest",
    "windowsSession",
    "appVersion",
    "observedAt",
  ]);
  if (p.contractVersion !== 1 || p.kind !== "local_attendance") invalid();
  uuid(p.proofId);
  if (!PURPOSES.includes(p.purpose as LocalAttendancePurpose)) invalid();
  parseIdentity(p.identity);
  uuid(p.actorUserId);
  uuid(p.registerId);
  uuid(p.tillId);
  hex(p.payloadDigest);
  const session = object(p.windowsSession, ["sessionId", "protocol", "remoteSession"]);
  if (
    !Number.isSafeInteger(session.sessionId) ||
    (session.sessionId as number) < 0 ||
    (session.sessionId as number) > 2_147_483_647 ||
    !PROTOCOLS.includes(session.protocol as WindowsSessionEvidence["protocol"]) ||
    typeof session.remoteSession !== "boolean"
  )
    invalid();
  text(p.appVersion, 64);
  if (!Number.isSafeInteger(p.observedAt) || (p.observedAt as number) < 0) invalid();
  return { envelope, payload: p as unknown as LocalAttendanceAttestation };
}

// jsonb does not keep key order, so compare the stored challenge canonically.
const same = (a: unknown, b: unknown) => boundedCanonical(a) === boundedCanonical(b);

/**
 * P2 attendance intake (`POST /terminals/attendance-proofs`). The desktop's trusted main process
 * attests which Windows session it is running in and binds that to one live challenge. This
 * stores the proof unconsumed; `LocalAttendanceVerifier` consumes it inside the transaction that
 * enrolls, authorizes a session or executes a command, so a failed operation leaves it usable
 * until the challenge expires.
 *
 * Accepted: a valid signature (the challenge's candidate key for enrollment, the enrolled key
 * otherwise) over a positively identified physical console session. Freshness comes from the
 * server challenge; the device's `observedAt` is recorded, not trusted. This is evidence of a
 * supported local session only: remote-control tools driving the console are not detected.
 */
@Injectable()
export class AttendanceProofsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  record(user: RequestUser, branchId: string, raw: unknown): Promise<LocalAttendanceProofReceipt> {
    return this.prisma.$transaction((tx) => this.recordInTransaction(tx, user, branchId, raw));
  }

  async recordInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<LocalAttendanceProofReceipt> {
    const { envelope, payload } = parseAttestation(raw);
    uuid(branchId);
    await this.access.resolveLive(user, branchId, tx);
    const { identity } = payload;
    if (
      identity.tenantId !== user.tenantId ||
      identity.branchId !== branchId ||
      payload.actorUserId !== user.userId ||
      envelope.keyId !== identity.keyId
    )
      denied("IDENTITY_MISMATCH");
    const attestationDigest = sha256(terminalSigningText("attendance", payload));

    const replay = await this.existing(tx, user, payload.proofId, attestationDigest);
    if (replay) return replay;

    const now = new Date();
    const challenge = await tx.terminalChallenge.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        purpose: payload.purpose,
        payloadDigest: payload.payloadDigest,
        consumedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!challenge) denied("CHALLENGE_INVALID");
    const publicKeyHex = await this.signingKey(tx, user, branchId, payload, challenge.payload);
    verifySignature(envelope, publicKeyHex, "attendance");
    if (!isLocalConsoleSession(payload.windowsSession)) denied("REMOTE_SESSION_DENIED");

    // Concurrent identical uploads: the loser waits on the primary key, inserts nothing and
    // then reads the winner's row, so both return the same proof.
    const inserted = await tx.terminalAttendanceProof.createMany({
      data: [
        {
          id: payload.proofId,
          tenantId: user.tenantId,
          branchId,
          challengeId: challenge.id,
          purpose: payload.purpose,
          actorUserId: user.userId,
          terminalId: identity.terminalId,
          enrollmentId: identity.enrollmentId,
          keyId: identity.keyId,
          registerId: payload.registerId,
          tillId: payload.tillId,
          payloadDigest: payload.payloadDigest,
          attestationDigest,
          attestation: envelope as unknown as Prisma.InputJsonValue,
          sessionProtocol: payload.windowsSession.protocol,
          windowsSessionId: payload.windowsSession.sessionId,
          appVersion: payload.appVersion,
          observedAt: new Date(payload.observedAt),
          expiresAt: challenge.expiresAt,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1)
      return { proofId: payload.proofId, purpose: payload.purpose, expiresAt: challenge.expiresAt.getTime() };
    const raced = await this.existing(tx, user, payload.proofId, attestationDigest);
    if (!raced) this.conflict();
    return raced;
  }

  /** Same signed attestation → the original proof (consumed or not); anything else → 409. */
  private async existing(tx: Tx, user: RequestUser, proofId: string, attestationDigest: string) {
    const row = await tx.terminalAttendanceProof.findUnique({ where: { id: proofId } });
    if (!row) return null;
    if (row.tenantId !== user.tenantId || row.attestationDigest !== attestationDigest) this.conflict();
    return {
      proofId: row.id,
      purpose: row.purpose as LocalAttendancePurpose,
      expiresAt: row.expiresAt.getTime(),
    } satisfies LocalAttendanceProofReceipt;
  }

  private conflict(): never {
    throw new ConflictException({
      code: "REPLAY_CONFLICT",
      message: "This attendance proof ID was already used for different content.",
    });
  }

  /** The attestation must name exactly what the challenge names; returns the key to verify with. */
  private async signingKey(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    attestation: LocalAttendanceAttestation,
    challengePayload: Prisma.JsonValue,
  ): Promise<string> {
    const c = challengePayload as Record<string, unknown>;
    const counter =
      attestation.purpose === "enrollment"
        ? { registerId: c.registerId, tillId: c.tillId }
        : {
            registerId: (c.session as Record<string, unknown>)?.registerId,
            tillId: (c.session as Record<string, unknown>)?.tillId,
          };
    if (
      !same(c.identity, attestation.identity) ||
      counter.registerId !== attestation.registerId ||
      counter.tillId !== attestation.tillId
    )
      denied("IDENTITY_MISMATCH");
    // A new device has no enrolled key yet: it proves possession of the candidate key it asked
    // to enroll. Every later proof uses the key pinned at enrollment.
    if (attestation.purpose === "enrollment") return hex(c.publicKeyHex);
    const { identity } = attestation;
    const enrollment = await tx.terminalEnrollment.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: identity.enrollmentId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
      },
      include: { terminal: true },
    });
    if (!enrollment || enrollment.revokedAt || enrollment.terminal.retiredAt) denied("TERMINAL_REVOKED");
    return enrollment.publicKeyHex;
  }
}
