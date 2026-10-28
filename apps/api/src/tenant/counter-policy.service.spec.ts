import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { defaultCounterPolicy } from "@pharmaceylon/shared";
import { CounterPolicyService } from "./counter-policy.service";
import { CounterPolicyController } from "./counter-policy.controller";
import { UpdateCounterPolicyDto } from "./dto/counter-policy.dto";

const branchId = "11111111-1111-4111-8111-111111111111";
const user = {
  userId: "user-1",
  tenantId: "tenant-1",
  tokenVersion: 1,
  branchRoles: [{ branchId, role: "custom", roleId: "role-1" }],
} as never;
const grant = {
  has: (key: string) => key === "tenant.management",
  roleKeys: ["custom"],
};
const row = {
  id: branchId,
  name: "Colombo",
  counterPolicy: null,
  counterPolicyVersion: 1,
};

describe("branch counter policy settings", () => {
  let prisma: any;
  let access: any;
  let audit: any;
  let service: CounterPolicyService;
  beforeEach(() => {
    prisma = {
      branch: {
        findFirst: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((fn: any) => fn(prisma));
    access = {
      resolve: jest.fn().mockResolvedValue(grant),
      resolveLive: jest.fn().mockResolvedValue(grant),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new CounterPolicyService(prisma, access, audit);
  });

  it("returns safe defaults and scopes reads to the tenant and active target branch", async () => {
    expect(await service.get(user, branchId)).toMatchObject({
      policy: defaultCounterPolicy(),
      version: 1,
    });
    expect(prisma.branch.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: branchId, tenantId: "tenant-1", isActive: true },
      }),
    );
    expect(access.resolve).toHaveBeenCalledWith(user, branchId);
  });
  it("refuses missing/cross-tenant branches", async () => {
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(service.get(user, branchId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.update(user, branchId, {
        expectedVersion: 1,
        policy: defaultCounterPolicy(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.branch.updateMany).not.toHaveBeenCalled();
  });
  it("refuses reads without target-branch settings access", async () => {
    access.resolve.mockResolvedValue({ has: () => false });
    await expect(service.get(user, branchId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
  it("uses live custom-role authority and atomically versions and audits the edit", async () => {
    await service.update(user, branchId, {
      expectedVersion: 1,
      policy: { ...defaultCounterPolicy(), offlineEnabled: true },
    });
    expect(access.resolveLive).toHaveBeenCalledTimes(2);
    expect(prisma.branch.updateMany).toHaveBeenCalledWith({
      where: {
        id: branchId,
        tenantId: "tenant-1",
        isActive: true,
        counterPolicyVersion: 1,
      },
      data: {
        counterPolicy: { ...defaultCounterPolicy(), offlineEnabled: true },
        counterPolicyVersion: { increment: 1 },
      },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        branchId,
        actorUserId: "user-1",
        eventName: "branch.counter_policy_updated",
      }),
      prisma,
    );
  });
  it("rejects stale versions without writing an audit", async () => {
    prisma.branch.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.update(user, branchId, {
        expectedVersion: 1,
        policy: defaultCounterPolicy(),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log).not.toHaveBeenCalled();
  });
  it("rechecks removed authority after the row-lock wait", async () => {
    access.resolveLive
      .mockResolvedValueOnce(grant)
      .mockResolvedValueOnce({ has: () => false, roleKeys: [] });
    await expect(
      service.update(user, branchId, {
        expectedVersion: 1,
        policy: defaultCounterPolicy(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.log).not.toHaveBeenCalled();
  });
  it("allows an owner to manage another branch only with a live owner role", async () => {
    const owner = {
      ...(user as any),
      branchRoles: [{ branchId: "owner-home", role: "owner" }],
    };
    access.resolveLive.mockResolvedValue({ ...grant, roleKeys: ["owner"] });
    await service.update(owner, branchId, {
      expectedVersion: 1,
      policy: defaultCounterPolicy(),
    });
    expect(access.resolveLive).toHaveBeenCalledWith(
      owner,
      "owner-home",
      prisma,
    );
    access.resolveLive.mockResolvedValue(grant);
    await expect(
      service.update(owner, branchId, {
        expectedVersion: 1,
        policy: defaultCounterPolicy(),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("refuses invented policy values before opening a transaction", async () => {
    await expect(
      service.update(user, branchId, {
        expectedVersion: 1,
        policy: { ...defaultCounterPolicy(), permissionHours: 72 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("propagates audit failure so the transaction cannot commit a successful edit", async () => {
    audit.log.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      service.update(user, branchId, {
        expectedVersion: 1,
        policy: defaultCounterPolicy(),
      }),
    ).rejects.toThrow("audit unavailable");
  });
  it("validates version and rejects unknown top-level request fields", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    for (const input of [
      { expectedVersion: 0, policy: {} },
      { expectedVersion: 1.5, policy: {} },
      { expectedVersion: 1, policy: {}, branchId: "other" },
    ]) {
      await expect(
        pipe.transform(input, {
          type: "body",
          metatype: UpdateCounterPolicyDto,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(
      Reflect.getMetadata(
        "permissions",
        CounterPolicyController.prototype.update,
      ),
    ).toEqual(["tenant.management"]);
  });
});
