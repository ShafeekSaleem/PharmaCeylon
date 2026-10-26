import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { NotificationCategory, NotificationSeverity, Prisma, RoleName } from "@prisma/client";
import {
  BRANCH_HOURS_ERROR_CODES,
  MAX_HOURS_EXTENSION_MS,
  isNoSelling,
  sameMandatory,
  validateBranchHours,
  type BranchHours,
  type BranchHoursView,
  type HolidaySuggestionsView,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { addDays, businessDateKey, dateKeyToUtc } from "../common/business-date.util";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { BranchRole } from "../security/interfaces/authenticated-request.interface";
import {
  CreateBranchHoursExtensionDto,
  RevokeBranchHoursExtensionDto,
  UpdateBranchHoursDto,
} from "./dto/branch-hours.dto";
import { HolidaySuggestionsSource } from "./holiday-suggestions";

/** Same audience as every other branch notification (see TenantService). */
const TENANT_NOTIFICATION_PERMISSION = "tenant.management";
/** A person picking "now" in a minute-precision field is a little in the past. */
const EXTENSION_START_GRACE_MS = 5 * 60 * 1000;
const EXTENSION_MAX_LEAD_DAYS = 366;
const HOLIDAY_LOOKAHEAD_DAYS = 400;

const HOURS_SELECT = {
  id: true,
  name: true,
  timezone: true,
  legacyOpeningHours: true,
  operatingHours: true,
  operatingHoursOrigin: true,
  operatingHoursVersion: true,
  operatingHoursUpdatedAt: true,
  operatingHoursUpdatedBy: true,
} satisfies Prisma.BranchSelect;

type Actor = { userId: string; branchRoles: BranchRole[] };

/**
 * W7 / D-W6: structured branch hours. The web is the only editor; P3 reads the stored document
 * and the active extensions when it resolves a grant's operating windows.
 *
 * Who may change what follows TenantService.updateBranch: an owner (on any branch) may change
 * everything; a manager may change the routine schedule, dated exceptions and business
 * extensions of a branch they manage. Mandatory limits are the owner's alone.
 */
@Injectable()
export class BranchHoursService {
  private readonly logger = new Logger(BranchHoursService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly holidays: HolidaySuggestionsSource,
  ) {}

  getHours(tenantId: string, branchId: string): Promise<BranchHoursView> {
    return this.view(tenantId, branchId);
  }

  async updateHours(
    tenantId: string,
    actor: Actor,
    branchId: string,
    dto: UpdateBranchHoursDto,
    now: Date = new Date(),
  ): Promise<BranchHoursView> {
    const branch = await this.findBranch(tenantId, branchId);
    const authority = this.authorityOver(actor, branchId);

    const parsed = validateBranchHours(dto.hours);
    if (!parsed.ok) {
      throw new BadRequestException({ code: "INVALID_BRANCH_HOURS", message: [...parsed.errors] });
    }
    const next = parsed.value;
    const current = this.storedHours(branch.operatingHours, branchId);
    const currentMandatory = current?.mandatory ?? null;

    if (authority === "manager" && !sameMandatory(next.mandatory, currentMandatory)) {
      throw new ForbiddenException({
        code: BRANCH_HOURS_ERROR_CODES.mandatoryOwnerOnly,
        message: "Only the owner can change mandatory selling limits.",
      });
    }
    if (isNoSelling(next) && !isNoSelling(current) && dto.confirmNoSelling !== true) {
      throw new BadRequestException({
        code: BRANCH_HOURS_ERROR_CODES.noSellingConfirmationRequired,
        message: `This stops all selling at ${branch.name}, including at counters during an outage. Confirm it to save.`,
      });
    }

    const unchanged =
      branch.operatingHoursOrigin === "editor" &&
      current !== null &&
      JSON.stringify(current) === JSON.stringify(next);
    if (unchanged) return this.view(tenantId, branchId);

    const changed = current
      ? (["weekly", "exceptions", "mandatory"] as const).filter(
          (part) => JSON.stringify(current[part]) !== JSON.stringify(next[part]),
        )
      : (["weekly", "exceptions", "mandatory"] as const);
    const mandatoryChanged = !sameMandatory(next.mandatory, currentMandatory);

    await this.prisma.$transaction(async (tx) => {
      const saved = await tx.branch.updateMany({
        where: { id: branchId, tenantId, operatingHoursVersion: dto.expectedVersion },
        data: {
          operatingHours: next as unknown as Prisma.InputJsonValue,
          operatingHoursOrigin: "editor",
          operatingHoursVersion: { increment: 1 },
          operatingHoursUpdatedAt: now,
          operatingHoursUpdatedBy: actor.userId,
        },
      });
      if (saved.count !== 1) throw this.versionConflict();

      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: actor.userId,
          eventName: "branch.hours_updated",
          entityName: "branch",
          entityId: branchId,
          payload: {
            fromVersion: dto.expectedVersion,
            toVersion: dto.expectedVersion + 1,
            previousOrigin: branch.operatingHoursOrigin,
            changed: [...changed],
            ...(mandatoryChanged
              ? { mandatoryBefore: currentMandatory, mandatoryAfter: next.mandatory }
              : {}),
            noSelling: isNoSelling(next),
          } as Prisma.InputJsonValue,
        },
        tx,
      );
    });

    await this.notifications.notifyByPermission(
      tenantId,
      TENANT_NOTIFICATION_PERMISSION,
      NotificationCategory.system,
      {
        severity: mandatoryChanged ? NotificationSeverity.warning : NotificationSeverity.info,
        title: isNoSelling(next)
          ? `All selling is stopped at "${branch.name}"`
          : mandatoryChanged
            ? `Mandatory selling limits changed at "${branch.name}"`
            : `Opening hours for "${branch.name}" were updated`,
        actionHref: `/settings/branches/${branchId}/hours`,
        entityType: "branch",
        entityId: branchId,
      },
      actor.userId,
    );

    return this.view(tenantId, branchId);
  }

  /** An online-approved business extension: the person saving it is its approver. */
  async createExtension(
    tenantId: string,
    actor: Actor,
    branchId: string,
    dto: CreateBranchHoursExtensionDto,
    now: Date = new Date(),
  ): Promise<BranchHoursView> {
    const branch = await this.findBranch(tenantId, branchId);
    this.authorityOver(actor, branchId);

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException("Give a reason for the extension.");
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException("The extension must end after it starts.");
    }
    if (endsAt.getTime() - startsAt.getTime() > MAX_HOURS_EXTENSION_MS) {
      throw new BadRequestException("An extension can cover at most 24 hours.");
    }
    if (startsAt.getTime() < now.getTime() - EXTENSION_START_GRACE_MS) {
      throw new BadRequestException("An extension can't start in the past.");
    }
    if (startsAt.getTime() > addDays(now, EXTENSION_MAX_LEAD_DAYS).getTime()) {
      throw new BadRequestException("An extension can be approved at most a year ahead.");
    }

    await this.prisma.$transaction(async (tx) => {
      // Bumping the version first takes the branch row's lock, so two people approving
      // overlapping extensions at once can't both pass the overlap check below.
      const bumped = await tx.branch.updateMany({
        where: { id: branchId, tenantId },
        data: { operatingHoursVersion: { increment: 1 } },
      });
      if (bumped.count !== 1) throw new NotFoundException("Branch not found");
      const overlapping = await tx.branchHoursExtension.findFirst({
        where: {
          tenantId,
          branchId,
          revokedAt: null,
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { startsAt: true, endsAt: true },
      });
      if (overlapping) {
        throw new ConflictException(
          `This overlaps an extension already approved from ${overlapping.startsAt.toISOString()} to ${overlapping.endsAt.toISOString()}. Revoke that one or choose another time.`,
        );
      }
      const created = await tx.branchHoursExtension.create({
        data: {
          tenantId,
          branchId,
          startsAt,
          endsAt,
          reason,
          approvedByUserId: actor.userId,
          approvedAt: now,
        },
        select: { id: true },
      });
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: actor.userId,
          eventName: "branch.hours_extension_approved",
          entityName: "branch_hours_extension",
          entityId: created.id,
          payload: { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), reason },
        },
        tx,
      );
    });

    await this.notifications.notifyByPermission(
      tenantId,
      TENANT_NOTIFICATION_PERMISSION,
      NotificationCategory.system,
      {
        title: `Selling hours extended at "${branch.name}"`,
        actionHref: `/settings/branches/${branchId}/hours`,
        entityType: "branch",
        entityId: branchId,
      },
      actor.userId,
    );

    return this.view(tenantId, branchId);
  }

  async revokeExtension(
    tenantId: string,
    actor: Actor,
    branchId: string,
    extensionId: string,
    dto: RevokeBranchHoursExtensionDto,
    now: Date = new Date(),
  ): Promise<BranchHoursView> {
    await this.findBranch(tenantId, branchId);
    this.authorityOver(actor, branchId);
    const reason = dto.reason.trim();
    if (!reason) throw new BadRequestException("Give a reason for revoking the extension.");

    const extension = await this.prisma.branchHoursExtension.findFirst({
      where: { id: extensionId, tenantId, branchId },
      select: { id: true, endsAt: true, revokedAt: true },
    });
    if (!extension) throw new NotFoundException("Extension not found");
    if (extension.revokedAt) throw new ConflictException("This extension has already been revoked.");
    if (extension.endsAt.getTime() <= now.getTime()) {
      throw new BadRequestException("This extension has already ended.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.branch.updateMany({
        where: { id: branchId, tenantId },
        data: { operatingHoursVersion: { increment: 1 } },
      });
      const revoked = await tx.branchHoursExtension.updateMany({
        where: { id: extensionId, tenantId, branchId, revokedAt: null },
        data: { revokedAt: now, revokedByUserId: actor.userId, revocationReason: reason },
      });
      if (revoked.count !== 1) throw new ConflictException("This extension has already been revoked.");
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: actor.userId,
          eventName: "branch.hours_extension_revoked",
          entityName: "branch_hours_extension",
          entityId: extensionId,
          payload: { reason },
        },
        tx,
      );
    });

    return this.view(tenantId, branchId);
  }

  /** Upcoming holidays from the agreed list, for the editor to offer. Never applied here. */
  async holidaySuggestions(
    tenantId: string,
    branchId: string,
    now: Date = new Date(),
  ): Promise<HolidaySuggestionsView> {
    const branch = await this.findBranch(tenantId, branchId);
    const today = businessDateKey(branch.timezone, now);
    const until = addDays(dateKeyToUtc(today), HOLIDAY_LOOKAHEAD_DAYS).toISOString().slice(0, 10);
    const { source, holidays } = this.holidays.list();
    return {
      source,
      holidays: holidays
        .filter((holiday) => holiday.date >= today && holiday.date <= until)
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  private async findBranch(tenantId: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: HOURS_SELECT,
    });
    if (!branch) throw new NotFoundException("Branch not found");
    return branch;
  }

  /** `tenant.branches_manage` only says the caller holds it somewhere; this is the branch rule. */
  private authorityOver(actor: Actor, branchId: string): "owner" | "manager" {
    if (actor.branchRoles.some((br) => br.role === RoleName.owner)) return "owner";
    if (actor.branchRoles.some((br) => br.branchId === branchId && br.role === RoleName.manager)) {
      return "manager";
    }
    throw new ForbiddenException("You can only change hours for a branch where you are the manager");
  }

  private storedHours(raw: Prisma.JsonValue | null, branchId: string): BranchHours | null {
    if (raw === null) return null;
    const parsed = validateBranchHours(raw);
    if (parsed.ok) return parsed.value;
    this.logger.error(`Stored hours for branch ${branchId} are invalid: ${parsed.errors.join(" ")}`);
    return null;
  }

  private versionConflict() {
    return new ConflictException({
      code: BRANCH_HOURS_ERROR_CODES.versionConflict,
      message:
        "Someone changed these hours since you opened them. Reload to see the latest, then make your change again.",
    });
  }

  private async view(tenantId: string, branchId: string): Promise<BranchHoursView> {
    const branch = await this.findBranch(tenantId, branchId);
    const extensions = await this.prisma.branchHoursExtension.findMany({
      where: { tenantId, branchId, revokedAt: null, endsAt: { gt: new Date() } },
      orderBy: { startsAt: "asc" },
      select: { id: true, startsAt: true, endsAt: true, reason: true, approvedByUserId: true, approvedAt: true },
    });
    const userIds = [
      ...new Set(
        [branch.operatingHoursUpdatedBy, ...extensions.map((e) => e.approvedByUserId)].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    ];
    const users = userIds.length
      ? await this.prisma.appUser.findMany({
          where: { id: { in: userIds }, tenantMemberships: { some: { tenantId } } },
          select: { id: true, fullName: true },
        })
      : [];
    const person = (id: string) => ({
      id,
      name: users.find((user) => user.id === id)?.fullName ?? null,
    });
    const hours = this.storedHours(branch.operatingHours, branchId);

    return {
      branchId: branch.id,
      branchName: branch.name,
      timezone: branch.timezone,
      version: branch.operatingHoursVersion,
      hours,
      origin: hours ? (branch.operatingHoursOrigin as BranchHoursView["origin"]) : null,
      updatedAt: branch.operatingHoursUpdatedAt?.toISOString() ?? null,
      updatedBy: branch.operatingHoursUpdatedBy ? person(branch.operatingHoursUpdatedBy) : null,
      legacyText: branch.legacyOpeningHours,
      extensions: extensions.map((e) => ({
        id: e.id,
        startsAt: e.startsAt.toISOString(),
        endsAt: e.endsAt.toISOString(),
        reason: e.reason,
        approvedBy: person(e.approvedByUserId),
        approvedAt: e.approvedAt.toISOString(),
      })),
    };
  }
}
