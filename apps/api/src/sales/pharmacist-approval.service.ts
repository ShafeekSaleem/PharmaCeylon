import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PERMISSION_CATALOG } from "../security/permission-catalog";
import { PermissionsService } from "../security/permissions.service";
import { PharmacistRegistrationService } from "../clinical/pharmacist-registration.service";
import { PinAlerts } from "../terminals/pin-alerts.service";
import { MAX_PIN_LOCKOUTS, recordWrongPin } from "../terminals/pos-pin";

/** Static fallback — mirrors `sales.approve_controlled`'s default grant in permission-catalog.ts. */
const APPROVER_ROLES: RoleName[] = [
  RoleName.owner,
  RoleName.manager,
  RoleName.pharmacist,
];

const APPROVE_CONTROLLED_PERMISSION = "sales.approve_controlled";

type BranchRoleEntry = { branchId: string; role: RoleName; roleId?: string | null };

@Injectable()
export class PharmacistApprovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly registrations: PharmacistRegistrationService,
    private readonly alerts: PinAlerts,
  ) {}

  /**
   * Who may co-sign a controlled-substance dispense. Not a guard-gated
   * endpoint (this is business logic inside checkout/PIN flows), so it
   * resolves the `sales.approve_controlled` permission directly via
   * `PermissionsService` — same resolution path (and owner bypass) as the
   * `@RequirePermission` guard, so a tenant that re-grants this permission
   * to another role sees it take effect here too.
   */
  async hasApproverRole(
    branchRoles: BranchRoleEntry[],
    branchId: string,
    permission: string = APPROVE_CONTROLLED_PERMISSION,
  ): Promise<boolean> {
    const ownerAnywhere = branchRoles.some((b) => b.role === RoleName.owner);
    if (ownerAnywhere) return true;
    const atBranch = branchRoles.filter((b) => b.branchId === branchId);
    return this.permissions.hasAnyPermission(atBranch, [permission]);
  }

  /**
   * Pharmacists / managers / owners active at this branch (for PIN picker), plus any custom role
   * granted approval. A controlled co-sign also needs a current SLMC registration at the branch
   * (P1 #47), so that list holds only people the checkout will accept.
   */
  async listApprovers(
    tenantId: string,
    branchId: string,
    permission: string = APPROVE_CONTROLLED_PERMISSION,
  ) {
    const fallbackRoles =
      permission === APPROVE_CONTROLLED_PERMISSION
        ? APPROVER_ROLES
        : (PERMISSION_CATALOG.find((entry) => entry.key === permission)?.defaultRoles ?? [
            RoleName.owner,
          ]);
    const grantedRoles = await this.prisma.role.findMany({
      where: { tenantId, permissions: { some: { permissionKey: permission } } },
      select: { id: true },
    });
    const grantedRoleIds = grantedRoles.map((r) => r.id);

    const rows = await this.prisma.userBranchRole.findMany({
      where: {
        tenantId,
        OR: [
          { branchId, role: { in: fallbackRoles } },
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
    let approvers = [...byUser.values()];
    if (permission === APPROVE_CONTROLLED_PERMISSION) {
      const qualified = await this.registrations.qualifiedAt(
        tenantId,
        branchId,
        approvers.map((a) => a.id),
      );
      approvers = approvers.filter((a) => qualified.has(a.id));
    }
    return approvers.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /**
   * D-W5: at a branch live on PharmaCeylon POS the PIN is set and changed at the counter, which
   * also prepares that counter. The web routes stay for branches still on the web POS, and during a
   * fallback, when the web POS is what the branch is using.
   */
  private async assertWebPinBranch(tenantId: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId },
      select: { desktopPosRollout: true, posFallbackEndsAt: true },
    });
    const fallback = Boolean(branch?.posFallbackEndsAt && branch.posFallbackEndsAt > new Date());
    if (branch?.desktopPosRollout === "live" && !fallback)
      throw new ForbiddenException({
        code: "PIN_SET_AT_COUNTER",
        message: "This branch uses PharmaCeylon POS: set or change your PIN at a counter.",
      });
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
    await this.assertWebPinBranch(tenantId, branchId);
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
    if (!ok) throw new ForbiddenException({ code: "PASSWORD_INCORRECT", message: "Login password is incorrect" });

    const posPinHash = await bcrypt.hash(pin, 10);
    // tenant-scope: verified-parent — the authenticated caller's membership was verified above.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        posPinHash,
        failedPosPinAttempts: 0,
        posPinLockedUntil: null,
        // Setting a PIN takes the password, so it also ends a switch-off.
        posPinLockouts: 0,
        posPinVersion: { increment: 1 },
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
    await this.assertWebPinBranch(tenantId, branchId);
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
    if (!ok) throw new ForbiddenException({ code: "PASSWORD_INCORRECT", message: "Login password is incorrect" });

    // tenant-scope: verified-parent — the authenticated caller's membership was verified above.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        posPinHash: null,
        failedPosPinAttempts: 0,
        posPinLockedUntil: null,
        posPinLockouts: 0,
        posPinVersion: { increment: 1 },
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
   * Failures use the PIN's lockout (`terminals/pos-pin.ts`), not the login account's, so till
   * mistakes don't lock anyone out of signing in; and that lockout escalates, so a signed-in
   * counter can't guess at a co-signer's PIN indefinitely either.
   */
  async verifyApproverPin(
    tenantId: string,
    branchId: string,
    approverUserId: string,
    pin: string,
    actorUserId: string,
    /** What the approver is signing for. Controlled dispense by default; a refund over the
     *  threshold passes `returns.approve`. */
    permission: string = APPROVE_CONTROLLED_PERMISSION,
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
        posPinLockouts: true,
        userBranchRoles: {
          where: {
            tenantId,
            OR: [{ branchId }, { role: RoleName.owner }],
          },
          select: { role: true, branchId: true, roleId: true },
        },
      },
    });
    // Refusals about the approver's secret are 403s, never 401: clients treat 401 as an expired
    // session and refresh and resend, which would count one wrong PIN twice.
    if (!user) {
      throw new ForbiddenException({ code: "APPROVER_NOT_FOUND", message: "Approver not found" });
    }

    const allowed = await this.hasApproverRole(user.userBranchRoles, branchId, permission);
    if (!allowed) {
      throw new ForbiddenException(
        permission === APPROVE_CONTROLLED_PERMISSION
          ? "Selected user is not authorised to approve controlled dispense at this branch"
          : "Selected user can't approve this at this branch",
      );
    }

    // A discount or refund co-sign (P2b #103) has no "hold for pharmacist" to fall back on.
    const controlled = permission === APPROVE_CONTROLLED_PERMISSION;
    // Also when no PIN is set: the password stands in for it here, and is guessed at the same way.
    if (user.posPinLockouts >= MAX_PIN_LOCKOUTS) {
      throw new ForbiddenException({
        code: "APPROVER_PIN_SWITCHED_OFF",
        message: `Too many wrong attempts for this approver. They need to sign in with their password before they can co-sign again.${controlled ? " Use Hold for pharmacist meanwhile." : " Ask another approver meanwhile."}`,
      });
    }
    if (user.posPinLockedUntil && user.posPinLockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException({
        code: "APPROVER_PIN_LOCKED",
        message: `Approver PIN is temporarily locked after too many failed attempts. Try again shortly${controlled ? " or use Hold for pharmacist" : " or ask another approver"}.`,
      });
    }

    const secretOk = user.posPinHash
      ? await bcrypt.compare(pin, user.posPinHash)
      : await bcrypt.compare(pin, user.passwordHash);

    if (!secretOk) {
      const { failures, lockedUntil, switchedOff } = await this.prisma.$transaction((tx) =>
        recordWrongPin(tx, user.id, new Date()),
      );
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId,
        eventName: "sale.pharmacist_pin_failed",
        entityName: "app_user",
        entityId: user.id,
        // The permission the co-sign was for; never the PIN.
        payload: { failures, locked: Boolean(lockedUntil), switchedOff, permission },
      });
      if (switchedOff) await this.alerts.switchedOff(tenantId, branchId, user.id);
      throw new ForbiddenException({
        code: "APPROVER_PIN_INCORRECT",
        message: user.posPinHash
          ? controlled
            ? "Incorrect pharmacist PIN"
            : "Incorrect till PIN"
          : "Incorrect password (this approver has not set a till PIN yet)",
      });
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
