import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PermissionsService } from "../security/permissions.service";
import { RolesAdminService } from "./roles-admin.service";

describe("RolesAdminService", () => {
  const tenantId = "tenant-1";
  const actorUserId = "actor-1";

  let prisma: {
    role: {
      findMany: jest.Mock;
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    rolePermission: { findMany: jest.Mock; deleteMany: jest.Mock; createMany: jest.Mock };
    userBranchRole: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: AuditService;
  let permissions: { invalidateRole: jest.Mock };
  let notifications: { notifyByPermission: jest.Mock };
  let service: RolesAdminService;

  beforeEach(() => {
    prisma = {
      role: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      rolePermission: { findMany: jest.fn(), deleteMany: jest.fn(), createMany: jest.fn() },
      userBranchRole: { count: jest.fn() },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    audit = { log: jest.fn() } as unknown as AuditService;
    permissions = { invalidateRole: jest.fn() };
    notifications = { notifyByPermission: jest.fn().mockResolvedValue(undefined) };
    service = new RolesAdminService(
      prisma as never,
      audit,
      permissions as unknown as PermissionsService,
      notifications as unknown as NotificationsService,
    );
  });

  describe("createRole", () => {
    it("slugifies the name into a unique key and grants the requested permissions", async () => {
      prisma.role.findUnique.mockResolvedValue(null);
      prisma.role.create.mockResolvedValue({
        id: "role-1",
        key: "shift-lead",
        name: "Shift Lead",
        description: null,
        isSystem: false,
        isLocked: false,
        permissions: [{ permissionKey: "inventory.view" }],
      });

      const result = await service.createRole(tenantId, actorUserId, {
        name: "Shift Lead",
        permissionKeys: ["inventory.view"],
      });

      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tenantId, key: "shift-lead", isSystem: false, isLocked: false }),
        }),
      );
      expect(result.permissionKeys).toEqual(["inventory.view"]);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "role.created" }),
      );
    });

    it("rejects an unknown permission key", async () => {
      await expect(
        service.createRole(tenantId, actorUserId, {
          name: "Bad Role",
          permissionKeys: ["not.a.real.permission"],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it("appends a numeric suffix when the slug collides with an existing role", async () => {
      prisma.role.findUnique
        .mockResolvedValueOnce({ id: "existing" }) // "shift-lead" taken
        .mockResolvedValueOnce(null); // "shift-lead-2" free
      prisma.role.create.mockResolvedValue({
        id: "role-2",
        key: "shift-lead-2",
        name: "Shift Lead",
        description: null,
        isSystem: false,
        isLocked: false,
        permissions: [],
      });

      await service.createRole(tenantId, actorUserId, { name: "Shift Lead", permissionKeys: [] });

      expect(prisma.role.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ key: "shift-lead-2" }) }),
      );
    });
  });

  describe("updateRole", () => {
    it("blocks renaming a built-in role", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isSystem: true });
      await expect(
        service.updateRole(tenantId, actorUserId, "role-1", { name: "New Name" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("scopes the final role update to the tenant", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isSystem: false });
      prisma.role.update.mockResolvedValue({
        id: "role-1",
        name: "Shift Supervisor",
        description: null,
      });

      await service.updateRole(tenantId, actorUserId, "role-1", {
        name: "Shift Supervisor",
      });

      expect(prisma.role.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "role-1", tenantId } }),
      );
    });

    it("404s for a role outside the tenant", async () => {
      prisma.role.findFirst.mockResolvedValue(null);
      await expect(
        service.updateRole(tenantId, actorUserId, "role-x", { name: "New Name" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateRolePermissions", () => {
    it("blocks editing the locked owner role's permissions", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "owner-role", isLocked: true });
      await expect(
        service.updateRolePermissions(tenantId, actorUserId, "owner-role", {
          permissionKeys: ["users.view"],
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("diffs added/removed permissions and invalidates the permissions cache", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isLocked: false });
      prisma.rolePermission.findMany.mockResolvedValue([
        { permissionKey: "inventory.view" },
        { permissionKey: "products.view" },
      ]);

      await service.updateRolePermissions(tenantId, actorUserId, "role-1", {
        permissionKeys: ["inventory.view", "stocktakes.use"],
      });

      expect(prisma.rolePermission.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, roleId: "role-1", permissionKey: { in: ["products.view"] } },
      });
      expect(prisma.rolePermission.createMany).toHaveBeenCalledWith({
        data: [{ tenantId, roleId: "role-1", permissionKey: "stocktakes.use" }],
      });
      expect(permissions.invalidateRole).toHaveBeenCalledWith("role-1");
    });

    it("rejects an unknown permission key before touching the database", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isLocked: false });
      await expect(
        service.updateRolePermissions(tenantId, actorUserId, "role-1", {
          permissionKeys: ["nonsense.key"],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.role.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("deleteRole", () => {
    it("blocks deleting a built-in role", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isSystem: true });
      await expect(service.deleteRole(tenantId, actorUserId, "role-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("blocks deleting a custom role that still has staff assigned", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isSystem: false, name: "Shift Lead" });
      prisma.userBranchRole.count.mockResolvedValue(2);
      await expect(service.deleteRole(tenantId, actorUserId, "role-1")).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.role.delete).not.toHaveBeenCalled();
    });

    it("deletes an unassigned custom role and invalidates its cache", async () => {
      prisma.role.findFirst.mockResolvedValue({ id: "role-1", isSystem: false, name: "Shift Lead" });
      prisma.userBranchRole.count.mockResolvedValue(0);

      const result = await service.deleteRole(tenantId, actorUserId, "role-1");

      expect(prisma.role.delete).toHaveBeenCalledWith({ where: { id: "role-1", tenantId } });
      expect(permissions.invalidateRole).toHaveBeenCalledWith("role-1");
      expect(result).toEqual({ ok: true });
    });
  });
});
