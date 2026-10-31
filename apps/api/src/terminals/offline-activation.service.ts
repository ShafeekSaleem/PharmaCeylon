import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type { OfflineActivationResult, OnlineTerminalCommand } from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { OfflineAssignmentService } from "./offline-assignment.service";
import { TerminalTrustService } from "./terminal-trust.service";
import { invalid, object, text, uuid } from "./terminal-wire";

type Tx = Prisma.TransactionClient;
export const OFFLINE_ACTIVATION_OPERATION = "POST /api/v1/terminals/offline-assignment/activate";
/** Branch permission to confirm activation locally. Not the owner's assignment authority. */
export const OFFLINE_ACTIVATION_PERMISSION = "terminal.activate_offline";

export type ActivationBody = Readonly<{ authorizationId: string; expectedNominationVersion: number }>;
function parseActivationBody(raw: unknown): ActivationBody {
  const body = object(raw, ["authorizationId", "expectedNominationVersion"]);
  uuid(body.authorizationId);
  if (!Number.isSafeInteger(body.expectedNominationVersion) || (body.expectedNominationVersion as number) < 0) invalid();
  return body as ActivationBody;
}
const descriptor = {
  operation: OFFLINE_ACTIVATION_OPERATION,
  permission: OFFLINE_ACTIVATION_PERMISSION,
  parseBody: parseActivationBody,
};

type Nomination = Prisma.OfflineTerminalNominationGetPayload<object>;
export type ClearanceDecision =
  | Readonly<{ cleared: true; basis: "initial_nomination" | "recovery_evidence" }>
  | Readonly<{ cleared: false; reason: "PREVIOUS_STILL_ACTIVE" | "OFFLINE_RECOVERY_EVIDENCE_REQUIRED" }>;

/**
 * D11 clearance port. Activation may replace a nominated terminal only once the old one can no
 * longer sell offline (server cutoff confirmed, or its last grant expired) AND its offline journal
 * is recovered or the loss reviewed. Grants (P3) and journal recovery (P5) do not exist yet, so the
 * production provider clears only a branch's first nomination and fails closed otherwise. P3/P5
 * replace `recoveryEvidence` with real grant-expiry and journal-review evidence.
 */
@Injectable()
export class OfflineActivationClearance {
  async check(tx: Tx, previous: Nomination | null): Promise<ClearanceDecision> {
    if (!previous) return { cleared: true, basis: "initial_nomination" };
    const old = await tx.terminalEnrollment.findFirst({
      where: { tenantId: previous.tenantId, branchId: previous.branchId, id: previous.enrollmentId },
      include: { terminal: true },
    });
    if (old && !old.revokedAt && !old.terminal.retiredAt) return { cleared: false, reason: "PREVIOUS_STILL_ACTIVE" };
    return (await this.recoveryEvidence(tx, previous))
      ? { cleared: true, basis: "recovery_evidence" }
      : { cleared: false, reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED" };
  }

  /** P3/P5 integration point: grant cutoff or expiry plus journal recovery/loss review. */
  protected async recoveryEvidence(_tx: Tx, _previous: Nomination): Promise<boolean> {
    return false;
  }
}

/**
 * Revised D13, second step: on the exact authorized target, an authorized local staff member
 * confirms activation online with a signed command and verified local attendance. In one
 * transaction: verify the command and attendance, revalidate the remote authorization live
 * (`requireCurrent`), apply D11 clearance, consume the authorization, advance the branch
 * nomination and audit the authorizer and the activator separately. Activation issues no grant;
 * P3 signs grants for the nominated terminal.
 */
@Injectable()
export class OfflineActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trust: TerminalTrustService,
    private readonly assignments: OfflineAssignmentService,
    private readonly clearance: OfflineActivationClearance,
    private readonly audit: AuditService,
  ) {}

  prepare(
    user: RequestUser,
    branchId: string,
    input: { workSessionId: string; authorizationId: string; expectedNominationVersion: number },
  ): Promise<OnlineTerminalCommand<ActivationBody>> {
    return this.prisma.$transaction((tx) =>
      this.trust.prepareCommand(tx, user, branchId, input.workSessionId, descriptor, {
        authorizationId: input.authorizationId,
        expectedNominationVersion: input.expectedNominationVersion,
      }),
    );
  }

  activate(user: RequestUser, branchId: string, raw: unknown): Promise<OfflineActivationResult> {
    const body = object(raw, ["envelope", "attendanceProofId"]);
    const proofId = text(body.attendanceProofId);
    return this.prisma.$transaction(async (tx) => {
      const { command, attendanceId } = await this.trust.verifyCommand(tx, user, branchId, descriptor, body.envelope, proofId);
      const { identity } = command;
      const authorization = await this.assignments.requireCurrent(tx, user.tenantId, branchId, {
        authorizationId: command.body.authorizationId,
        targetEnrollmentId: identity.enrollmentId,
        expectedNominationVersion: command.body.expectedNominationVersion,
      });
      if (authorization.targetTerminalId !== identity.terminalId || authorization.targetKeyId !== identity.keyId)
        throw new ConflictException({ code: "OFFLINE_AUTHORIZATION_NOT_CURRENT", message: "This authorization is for a different counter." });

      const previous = await tx.offlineTerminalNomination.findFirst({ where: { tenantId: user.tenantId, branchId } });
      const decision = await this.clearance.check(tx, previous);
      if (!decision.cleared)
        throw new ConflictException({
          code: "D11_CLEARANCE_REQUIRED",
          reason: decision.reason,
          message:
            decision.reason === "PREVIOUS_STILL_ACTIVE"
              ? "The current offline counter is still enrolled. Disable it in the back office first."
              : "The previous offline counter's sales must be recovered or reviewed before another can take over.",
        });

      const now = new Date();
      const consumed = await tx.offlineTerminalAssignmentAuthorization.updateMany({
        where: { id: authorization.id, tenantId: user.tenantId, branchId, status: "authorized" },
        data: { status: "consumed", consumedAt: now, consumedByUserId: user.userId },
      });
      if (consumed.count !== 1)
        throw new ConflictException({ code: "OFFLINE_AUTHORIZATION_NOT_CURRENT", message: "This authorization was already used." });
      const version = (previous?.version ?? 0) + 1;
      const target = {
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        version,
        authorizationId: authorization.id,
        activatedAt: now,
        activatedByUserId: user.userId,
      };
      if (previous) {
        const moved = await tx.offlineTerminalNomination.updateMany({
          where: { tenantId: user.tenantId, branchId, version: previous.version },
          data: target,
        });
        if (moved.count !== 1)
          throw new ConflictException({ code: "NOMINATION_VERSION_CHANGED", message: "The branch's offline counter just changed." });
      } else {
        await tx.offlineTerminalNomination.create({ data: { tenantId: user.tenantId, branchId, ...target } });
      }
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.offline_activated",
          entityName: "offline_terminal_nomination",
          entityId: identity.enrollmentId,
          payload: {
            authorizationId: authorization.id,
            authorizedByUserId: authorization.authorizedByUserId,
            authority: authorization.authority,
            delegationId: authorization.delegationId,
            activatedByUserId: user.userId,
            nominationVersion: version,
            previousEnrollmentId: previous?.enrollmentId ?? null,
            clearance: decision.basis,
            terminalId: identity.terminalId,
            commandId: command.commandId,
            workSessionId: command.session.workSessionId,
            attendanceId,
          },
        },
        tx,
      );
      return {
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        nominationVersion: version,
        activatedAt: now.getTime(),
        authorizedByUserId: authorization.authorizedByUserId,
        activatedByUserId: user.userId,
      };
    });
  }
}
