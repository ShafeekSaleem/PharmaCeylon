import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PermissionsService } from "../security/permissions.service";

/** Static fallback — mirrors `sales.approve_controlled`'s default grant in permission-catalog.ts. */
const APPROVER_ROLES: RoleName[] = [
  RoleName.owner,
  RoleName.manager,
  RoleName.pharmacist,
];

const APPROVE_CONTROLLED_PERMISSION = "sales.approve_controlled";

const MAX_PIN_FAILURES = 5;
const PIN_LOCK_MINUTES = 15;

type BranchRoleEntry = { branchId: string; role: RoleName; roleId?: string | null };

@Injectable()
export class PharmacistApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  /**
   * Who may co-sign a controlled-substance dispense. Not a guard-gated
   * endpoint (this is business logic inside checkout/PIN flows), so it
   * resolves the `sales.approve_controlled` permission directly via
   * `PermissionsService` — same resolution path (and owner bypass) as the
   * `@RequirePermission` guard, so a tenant that re-grants this permission
   * to another role sees it take effect here too.
   */
  async hasApproverRole(branchRoles: BranchRoleEntry[], branchId: string): Promise<boolean> {
    const ownerAnywhere = branchRoles.some((b) => b.role === RoleName.owner);
    if (ownerAnywhere) return true;
    const atBranch = branchRoles.filter((b) => b.branchId === branchId);
    return this.permissions.hasAnyPermission(atBranch, [APPROVE_CONTROLLED_PERMISSION]);
  }

  /** Pharmacists / managers / owners active at this branch (for PIN picker), plus any custom role granted approval. */
  async listApprovers(tenantId: string, branchId: string) {
    const grantedRoles = await this.prisma.role.findMany({
      where: { tenantId, permissions: { some: { permissionKey: APPROVE_CONTROLLED_PERMISSION } } },
      select: { id: true },
    });
    const grantedRoleIds = grantedRoles.map((r) => r.id);

    const rows = await this.prisma.userBranchRole.findMany({
      where: {
        tenantId,
        OR: [
          { branchId, role: { in: APPROVER_ROLES } },
          ...(grantedRoleIds.length ? [{ branchId, roleId: { in: grantedRoleIds } }] : []),
          { role: RoleName.owner },
        ],
        user: {
          isActive: true,
          tenantMemberships: { some: { tenantId, isActive: true } },
        },
      },
      select: {
        role: true,
        user: {
          select: {
            id: true,
            fullName: true,
            email: true,
            posPinHash: true,
          },
        },
      },
      orderBy: { user: { fullName: "asc" } },
    });

    const byUser = new Map<
      string,
      { id: string; fullName: string; email: string; hasPosPin: boolean; roles: RoleName[] }
    >();
    for (const row of rows) {
      const existing = byUser.get(row.user.id);
      if (existing) {
        if (!existing.roles.includes(row.role)) existing.roles.push(row.role);
        continue;
      }
      byUser.set(row.user.id, {
        id: row.user.id,
        fullName: row.user.fullName,
        email: row.user.email,
        hasPosPin: Boolean(row.user.posPinHash),
        roles: [row.role],
      });
    }
    return [...byUser.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  async setPosPin(
    tenantId: string,
    userId: string,
    branchRoles: BranchRoleEntry[],
    branchId: string,
    pin: string,
    password: string,
  ) {
    if (!(await this.hasApproverRole(branchRoles, branchId))) {
      throw new ForbiddenException("Only pharmacist, manager, or owner may set a POS PIN");
    }
    const user = await this.prisma.appUser.findFirst({
      where: {
        id: userId,
        isActive: true,
        tenantMemberships: { some: { tenantId, isActive: true } },
      },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException("User not found");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Login password is incorrect");

    const posPinHash = await bcrypt.hash(pin, 10);
    // tenant-scope: verified-parent — the authenticated caller's membership was verified above.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        posPinHash,
        failedPosPinAttempts: 0,
        posPinLockedUntil: null,
      },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "user.pos_pin.set",
      entityName: "app_user",
      entityId: userId,
    });
    return { set: true };
  }

  async clearPosPin(
    tenantId: string,
    userId: string,
    branchRoles: BranchRoleEntry[],
    branchId: string,
    password: string,
  ) {
    if (!(await this.hasApproverRole(branchRoles, branchId))) {
      throw new ForbiddenException("Only pharmacist, manager, or owner may clear a POS PIN");
    }
    const user = await this.prisma.appUser.findFirst({
      where: {
        id: userId,
        isActive: true,
        tenantMemberships: { some: { tenantId, isActive: true } },
      },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw new UnauthorizedException("User not found");
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException("Login password is incorrect");

    // tenant-scope: verified-parent — the authenticated caller's membership was verified above.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        posPinHash: null,
        failedPosPinAttempts: 0,
        posPinLockedUntil: null,
      },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "user.pos_pin.cleared",
      entityName: "app_user",
      entityId: userId,
    });
    return { cleared: true };
  }

  /**
   * Verify pharmacist co-sign. Prefers POS PIN when set; otherwise login password.
   * Failures use a separate lockout counter so till mistakes don't lock the login account.
   */
  async verifyApproverPin(
    tenantId: string,
    branchId: string,
    approverUserId: string,
    pin: string,
    actorUserId: string,
  ): Promise<{ approverUserId: string; approverName: string }> {
    const user = await this.prisma.appUser.findFirst({
      where: {
        id: approverUserId,
        isActive: true,
        tenantMemberships: { some: { tenantId, isActive: true } },
      },
      select: {
        id: true,
        fullName: true,
        passwordHash: true,
        posPinHash: true,
        failedPosPinAttempts: true,
        posPinLockedUntil: true,
        userBranchRoles: {
          where: {
            tenantId,
            OR: [{ branchId }, { role: RoleName.owner }],
          },
          select: { role: true, branchId: true, roleId: true },
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException("Approver not found");
    }

    const allowed = await this.hasApproverRole(user.userBranchRoles, branchId);
    if (!allowed) {
      throw new ForbiddenException(
        "Selected user is not authorised to approve controlled dispense at this branch",
      );
    }

    if (user.posPinLockedUntil && user.posPinLockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(
        "Approver PIN is temporarily locked after too many failed attempts. Try again shortly or use Hold for pharmacist.",
      );
    }

    const secretOk = user.posPinHash
      ? await bcrypt.compare(pin, user.posPinHash)
      : await bcrypt.compare(pin, user.passwordHash);

    if (!secretOk) {
      const failures = user.failedPosPinAttempts + 1;
      const locked =
        failures >= MAX_PIN_FAILURES
          ? new Date(Date.now() + PIN_LOCK_MINUTES * 60_000)
          : null;
      // tenant-scope: verified-parent — the approver's tenant membership was verified above.
      await this.prisma.appUser.update({
        where: { id: user.id },
        data: {
          failedPosPinAttempts: failures,
          posPinLockedUntil: locked,
        },
      });
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId,
        eventName: "sale.pharmacist_pin_failed",
        entityName: "app_user",
        entityId: user.id,
        payload: { failures, locked: Boolean(locked) },
      });
      throw new UnauthorizedException(
        user.posPinHash
          ? "Incorrect pharmacist PIN"
          : "Incorrect password (this approver has not set a till PIN yet)",
      );
    }

    if (user.failedPosPinAttempts > 0 || user.posPinLockedUntil) {
      // tenant-scope: verified-parent — the approver's tenant membership was verified above.
      await this.prisma.appUser.update({
        where: { id: user.id },
        data: { failedPosPinAttempts: 0, posPinLockedUntil: null },
      });
    }

    return { approverUserId: user.id, approverName: user.fullName };
  }
}
