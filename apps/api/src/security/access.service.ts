import { ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma, RoleName } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { defaultPermissionsForRole, PERMISSION_KEYS } from "./permission-catalog";
import { RequestUser } from "./interfaces/authenticated-request.interface";
import { PermissionsService } from "./permissions.service";

/** Roles that may approve their own requests when a tenant hasn't changed the setting. */
export const DEFAULT_SELF_APPROVAL_ROLE_KEYS = [RoleName.owner, RoleName.manager] as const;

export type ActorAccess = {
  userId: string;
  /** Permission keys granted at the active branch. Owners hold every key. */
  permissions: ReadonlySet<string>;
  /** `Role.key` of each role held at the branch — built-in names or custom-role slugs. */
  roleKeys: readonly string[];
  /** Whether one of those roles is in the tenant's "may approve their own requests" list. */
  canSelfApprove: boolean;
  has(permission: string): boolean;
};

/**
 * What the caller may do at the branch they are working in, for decisions a route guard can't
 * make alone — "may this person approve *this* document?" depends on who raised it.
 *
 * Services used to answer that with `roles.includes(RoleName.owner) || roles.includes(manager)`,
 * which ignored the configurable permission system: a custom role granted `transfers.approve`
 * still got a 403. Authority now comes from permissions, and the one role-shaped rule that
 * remains — who may approve their own requests — is a tenant setting, not code.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  /** Terminal trust changes cannot use the bounded-staleness user/role caches.
   * Read membership, token version, branch roles and grants on the caller's transaction.
   * This permission resolution never substitutes for device/attendance/clinical checks.
   */
  async resolveLive(user: RequestUser, branchId: string, tx: Prisma.TransactionClient): Promise<ActorAccess> {
    if (!Number.isSafeInteger(user.tokenVersion) || user.tokenVersion! < 0) throw new ForbiddenException("Live branch authentication required");
    return this.resolveCurrentAuthority(user, branchId, tx, user.tokenVersion);
  }

  /** Revalidate the actor of persisted approval evidence, not an incoming request.
   * An old approval needs current rights, not the approver's old access token.
   */
  async resolveApprovalAuthority(identity: Pick<RequestUser, "tenantId" | "userId">, branchId: string, tx: Prisma.TransactionClient): Promise<ActorAccess> {
    return this.resolveCurrentAuthority(identity, branchId, tx);
  }

  private async resolveCurrentAuthority(user: Pick<RequestUser, "tenantId" | "userId">, branchId: string, tx: Prisma.TransactionClient, expectedTokenVersion?: number): Promise<ActorAccess> {
    const account = await tx.appUser.findFirst({
      where: { id: user.userId, isActive: true, tenantMemberships: { some: { tenantId: user.tenantId, isActive: true } } },
      select: { tokenVersion: true },
    });
    const branch = await tx.branch.findFirst({ where: { id: branchId, tenantId: user.tenantId, isActive: true, tenant: { isActive: true } }, select: { id: true } });
    if (!account || !branch || (expectedTokenVersion !== undefined && expectedTokenVersion !== account.tokenVersion)) throw new ForbiddenException("Live branch authentication required");
    const roles = await tx.userBranchRole.findMany({
      where: { tenantId: user.tenantId, userId: user.userId },
      include: { roleRef: { include: { permissions: true } } },
    });
    const atBranch = roles.filter(role => role.branchId === branchId);
    if (!atBranch.length) throw new ForbiddenException("No current branch assignment");
    const isOwner = roles.some(role => role.role === RoleName.owner);
    const grants = new Set<string>(isOwner ? PERMISSION_KEYS : []);
    const roleKeys = new Set<string>(isOwner ? [RoleName.owner] : []);
    for (const role of atBranch) {
      if (role.roleRef && role.roleRef.tenantId !== user.tenantId) throw new ForbiddenException("Role tenant mismatch");
      roleKeys.add(role.roleRef?.key ?? role.role);
      for (const key of role.roleRef
        ? role.roleRef.permissions.filter(p => p.tenantId === user.tenantId).map(p => p.permissionKey)
        : defaultPermissionsForRole(role.role)) grants.add(key);
    }
    const settings = await tx.tenantSettings.findUnique({ where: { tenantId: user.tenantId }, select: { selfApprovalRoleKeys: true } });
    const selfApprovers = new Set<string>(settings?.selfApprovalRoleKeys ?? DEFAULT_SELF_APPROVAL_ROLE_KEYS);
    return { userId: user.userId, permissions: grants, roleKeys: [...roleKeys],
      canSelfApprove: [...roleKeys].some(key => selfApprovers.has(key)), has: key => grants.has(key) };
  }

  async resolve(user: RequestUser, branchId: string | undefined): Promise<ActorAccess> {
    const isOwner = user.branchRoles.some((entry) => entry.role === RoleName.owner);
    const atBranch = branchId
      ? user.branchRoles.filter((entry) => entry.branchId === branchId)
      : user.branchRoles;

    const permissions: ReadonlySet<string> = isOwner
      ? new Set(PERMISSION_KEYS)
      : await this.permissions.resolveGrantedKeys(atBranch);

    const roleKeys = new Set<string>();
    if (isOwner) roleKeys.add(RoleName.owner);
    const customRoleIds: string[] = [];
    for (const entry of atBranch) {
      if (entry.role === RoleName.custom) {
        if (entry.roleId) customRoleIds.push(entry.roleId);
      } else {
        roleKeys.add(entry.role);
      }
    }
    if (customRoleIds.length > 0) {
      const roles = await this.prisma.role.findMany({
        where: { tenantId: user.tenantId, id: { in: customRoleIds } },
        select: { key: true },
      });
      for (const role of roles) roleKeys.add(role.key);
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId: user.tenantId },
      select: { selfApprovalRoleKeys: true },
    });
    const selfApprovers = new Set<string>(
      settings?.selfApprovalRoleKeys ?? DEFAULT_SELF_APPROVAL_ROLE_KEYS,
    );

    return {
      userId: user.userId,
      permissions,
      roleKeys: [...roleKeys],
      canSelfApprove: [...roleKeys].some((key) => selfApprovers.has(key)),
      has: (permission: string) => permissions.has(permission),
    };
  }
}

/**
 * Refuse an approval when the approver raised the request and their role may not approve its
 * own. `raisedBy` lists everyone whose work is being approved (a stocktake's counters as well
 * as its creator).
 */
export function assertMayApprove(
  access: ActorAccess,
  raisedBy: ReadonlyArray<string | null | undefined>,
  what: string,
): void {
  if (access.canSelfApprove) return;
  if (raisedBy.some((id) => id === access.userId)) {
    throw new ForbiddenException(
      `You raised this ${what}, and your role can't approve its own requests. Ask another approver.`,
    );
  }
}
