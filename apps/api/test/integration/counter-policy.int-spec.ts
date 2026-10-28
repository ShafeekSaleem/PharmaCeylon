import { ConfigService } from "@nestjs/config";
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { defaultCounterPolicy } from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { CounterPolicyService } from "../../src/tenant/counter-policy.service";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
let fx: TenantFixture;
let owner: RequestUser;
let custom: RequestUser;
let roleId: string;
let service: CounterPolicyService;
const enabled = { ...defaultCounterPolicy(), offlineEnabled: true };

beforeAll(async () => {
  fx = await createTenant(prisma, "w7policy");
  await prisma.userBranchRole.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      userId: fx.ownerId,
      role: RoleName.owner,
    },
  });
  const role = await prisma.role.create({
    data: {
      tenantId: fx.tenantId,
      key: "counter_policy_editor",
      name: "Counter policy editor",
    },
  });
  roleId = role.id;
  await prisma.permission.upsert({
    where: { key: "tenant.management" },
    create: {
      key: "tenant.management",
      label: "Manage tenant",
      module: "tenant",
      description: "Manage tenant settings",
    },
    update: {},
  });
  await prisma.rolePermission.create({
    data: { tenantId: fx.tenantId, roleId, permissionKey: "tenant.management" },
  });
  await prisma.userBranchRole.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      userId: fx.clerkId,
      role: RoleName.custom,
      roleId,
    },
  });
  const ownerRow = await prisma.appUser.findUniqueOrThrow({
    where: { id: fx.ownerId },
  });
  const clerkRow = await prisma.appUser.findUniqueOrThrow({
    where: { id: fx.clerkId },
  });
  owner = {
    userId: fx.ownerId,
    tenantId: fx.tenantId,
    tokenVersion: ownerRow.tokenVersion,
    email: "owner@it.test",
    fullName: "Owner",
    authMethod: "cookie",
    branchRoles: [{ branchId: fx.mainBranchId, role: RoleName.owner }],
  };
  custom = {
    ...owner,
    userId: fx.clerkId,
    tokenVersion: clerkRow.tokenVersion,
    branchRoles: [{ branchId: fx.mainBranchId, role: RoleName.custom, roleId }],
  };
  const access = new AccessService(
    prisma as never,
    new PermissionsService(
      prisma as never,
      new ConfigService({ USER_CONTEXT_TTL_SECONDS: 0 }),
    ),
  );
  service = new CounterPolicyService(
    prisma as never,
    access,
    new AuditService(prisma as never),
  );
});
afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: { counterPolicy: defaultCounterPolicy(), counterPolicyVersion: 1 },
  });
  await prisma.rolePermission.upsert({
    where: {
      roleId_permissionKey: { roleId, permissionKey: "tenant.management" },
    },
    create: {
      tenantId: fx.tenantId,
      roleId,
      permissionKey: "tenant.management",
    },
    update: {},
  });
});

it("migrates safe defaults and lets an owner edit a branch without an assignment there", async () => {
  const initial = await service.get(owner, fx.otherBranchId);
  expect(initial.policy).toEqual(defaultCounterPolicy());
  expect(initial.version).toBe(1);
  const saved = await service.update(owner, fx.otherBranchId, {
    expectedVersion: 1,
    policy: enabled,
  });
  expect(saved.version).toBe(2);
  expect(saved.policy.offlineEnabled).toBe(true);
});

it("uses exact custom-role branch grants and refuses another tenant", async () => {
  await expect(
    service.update(custom, fx.otherBranchId, {
      expectedVersion: 1,
      policy: enabled,
    }),
  ).rejects.toBeInstanceOf(ForbiddenException);
  const other = await createTenant(prisma, "w7foreign");
  await expect(service.get(owner, other.mainBranchId)).rejects.toBeInstanceOf(
    NotFoundException,
  );
  await expect(
    service.update(owner, other.mainBranchId, {
      expectedVersion: 1,
      policy: enabled,
    }),
  ).rejects.toBeInstanceOf(NotFoundException);
  const saved = await service.update(custom, fx.mainBranchId, {
    expectedVersion: 1,
    policy: enabled,
  });
  expect(saved.version).toBe(2);
});

it("one of two concurrent edits wins; exactly one audit commits", async () => {
  const before = await prisma.auditEvent.count({
    where: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      eventName: "branch.counter_policy_updated",
    },
  });
  const results = await Promise.allSettled([
    service.update(custom, fx.mainBranchId, {
      expectedVersion: 1,
      policy: enabled,
    }),
    service.update(custom, fx.mainBranchId, {
      expectedVersion: 1,
      policy: enabled,
    }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(ConflictException);
  expect(
    await prisma.auditEvent.count({
      where: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        eventName: "branch.counter_policy_updated",
      },
    }),
  ).toBe(before + 1);
  expect((await service.get(custom, fx.mainBranchId)).version).toBe(2);
});

it("an audit failure rolls back the policy and version", async () => {
  const access = new AccessService(
    prisma as never,
    new PermissionsService(
      prisma as never,
      new ConfigService({ USER_CONTEXT_TTL_SECONDS: 0 }),
    ),
  );
  const failing = new CounterPolicyService(prisma as never, access, {
    log: async () => {
      throw new Error("audit failed");
    },
  } as never);
  await expect(
    failing.update(custom, fx.mainBranchId, {
      expectedVersion: 1,
      policy: enabled,
    }),
  ).rejects.toThrow("audit failed");
  const stored = await prisma.branch.findUniqueOrThrow({
    where: { id: fx.mainBranchId },
  });
  expect(stored.counterPolicyVersion).toBe(1);
  expect(stored.counterPolicy).toEqual(defaultCounterPolicy());
});

it("removed settings authority during a branch-lock wait rolls back the edit", async () => {
  let unlock!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const holder = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM branch WHERE id = ${fx.mainBranchId}::uuid FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 20000 },
  );
  await acquired;
  const pending = service.update(custom, fx.mainBranchId, {
    expectedVersion: 1,
    policy: enabled,
  });
  // Attach immediately so an unexpected early refusal is handled while the lock holder exits.
  const outcome = pending.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%counter_policy%'`;
      if (Number(rows[0]?.count) > 0) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
    await prisma.rolePermission.deleteMany({
      where: {
        tenantId: fx.tenantId,
        roleId,
        permissionKey: "tenant.management",
      },
    });
  } finally {
    unlock();
    await holder;
  }
  expect((await outcome).error).toBeInstanceOf(ForbiddenException);
  const stored = await prisma.branch.findUniqueOrThrow({
    where: { id: fx.mainBranchId },
  });
  expect(stored.counterPolicyVersion).toBe(1);
  expect(stored.counterPolicy).toEqual(defaultCounterPolicy());
});
