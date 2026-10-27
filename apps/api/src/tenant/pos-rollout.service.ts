import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  DesktopPosRollout,
  NotificationCategory,
  NotificationSeverity,
  Prisma,
  RoleName,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  buildGoLiveChecklist,
  fallbackActive,
  goLiveBlocked,
  MAX_FALLBACK_HOURS,
  POS_ROLLOUT_SELECT,
  type PosRolloutColumns,
  resolvePosRollout,
} from "./pos-rollout";

type Tx = Prisma.TransactionClient;

const BRANCH_SELECT = { id: true, name: true, ...POS_ROLLOUT_SELECT } as const;
type BranchRow = PosRolloutColumns & { id: string; name: string };

/**
 * Owner controls for a branch's desktop POS switch and web-POS fallback (D-W1, D-W7).
 *
 * Each change is a conditional update on the state the caller was shown, so two owners acting
 * at once can't both win, and the audit event commits in the same transaction as the change.
 */
@Injectable()
export class PosRolloutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async get(user: RequestUser, branchId: string) {
    const branch = await this.readableBranch(user, branchId);
    return this.view(this.prisma, user.tenantId, branch);
  }

  async goLive(user: RequestUser, branchId: string) {
    this.assertOwner(user);
    const now = new Date();
    const branch = await this.prisma.$transaction(async (tx) => {
      const branch = await this.branch(tx, user.tenantId, branchId);
      if (branch.desktopPosRollout === DesktopPosRollout.live) {
        throw new ConflictException("Desktop POS is already live at this branch");
      }
      const checklist = await this.checklist(tx, user.tenantId, branchId);
      if (goLiveBlocked(checklist)) {
        throw new ConflictException({
          code: "GO_LIVE_CHECKLIST_INCOMPLETE",
          message: "This branch can't go live until its go-live checklist passes.",
          checklist,
        });
      }
      await this.update(tx, user.tenantId, branch, {
        desktopPosRollout: DesktopPosRollout.live,
        desktopPosLiveAt: now,
        posFallbackStartedAt: null,
        posFallbackEndsAt: null,
      });
      await this.log(tx, user, branchId, "branch.pos_rollout_live", { checklist });
      return branch;
    });
    await this.notify(user, branch, `Desktop POS is live at "${branch.name}"`);
    return this.get(user, branchId);
  }

  /** Back to the web POS for good. A fallback is the time-limited way back; this is the switch. */
  async goNotLive(user: RequestUser, branchId: string) {
    this.assertOwner(user);
    const branch = await this.prisma.$transaction(async (tx) => {
      const branch = await this.branch(tx, user.tenantId, branchId);
      if (branch.desktopPosRollout !== DesktopPosRollout.live) {
        throw new ConflictException("Desktop POS isn't live at this branch");
      }
      await this.update(tx, user.tenantId, branch, {
        desktopPosRollout: DesktopPosRollout.not_live,
        desktopPosLiveAt: null,
        posFallbackStartedAt: null,
        posFallbackEndsAt: null,
      });
      await this.log(tx, user, branchId, "branch.pos_rollout_not_live", {
        liveSince: branch.desktopPosLiveAt?.toISOString() ?? null,
      });
      return branch;
    });
    await this.notify(
      user,
      branch,
      `"${branch.name}" is back on the web POS`,
      NotificationSeverity.warning,
    );
    return this.get(user, branchId);
  }

  /** Starts a fallback, or moves the end of the one already running. */
  async startFallback(user: RequestUser, branchId: string, endsAtInput: string, reason?: string) {
    this.assertOwner(user);
    const now = new Date();
    const endsAt = new Date(endsAtInput);
    if (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime()) {
      throw new BadRequestException("Choose when the fallback ends, in the future");
    }
    if (endsAt.getTime() - now.getTime() > MAX_FALLBACK_HOURS * 3_600_000) {
      throw new BadRequestException(
        `A fallback can last at most ${MAX_FALLBACK_HOURS / 24} days. Start it again to go longer.`,
      );
    }
    const note = reason?.trim() || null;
    const branch = await this.prisma.$transaction(async (tx) => {
      const branch = await this.branch(tx, user.tenantId, branchId);
      if (branch.desktopPosRollout !== DesktopPosRollout.live) {
        throw new ConflictException(
          "A fallback is only for a branch where desktop POS is live. This branch already uses the web POS.",
        );
      }
      const running = fallbackActive(branch, now);
      await this.update(tx, user.tenantId, branch, {
        posFallbackStartedAt: running ? branch.posFallbackStartedAt : now,
        posFallbackEndsAt: endsAt,
      });
      await this.log(
        tx,
        user,
        branchId,
        running ? "branch.pos_fallback_extended" : "branch.pos_fallback_started",
        {
          endsAt: endsAt.toISOString(),
          ...(running ? { previousEndsAt: branch.posFallbackEndsAt!.toISOString() } : {}),
          reason: note,
        },
      );
      return branch;
    });
    await this.notify(
      user,
      branch,
      `Web POS fallback is on at "${branch.name}"`,
      NotificationSeverity.warning,
    );
    return this.get(user, branchId);
  }

  async endFallback(user: RequestUser, branchId: string) {
    this.assertOwner(user);
    const now = new Date();
    const branch = await this.prisma.$transaction(async (tx) => {
      const branch = await this.branch(tx, user.tenantId, branchId);
      if (!fallbackActive(branch, now)) {
        throw new ConflictException("No web POS fallback is running at this branch");
      }
      await this.update(tx, user.tenantId, branch, {
        posFallbackStartedAt: null,
        posFallbackEndsAt: null,
      });
      await this.log(tx, user, branchId, "branch.pos_fallback_ended", {
        startedAt: branch.posFallbackStartedAt!.toISOString(),
        scheduledEndsAt: branch.posFallbackEndsAt!.toISOString(),
      });
      return branch;
    });
    await this.notify(user, branch, `Web POS fallback ended at "${branch.name}"`);
    return this.get(user, branchId);
  }

  /**
   * Only owners change the switch (D-W7). A permission key can be granted to any role, so this
   * checks the owner role itself, the same way `TenantService.updateBranch` keeps a branch's
   * identity owner-only.
   */
  private assertOwner(user: RequestUser) {
    if (!user.branchRoles.some((entry) => entry.role === RoleName.owner)) {
      throw new ForbiddenException("Only an owner can change desktop POS for a branch");
    }
  }

  private async readableBranch(user: RequestUser, branchId: string) {
    const isOwner = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    if (!isOwner && !user.branchRoles.some((entry) => entry.branchId === branchId)) {
      throw new NotFoundException("Branch not found");
    }
    return this.branch(this.prisma, user.tenantId, branchId);
  }

  private async branch(client: Tx, tenantId: string, branchId: string): Promise<BranchRow> {
    const branch = await client.branch.findFirst({
      where: { id: branchId, tenantId },
      select: BRANCH_SELECT,
    });
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }

  /** Writes only if the branch still holds the state this change was decided on. */
  private async update(
    tx: Tx,
    tenantId: string,
    seen: BranchRow,
    data: Prisma.BranchUpdateManyMutationInput,
  ) {
    const changed = await tx.branch.updateMany({
      where: {
        id: seen.id,
        tenantId,
        desktopPosRollout: seen.desktopPosRollout,
        posFallbackEndsAt: seen.posFallbackEndsAt,
      },
      data,
    });
    if (changed.count !== 1) {
      throw new ConflictException("Desktop POS for this branch just changed. Reload and try again.");
    }
  }

  private async checklist(client: Tx, tenantId: string, branchId: string) {
    const activeEnrollments = await client.terminalEnrollment.count({
      where: { tenantId, branchId, revokedAt: null, terminal: { retiredAt: null } },
    });
    return buildGoLiveChecklist({ activeEnrollments });
  }

  private async view(client: Tx, tenantId: string, branch: BranchRow) {
    const checklist = await this.checklist(client, tenantId, branch.id);
    return {
      branchId: branch.id,
      ...resolvePosRollout(branch),
      checklist,
      canGoLive: branch.desktopPosRollout !== DesktopPosRollout.live && !goLiveBlocked(checklist),
      maxFallbackHours: MAX_FALLBACK_HOURS,
    };
  }

  private log(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    eventName: string,
    payload: Prisma.InputJsonValue,
  ) {
    return this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName,
        entityName: "branch",
        entityId: branchId,
        payload,
      },
      tx,
    );
  }

  private async notify(
    user: RequestUser,
    branch: BranchRow,
    title: string,
    severity: NotificationSeverity = NotificationSeverity.info,
  ) {
    await this.notifications.notifyByPermission(
      user.tenantId,
      "tenant.management",
      NotificationCategory.system,
      {
        severity,
        title,
        actionHref: "/settings/branches",
        entityType: "branch",
        entityId: branch.id,
      },
      user.userId,
    );
  }
}
