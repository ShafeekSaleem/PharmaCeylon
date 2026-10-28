import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import type {
  OfflineAssignmentView,
  OfflineTerminalAssignmentAuthorization,
  OfflineTerminalDelegation,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService, type ActorAccess } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";

type Tx = Prisma.TransactionClient;

/** The branch-management permission a delegate must still hold. Necessary, never sufficient:
 * only an owner's explicit delegation row confers assignment authority. */
export const OFFLINE_ASSIGNMENT_MANAGER_PERMISSION = "tenant.management";

export const OFFLINE_ASSIGNMENT_ERRORS = {
  ownerOnly: "OFFLINE_ASSIGNMENT_OWNER_ONLY",
  notDelegated: "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
  delegateIneligible: "OFFLINE_DELEGATE_INELIGIBLE",
  targetInvalid: "OFFLINE_TARGET_INVALID",
  alreadyNominated: "OFFLINE_TARGET_ALREADY_NOMINATED",
  versionChanged: "NOMINATION_VERSION_CHANGED",
  retryConflict: "AUTHORIZATION_ID_CONFLICT",
  notCurrent: "OFFLINE_AUTHORIZATION_NOT_CURRENT",
} as const;

type Authority =
  | Readonly<{ kind: "owner" }>
  | Readonly<{ kind: "delegated_manager"; delegationId: string }>;

const isOwner = (actor: ActorAccess) => actor.roleKeys.includes(RoleName.owner);

/**
 * Revised D13: who may make which enrolled terminal the branch's offline-capable one.
 *
 * - **Delegation.** Only an owner can delegate, per manager and per branch. Managers cannot
 *   delegate onward, and no role or permission edit creates or implies a delegation. A delegate
 *   must still be assigned at the branch and hold branch management (`tenant.management`) there.
 * - **Authorization.** Online, remote-capable: an owner, or a manager with a live delegation for
 *   this branch, authorizes one exact enrolled target and the nomination version they expect.
 *   It nominates nothing and issues no grant. At most one is outstanding per branch; a newer one
 *   supersedes it. The client supplies the authorization UUID so retries are idempotent.
 * - **Activation** is a separate, local, signed online step on the exact target (P2/P3, with
 *   D11 clearance). It must call `requireCurrent` inside its own transaction, then consume the
 *   authorization and write the nomination atomically.
 *
 * "Owner" is the locked built-in role, the same rule AccessService applies everywhere.
 */
