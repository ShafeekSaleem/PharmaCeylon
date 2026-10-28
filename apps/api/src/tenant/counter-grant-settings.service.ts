import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import {
  COUNTER_OFFLINE_RULES,
  OFFLINE_MANAGER_PERMISSIONS,
  type CounterGrantSettings,
  type OfflineManagerAction,
} from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import { defaultPermissionsForRole } from "../security/permission-catalog";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { BranchHoursService } from "./branch-hours.service";
import { storedPolicy } from "./counter-policy.service";

const ACTIONS = Object.entries(OFFLINE_MANAGER_PERMISSIONS) as [OfflineManagerAction, string][];

/**
 * W7 acceptance: everything settings contribute to an offline grant, read from settings alone.
 * Read-only — it neither issues nor signs anything (P3 #49 does), and it is not consumed by any
 * counter yet. Each source keeps its own version so P3 knows when to re-issue.
 */
@Injectable()
export class CounterGrantSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly hours: BranchHoursService,
  ) {}

  async forBranch(user: RequestUser, branchId: string): Promise<CounterGrantSettings> {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId: user.tenantId, isActive: true },
      select: { id: true, counterPolicy: true, counterPolicyVersion: true },
    });
    if (!branch) throw new NotFoundException("Branch not found.");
    const actor = await this.access.resolve(user, branchId);
    if (!actor.has("tenant.management"))
      throw new ForbiddenException("Counter settings require settings access at this branch.");
    return this.build(user.tenantId, branch);
  }

  private async build(
    tenantId: string,
    branch: { id: string; counterPolicy: unknown; counterPolicyVersion: number },
  ): Promise<CounterGrantSettings> {
    const policy = storedPolicy(branch.counterPolicy as never);
    const hours = await this.hours.getHours(tenantId, branch.id);
    return {
      branchId: branch.id,
      timezone: hours.timezone,
      sourceVersions: { counterPolicy: branch.counterPolicyVersion, operatingHours: hours.version },
      fixedRules: COUNTER_OFFLINE_RULES,
      offlineEnabled: policy.offlineEnabled,
      externalCardAllowed: policy.offlineEnabled && policy.offlineExternalCardEnabled,
      externalCardMerchants: policy.externalCardMerchants,
      onlinePaymentMethods: policy.onlinePaymentMethods,
      registerNumbering: policy.registerNumbering,
      hours: hours.hours,
      extensions: hours.extensions,
      offlineManagers: await this.offlineManagers(tenantId, branch.id),
    };
  }

  /** Staff assigned at the branch whose roles hold an offline manager permission there, plus the
   * tenant's owners, who hold every permission at every branch. */
  private async offlineManagers(tenantId: string, branchId: string) {
    const assignments = await this.prisma.userBranchRole.findMany({
      where: {
        tenantId,
        OR: [{ branchId }, { role: RoleName.owner }],
        user: { isActive: true, tenantMemberships: { some: { tenantId, isActive: true } } },
      },
      select: {
        userId: true,
        branchId: true,
        role: true,
        user: { select: { fullName: true } },
        roleRef: { select: { tenantId: true, permissions: { select: { tenantId: true, permissionKey: true } } } },
      },
    });
    const byUser = new Map<string, { name: string; keys: Set<string>; owner: boolean }>();
    for (const row of assignments) {
      const entry = byUser.get(row.userId) ?? { name: row.user.fullName, keys: new Set(), owner: false };
      byUser.set(row.userId, entry);
      if (row.role === RoleName.owner) entry.owner = true;
      if (row.branchId !== branchId) continue;
      const keys = row.roleRef
        ? row.roleRef.tenantId === tenantId
          ? row.roleRef.permissions.filter((p) => p.tenantId === tenantId).map((p) => p.permissionKey)
          : []
        : defaultPermissionsForRole(row.role);
      for (const key of keys) entry.keys.add(key);
    }
    return [...byUser.entries()]
      .map(([userId, entry]) => ({
        userId,
        name: entry.name,
        offlineManagerActions: ACTIONS.filter(([, key]) => entry.owner || entry.keys.has(key)).map(
          ([action]) => action,
        ),
      }))
      .filter((staff) => staff.offlineManagerActions.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  }
}
