import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import {
  COUNTER_OFFLINE_RULES,
  OFFLINE_MANAGER_PERMISSIONS,
  effectiveDefaultPaymentMethod,
  type CounterGrantSettings,
  type OfflineManagerAction,
} from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import { PermissionsService } from "../security/permissions.service";
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
    private readonly permissions: PermissionsService,
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
    const [hours, tenantSettings, offlineManagers] = await Promise.all([
      this.hours.getHours(tenantId, branch.id),
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { posDefaultPaymentMethod: true },
      }),
      this.offlineManagers(tenantId, branch.id),
    ]);
    return {
      branchId: branch.id,
      timezone: hours.timezone,
      sourceVersions: { counterPolicy: branch.counterPolicyVersion, operatingHours: hours.version },
      fixedRules: COUNTER_OFFLINE_RULES,
      offlineEnabled: policy.offlineEnabled,
      externalCardAllowed: policy.offlineEnabled && policy.offlineExternalCardEnabled,
      externalCardMerchants: policy.externalCardMerchants,
      onlinePaymentMethods: policy.onlinePaymentMethods,
      // No settings row yet means the schema default, cash.
      defaultPaymentMethod: effectiveDefaultPaymentMethod(
        tenantSettings?.posDefaultPaymentMethod ?? "cash",
        policy.onlinePaymentMethods,
      ),
      registerNumbering: policy.registerNumbering,
      hours: hours.hours,
      extensions: hours.extensions,
      offlineManagers,
    };
  }

  /** Staff assigned at the branch whose roles hold an offline manager permission there, plus the
   * tenant's owners, who hold every permission at every branch (as in `AccessService`). */
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
        roleId: true,
        user: { select: { fullName: true } },
        roleRef: { select: { tenantId: true } },
      },
    });
    const byUser = new Map<
      string,
      { name: string; owner: boolean; candidates: { role: RoleName; roleId: string | null }[] }
    >();
    for (const row of assignments) {
      const entry = byUser.get(row.userId) ?? { name: row.user.fullName, owner: false, candidates: [] };
      byUser.set(row.userId, entry);
      if (row.role === RoleName.owner) entry.owner = true;
      // Only this branch's roles count, and never a role row belonging to another tenant.
      if (row.branchId !== branchId) continue;
      if (row.roleId && row.roleRef?.tenantId !== tenantId) continue;
      entry.candidates.push({ role: row.role, roleId: row.roleId });
    }
    const staff = await Promise.all(
      [...byUser.entries()].map(async ([userId, entry]) => {
        const keys = entry.owner
          ? null
          : await this.permissions.resolveGrantedKeys(entry.candidates);
        return {
          userId,
          name: entry.name,
          offlineManagerActions: ACTIONS.filter(([, key]) => !keys || keys.has(key)).map(
            ([action]) => action,
          ),
        };
      }),
    );
    return staff
      .filter((s) => s.offlineManagerActions.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  }
}
