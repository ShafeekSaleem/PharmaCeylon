import { ForbiddenException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import { AccessService, assertMayApprove } from "./access.service";
import { PERMISSION_KEYS } from "./permission-catalog";
import type { RequestUser } from "./interfaces/authenticated-request.interface";

function user(branchRoles: RequestUser["branchRoles"]): RequestUser {
  return {
    userId: "u1",
    tenantId: "t1",
    email: "u1@test",
    fullName: "User One",
    authMethod: "cookie",
    branchRoles,
  };
}

function service(selfApprovalRoleKeys: string[] | null, grants: string[] = []) {
  const prisma = {
    tenantSettings: {
      findUnique: jest
        .fn()
        .mockResolvedValue(selfApprovalRoleKeys ? { selfApprovalRoleKeys } : null),
    },
    role: {
      findMany: jest.fn().mockResolvedValue([{ key: "senior_clerk" }]),
    },
  };
  const permissions = { resolveGrantedKeys: jest.fn().mockResolvedValue(new Set(grants)) };
  return new AccessService(prisma as never, permissions as never);
}

describe("AccessService", () => {
  it("lets owners and managers approve their own requests by default", async () => {
    const manager = await service(null).resolve(
      user([{ branchId: "b1", role: RoleName.manager }]),
      "b1",
    );
    expect(manager.canSelfApprove).toBe(true);

    const clerk = await service(null).resolve(
      user([{ branchId: "b1", role: RoleName.inventory_clerk }]),
      "b1",
    );
    expect(clerk.canSelfApprove).toBe(false);
  });

  it("follows the tenant's setting instead of the default", async () => {
    const clerk = await service(["owner", "inventory_clerk"]).resolve(
      user([{ branchId: "b1", role: RoleName.inventory_clerk }]),
      "b1",
    );
    expect(clerk.canSelfApprove).toBe(true);

    const manager = await service(["owner"]).resolve(
      user([{ branchId: "b1", role: RoleName.manager }]),
      "b1",
    );
    expect(manager.canSelfApprove).toBe(false);
  });

  it("matches custom roles by their key", async () => {
    const custom = await service(["senior_clerk"]).resolve(
      user([{ branchId: "b1", role: RoleName.custom, roleId: "role-1" }]),
      "b1",
    );
    expect(custom.roleKeys).toContain("senior_clerk");
    expect(custom.canSelfApprove).toBe(true);
  });

  it("only counts roles held at the branch being worked in", async () => {
    const access = await service(null).resolve(
      user([
        { branchId: "b1", role: RoleName.manager },
        { branchId: "b2", role: RoleName.cashier },
      ]),
      "b2",
    );
    expect(access.canSelfApprove).toBe(false);
  });

  it("grants owners every permission and self-approval at any branch", async () => {
    const owner = await service(null).resolve(
      user([{ branchId: "b1", role: RoleName.owner }]),
      "b2",
    );
    expect(owner.permissions.size).toBe(PERMISSION_KEYS.length);
    expect(owner.canSelfApprove).toBe(true);
  });

  it("reads permissions from the configurable grants, not from role names", async () => {
    const access = await service(null, ["transfers.approve"]).resolve(
      user([{ branchId: "b1", role: RoleName.custom, roleId: "role-1" }]),
      "b1",
    );
    expect(access.has("transfers.approve")).toBe(true);
    expect(access.has("inventory.write_off")).toBe(false);
  });
});

describe("assertMayApprove", () => {
  const base = { permissions: new Set<string>(), roleKeys: [], has: () => true };

  it("blocks approving your own request when your role may not", () => {
    expect(() =>
      assertMayApprove({ ...base, userId: "u1", canSelfApprove: false }, ["u1"], "transfer"),
    ).toThrow(ForbiddenException);
  });

  it("allows approving someone else's request regardless of the setting", () => {
    expect(() =>
      assertMayApprove({ ...base, userId: "u2", canSelfApprove: false }, ["u1"], "transfer"),
    ).not.toThrow();
  });

  it("allows approving your own request when your role may", () => {
    expect(() =>
      assertMayApprove({ ...base, userId: "u1", canSelfApprove: true }, ["u1"], "transfer"),
    ).not.toThrow();
  });
});
