import { ForbiddenException, NotFoundException } from "@nestjs/common";
import {
  COUNTER_OFFLINE_RULES,
  defaultCounterPolicy,
  type OfflineGrant,
} from "@pharmaceylon/shared";
import { CounterGrantSettingsController } from "./counter-policy.controller";
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
            user: { fullName: "Asha" },
            roleRef: { tenantId: "tenant-1", permissions: perms("sales.offline_hours_acknowledge") },
          },
          // An owner assigned at another branch holds every action here too.
          { userId: "u-owner", branchId: "other", role: "owner", user: { fullName: "Owner" }, roleRef: null },
          // A cashier holds neither, so isn't listed.
          {
            userId: "u-cashier",
            branchId,
            role: "cashier",
            user: { fullName: "Cashier" },
            roleRef: { tenantId: "tenant-1", permissions: perms("sales.pos_use") },
          },
          // A legacy built-in row without roleId falls back to the catalog defaults.
          { userId: "u-manager", branchId, role: "manager", user: { fullName: "Mala" }, roleRef: null },
          // A role row from another tenant grants nothing.
          {
            userId: "u-foreign",
            branchId,
            role: "custom",
            user: { fullName: "Zed" },
            roleRef: { tenantId: "tenant-2", permissions: perms("sales.offline_hours_acknowledge") },
          },
        ]),
      },
    };
    access = {
      resolve: jest.fn().mockResolvedValue({ has: (k: string) => k === "tenant.management" }),
    };
    hours = { getHours: jest.fn().mockResolvedValue(hoursView) };
    service = new CounterGrantSettingsService(prisma, access, hours);
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
