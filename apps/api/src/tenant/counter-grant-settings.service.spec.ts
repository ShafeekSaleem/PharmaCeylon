import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  COUNTER_OFFLINE_RULES,
  defaultCounterPolicy,
  type OfflineGrant,
} from "@pharmaceylon/shared";
import { CounterGrantSettingsController } from "./counter-policy.controller";
import { PermissionsService } from "../security/permissions.service";
import { CounterGrantSettingsService } from "./counter-grant-settings.service";

const branchId = "11111111-1111-4111-8111-111111111111";
const user = {
  userId: "user-1",
  tenantId: "tenant-1",
  tokenVersion: 1,
  branchRoles: [{ branchId, role: "manager", roleId: "role-m" }],
} as never;
const hoursView = {
  branchId,
  branchName: "Colombo",
  timezone: "Asia/Colombo",
  version: 4,
  hours: { schemaVersion: 1, weekly: {}, exceptions: [], mandatory: null },
  origin: "editor",
  updatedAt: null,
  updatedBy: null,
  legacyText: null,
  extensions: [],
};
const perms = (...keys: string[]) =>
  keys.map((permissionKey) => ({ tenantId: "tenant-1", permissionKey }));

describe("counter grant settings source", () => {
  let prisma: any;
  let access: any;
  let hours: any;
  let service: CounterGrantSettingsService;
  beforeEach(() => {
    prisma = {
      branch: {
        findFirst: jest.fn().mockResolvedValue({
          id: branchId,
          counterPolicyVersion: 7,
          counterPolicy: {
            ...defaultCounterPolicy(),
            offlineEnabled: true,
            offlineExternalCardEnabled: true,
            externalCardMerchants: [{ provider: "Bank", merchantId: "M1" }],
          },
        }),
      },
      userBranchRole: {
        findMany: jest.fn().mockResolvedValue([
          // A custom role holding only the after-hours acknowledgement.
          {
            userId: "u-custom",
            branchId,
            role: "custom",
            roleId: "role-custom",
            user: { fullName: "Asha" },
            roleRef: { tenantId: "tenant-1" },
          },
          // An owner assigned at another branch holds every action here too.
          {
            userId: "u-owner",
            branchId: "other",
            role: "owner",
            roleId: null,
            user: { fullName: "Owner" },
            roleRef: null,
          },
          // A cashier holds neither, so isn't listed.
          {
            userId: "u-cashier",
            branchId,
            role: "cashier",
            roleId: "role-cashier",
            user: { fullName: "Cashier" },
            roleRef: { tenantId: "tenant-1" },
          },
          // A legacy built-in row without roleId falls back to the catalog defaults.
          {
            userId: "u-manager",
            branchId,
            role: "manager",
            roleId: null,
            user: { fullName: "Mala" },
            roleRef: null,
          },
          // A role row from another tenant grants nothing, whatever it holds.
          {
            userId: "u-foreign",
            branchId,
            role: "custom",
            roleId: "role-foreign",
            user: { fullName: "Zed" },
            roleRef: { tenantId: "tenant-2" },
          },
        ]),
      },
      rolePermission: {
        findMany: jest.fn().mockImplementation(({ where }: { where: { roleId: string } }) =>
          Promise.resolve(
            ({
              "role-custom": perms("sales.offline_hours_acknowledge"),
              "role-cashier": perms("sales.pos_use"),
              "role-foreign": perms("sales.offline_hours_acknowledge"),
            } as Record<string, unknown[]>)[where.roleId] ?? [],
          ),
        ),
      },
      tenantSettings: {
        findUnique: jest.fn().mockResolvedValue({ posDefaultPaymentMethod: "split" }),
      },
    };
    access = {
      resolve: jest.fn().mockResolvedValue({ has: (k: string) => k === "tenant.management" }),
    };
    hours = { getHours: jest.fn().mockResolvedValue(hoursView) };
    const permissions = new PermissionsService(
      prisma,
      new ConfigService({ USER_CONTEXT_TTL_SECONDS: 0 }),
    );
    service = new CounterGrantSettingsService(prisma, access, permissions, hours);
  });

  it("gives P3 every settings-derived grant field, with the versions to re-issue on", async () => {
    const settings = await service.forBranch(user, branchId);
    expect(settings).toMatchObject({
      branchId,
      timezone: "Asia/Colombo",
      sourceVersions: { counterPolicy: 7, operatingHours: 4 },
      fixedRules: COUNTER_OFFLINE_RULES,
      offlineEnabled: true,
      externalCardAllowed: true,
      externalCardMerchants: [{ provider: "Bank", merchantId: "M1" }],
      hours: hoursView.hours,
      extensions: [],
      // Every online method is on by default, so the tenant's split default stands.
      defaultPaymentMethod: "split",
    });
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalledWith({
      where: { roleId: "role-foreign" },
      select: { permissionKey: true },
    });
    expect(settings.offlineManagers).toEqual([
      { userId: "u-custom", name: "Asha", offlineManagerActions: ["acknowledge_business_hours"] },
      {
        userId: "u-manager",
        name: "Mala",
        offlineManagerActions: ["acknowledge_business_hours", "assist_shift_handover"],
      },
      {
        userId: "u-owner",
        name: "Owner",
        offlineManagerActions: ["acknowledge_business_hours", "assist_shift_handover"],
      },
    ]);

    // Every OfflineGrant field comes either from these settings or from nomination, enrollment
    // and issuance, which P3 owns. A new grant field fails this until someone places it.
    const fromSettings = {
      externalCardAllowed: settings.externalCardAllowed,
      policyVersion: settings.sourceVersions.counterPolicy,
      maxSnapshotAgeAtOutageMs: settings.fixedRules.snapshotFreshnessMinutes * 60_000,
      operatingWindows: settings.hours?.weekly,
      mandatoryOperatingWindows: settings.hours?.mandatory,
      operatingHoursException: settings.extensions,
      authorizedStaff: settings.offlineManagers,
    } satisfies Partial<Record<keyof OfflineGrant, unknown>>;
    const fromIssuance: Array<keyof OfflineGrant> = [
      "contractVersion",
      "kind",
      "identity",
      "registerId",
      "tillId",
      "grantId",
      "grantVersion",
      "nominationVersion",
      "issuedAt",
      "notBefore",
      "expiresAt",
      "currency",
    ];
    type Covered = keyof typeof fromSettings | (typeof fromIssuance)[number];
    const everyField: Record<Exclude<keyof OfflineGrant, Covered>, never> = {};
    expect(everyField).toEqual({});
    expect(fromSettings.maxSnapshotAgeAtOutageMs).toBe(15 * 60_000);
  });

  it("starts counters on cash where the branch doesn't take what the tenant default needs", async () => {
    prisma.branch.findFirst.mockResolvedValue({
      id: branchId,
      counterPolicyVersion: 2,
      counterPolicy: { ...defaultCounterPolicy(), onlinePaymentMethods: ["mobile_wallet"] },
    });
    expect((await service.forBranch(user, branchId)).defaultPaymentMethod).toBe("cash");
    prisma.tenantSettings.findUnique.mockResolvedValue(null);
    prisma.branch.findFirst.mockResolvedValue({ id: branchId, counterPolicyVersion: 1, counterPolicy: null });
    expect((await service.forBranch(user, branchId)).defaultPaymentMethod).toBe("cash");
  });

  it("never allows external card offline when offline selling is off", async () => {
    prisma.branch.findFirst.mockResolvedValue({
      id: branchId,
      counterPolicyVersion: 1,
      counterPolicy: null,
    });
    const settings = await service.forBranch(user, branchId);
    expect(settings.offlineEnabled).toBe(false);
    expect(settings.externalCardAllowed).toBe(false);
  });

  it("is scoped to an active branch of the caller's tenant and needs settings access there", async () => {
    await service.forBranch(user, branchId);
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: branchId, tenantId: "tenant-1", isActive: true } }),
    );
    expect(prisma.userBranchRole.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }),
    );
    expect(access.resolve).toHaveBeenCalledWith(user, branchId);
    access.resolve.mockResolvedValue({ has: () => false });
    await expect(service.forBranch(user, branchId)).rejects.toBeInstanceOf(ForbiddenException);
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(service.forBranch(user, branchId)).rejects.toBeInstanceOf(NotFoundException);
    expect(
      Reflect.getMetadata("permissions", CounterGrantSettingsController.prototype.get),
    ).toEqual(["tenant.management"]);
  });
});
