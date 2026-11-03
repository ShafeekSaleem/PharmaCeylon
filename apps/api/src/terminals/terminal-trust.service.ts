import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type TerminalChallenge } from "@prisma/client";
import type {
  OnlineTerminalCommand,
  Signed,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalPinSessionCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { MUTATION_ACTIONS } from "../security/mutation-actions";
import { LocalAttendanceVerifier } from "./local-attendance.verifier";
import { checkPosPin, pinRefusal, pinUnavailable, type PinCheck } from "./pos-pin";
import {
  boundedCanonical,
  CHALLENGE_LIFETIME_MS,
  denied,
  hex,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  parseOnlineCommand,
  parseSession,
  sha256,
  text,
  times,
  uuid,
  verifySignature,
  type BodyParser,
} from "./terminal-wire";

type Tx = Prisma.TransactionClient;
/** Whose challenge it is: the signed-in caller, or the person a PIN sign-in names. */
type Actor = Pick<RequestUser, "tenantId" | "userId">;
/** An open PIN challenge is handed out again while at least this much of its life is left, so the
 * counter always has time to finish it. */
const PIN_CHALLENGE_REUSE_MIN_MS = CHALLENGE_LIFETIME_MS / 2;

/** Crockford base32 without I, L, O, U: easy to read aloud and type at a counter. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function normalizeEnrollmentCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}
export function newEnrollmentCode(): { code: string; display: string } {
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
  return { code, display: `${code.slice(0, 5)}-${code.slice(5)}` };
}
type Purpose = "enrollment" | "session" | "command" | "pin_session";
type EvidenceIds = Pick<
  OnlineTerminalCommand<unknown>,
  "approvalEvidenceId" | "pharmacistEvidenceId" | "operatingHoursExceptionId"
>;

/** All writes take the caller's transaction. In particular verifyCommand's nonce consumption
 * MUST share the future business/audit/receipt transaction so a failed execution is retryable.
 * These services are exported to P2 and the forthcoming executor, not exposed as HTTP routes.
 */
@Injectable()
export class TerminalTrustService {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly attendance: LocalAttendanceVerifier,
  ) {}

  private async actor(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    permission?: string,
  ) {
    uuid(user.tenantId);
    uuid(user.userId);
    uuid(branchId);
    const access = await this.access.resolveLive(user, branchId, tx);
    if (permission !== undefined && !access.has(permission))
      denied("PERMISSION_DENIED");
    return access;
  }

  async createCounter(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    label: string,
  ) {
    await this.actor(tx, user, branchId, "tenant.management");
    text(label, 120);
    const counter = await tx.terminalCounter.create({
      data: { tenantId: user.tenantId, branchId, label },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.counter_created",
        entityName: "terminal_counter",
        entityId: counter.id,
        payload: { registerId: counter.id, tillId: counter.tillId },
      },
      tx,
    );
    return counter;
  }

  private async counter(
    tx: Tx,
    tenantId: string,
    branchId: string,
    registerId: string,
    tillId?: string,
  ) {
    const counter = await tx.terminalCounter.findFirst({
      where: {
        tenantId,
        branchId,
        id: uuid(registerId),
        ...(tillId ? { tillId } : {}),
        isActive: true,
      },
    });
    if (!counter) denied("IDENTITY_MISMATCH");
    return counter;
  }

  /**
   * One computer per counter. Locks the counter row so concurrent enrollments onto it serialize,
   * then refuses an occupied counter with 409 rather than tripping the unique index (a 500).
   */
  private async vacantCounter(
    tx: Tx,
    tenantId: string,
    branchId: string,
    registerId: string,
    tillId?: string,
  ) {
    const counter = await this.counter(tx, tenantId, branchId, registerId, tillId);
    await tx.$queryRaw`SELECT id FROM terminal_counter WHERE tenant_id = ${tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${counter.id}::uuid FOR UPDATE`;
    const occupied = await tx.operationalTerminal.count({
      where: { tenantId, branchId, registerId: counter.id, retiredAt: null },
    });
    if (occupied)
      throw new ConflictException({
        code: "COUNTER_OCCUPIED",
        message: "A computer is already enrolled on this counter. Retire it first.",
      });
    return counter;
  }

  private async challenge<T extends { serverNonce: string; expiresAt: number }>(
    tx: Tx,
    user: Actor,
    branchId: string,
    purpose: Purpose,
    payload: T,
    enrollmentCodeId: string | null = null,
  ): Promise<T> {
    const encoded = boundedCanonical(payload);
    await tx.terminalChallenge.create({
      data: {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        purpose,
        nonceHash: sha256(payload.serverNonce),
        payloadDigest: sha256(encoded),
        payload: payload as Prisma.InputJsonValue,
        expiresAt: new Date(payload.expiresAt),
        enrollmentCodeId,
      },
    });
    return payload;
  }

  private timing() {
    const issuedAt = Date.now();
    return {
      issuedAt,
      expiresAt: issuedAt + CHALLENGE_LIFETIME_MS,
      serverNonce: randomBytes(32).toString("hex"),
    };
  }

  async beginEnrollment(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    input: {
      registerId: string;
      keyId: string;
      publicKeyHex: string;
      label: string;
    },
  ): Promise<TerminalEnrollmentCommand> {
    await this.actor(tx, user, branchId, "tenant.management");
    text(input.keyId);
    hex(input.publicKeyHex);
    text(input.label, 120);
    const counter = await this.vacantCounter(
      tx,
      user.tenantId,
      branchId,
      input.registerId,
    );
    return this.challenge(tx, user, branchId, "enrollment", {
      contractVersion: 1,
      kind: "terminal_enrollment",
      identity: {
        tenantId: user.tenantId,
        branchId,
        terminalId: randomUUID(),
        enrollmentId: randomUUID(),
        keyId: input.keyId,
      },
      requestedByUserId: user.userId,
      registerId: counter.id,
      tillId: counter.tillId,
      label: input.label,
      publicKeyHex: input.publicKeyHex,
      ...this.timing(),
    });
  }

  /** P2: any branch staff member at the new computer redeems a manager's one-time code. The code
   * fixes the counter; it is checked again and consumed when the enrollment finishes. */
  async beginEnrollmentWithCode(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    input: { code: string; keyId: string; publicKeyHex: string; label: string },
  ): Promise<{ command: TerminalEnrollmentCommand; counterLabel: string }> {
    await this.actor(tx, user, branchId);
    text(input.keyId);
    hex(input.publicKeyHex);
    text(input.label, 120);
    const code = await tx.terminalEnrollmentCode.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        codeHash: sha256(normalizeEnrollmentCode(text(input.code, 32))),
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!code) denied("ENROLLMENT_CODE_INVALID");
    const counter = await this.vacantCounter(
      tx,
      user.tenantId,
      branchId,
      code.registerId,
      code.tillId,
    );
    const command = await this.challenge(
      tx,
      user,
      branchId,
      "enrollment",
      {
        contractVersion: 1 as const,
        kind: "terminal_enrollment" as const,
        identity: {
          tenantId: user.tenantId,
          branchId,
          terminalId: randomUUID(),
          enrollmentId: randomUUID(),
          keyId: input.keyId,
        },
        requestedByUserId: user.userId,
        registerId: counter.id,
        tillId: counter.tillId,
        label: input.label,
        publicKeyHex: input.publicKeyHex,
        ...this.timing(),
      },
      code.id,
    );
    return { command, counterLabel: counter.label };
  }

  /** Locks and rechecks the code a challenge was issued against; the counter must still match. */
  private async claimableCode(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    codeId: string,
    payload: { registerId: string; tillId: string },
  ) {
    await tx.$queryRaw`SELECT id FROM terminal_enrollment_code WHERE tenant_id = ${user.tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${codeId}::uuid FOR UPDATE`;
    const code = await tx.terminalEnrollmentCode.findFirst({
      where: { tenantId: user.tenantId, branchId, id: codeId },
    });
    if (
      !code ||
      code.usedAt ||
      code.revokedAt ||
      code.expiresAt.getTime() <= Date.now() ||
      code.registerId !== payload.registerId ||
      code.tillId !== payload.tillId
    )
      denied("ENROLLMENT_CODE_INVALID");
    return code;
  }

  private async checkChallenge(
    tx: Tx,
    user: Actor,
    branchId: string,
    purpose: Purpose,
    payload: { serverNonce: string; expiresAt: number; issuedAt: number },
    digest: string,
  ) {
    const now = Date.now();
    times(payload, now);
    const challenge = await tx.terminalChallenge.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        purpose,
        nonceHash: sha256(payload.serverNonce),
        payloadDigest: digest,
        consumedAt: null,
        expiresAt: { gt: new Date(now) },
      },
    });
    if (!challenge || challenge.expiresAt.getTime() !== payload.expiresAt)
      denied("CHALLENGE_INVALID");
    return challenge;
  }

  private async consume(
    tx: Tx,
    user: Actor,
    branchId: string,
    challengeId: string,
  ) {
    const consumed = await tx.terminalChallenge.updateMany({
      where: {
        id: challengeId,
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) denied("CHALLENGE_USED_OR_EXPIRED");
  }

  async finishEnrollment(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    proofId: string,
  ) {
    const envelope = parseEnvelope(raw);
    const p = object(envelope.payload, [
      "contractVersion",
      "kind",
      "identity",
      "requestedByUserId",
      "registerId",
      "tillId",
      "label",
      "publicKeyHex",
      "issuedAt",
      "expiresAt",
      "serverNonce",
    ]);
    if (p.contractVersion !== 1 || p.kind !== "terminal_enrollment") invalid();
    const identity = parseIdentity(p.identity);
    uuid(p.requestedByUserId);
    uuid(p.registerId);
    uuid(p.tillId);
    text(p.label, 120);
    hex(p.publicKeyHex);
    await this.actor(tx, user, branchId);
    if (
      identity.tenantId !== user.tenantId ||
      identity.branchId !== branchId ||
      p.requestedByUserId !== user.userId ||
      envelope.keyId !== identity.keyId
    )
      denied("IDENTITY_MISMATCH");
    const payload = p as unknown as TerminalEnrollmentCommand;
    const digest = sha256(boundedCanonical(payload));
    const challenge = await this.checkChallenge(
      tx,
      user,
      branchId,
      "enrollment",
      payload,
      digest,
    );
    // A manager enrolls directly; anyone else needs the manager's one-time code for this counter.
    const code = challenge.enrollmentCodeId
      ? await this.claimableCode(tx, user, branchId, challenge.enrollmentCodeId, payload)
      : null;
    if (!code) await this.actor(tx, user, branchId, "tenant.management");
    verifySignature(envelope, payload.publicKeyHex);
    // Rechecked under the counter lock: a computer may have enrolled here since the challenge.
    await this.vacantCounter(
      tx,
      user.tenantId,
      branchId,
      payload.registerId,
      payload.tillId,
    );
    const attendanceId = await this.attendance.verify(tx, text(proofId), {
      purpose: "enrollment",
      identity,
      actorUserId: user.userId,
      registerId: payload.registerId,
      tillId: payload.tillId,
      payloadDigest: digest,
    });
    text(attendanceId);
    await this.consume(tx, user, branchId, challenge.id);
    await tx.operationalTerminal.create({
      data: {
        id: identity.terminalId,
        tenantId: user.tenantId,
        branchId,
        label: payload.label,
        registerId: payload.registerId,
        tillId: payload.tillId,
      },
    });
    const enrollment = await tx.terminalEnrollment.create({
      data: {
        id: identity.enrollmentId,
        tenantId: user.tenantId,
        branchId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
        publicKeyHex: payload.publicKeyHex,
        enrolledByUserId: user.userId,
      },
    });
    if (code) {
      const used = await tx.terminalEnrollmentCode.updateMany({
        where: { tenantId: user.tenantId, branchId, id: code.id, usedAt: null, revokedAt: null },
        data: { usedAt: new Date(), usedByUserId: user.userId, enrollmentId: enrollment.id },
      });
      if (used.count !== 1) denied("ENROLLMENT_CODE_INVALID");
    }
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.enrolled",
        entityName: "terminal_enrollment",
        entityId: enrollment.id,
        payload: {
          terminalId: identity.terminalId,
          registerId: payload.registerId,
          tillId: payload.tillId,
          keyId: identity.keyId,
          attendanceId,
          enrollmentCodeId: code?.id ?? null,
          codeIssuedByUserId: code?.createdByUserId ?? null,
        },
      },
      tx,
    );
    return identity;
  }

  private async enrollment(
    tx: Tx,
    user: Pick<RequestUser, "tenantId">,
    branchId: string,
    identity: TerminalIdentity,
  ) {
    if (identity.tenantId !== user.tenantId || identity.branchId !== branchId)
      denied("IDENTITY_MISMATCH");
    // Serialize revocation and verification through the business transaction's end.
    // Callers recheck live authority after this lock wait before issuing/accepting a challenge.
    await tx.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${user.tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${identity.enrollmentId}::uuid FOR UPDATE`;
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
    if (!enrollment || enrollment.revokedAt || enrollment.terminal.retiredAt)
      denied("TERMINAL_REVOKED");
    if (!enrollment.terminal.registerId || !enrollment.terminal.tillId)
      denied("SESSION_INVALID");
    await this.counter(
      tx,
      user.tenantId,
      branchId,
      enrollment.terminal.registerId,
      enrollment.terminal.tillId,
    );
    return enrollment;
  }

  async beginSession(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    rawIdentity: unknown,
  ): Promise<TerminalSessionCommand> {
    const identity = parseIdentity(rawIdentity);
    await this.actor(tx, user, branchId);
    const enrollment = await this.enrollment(tx, user, branchId, identity);
    // Authority may have changed while the enrollment lock was blocked.
    await this.actor(tx, user, branchId);
    return this.challenge(tx, user, branchId, "session", {
      contractVersion: 1,
      kind: "terminal_session",
      identity,
      session: {
        workSessionId: randomUUID(),
        staffUserId: user.userId,
        registerId: enrollment.terminal.registerId!,
        tillId: enrollment.terminal.tillId!,
      },
      tokenVersion: user.tokenVersion!,
      ...this.timing(),
    });
  }

  async finishSession(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    proofId: string,
  ) {
    const envelope = parseEnvelope(raw);
    const p = object(envelope.payload, [
      "contractVersion",
      "kind",
      "identity",
      "session",
      "tokenVersion",
      "issuedAt",
      "expiresAt",
      "serverNonce",
    ]);
    if (
      p.contractVersion !== 1 ||
      p.kind !== "terminal_session" ||
      !Number.isSafeInteger(p.tokenVersion)
    )
      invalid();
    const identity = parseIdentity(p.identity);
    const session = parseSession(p.session);
    await this.actor(tx, user, branchId);
    const enrollment = await this.enrollment(tx, user, branchId, identity);
    await this.actor(tx, user, branchId);
    if (
      session.staffUserId !== user.userId ||
      p.tokenVersion !== user.tokenVersion ||
      envelope.keyId !== identity.keyId ||
      session.registerId !== enrollment.terminal.registerId ||
      session.tillId !== enrollment.terminal.tillId
    )
      denied("SESSION_INVALID");
    const payload = p as unknown as TerminalSessionCommand;
    const digest = sha256(boundedCanonical(payload));
    const challenge = await this.checkChallenge(
      tx,
      user,
      branchId,
      "session",
      payload,
      digest,
    );
    verifySignature(envelope, enrollment.publicKeyHex);
    const attendanceId = await this.attendance.verify(tx, text(proofId), {
      purpose: "session",
      identity,
      actorUserId: user.userId,
      registerId: session.registerId,
      tillId: session.tillId,
      payloadDigest: digest,
    });
    text(attendanceId);
    await this.consume(tx, user, branchId, challenge.id);
    await this.bind(tx, user, identity, session, user.tokenVersion!, {
      enrollmentId: identity.enrollmentId,
      attendanceId,
    });
    return session;
  }

  /**
   * One open binding per till. A colleague signing in at the counter (or the same person after a
   * crash) replaces the previous binding; the enrollment lock serializes this per terminal.
   * Deauthorization only: shift/cash state is separate and unaffected.
   */
  private async bind(
    tx: Tx,
    actor: Actor,
    identity: TerminalIdentity,
    session: TerminalSessionCommand["session"],
    tokenVersion: number,
    evidence: Record<string, string>,
  ) {
    const { branchId } = identity;
    const superseded = await tx.terminalStaffSession.findMany({
      where: { tenantId: actor.tenantId, branchId, tillId: session.tillId, closedAt: null },
      select: { id: true, staffUserId: true },
    });
    if (superseded.length) {
      await tx.terminalStaffSession.updateMany({
        where: { tenantId: actor.tenantId, branchId, id: { in: superseded.map((s) => s.id) }, closedAt: null },
        data: { closedAt: new Date() },
      });
      for (const previous of superseded)
        await this.audit.log(
          {
            tenantId: actor.tenantId,
            branchId,
            actorUserId: actor.userId,
            eventName: "terminal.session_superseded",
            entityName: "terminal_staff_session",
            entityId: previous.id,
            payload: {
              enrollmentId: identity.enrollmentId,
              previousStaffUserId: previous.staffUserId,
              nextWorkSessionId: session.workSessionId,
            },
          },
          tx,
        );
    }
    const bound = await tx.terminalStaffSession.create({
      data: {
        id: session.workSessionId,
        tenantId: actor.tenantId,
        branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        registerId: session.registerId,
        tillId: session.tillId,
        staffUserId: actor.userId,
        tokenVersion,
      },
    });
    await this.audit.log(
      {
        tenantId: actor.tenantId,
        branchId,
        actorUserId: actor.userId,
        eventName: "terminal.session_authorized",
        entityName: "terminal_staff_session",
        entityId: bound.id,
        payload: evidence,
      },
      tx,
    );
  }

  private async session(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    workSessionId: string,
  ) {
    const session = await tx.terminalStaffSession.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: uuid(workSessionId),
        staffUserId: user.userId,
        tokenVersion: user.tokenVersion,
        closedAt: null,
      },
    });
    if (!session) denied("SESSION_INVALID");
    const identity = {
      tenantId: user.tenantId,
      branchId,
      terminalId: session.terminalId,
      enrollmentId: session.enrollmentId,
      keyId: session.keyId,
    };
    const enrollment = await this.enrollment(tx, user, branchId, identity);
    const current = await tx.terminalStaffSession.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: session.id,
        staffUserId: user.userId,
        tokenVersion: user.tokenVersion,
        closedAt: null,
      },
    });
    if (!current) denied("SESSION_INVALID");
    if (
      session.registerId !== enrollment.terminal.registerId ||
      session.tillId !== enrollment.terminal.tillId
    )
      denied("SESSION_INVALID");
    return { session, identity, enrollment };
  }

  /** The caller's own open staff binding on an active enrollment, with the enrollment locked for
   * the rest of the transaction. For counter-only actions that need no signed command. */
  async requireOpenSession(tx: Tx, user: RequestUser, branchId: string, workSessionId: string) {
    await this.actor(tx, user, branchId);
    const found = await this.session(tx, user, branchId, workSessionId);
    await this.actor(tx, user, branchId);
    return found;
  }

  /**
   * The person a PIN sign-in names, as they are now: a counter user at this branch, with a PIN
   * whose current version this enrollment was prepared at. Telling the counter which of these
   * failed is safe, because only the enrolled key gets this far.
   */
  private async pinStaff(tx: Tx, identity: TerminalIdentity, staffUserId: string) {
    const actor = { tenantId: identity.tenantId, userId: staffUserId };
    // Any access refusal (no branch assignment, a removed role) is the same answer to the counter:
    // this person may not work here, so it should stop offering them.
    const access = await this.access.resolveApprovalAuthority(actor, identity.branchId, tx).catch((error: unknown) => {
      if (error instanceof ForbiddenException) denied("PERMISSION_DENIED");
      throw error;
    });
    if (!access.has("terminal.execute")) denied("PERMISSION_DENIED");
    // tenant-scope: verified-parent — the membership filter scopes the account to this tenant.
    const account = await tx.appUser.findFirst({
      where: {
        id: staffUserId,
        isActive: true,
        tenantMemberships: { some: { tenantId: identity.tenantId, isActive: true } },
      },
      select: {
        id: true,
        tokenVersion: true,
        posPinHash: true,
        posPinVersion: true,
        posPinLockedUntil: true,
        posPinLockouts: true,
      },
    });
    if (!account) denied("PERMISSION_DENIED");
    const preparation = await tx.terminalStaffPreparation.findFirst({
      where: { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, staffUserId },
      select: { pinVersion: true },
    });
    if (!account.posPinHash || preparation?.pinVersion !== account.posPinVersion)
      throw new ForbiddenException({
        code: "PIN_NOT_PREPARED",
        message: "This counter is not prepared for that person's current PIN.",
      });
    return { actor, account };
  }

  /**
   * The public PIN routes check the device signature against a plain read before `enrollment()`
   * takes the counter's row lock, so a request nobody signed can't hold up the real counter's
   * sign-ins, commands or revocation. The locked read is checked again after.
   */
  private async signedByEnrolledKey(tx: Tx, identity: TerminalIdentity, envelope: Signed<unknown>) {
    const enrollment = await tx.terminalEnrollment.findFirst({
      where: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        id: identity.enrollmentId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
      },
      select: { publicKeyHex: true },
    });
    if (!enrollment) denied("TERMINAL_REVOKED");
    verifySignature(envelope, enrollment.publicKeyHex);
  }

  /**
   * A challenge this counter was already given for this person, with enough life left to finish
   * and the person's PIN and tokens unchanged since. Handing it out again means replaying a
   * captured request adds no rows: the counter can still finish it, and a replayer can't without
   * the key and the PIN.
   */
  private async openPinChallenge(
    tx: Tx,
    actor: Actor,
    identity: TerminalIdentity,
    enrollment: { terminal: { registerId: string | null; tillId: string | null } },
    account: { posPinVersion: number; tokenVersion: number },
  ): Promise<TerminalPinSessionCommand | null> {
    const open = await tx.terminalChallenge.findFirst({
      where: {
        tenantId: actor.tenantId,
        branchId: identity.branchId,
        actorUserId: actor.userId,
        purpose: "pin_session",
        consumedAt: null,
        expiresAt: { gt: new Date(Date.now() + PIN_CHALLENGE_REUSE_MIN_MS) },
        payload: { path: ["identity", "enrollmentId"], equals: identity.enrollmentId },
      },
      orderBy: { expiresAt: "desc" },
    });
    if (!open) return null;
    const payload = open.payload as unknown as TerminalPinSessionCommand;
    if (
      boundedCanonical(payload.identity) !== boundedCanonical(identity) ||
      payload.session.registerId !== enrollment.terminal.registerId ||
      payload.session.tillId !== enrollment.terminal.tillId ||
      payload.pinVersion !== account.posPinVersion ||
      payload.tokenVersion !== account.tokenVersion
    )
      return null;
    return payload;
  }

  /**
   * D-W5 PIN sign-in, step 1. Nobody is signed in, so the enrolled key alone asks for a challenge
   * for one prepared person whose PIN can be tried now. A replayed request gets the same open
   * challenge back, which cannot be finished without the key and the person's PIN.
   */
  async beginPinSession(tx: Tx, raw: unknown): Promise<TerminalPinSessionCommand> {
    const envelope = parseEnvelope(raw);
    const p = object(envelope.payload, ["contractVersion", "kind", "identity", "staffUserId"]);
    if (p.contractVersion !== 1 || p.kind !== "terminal_pin_session_request") invalid();
    const identity = parseIdentity(p.identity);
    const staffUserId = uuid(p.staffUserId);
    if (envelope.keyId !== identity.keyId) denied("IDENTITY_MISMATCH");
    await this.signedByEnrolledKey(tx, identity, envelope);
    const enrollment = await this.enrollment(tx, identity, identity.branchId, identity);
    verifySignature(envelope, enrollment.publicKeyHex);
    const { actor, account } = await this.pinStaff(tx, identity, staffUserId);
    // A locked or switched-off PIN can't be tried, so it gets no challenge to spend.
    const unavailable = pinUnavailable(account, new Date());
    if (unavailable) pinRefusal(unavailable.outcome, unavailable.lockedUntil);
    const open = await this.openPinChallenge(tx, actor, identity, enrollment, account);
    if (open) return open;
    return this.challenge(tx, actor, identity.branchId, "pin_session", {
      contractVersion: 1,
      kind: "terminal_pin_session",
      identity,
      session: {
        workSessionId: randomUUID(),
        staffUserId,
        registerId: enrollment.terminal.registerId!,
        tillId: enrollment.terminal.tillId!,
      },
      pinVersion: account.posPinVersion,
      tokenVersion: account.tokenVersion,
      ...this.timing(),
    });
  }

  /**
   * D-W5 PIN sign-in, step 2: the signed challenge, an attendance attestation for it and the PIN.
   * The challenge and the proof are spent whatever the PIN, so each challenge buys one guess, and
   * a refusal is returned (not thrown) so the caller commits the failure count before refusing.
   * `recordAttendance` stores the proof in this transaction; the verifier then consumes it.
   */
  async finishPinSession(
    tx: Tx,
    raw: unknown,
    pin: string,
    recordAttendance: (challenge: TerminalChallenge, publicKeyHex: string) => Promise<string>,
  ): Promise<
    | { outcome: "signed_in"; tenantId: string; session: TerminalPinSessionCommand["session"] }
    | {
        outcome: Exclude<PinCheck, "ok">;
        lockedUntil: Date | null;
        /** This guess switched the PIN off: the caller alerts once the refusal has committed. */
        switchedOff: boolean;
        tenantId: string;
        branchId: string;
        staffUserId: string;
      }
  > {
    const envelope = parseEnvelope(raw);
    const p = object(envelope.payload, [
      "contractVersion",
      "kind",
      "identity",
      "session",
      "pinVersion",
      "tokenVersion",
      "issuedAt",
      "expiresAt",
      "serverNonce",
    ]);
    if (
      p.contractVersion !== 1 ||
      p.kind !== "terminal_pin_session" ||
      !Number.isSafeInteger(p.pinVersion) ||
      !Number.isSafeInteger(p.tokenVersion)
    )
      invalid();
    const identity = parseIdentity(p.identity);
    const session = parseSession(p.session);
    const { branchId } = identity;
    if (envelope.keyId !== identity.keyId) denied("SESSION_INVALID");
    await this.signedByEnrolledKey(tx, identity, envelope);
    const enrollment = await this.enrollment(tx, identity, branchId, identity);
    if (
      session.registerId !== enrollment.terminal.registerId ||
      session.tillId !== enrollment.terminal.tillId
    )
      denied("SESSION_INVALID");
    const payload = p as unknown as TerminalPinSessionCommand;
    const digest = sha256(boundedCanonical(payload));
    const actor = { tenantId: identity.tenantId, userId: session.staffUserId };
    const challenge = await this.checkChallenge(tx, actor, branchId, "pin_session", payload, digest);
    verifySignature(envelope, enrollment.publicKeyHex);
    const proofId = await recordAttendance(challenge, enrollment.publicKeyHex);
    const attendanceId = await this.attendance.verify(tx, text(proofId), {
      purpose: "pin_session",
      identity,
      actorUserId: actor.userId,
      registerId: session.registerId,
      tillId: session.tillId,
      payloadDigest: digest,
    });
    // Rechecked now: a role, PIN or token change since the challenge makes it stale.
    const { account } = await this.pinStaff(tx, identity, actor.userId);
    if (payload.pinVersion !== account.posPinVersion || payload.tokenVersion !== account.tokenVersion)
      denied("SESSION_INVALID");
    await this.consume(tx, actor, branchId, challenge.id);
    const checked = await checkPosPin(tx, account, pin, new Date());
    if (checked.outcome !== "ok") {
      await this.audit.log(
        {
          tenantId: actor.tenantId,
          branchId,
          actorUserId: actor.userId,
          eventName: "terminal.pin_sign_in_refused",
          entityName: "terminal_enrollment",
          entityId: identity.enrollmentId,
          payload: { outcome: checked.outcome, switchedOff: checked.switchedOff, attendanceId },
        },
        tx,
      );
      return {
        outcome: checked.outcome,
        lockedUntil: checked.lockedUntil,
        switchedOff: checked.switchedOff,
        tenantId: actor.tenantId,
        branchId,
        staffUserId: actor.userId,
      };
    }
    await this.bind(tx, actor, identity, session, account.tokenVersion, {
      enrollmentId: identity.enrollmentId,
      attendanceId,
      via: "pin",
    });
    return { outcome: "signed_in", tenantId: actor.tenantId, session };
  }

  /** Service-only command descriptor: parseBody must be a strict domain DTO parser,
   * permission comes from the server adapter, not a client's body/header/action label.
   */
  async prepareCommand<T>(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    workSessionId: string,
    descriptor: {
      operation: string;
      permission: string;
      parseBody: BodyParser<T>;
    },
    body: unknown,
    evidence: EvidenceIds = {
      approvalEvidenceId: null,
      pharmacistEvidenceId: null,
      operatingHoursExceptionId: null,
    },
  ): Promise<OnlineTerminalCommand<T>> {
    if (
      !Object.prototype.hasOwnProperty.call(
        MUTATION_ACTIONS,
        descriptor.operation,
      )
    )
      invalid();
    await this.actor(tx, user, branchId, descriptor.permission);
    const { session, identity } = await this.session(
      tx,
      user,
      branchId,
      workSessionId,
    );
    await this.actor(tx, user, branchId, descriptor.permission);
    const payload: OnlineTerminalCommand<T> = {
      contractVersion: 1,
      kind: "online_operation",
      commandId: randomUUID(),
      identity,
      session: {
        registerId: session.registerId,
        tillId: session.tillId,
        workSessionId: session.id,
        staffUserId: session.staffUserId,
      },
      operation: descriptor.operation,
      body: descriptor.parseBody(body),
      ...evidence,
      ...this.timing(),
    };
    if (boundedCanonical(payload.body) !== boundedCanonical(body)) invalid();
    // Use the same strict boundary as command verification, including evidence IDs.
    parseOnlineCommand(
      {
        algorithm: "Ed25519",
        keyId: identity.keyId,
        payload,
        signature: Buffer.alloc(64).toString("base64url"),
      },
      descriptor.parseBody,
    );
    return this.challenge(tx, user, branchId, "command", payload);
  }

  async verifyCommand<T>(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    descriptor: {
      operation: string;
      permission: string;
      parseBody: BodyParser<T>;
    },
    raw: unknown,
    proofId: string,
  ) {
    const envelope = parseOnlineCommand(raw, descriptor.parseBody);
    const payload = envelope.payload;
    if (
      !Object.prototype.hasOwnProperty.call(
        MUTATION_ACTIONS,
        descriptor.operation,
      ) ||
      payload.operation !== descriptor.operation
    )
      denied("IDENTITY_MISMATCH");
    await this.actor(tx, user, branchId, descriptor.permission);
    const { session, identity, enrollment } = await this.session(
      tx,
      user,
      branchId,
      payload.session.workSessionId,
    );
    await this.actor(tx, user, branchId, descriptor.permission);
    if (
      Object.keys(identity).some(
        (k) =>
          identity[k as keyof typeof identity] !==
          payload.identity[k as keyof typeof identity],
      ) ||
      payload.session.staffUserId !== session.staffUserId ||
      payload.session.registerId !== session.registerId ||
      payload.session.tillId !== session.tillId ||
      envelope.keyId !== identity.keyId
    )
      denied("IDENTITY_MISMATCH");
    const digest = sha256(boundedCanonical(payload));
    const challenge = await this.checkChallenge(
      tx,
      user,
      branchId,
      "command",
      payload,
      digest,
    );
    verifySignature(envelope, enrollment.publicKeyHex);
    const attendanceId = await this.attendance.verify(tx, text(proofId), {
      purpose: "command",
      identity,
      actorUserId: user.userId,
      registerId: session.registerId,
      tillId: session.tillId,
      payloadDigest: digest,
    });
    text(attendanceId);
    await this.consume(tx, user, branchId, challenge.id);
    return { command: payload, digest, attendanceId };
  }

  /** Remote authenticated session termination is deauthorization, not shift/cash closure. */
  async endSession(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    workSessionId: string,
  ) {
    await this.actor(tx, user, branchId);
    // A freshly reauthenticated user may deauthorize their old token-version binding.
    const existing = await tx.terminalStaffSession.findFirst({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: uuid(workSessionId),
        staffUserId: user.userId,
        closedAt: null,
      },
    });
    if (!existing) denied("SESSION_INVALID");
    await tx.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${user.tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${existing.enrollmentId}::uuid FOR UPDATE`;
    await this.actor(tx, user, branchId);
    const closed = await tx.terminalStaffSession.updateMany({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: uuid(workSessionId),
        staffUserId: user.userId,
        closedAt: null,
      },
      data: { closedAt: new Date() },
    });
    if (closed.count !== 1) denied("SESSION_INVALID");
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.session_ended",
        entityName: "terminal_staff_session",
        entityId: workSessionId,
      },
      tx,
    );
  }

  async revokeEnrollment(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    enrollmentId: string,
    reason: string,
  ) {
    await this.actor(tx, user, branchId, "tenant.management");
    text(reason, 500);
    uuid(enrollmentId);
    await tx.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${user.tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${enrollmentId}::uuid FOR UPDATE`;
    await this.actor(tx, user, branchId, "tenant.management");
    const enrollment = await tx.terminalEnrollment.findFirst({
      where: { tenantId: user.tenantId, branchId, id: enrollmentId },
    });
    if (!enrollment) denied("IDENTITY_MISMATCH");
    if (enrollment.revokedAt) return;
    const revoked = await tx.terminalEnrollment.updateMany({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: enrollmentId,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    if (revoked.count !== 1) denied("TERMINAL_REVOKED");
    await tx.terminalStaffSession.updateMany({
      where: {
        tenantId: user.tenantId,
        branchId,
        enrollmentId,
        closedAt: null,
      },
      data: { closedAt: new Date() },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.revoked",
        entityName: "terminal_enrollment",
        entityId: enrollmentId,
        payload: { terminalId: enrollment.terminalId, reason },
      },
      tx,
    );
  }

  /** Releases the online counter identity for replacement; confers no offline grant/D11 clearance. */
  async retireTerminal(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    terminalId: string,
    reason: string,
  ) {
    await this.actor(tx, user, branchId, "tenant.management");
    uuid(terminalId);
    text(reason, 500);
    const terminal = await tx.operationalTerminal.findFirst({
      where: { tenantId: user.tenantId, branchId, id: terminalId },
    });
    if (!terminal) denied("IDENTITY_MISMATCH");
    const enrollments = await tx.terminalEnrollment.findMany({
      where: { tenantId: user.tenantId, branchId, terminalId, revokedAt: null },
      orderBy: { id: "asc" },
    });
    for (const enrollment of enrollments)
      await this.revokeEnrollment(tx, user, branchId, enrollment.id, reason);
    await this.actor(tx, user, branchId, "tenant.management");
    const changed = await tx.operationalTerminal.updateMany({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: terminalId,
        retiredAt: null,
      },
      data: { retiredAt: new Date() },
    });
    if (changed.count)
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.retired",
          entityName: "operational_terminal",
          entityId: terminalId,
          payload: { reason },
        },
        tx,
      );
  }
}
