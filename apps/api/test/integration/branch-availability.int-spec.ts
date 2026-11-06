import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { RolesAdminService } from "../../src/admin/roles-admin.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { PermissionsService } from "../../src/security/permissions.service";
import {
  createPrisma,
  createStockedBatch,
  createTenant,
  type TenantFixture,
} from "./fixtures";

/**
 * The counter's Other branches (#103, decided 2026-11-05): every other active branch of the
 * tenant as In stock, Low or Out, with no quantities, and Ask the pharmacist for a controlled
 * product. Behind its own permission, granted to the counter roles by default.
 */
const KEY = "inventory.view_other_branches_availability";
const prisma = createPrisma();
const stock = new StockService();
const inventory = new InventoryService(
  prisma as never,
  { log: async () => {} } as never,
  stock,
  new StockReadService(prisma as never),
);
const permissions = new PermissionsService(prisma as never, { get: () => 0 } as unknown as ConfigService);
const roles = new RolesAdminService(
  prisma as never,
  { log: async () => {} } as never,
  permissions,
  { notifyByPermission: async () => {} } as never,
);

let fx: TenantFixture;
let other: TenantFixture;
let kandyId: string;
let jaffnaId: string;
let closedId: string;

beforeAll(async () => {
  fx = await createTenant(prisma, "branch-availability");
  other = await createTenant(prisma, "branch-availability-other");
  await ensureRbacSeed(prisma);
  await prisma.product.update({ where: { id: fx.productId }, data: { reorderLevel: 10 } });
  const [kandy, jaffna, closed] = await Promise.all(
    [
      { code: "KANDY", isActive: true },
      { code: "JAFFNA", isActive: true },
      { code: "CLOSED", isActive: false },
    ].map(({ code, isActive }) =>
      prisma.branch.create({
        data: { tenantId: fx.tenantId, code, name: `${code} branch`, timezone: "Asia/Colombo", isActive },
      }),
    ),
  );
  kandyId = kandy!.id;
  jaffnaId = jaffna!.id;
  closedId = closed!.id;
  // This branch: plenty. Galle: above the reorder level. Kandy: at it (low), plus an expired
  // batch that must not count. Jaffna: nothing. The closed branch has stock but isn't listed.
  await createStockedBatch(prisma, stock, fx, { qty: 50 });
  await createStockedBatch(prisma, stock, fx, { qty: 25, branchId: fx.otherBranchId });
  await createStockedBatch(prisma, stock, fx, { qty: 10, branchId: kandyId });
  await createStockedBatch(prisma, stock, fx, { qty: 90, branchId: kandyId, expiryInDays: -5 });
  await createStockedBatch(prisma, stock, fx, { qty: 40, branchId: closedId });
});
afterAll(async () => prisma.$disconnect());

it("bands every other active branch of the tenant by what it can sell", async () => {
  const result = await inventory.otherBranchAvailability(fx.tenantId, fx.mainBranchId, fx.productId);
  expect(result.controlled).toBe(false);
  const bands = Object.fromEntries(result.branches.map((b) => [b.branchId, b.band]));
  expect(bands).toEqual({
    [fx.otherBranchId]: "in_stock",
    [kandyId]: "low",
    [jaffnaId]: "out",
  });
  // Not this branch, not an inactive one, not another tenant's.
  expect(bands[fx.mainBranchId]).toBeUndefined();
  expect(bands[closedId]).toBeUndefined();
  expect(bands[other.mainBranchId]).toBeUndefined();
});

it("sends no quantities, costs or batches", async () => {
  const result = await inventory.otherBranchAvailability(fx.tenantId, fx.mainBranchId, fx.productId);
  for (const branch of result.branches)
    expect(Object.keys(branch).sort()).toEqual(["band", "branchId", "name"]);
  expect(Object.keys(result).sort()).toEqual(["branches", "controlled", "productId"]);
  const text = JSON.stringify(result);
  for (const qty of ["25", "10", "90", "40", "50"]) expect(text).not.toMatch(new RegExp(`:${qty}\\b`));
});

it("says Ask the pharmacist for every branch of a controlled product", async () => {
  await prisma.product.update({ where: { id: fx.productId }, data: { isControlled: true } });
  try {
    const result = await inventory.otherBranchAvailability(fx.tenantId, fx.mainBranchId, fx.productId);
    expect(result.controlled).toBe(true);
    expect(result.branches).toHaveLength(3);
    expect(result.branches.every((b) => b.band === "ask_pharmacist")).toBe(true);
  } finally {
    await prisma.product.update({ where: { id: fx.productId }, data: { isControlled: false } });
  }
});

it("refuses another tenant's product", async () => {
  await expect(
    inventory.otherBranchAvailability(other.tenantId, other.mainBranchId, fx.productId),
  ).rejects.toBeInstanceOf(NotFoundException);
});

describe("the permission", () => {
  const roleOf = (key: string) =>
    prisma.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: fx.tenantId, key } } });

  it("is on for the counter roles and off for the inventory clerk by default", async () => {
    for (const key of ["owner", "manager", "pharmacist", "cashier"])
      expect((await permissions.getPermissionsForRole((await roleOf(key)).id)).has(KEY)).toBe(true);
    expect((await permissions.getPermissionsForRole((await roleOf("inventory_clerk")).id)).has(KEY)).toBe(
      false,
    );
  });

  it("can be switched off for a role, and the role then doesn't pass the route's check", async () => {
    const cashier = await roleOf("cashier");
    const before = await permissions.getPermissionsForRole(cashier.id);
    await roles.updateRolePermissions(fx.tenantId, fx.ownerId, cashier.id, {
      permissionKeys: [...before].filter((key) => key !== KEY),
    });
    expect(
      await permissions.hasAnyPermission([{ role: RoleName.cashier, roleId: cashier.id }], [KEY]),
    ).toBe(false);
    // Still sees its own branch's stock.
    expect(
      await permissions.hasAnyPermission([{ role: RoleName.cashier, roleId: cashier.id }], ["inventory.view"]),
    ).toBe(true);
  });

  const runMigration = async () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations/20261105400000_other_branch_availability/migration.sql"),
      "utf8",
    );
    for (const statement of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean))
      await prisma.$executeRawUnsafe(statement);
  };
  const grantedRoles = async () =>
    (
      await prisma.rolePermission.findMany({
        where: { tenantId: fx.tenantId, permissionKey: KEY },
        select: { role: { select: { key: true } } },
      })
    )
      .map((g) => g.role.key)
      .sort();

  it("is granted to existing tenants' built-in counter roles by the migration, and no others", async () => {
    const custom = await roles.createRole(fx.tenantId, fx.ownerId, {
      name: "Shelf helper",
      permissionKeys: ["inventory.view"],
    });
    // A database that never had the permission: the migration adds it and grants it.
    await prisma.rolePermission.deleteMany({ where: { permissionKey: KEY } });
    await prisma.permission.delete({ where: { key: KEY } });
    await runMigration();
    expect(await grantedRoles()).toEqual(["cashier", "manager", "owner", "pharmacist"]);
    expect((await grantedRoles()).includes(custom.key)).toBe(false);
  });

  it("grants nothing when re-run where the permission already exists", async () => {
    // It first merged as 20261105300000_other_branch_availability; a database that ran that runs
    // the renamed migration again, and an owner's switch-off since must survive it.
    const cashier = await roleOf("cashier");
    await prisma.rolePermission.deleteMany({ where: { roleId: cashier.id, permissionKey: KEY } });
    await runMigration();
    expect(await grantedRoles()).toEqual(["manager", "owner", "pharmacist"]);
  });
});