@Injectable()
export class OfflineAssignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async view(user: RequestUser, branchId: string): Promise<OfflineAssignmentView> {
    return this.prisma.$transaction(async (tx) => {
      await this.access.resolveLive(user, branchId, tx);
      return this.read(tx, user.tenantId, branchId);
    });
  }

  async delegate(user: RequestUser, branchId: string, managerUserId: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockBranch(tx, user.tenantId, branchId);
      await this.requireOwner(tx, user, branchId);
      if (managerUserId === user.userId)
        throw this.forbidden(OFFLINE_ASSIGNMENT_ERRORS.delegateIneligible, "Owners already hold this authority.");
      const delegate = await this.eligibleDelegate(tx, user.tenantId, branchId, managerUserId);
      if (!delegate || isOwner(delegate))
        throw this.forbidden(
          OFFLINE_ASSIGNMENT_ERRORS.delegateIneligible,
          "Choose a manager who is assigned to this branch and can manage it.",
        );
      const existing = await tx.offlineTerminalDelegation.findFirst({
        where: { tenantId: user.tenantId, branchId, managerUserId, revokedAt: null },
      });
      if (!existing) {
        const created = await tx.offlineTerminalDelegation.create({
          data: { tenantId: user.tenantId, branchId, managerUserId, delegatedByUserId: user.userId },
        });
        await this.audit.log(
          {
            tenantId: user.tenantId,
            branchId,
            actorUserId: user.userId,
            eventName: "terminal.offline_delegation_granted",
            entityName: "offline_terminal_delegation",
            entityId: created.id,
            payload: { managerUserId },
          },
          tx,
        );
      }
      return this.read(tx, user.tenantId, branchId);
    });
  }

  async revokeDelegation(user: RequestUser, branchId: string, delegationId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockBranch(tx, user.tenantId, branchId);
      await this.requireOwner(tx, user, branchId);
      const delegation = await tx.offlineTerminalDelegation.findFirst({
        where: { id: delegationId, tenantId: user.tenantId, branchId },
      });
      if (!delegation) throw new NotFoundException("Delegation not found.");
      if (delegation.revokedAt) return this.read(tx, user.tenantId, branchId);
      const now = new Date();
      await tx.offlineTerminalDelegation.updateMany({
        where: { id: delegation.id, tenantId: user.tenantId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: user.userId, revocationReason: reason.trim() },
      });
      // The delegate's outstanding authorization loses its authority with the delegation.
      const outstanding = await tx.offlineTerminalAssignmentAuthorization.updateMany({
        where: { tenantId: user.tenantId, branchId, delegationId: delegation.id, status: "authorized" },
        data: {
          status: "revoked",
          revokedAt: now,
          revokedByUserId: user.userId,
          revocationReason: "Delegation revoked",
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.offline_delegation_revoked",
          entityName: "offline_terminal_delegation",
          entityId: delegation.id,
          payload: {
            managerUserId: delegation.managerUserId,
            reason: reason.trim(),
            authorizationsRevoked: outstanding.count,
          },
        },
        tx,
      );
      return this.read(tx, user.tenantId, branchId);
    });
  }

  async authorize(
    user: RequestUser,
    branchId: string,
    input: {
      authorizationId: string;
      targetTerminalId: string;
      targetEnrollmentId: string;
      expectedNominationVersion: number;
      reason: string;
    },
  ) {
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException("Give a reason for this assignment.");
    return this.prisma.$transaction(async (tx) => {
      await this.lockBranch(tx, user.tenantId, branchId);
      const replay = await tx.offlineTerminalAssignmentAuthorization.findUnique({
        where: { id: input.authorizationId },
      });
      if (replay) {
        const same =
          replay.tenantId === user.tenantId &&
          replay.branchId === branchId &&
          replay.targetTerminalId === input.targetTerminalId &&
          replay.targetEnrollmentId === input.targetEnrollmentId &&
          replay.expectedNominationVersion === input.expectedNominationVersion &&
          replay.reason === reason &&
          replay.authorizedByUserId === user.userId;
        if (!same)
          throw new ConflictException({
            code: OFFLINE_ASSIGNMENT_ERRORS.retryConflict,
            message: "This authorization ID was already used for a different assignment.",
          });
        return this.read(tx, user.tenantId, branchId);
      }

      const authority = await this.authorityOf(tx, user, branchId);
      const target = await this.activeTarget(tx, user.tenantId, branchId, input.targetTerminalId, input.targetEnrollmentId);
      if (!target)
        throw new ConflictException({
          code: OFFLINE_ASSIGNMENT_ERRORS.targetInvalid,
          message: "That counter is not an active enrolled terminal at this branch.",
        });
      const nomination = await this.nomination(tx, user.tenantId, branchId);
      if ((nomination?.version ?? 0) !== input.expectedNominationVersion)
        throw new ConflictException({
          code: OFFLINE_ASSIGNMENT_ERRORS.versionChanged,
          message: "The offline counter for this branch changed. Refresh and review before authorizing.",
        });
      if (nomination?.enrollmentId === input.targetEnrollmentId)
        throw new ConflictException({
          code: OFFLINE_ASSIGNMENT_ERRORS.alreadyNominated,
          message: "That counter is already the branch's offline counter.",
        });

      const now = new Date();
      const superseded = await tx.offlineTerminalAssignmentAuthorization.updateMany({
        where: { tenantId: user.tenantId, branchId, status: "authorized" },
        data: {
          status: "revoked",
          revokedAt: now,
          revokedByUserId: user.userId,
          revocationReason: `Superseded by ${input.authorizationId}`,
        },
      });
      const created = await tx.offlineTerminalAssignmentAuthorization.create({
        data: {
          id: input.authorizationId,
          tenantId: user.tenantId,
          branchId,
          targetTerminalId: target.terminalId,
          targetEnrollmentId: target.id,
          targetKeyId: target.keyId,
          expectedNominationVersion: input.expectedNominationVersion,
          reason,
          authorizedByUserId: user.userId,
          authority: authority.kind,
          delegationId: authority.kind === "delegated_manager" ? authority.delegationId : null,
          authorizedAt: now,
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.offline_assignment_authorized",
          entityName: "offline_terminal_assignment_authorization",
          entityId: created.id,
          payload: {
            authority: authority.kind,
            delegationId: created.delegationId,
            targetTerminalId: created.targetTerminalId,
            targetEnrollmentId: created.targetEnrollmentId,
            expectedNominationVersion: created.expectedNominationVersion,
            reason,
            superseded: superseded.count,
          },
        },
        tx,
      );
      return this.read(tx, user.tenantId, branchId);
    });
  }

  async revokeAuthorization(user: RequestUser, branchId: string, authorizationId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockBranch(tx, user.tenantId, branchId);
      await this.authorityOf(tx, user, branchId);
      const row = await tx.offlineTerminalAssignmentAuthorization.findFirst({
        where: { id: authorizationId, tenantId: user.tenantId, branchId },
      });
      if (!row) throw new NotFoundException("Authorization not found.");
      if (row.status === "revoked") return this.read(tx, user.tenantId, branchId);
      if (row.status !== "authorized")
        throw new ConflictException("This authorization was already used to activate the counter.");
      await tx.offlineTerminalAssignmentAuthorization.updateMany({
        where: { id: row.id, tenantId: user.tenantId, status: "authorized" },
        data: { status: "revoked", revokedAt: new Date(), revokedByUserId: user.userId, revocationReason: reason.trim() },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.offline_assignment_revoked",
          entityName: "offline_terminal_assignment_authorization",
          entityId: row.id,
          payload: { reason: reason.trim() },
        },
        tx,
      );
      return this.read(tx, user.tenantId, branchId);
    });
  }

  /**
   * Activation-time revalidation (P2/P3 call this inside the activation transaction, after the
   * signed local command and attendance are verified): the authorization is still outstanding
   * for this exact target, the target enrollment is still active, the nomination version is
   * unchanged, and the original authorizer still holds the authority they used — an owner, or a
   * manager whose delegation is live and who is still assigned with branch management. Their
   * old login token is irrelevant; current rights are. Does not consume.
   */
  async requireCurrent(
    tx: Tx,
    tenantId: string,
    branchId: string,
    expected: { authorizationId: string; targetEnrollmentId: string; expectedNominationVersion: number },
  ) {
    await this.lockBranch(tx, tenantId, branchId);
    const row = await tx.offlineTerminalAssignmentAuthorization.findFirst({
      where: { id: expected.authorizationId, tenantId, branchId },
    });
    const notCurrent = (message: string) =>
      new ConflictException({ code: OFFLINE_ASSIGNMENT_ERRORS.notCurrent, message });
    if (!row || row.status !== "authorized") throw notCurrent("This assignment authorization is no longer outstanding.");
    if (row.targetEnrollmentId !== expected.targetEnrollmentId)
      throw notCurrent("This authorization is for a different counter.");
    if (row.expectedNominationVersion !== expected.expectedNominationVersion ||
        ((await this.nomination(tx, tenantId, branchId))?.version ?? 0) !== row.expectedNominationVersion)
      throw notCurrent("The branch's offline counter changed after this authorization.");
    if (!(await this.activeTarget(tx, tenantId, branchId, row.targetTerminalId, row.targetEnrollmentId)))
      throw notCurrent("The authorized counter is no longer an active enrolled terminal.");
    const authorizer = await this.access
      .resolveApprovalAuthority({ tenantId, userId: row.authorizedByUserId }, branchId, tx)
      .catch(() => null);
    const stillAuthorized =
      authorizer !== null &&
      (row.authority === "owner"
        ? isOwner(authorizer)
        : authorizer.has(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION) &&
          (await tx.offlineTerminalDelegation.count({
            where: { id: row.delegationId!, tenantId, branchId, managerUserId: row.authorizedByUserId, revokedAt: null },
          })) === 1);
    if (!stillAuthorized) throw notCurrent("The person who authorized this no longer holds that authority.");
    return row;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Serializes delegation, authorization, revocation and activation per branch. */
  private async lockBranch(tx: Tx, tenantId: string, branchId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM branch
      WHERE id = ${branchId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
    if (rows.length !== 1) throw new NotFoundException("Branch not found.");
  }

  private async requireOwner(tx: Tx, user: RequestUser, branchId: string) {
    if (!isOwner(await this.access.resolveLive(user, branchId, tx)))
      throw this.forbidden(OFFLINE_ASSIGNMENT_ERRORS.ownerOnly, "Only an owner can delegate offline-counter assignment.");
  }

  private async authorityOf(tx: Tx, user: RequestUser, branchId: string): Promise<Authority> {
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (isOwner(actor)) return { kind: "owner" };
    const delegation = actor.has(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION)
      ? await tx.offlineTerminalDelegation.findFirst({
          where: { tenantId: user.tenantId, branchId, managerUserId: user.userId, revokedAt: null },
          select: { id: true },
        })
      : null;
    if (!delegation)
      throw this.forbidden(
        OFFLINE_ASSIGNMENT_ERRORS.notDelegated,
        "Only an owner, or a manager the owner delegated for this branch, can assign the offline counter.",
      );
    return { kind: "delegated_manager", delegationId: delegation.id };
  }

  private async eligibleDelegate(tx: Tx, tenantId: string, branchId: string, userId: string) {
    const actor = await this.access
      .resolveApprovalAuthority({ tenantId, userId }, branchId, tx)
      .catch((error: unknown) => {
        if (error instanceof ForbiddenException) return null;
        throw error;
      });
    return actor?.has(OFFLINE_ASSIGNMENT_MANAGER_PERMISSION) ? actor : null;
  }

  private activeTarget(tx: Tx, tenantId: string, branchId: string, terminalId: string, enrollmentId: string) {
    return tx.terminalEnrollment.findFirst({
      where: {
        id: enrollmentId,
        tenantId,
        branchId,
        terminalId,
        revokedAt: null,
        terminal: { retiredAt: null, registerId: { not: null } },
      },
      select: { id: true, terminalId: true, keyId: true },
    });
  }

  private nomination(tx: Tx, tenantId: string, branchId: string) {
    return tx.offlineTerminalNomination.findUnique({
      where: { tenantId_branchId: { tenantId, branchId } },
    });
  }

  private forbidden(code: string, message: string) {
    return new ForbiddenException({ code, message });
  }

  private async read(tx: Tx, tenantId: string, branchId: string): Promise<OfflineAssignmentView> {
    // Sequential: one transaction client never runs queries concurrently.
    const nomination = await this.nomination(tx, tenantId, branchId);
    const delegations = await tx.offlineTerminalDelegation.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const authorizations = await tx.offlineTerminalAssignmentAuthorization.findMany({
      where: { tenantId, branchId },
      orderBy: { authorizedAt: "desc" },
      take: 20,
    });
    const ms = (d: Date | null) => (d ? d.getTime() : null);
    return {
      branchId,
      nomination: nomination
        ? {
            terminalId: nomination.terminalId,
            enrollmentId: nomination.enrollmentId,
            version: nomination.version,
            activatedAt: nomination.activatedAt.getTime(),
          }
        : null,
      nominationVersion: nomination?.version ?? 0,
      delegations: delegations.map(
        (d): OfflineTerminalDelegation => ({
          delegationId: d.id,
          tenantId: d.tenantId,
          branchId: d.branchId,
          managerUserId: d.managerUserId,
          delegatedByOwnerUserId: d.delegatedByUserId,
          createdAt: d.createdAt.getTime(),
          revokedAt: ms(d.revokedAt),
        }),
      ),
      authorizations: authorizations.map(
        (a): OfflineTerminalAssignmentAuthorization & OfflineAssignmentView["authorizations"][number] => ({
          authorizationId: a.id,
          tenantId: a.tenantId,
          branchId: a.branchId,
          targetTerminalId: a.targetTerminalId,
          targetEnrollmentId: a.targetEnrollmentId,
          expectedNominationVersion: a.expectedNominationVersion,
          reason: a.reason,
          authorizedByUserId: a.authorizedByUserId,
          authorizedAt: a.authorizedAt.getTime(),
          status: a.status as OfflineTerminalAssignmentAuthorization["status"],
          authority: a.authority as "owner" | "delegated_manager",
          delegationId: a.delegationId,
          revokedAt: ms(a.revokedAt),
          revocationReason: a.revocationReason,
          consumedAt: ms(a.consumedAt),
        }),
      ),
    };
  }
}
