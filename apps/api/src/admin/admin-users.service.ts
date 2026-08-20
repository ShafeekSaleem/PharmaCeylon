import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { UserContextService } from "../auth/user-context.service";
import { AssignBranchRoleDto } from "./dto/assign-branch-role.dto";
import { CreateTenantUserDto } from "./dto/create-tenant-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly userContext: UserContextService,
    private readonly authService: AuthService,
  ) {}

  /**
   * All active branches for the tenant, unscoped by the caller's own
   * branchRoles — unlike `GET /tenant/branches`, which only returns branches
   * the caller personally has a role on. Owner/manager admin pages need the
   * full tenant picture (e.g. another manager's branches) regardless of the
   * caller's own assignments.
   */
  async listAllBranches(tenantId: string) {
    return this.prisma.branch.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, code: true, name: true, city: true, timezone: true },
      orderBy: { code: "asc" },
    });
  }

  async listUsers(tenantId: string) {
    return this.prisma.appUser.findMany({
      where: { tenantId },
      orderBy: { email: "asc" },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        userBranchRoles: {
          select: {
            id: true,
            branchId: true,
            role: true,
            roleId: true,
            roleRef: { select: { id: true, name: true, key: true } },
          },
        },
      },
    });
  }

  async createUser(actorTenantId: string, actorUserId: string, dto: CreateTenantUserDto) {
    const email = dto.email.toLowerCase().trim();
    const hash = await bcrypt.hash(dto.password, 10);
    try {
      const user = await this.prisma.appUser.create({
        data: {
          tenantId: actorTenantId,
          email,
          fullName: dto.fullName.trim(),
          passwordHash: hash,
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          isActive: true,
          createdAt: true,
          userBranchRoles: true,
        },
      });
      await this.audit.log({
        tenantId: actorTenantId,
        actorUserId: actorUserId,
        eventName: "user.created",
        entityName: "app_user",
        entityId: user.id,
        payload: { email: user.email },
      });
      return user;
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2002") {
        throw new ConflictException("Email is already registered");
      }
      throw e;
    }
  }

  async assignBranchRole(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
    dto: AssignBranchRoleDto,
  ) {
    if (dto.role === RoleName.owner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can grant the owner role");
    }

    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
    });
    if (!target) throw new NotFoundException("User not found");

    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId },
    });
    if (!branch) throw new NotFoundException("Branch not found");

    const roleId = await this.resolveRoleId(tenantId, dto.role, dto.roleId);

    const row = await this.prisma.userBranchRole.upsert({
      where: {
        tenantId_userId_branchId_role: {
          tenantId,
          userId: targetUserId,
          branchId: dto.branchId,
          role: dto.role,
        },
      },
      create: {
        tenantId,
        userId: targetUserId,
        branchId: dto.branchId,
        role: dto.role,
        roleId,
      },
      // Self-heals a mapping created before this tenant's Role rows existed.
      update: { roleId },
    });
    this.userContext.invalidate(targetUserId);
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.branch_role.assigned",
      entityName: "user_branch_role",
      entityId: row.id,
      payload: { targetUserId, branchId: dto.branchId, role: dto.role },
    });
    return row;
  }

  /**
   * Resolves the `Role` row a `UserBranchRole` mapping should point at for
   * permission resolution. Built-in roles resolve automatically from the
   * tenant's seeded system Role (`Role.key === role`); `custom` requires an
   * explicit `roleId` naming one of the tenant's custom roles.
   */
  private async resolveRoleId(
    tenantId: string,
    role: RoleName,
    explicitRoleId?: string,
  ): Promise<string | null> {
    if (role === RoleName.custom) {
      if (!explicitRoleId) {
        throw new BadRequestException("roleId is required when assigning a custom role");
      }
      const roleRow = await this.prisma.role.findFirst({
        where: { id: explicitRoleId, tenantId },
      });
      if (!roleRow) throw new NotFoundException("Role not found");
      return roleRow.id;
    }
    const roleRow = await this.prisma.role.findUnique({
      where: { tenantId_key: { tenantId, key: role } },
    });
    return roleRow?.id ?? null;
  }

  async removeBranchRole(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
    mappingId: string,
  ) {
    const row = await this.prisma.userBranchRole.findFirst({
      where: { id: mappingId, tenantId, userId: targetUserId },
    });
    if (!row) throw new NotFoundException("Role mapping not found");
    if (row.role === RoleName.owner && targetUserId === actorUserId) {
      throw new ForbiddenException("Cannot remove your own owner role mapping");
    }
    if (row.role === RoleName.owner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can remove another owner's role mapping");
    }
    await this.prisma.userBranchRole.delete({ where: { id: mappingId } });
    this.userContext.invalidate(targetUserId);
    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.branch_role.removed",
      entityName: "user_branch_role",
      entityId: mappingId,
      payload: { targetUserId },
    });
    return { ok: true };
  }

  async updateUser(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
    dto: UpdateUserDto,
  ) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
      include: { userBranchRoles: { select: { role: true } } },
    });
    if (!target) throw new NotFoundException("User not found");

    const targetIsOwner = target.userBranchRoles.some((r) => r.role === RoleName.owner);
    if (targetIsOwner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can modify another owner's account");
    }

    if (dto.isActive === false) {
      if (targetUserId === actorUserId) {
        throw new ForbiddenException("You cannot deactivate your own account");
      }
      if (targetIsOwner) {
        const owners = await this.prisma.userBranchRole.findMany({
          where: { tenantId, role: RoleName.owner },
          select: { userId: true },
          distinct: ["userId"],
        });
        if (owners.length <= 1) {
          throw new ForbiddenException("Cannot deactivate the tenant's only owner");
        }
      }
    }

    const updated = await this.prisma.appUser.update({
      where: { id: targetUserId },
      data: {
        ...(dto.fullName != null ? { fullName: dto.fullName.trim() } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
        ...(dto.isActive === false ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        isActive: true,
        createdAt: true,
        userBranchRoles: {
          select: {
            id: true,
            branchId: true,
            role: true,
            roleId: true,
            roleRef: { select: { id: true, name: true, key: true } },
          },
        },
      },
    });

    if (dto.isActive === false) {
      this.userContext.invalidate(targetUserId);
    }

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName:
        dto.isActive === false
          ? "user.deactivated"
          : dto.isActive === true
            ? "user.reactivated"
            : "user.updated",
      entityName: "app_user",
      entityId: targetUserId,
      payload: { fullName: dto.fullName, isActive: dto.isActive },
    });

    return updated;
  }

  /**
   * Permanently removes a staff account. Only allowed once the account is
   * deactivated — this is not an alternative to deactivation, it's cleanup
   * for an account that should never have existed (wrong email, test
   * account, etc). Any account with real activity (a sale, a PO, a stock
   * movement, an audit trail entry as actor, ...) still has rows referencing
   * it via a restrictive foreign key, so the delete fails and we surface
   * that as a clear error instead of enumerating every relation by hand.
   */
  async deleteUser(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
  ) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
      include: { userBranchRoles: { select: { role: true } } },
    });
    if (!target) throw new NotFoundException("User not found");

    if (target.isActive) {
      throw new ForbiddenException("Deactivate this account before deleting it");
    }

    const targetIsOwner = target.userBranchRoles.some((r) => r.role === RoleName.owner);
    if (targetIsOwner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can delete another owner's account");
    }

    try {
      await this.prisma.$transaction([
        this.prisma.userBranchRole.deleteMany({ where: { tenantId, userId: targetUserId } }),
        this.prisma.appUser.delete({ where: { id: targetUserId } }),
      ]);
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === "P2003") {
        throw new ConflictException(
          "This account has activity on record (sales, purchases, stock movements, audit history, etc.) and can't be permanently deleted — it stays deactivated instead.",
        );
      }
      throw e;
    }

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.deleted",
      entityName: "app_user",
      entityId: targetUserId,
      payload: { email: target.email },
    });

    return { ok: true };
  }

  /** PIN lock/session state for the Manage Staff "Security" panel. */
  async getSecurity(tenantId: string, targetUserId: string) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
      select: { posPinHash: true, failedPosPinAttempts: true, posPinLockedUntil: true },
    });
    if (!target) throw new NotFoundException("User not found");

    const now = new Date();
    const sessions = await this.prisma.session.findMany({
      where: { userId: targetUserId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastUsedAt: "desc" },
      select: { id: true, userAgent: true, ipAddress: true, lastUsedAt: true, createdAt: true },
    });

    return {
      pin: {
        isSet: Boolean(target.posPinHash),
        isLocked: Boolean(target.posPinLockedUntil && target.posPinLockedUntil.getTime() > now.getTime()),
        lockedUntil: target.posPinLockedUntil,
        failedAttempts: target.failedPosPinAttempts,
      },
      sessions,
    };
  }

  /**
   * Clears a staff member's POS till PIN so they can set a fresh one
   * themselves at the till (Quick Actions → Till PIN) — this never sets a
   * new PIN on their behalf, only unlocks/clears, same as a password reset.
   */
  async resetPosPin(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
  ) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
      include: { userBranchRoles: { select: { role: true } } },
    });
    if (!target) throw new NotFoundException("User not found");

    const targetIsOwner = target.userBranchRoles.some((r) => r.role === RoleName.owner);
    if (targetIsOwner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can modify another owner's account");
    }

    await this.prisma.appUser.update({
      where: { id: targetUserId },
      data: { posPinHash: null, failedPosPinAttempts: 0, posPinLockedUntil: null },
    });

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.pos_pin.admin_reset",
      entityName: "app_user",
      entityId: targetUserId,
    });

    return { reset: true };
  }

  /** Signs a staff member out of every device immediately. */
  async forceLogout(
    tenantId: string,
    actorUserId: string,
    actorIsOwner: boolean,
    targetUserId: string,
  ) {
    const target = await this.prisma.appUser.findFirst({
      where: { id: targetUserId, tenantId },
      include: { userBranchRoles: { select: { role: true } } },
    });
    if (!target) throw new NotFoundException("User not found");

    const targetIsOwner = target.userBranchRoles.some((r) => r.role === RoleName.owner);
    if (targetIsOwner && !actorIsOwner) {
      throw new ForbiddenException("Only an owner can modify another owner's account");
    }

    await this.authService.revokeAllSessions(targetUserId, "admin_invalidated");

    await this.audit.log({
      tenantId,
      actorUserId,
      eventName: "user.sessions.force_logout",
      entityName: "app_user",
      entityId: targetUserId,
    });

    return { ok: true };
  }
}
