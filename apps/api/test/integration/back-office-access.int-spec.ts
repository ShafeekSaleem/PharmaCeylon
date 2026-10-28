import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { RolesAdminService } from "../../src/admin/roles-admin.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { TenantController } from "../../src/tenant/tenant.controller";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
let fx: TenantFixture;
let other: TenantFixture;
const config = { get: () => 0 } as unknown as ConfigService;
const permissions = new PermissionsService(prisma as never, config);
const roles = new RolesAdminService(
  prisma as never,
  { log: async () => {} } as never,
  permissions,
  { notifyByPermission: async () => {} } as never,
);

beforeAll(async () => {
  fx = await createTenant(prisma, "web-scope");
  other = await createTenant(prisma, "other-web-scope");
  await ensureRbacSeed(prisma);
});
afterAll(async () => prisma.$disconnect());

it("seeds cashier web scope off without removing cashier API grants and preserves edits on reseed", async () => {
  const cashier = await prisma.role.findUniqueOrThrow({
    where: { tenantId_key: { tenantId: fx.tenantId, key: "cashier" } },
  });
  expect(cashier.backOfficeAccess).toBe(false);
  const before = await permissions.getPermissionsForRole(cashier.id);
  expect(before.has("sales.pos_use")).toBe(true);
  await roles.updateRolePermissions(fx.tenantId, fx.ownerId, cashier.id, {
    permissionKeys: [...before],
    backOfficeAccess: true,
  });
  await ensureRbacSeed(prisma);
  expect(
    (await prisma.role.findUniqueOrThrow({ where: { id: cashier.id } })).backOfficeAccess,
  ).toBe(true);
  expect(await permissions.getPermissionsForRole(cashier.id)).toEqual(before);
});

it("edits a custom role's web scope independently, keeps tenant boundaries and refuses owner lockout", async () => {
  const custom = await roles.createRole(fx.tenantId, fx.ownerId, {
    name: "Counter operator",
    permissionKeys: ["sales.pos_use", "inventory.view"],
    backOfficeAccess: false,
  });
  expect(
    await permissions.resolveBackOfficeAccess(other.tenantId, [
      { role: RoleName.custom, roleId: custom.id },
    ]),
  ).toBe(false);
  await expect(
    roles.updateRolePermissions(other.tenantId, other.ownerId, custom.id, {
      permissionKeys: [],
      backOfficeAccess: true,
    }),
  ).rejects.toThrow("Role not found");
  await roles.updateRolePermissions(fx.tenantId, fx.ownerId, custom.id, {
    permissionKeys: custom.permissionKeys,
    backOfficeAccess: true,
  });
  expect(
    await permissions.resolveBackOfficeAccess(fx.tenantId, [
      { role: RoleName.custom, roleId: custom.id },
    ]),
  ).toBe(true);
  const owner = await prisma.role.findUniqueOrThrow({
    where: { tenantId_key: { tenantId: fx.tenantId, key: "owner" } },
  });
  await expect(
    roles.updateRolePermissions(fx.tenantId, fx.ownerId, owner.id, {
      permissionKeys: [],
      backOfficeAccess: false,
    }),
  ).rejects.toThrow(/owner role/);
  await expect(
    prisma.role.update({
      where: { id: owner.id },
      data: { backOfficeAccess: false },
    }),
  ).rejects.toThrow();
});

it("returns web scope for only the selected branch while preserving the role's operational grants", async () => {
  const denied = await roles.createRole(fx.tenantId, fx.ownerId, {
    name: "Till",
    permissionKeys: ["sales.pos_use"],
    backOfficeAccess: false,
  });
  const allowed = await roles.createRole(fx.tenantId, fx.ownerId, {
    name: "Office",
    permissionKeys: ["inventory.view"],
    backOfficeAccess: true,
  });
  const controller = new TenantController(
    prisma as never,
    permissions,
    {} as never,
    { resolve: async () => ({ canSelfApprove: false }) } as never,
  );
  const user = {
    tenantId: fx.tenantId,
    userId: fx.clerkId,
    branchRoles: [
      { branchId: fx.mainBranchId, role: RoleName.custom, roleId: denied.id },
      { branchId: fx.otherBranchId, role: RoleName.custom, roleId: allowed.id },
    ],
  } as never;
  expect(
    await controller.myPermissions(user, {
      branchId: fx.mainBranchId,
    } as never),
  ).toMatchObject({
    backOfficeAccess: false,
    permissionKeys: ["sales.pos_use"],
  });
  expect(
    await controller.myPermissions(user, {
      branchId: fx.otherBranchId,
    } as never),
  ).toMatchObject({
    backOfficeAccess: true,
    permissionKeys: ["inventory.view"],
  });
});
