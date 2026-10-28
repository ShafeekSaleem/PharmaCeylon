import { ConflictException, Injectable, Logger } from "@nestjs/common";
import type { Prisma, TerminalCommandReceipt } from "@prisma/client";
import type {
  OnlineCommandReceipt,
  OnlineTerminalCommand,
  Signed,
  SignedPhysicalOperation,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { tenantTransactionStorage } from "../prisma/tenant-transaction.store";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { OperationAuthorizationService } from "../security/operation-authorization.service";
import type { CommandProvenance } from "../terminals/command-provenance";
import { TerminalTrustService } from "../terminals/terminal-trust.service";
import {
  boundedCanonical,
  denied,
  invalid,
  object,
  parseEnvelope,
  parseOnlineCommand,
  sha256,
  text,
  uuid,
  verifySignature,
} from "../terminals/terminal-wire";
import { SignedOperations, type SignedOperation } from "./signed-operations";

type Tx = Prisma.TransactionClient;
type Operation = SignedOperation<SignedPhysicalOperation>;
type Envelope = Signed<OnlineTerminalCommand<unknown>>;
type EvidenceIds = Pick<
  OnlineTerminalCommand<unknown>,
  "approvalEvidenceId" | "pharmacistEvidenceId" | "operatingHoursExceptionId"
>;

function replayConflict(): never {
  throw new ConflictException({
    code: "REPLAY_CONFLICT",
    message: "This command was already executed with different content",
  });
}
const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/** Online signed execution with original-result receipts (contract: docs/API_CONTRACT.md).
 *
 * One READ COMMITTED transaction per request: lock the enrollment, look up the scoped receipt,
 * then either replay it or verify/authorize, run the domain core, write the execution audit and
 * insert the receipt. Every failure rolls back all of it, including nonce consumption. The
 * enrollment lock serializes identical retries, so a waiting retry sees the committed receipt
 * and replays it instead of reaching the consumed challenge.
 */
@Injectable()
export class TerminalCommandExecutor {
  private readonly logger = new Logger(TerminalCommandExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly authorization: OperationAuthorizationService,
    private readonly operations: SignedOperations,
    private readonly audit: AuditService,
  ) {}

  /** Issues the payload the enrolled desktop signs verbatim. Has no business effect. */
  async prepare(user: RequestUser, branchId: string, raw: unknown) {
    const request = object(raw, [
      "workSessionId",
      "operation",
      "body",
      "approvalEvidenceId",
      "pharmacistEvidenceId",
      "operatingHoursExceptionId",
    ]);
    const operation = this.operations.get(request.operation);
    const evidence = this.evidence(operation, request);
    const { descriptor } = operation;
    return this.transaction(user, branchId, (tx) =>
      this.trust.prepareCommand(
        tx,
        user,
        branchId,
        uuid(request.workSessionId),
        {
          operation: `${descriptor.method} ${descriptor.routeTemplate}`,
          permission: descriptor.permission,
          parseBody: descriptor.parseBody,
        },
        request.body,
        evidence,
      ),
    );
  }

  async execute(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<OnlineCommandReceipt> {
    const request = object(raw, ["command", "attendanceProofId"]);
    const attendanceProofId = text(request.attendanceProofId);
    const { payload } = parseEnvelope(request.command);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) invalid();
    const operation = this.operations.get((payload as { operation?: unknown }).operation);
    const envelope = parseOnlineCommand(
      request.command,
      operation.descriptor.parseBody,
    ) as Envelope;
    const command = envelope.payload;
    this.evidence(operation, command);
    if (
      command.identity.tenantId !== user.tenantId ||
      command.identity.branchId !== branchId
    )
      denied("IDENTITY_MISMATCH");
    const requestDigest = sha256(boundedCanonical(command));
    const afterCommit: Array<() => Promise<void>> = [];
    let receipt: OnlineCommandReceipt;
    try {
      receipt = await this.transaction(user, branchId, (tx) =>
        this.executeOrReplay(tx, user, branchId, operation, envelope, requestDigest,
          attendanceProofId, afterCommit),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Defensive only: the enrollment lock already serializes one command identity. Never
      // execute twice; replay the committed original or report the conflict.
      afterCommit.length = 0;
      receipt = await this.transaction(user, branchId, async (tx) => {
        await this.lockEnrollment(tx, user.tenantId, branchId, command.identity.enrollmentId);
        const existing = await this.findReceipt(tx, user.tenantId, command);
        if (!existing) throw error;
        return this.replay(tx, user, branchId, envelope, requestDigest, existing);
      });
    }
    for (const hook of afterCommit)
      await hook().catch((error: unknown) =>
        this.logger.warn(`Post-commit follow-up failed for command ${command.commandId}: ${String(error)}`),
      );
    return receipt;
  }

  private async executeOrReplay(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    operation: Operation,
    envelope: Envelope,
    requestDigest: string,
    attendanceProofId: string,
    afterCommit: Array<() => Promise<void>>,
  ): Promise<OnlineCommandReceipt> {
    const command = envelope.payload;
    await this.lockEnrollment(tx, user.tenantId, branchId, command.identity.enrollmentId);
    const existing = await this.findReceipt(tx, user.tenantId, command);
    if (existing)
      return this.replay(tx, user, branchId, envelope, requestDigest, existing);

    const authorized = await this.authorization.authorize(
      tx,
      user,
      branchId,
      operation.descriptor,
      { body: command.body, signedCommand: envelope, attendanceProofId },
    );
    if (!authorized.terminal || authorized.terminal.digest !== requestDigest)
      denied("TERMINAL_REQUIRED");
    const provenance: CommandProvenance = {
      commandId: command.commandId,
      requestDigest,
      terminalId: command.identity.terminalId,
      enrollmentId: command.identity.enrollmentId,
      keyId: command.identity.keyId,
      registerId: command.session.registerId,
      tillId: command.session.tillId,
      workSessionId: command.session.workSessionId,
      attendanceId: authorized.terminal.attendanceId,
    };
    const executed = await operation.execute(tx, user, branchId, authorized.body, {
      approvalEvidenceId: command.approvalEvidenceId,
      command: provenance,
    });
    const row = await tx.terminalCommandReceipt.create({
      data: {
        tenantId: user.tenantId,
        branchId,
        terminalId: command.identity.terminalId,
        enrollmentId: command.identity.enrollmentId,
        keyId: command.identity.keyId,
        commandId: command.commandId,
        operation: command.operation,
        requestDigest,
        offlineSequence: null,
        actorUserId: user.userId,
        command: envelope as unknown as Prisma.InputJsonValue,
        result: executed.result as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.command_executed",
        entityName: "terminal_command_receipt",
        entityId: row.id,
        payload: {
          ...provenance,
          operation: command.operation,
          approvalEvidenceId: command.approvalEvidenceId,
          resultType: executed.result.type,
        },
      },
      tx,
    );
    if (executed.afterCommit) afterCommit.push(executed.afterCommit);
    return this.toReceipt(row, false);
  }

  /** Authenticated retrieval of the original result: same staff user, active enrollment and
   * a valid signature over the identical payload. No attendance proof, nonce or open session is
   * needed, and nothing is written. Any content difference is REPLAY_CONFLICT.
   */
  private async replay(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    envelope: Envelope,
    requestDigest: string,
    existing: TerminalCommandReceipt,
  ): Promise<OnlineCommandReceipt> {
    const { identity } = envelope.payload;
    const enrollment = await tx.terminalEnrollment.findFirst({
      where: { tenantId: user.tenantId, branchId, id: identity.enrollmentId },
      include: { terminal: true },
    });
    if (!enrollment || enrollment.revokedAt || enrollment.terminal.retiredAt)
      denied("TERMINAL_REVOKED");
    if (
      enrollment.terminalId !== identity.terminalId ||
      enrollment.keyId !== identity.keyId ||
      envelope.keyId !== identity.keyId
    )
      denied("IDENTITY_MISMATCH");
    verifySignature(envelope, enrollment.publicKeyHex);
    if (existing.actorUserId !== user.userId || existing.branchId !== branchId)
      denied("IDENTITY_MISMATCH");
    if (
      existing.requestDigest !== requestDigest ||
      existing.operation !== envelope.payload.operation ||
      existing.terminalId !== identity.terminalId ||
      existing.keyId !== identity.keyId
    )
      replayConflict();
    return this.toReceipt(existing, true);
  }

  private evidence(operation: Operation, raw: Record<string, unknown>): EvidenceIds {
    if (raw.pharmacistEvidenceId !== null || raw.operatingHoursExceptionId !== null)
      invalid();
    if (!operation.descriptor.approval) {
      if (raw.approvalEvidenceId !== null) invalid();
      return { approvalEvidenceId: null, pharmacistEvidenceId: null, operatingHoursExceptionId: null };
    }
    return {
      approvalEvidenceId: uuid(raw.approvalEvidenceId),
      pharmacistEvidenceId: null,
      operatingHoursExceptionId: null,
    };
  }

  private async lockEnrollment(tx: Tx, tenantId: string, branchId: string, enrollmentId: string) {
    await tx.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${tenantId}::uuid
      AND branch_id = ${branchId}::uuid AND id = ${enrollmentId}::uuid FOR UPDATE`;
  }

  private findReceipt(tx: Tx, tenantId: string, command: OnlineTerminalCommand<unknown>) {
    return tx.terminalCommandReceipt.findFirst({
      where: {
        tenantId,
        enrollmentId: command.identity.enrollmentId,
        commandId: command.commandId,
      },
    });
  }

  private transaction<T>(user: RequestUser, branchId: string, work: (tx: Tx) => Promise<T>) {
    return this.prisma.$transaction(
      (tx) =>
        tenantTransactionStorage.run(
          { tenantId: user.tenantId, branchId, client: tx },
          () => work(tx),
        ),
      { timeout: 120_000, maxWait: 60_000 },
    );
  }

  private toReceipt(row: TerminalCommandReceipt, replayed: boolean): OnlineCommandReceipt {
    const stored = row.command as unknown as Envelope;
    return {
      contractVersion: 1,
      kind: "online_command_receipt",
      receiptId: row.id,
      commandId: row.commandId,
      identity: {
        tenantId: row.tenantId,
        branchId: row.branchId,
        terminalId: row.terminalId,
        enrollmentId: row.enrollmentId,
        keyId: row.keyId,
      },
      workSessionId: stored.payload.session.workSessionId,
      operation: row.operation as SignedPhysicalOperation,
      requestDigest: row.requestDigest,
      actorUserId: row.actorUserId,
      recordedAt: row.recordedAt.getTime(),
      replayed,
      result: row.result as unknown as OnlineCommandReceipt["result"],
    };
  }
}
