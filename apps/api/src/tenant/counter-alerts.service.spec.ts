import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  ValidationPipe,
} from "@nestjs/common";
import { defaultCounterAlertPolicy } from "@pharmaceylon/shared";
import { CounterAlertsController } from "./counter-alerts.controller";
import { CounterAlertsService } from "./counter-alerts.service";
import { UpdateCounterAlertsDto } from "./dto/counter-alerts.dto";

const user = { userId: "user-1", tenantId: "tenant-1", branchRoles: [] } as never;
const withRecipients = (keys: string[]) => {
  const policy = defaultCounterAlertPolicy();
  policy.rules[0] = { ...policy.rules[0], recipientRoleKeys: keys };
  return policy;
};

describe("counter alert settings", () => {
  let prisma: any;
  let audit: any;
  let service: CounterAlertsService;
  beforeEach(() => {
    prisma = {
      tenantSettings: {
        upsert: jest.fn().mockResolvedValue({
          id: "settings-1",
          counterAlertPolicy: null,
          counterAlertPolicyVersion: 3,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      role: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new CounterAlertsService(prisma, audit);
  });

  it("reads the tenant's defaults with their version", async () => {
    expect(await service.get("tenant-1")).toEqual({
      version: 3,
      policy: defaultCounterAlertPolicy(),
    });
    expect(prisma.tenantSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tenant-1" } }),
    );
  });

  it("fails closed on a stored document it can't read", async () => {
    prisma.tenantSettings.upsert.mockResolvedValue({
      counterAlertPolicy: { schemaVersion: 1, rules: [] },
      counterAlertPolicyVersion: 2,
    });
    await expect(service.get("tenant-1")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("saves conditionally on the loaded version and audits in the same transaction", async () => {
    await service.update(user, { expectedVersion: 3, policy: defaultCounterAlertPolicy() });
    expect(prisma.tenantSettings.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", counterAlertPolicyVersion: 3 },
      data: {
        counterAlertPolicy: defaultCounterAlertPolicy(),
        counterAlertPolicyVersion: { increment: 1 },
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        eventName: "tenant_settings.counter_alerts_updated",
        entityId: "settings-1",
      }),
      prisma,
    );
    // Built-in roles need no lookup.
    expect(prisma.role.findMany).not.toHaveBeenCalled();
  });

  it("refuses stale versions without an audit", async () => {
    prisma.tenantSettings.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(user, { expectedVersion: 1, policy: defaultCounterAlertPolicy() }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("accepts this tenant's custom roles and refuses unknown ones", async () => {
    prisma.role.findMany.mockResolvedValue([{ key: "shift-lead" }]);
    await service.update(user, {
      expectedVersion: 3,
      policy: withRecipients(["owner", "shift-lead"]),
    });
    expect(prisma.role.findMany).toHaveBeenCalledWith({
      where: { tenantId: "tenant-1", key: { in: ["shift-lead"] } },
      select: { key: true },
    });
    prisma.role.findMany.mockResolvedValue([]);
    prisma.tenantSettings.updateMany.mockClear();
    await expect(
      service.update(user, { expectedVersion: 3, policy: withRecipients(["ghost"]) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tenantSettings.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an alert switched on with nobody to receive it", async () => {
    await expect(
      service.update(user, { expectedVersion: 3, policy: withRecipients([]) }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires tenant.management and a whole-number version", async () => {
    for (const method of ["get", "update"] as const) {
      expect(Reflect.getMetadata("permissions", CounterAlertsController.prototype[method])).toEqual(
        ["tenant.management"],
      );
    }
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    for (const input of [
      { expectedVersion: 0, policy: {} },
      { expectedVersion: 1, policy: {}, tenantId: "other" },
    ]) {
      await expect(
        pipe.transform(input, { type: "body", metatype: UpdateCounterAlertsDto }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
