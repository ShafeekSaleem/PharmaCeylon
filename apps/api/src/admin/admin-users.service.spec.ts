import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { UserContextService } from "../auth/user-context.service";
import { AdminUsersService } from "./admin-users.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("AdminUsersService", () => {
  const tenantId = "tenant-1";
  const ownerId = "owner-1";
  const managerId = "manager-1";
  const targetId = "target-1";
  const branchId = "branch-1";

  let prisma: {
    appUser: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock };
    branch: { findFirst: jest.Mock };
    userBranchRole: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      upsert: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    role: { findUnique: jest.Mock; findFirst: jest.Mock };
    session: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: AuditService;
  let userContext: UserContextService;
  let authService: { revokeAllSessions: jest.Mock };
  let service: AdminUsersService;

  beforeEach(() => {
    prisma = {
      appUser: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      branch: { findFirst: jest.fn() },
      userBranchRole: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      role: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn() },
      session: { findMany: jest.fn() },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    };
    audit = { log: jest.fn() } as unknown as AuditService;
    userContext = { invalidate: jest.fn() } as unknown as UserContextService;
    authService = { revokeAllSessions: jest.fn().mockResolvedValue(undefined) };
    service = new AdminUsersService(
      prisma as never,
      audit,
      userContext,
      authService as unknown as AuthService,
    );
    mockedBcrypt.hash.mockReset();
  });

  describe("createUser", () => {
    it("creates a user and logs the audit event", async () => {
      mockedBcrypt.hash.mockResolvedValue("hashed" as never);
      prisma.appUser.create.mockResolvedValue({
        id: targetId,
        email: "new@pharmaceylon.demo",
        fullName: "New Hire",
        isActive: true,
        createdAt: new Date(),
        userBranchRoles: [],
      });

      const result = await service.createUser(tenantId, ownerId, {
        email: "New@Pharmaceylon.demo",
        password: "password123",
        fullName: "New Hire",
      });

      expect(result.id).toBe(targetId);
      expect(prisma.appUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: "new@pharmaceylon.demo", tenantId }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.created" }),
      );
    });

    it("maps a duplicate-email database error to ConflictException", async () => {
      mockedBcrypt.hash.mockResolvedValue("hashed" as never);
      prisma.appUser.create.mockRejectedValue({ code: "P2002" });

      await expect(
        service.createUser(tenantId, ownerId, {
          email: "dupe@pharmaceylon.demo",
          password: "password123",
          fullName: "Dupe",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("assignBranchRole", () => {
    it("lets an owner grant the owner role", async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: targetId });
      prisma.branch.findFirst.mockResolvedValue({ id: branchId });
      prisma.userBranchRole.upsert.mockResolvedValue({ id: "mapping-1" });

      await service.assignBranchRole(tenantId, ownerId, true, targetId, {
        branchId,
        role: RoleName.owner,
      });

      expect(prisma.userBranchRole.upsert).toHaveBeenCalled();
      expect(userContext.invalidate).toHaveBeenCalledWith(targetId);
    });

    it("blocks a manager from granting the owner role", async () => {
      await expect(
        service.assignBranchRole(tenantId, managerId, false, targetId, {
          branchId,
          role: RoleName.owner,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.userBranchRole.upsert).not.toHaveBeenCalled();
    });

    it("lets a manager grant a non-owner role", async () => {
      prisma.appUser.findFirst.mockResolvedValue({ id: targetId });
      prisma.branch.findFirst.mockResolvedValue({ id: branchId });
      prisma.userBranchRole.upsert.mockResolvedValue({ id: "mapping-2" });

      await service.assignBranchRole(tenantId, managerId, false, targetId, {
        branchId,
        role: RoleName.cashier,
      });

      expect(prisma.userBranchRole.upsert).toHaveBeenCalled();
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(
        service.assignBranchRole(tenantId, ownerId, true, targetId, {
          branchId,
          role: RoleName.cashier,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("removeBranchRole", () => {
    it("blocks removing your own owner mapping even as owner", async () => {
      prisma.userBranchRole.findFirst.mockResolvedValue({
        id: "mapping-1",
        role: RoleName.owner,
      });

      await expect(
        service.removeBranchRole(tenantId, ownerId, true, ownerId, "mapping-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.userBranchRole.delete).not.toHaveBeenCalled();
    });

    it("blocks a manager from removing another user's owner mapping", async () => {
      prisma.userBranchRole.findFirst.mockResolvedValue({
        id: "mapping-1",
        role: RoleName.owner,
      });

      await expect(
        service.removeBranchRole(tenantId, managerId, false, targetId, "mapping-1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.userBranchRole.delete).not.toHaveBeenCalled();
    });

    it("lets an owner remove another user's owner mapping", async () => {
      prisma.userBranchRole.findFirst.mockResolvedValue({
        id: "mapping-1",
        role: RoleName.owner,
      });
      prisma.userBranchRole.delete.mockResolvedValue({});

      await service.removeBranchRole(tenantId, ownerId, true, targetId, "mapping-1");

      expect(prisma.userBranchRole.delete).toHaveBeenCalledWith({
        where: { id: "mapping-1", tenantId },
      });
      expect(userContext.invalidate).toHaveBeenCalledWith(targetId);
    });

    it("lets a manager remove a non-owner mapping", async () => {
      prisma.userBranchRole.findFirst.mockResolvedValue({
        id: "mapping-2",
        role: RoleName.cashier,
      });
      prisma.userBranchRole.delete.mockResolvedValue({});

      await service.removeBranchRole(tenantId, managerId, false, targetId, "mapping-2");

      expect(prisma.userBranchRole.delete).toHaveBeenCalled();
    });
  });

  describe("updateUser", () => {
    it("renames a user", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.cashier }],
      });
      prisma.appUser.update.mockResolvedValue({
        id: targetId,
        fullName: "Renamed",
        isActive: true,
        userBranchRoles: [],
      });

      const result = await service.updateUser(tenantId, managerId, false, targetId, {
        fullName: "Renamed",
      });

      expect(result.fullName).toBe("Renamed");
      expect(prisma.appUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: targetId, tenantId },
          data: expect.objectContaining({ fullName: "Renamed" }),
        }),
      );
      expect(userContext.invalidate).not.toHaveBeenCalled();
    });

    it("blocks a manager from modifying an owner's account at all", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.owner }],
      });

      await expect(
        service.updateUser(tenantId, managerId, false, targetId, { fullName: "Nope" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appUser.update).not.toHaveBeenCalled();
    });

    it("blocks deactivating your own account", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: ownerId,
        userBranchRoles: [{ role: RoleName.owner }],
      });

      await expect(
        service.updateUser(tenantId, ownerId, true, ownerId, { isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appUser.update).not.toHaveBeenCalled();
    });

    it("blocks deactivating the tenant's only owner", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.owner }],
      });
      prisma.userBranchRole.findMany.mockResolvedValue([{ userId: targetId }]);

      await expect(
        service.updateUser(tenantId, ownerId, true, targetId, { isActive: false }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appUser.update).not.toHaveBeenCalled();
    });

    it("allows deactivating one of several owners and bumps tokenVersion", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.owner }],
      });
      prisma.userBranchRole.findMany.mockResolvedValue([
        { userId: targetId },
        { userId: ownerId },
      ]);
      prisma.appUser.update.mockResolvedValue({
        id: targetId,
        fullName: "Owner Two",
        isActive: false,
        userBranchRoles: [],
      });

      const result = await service.updateUser(tenantId, ownerId, true, targetId, {
        isActive: false,
      });

      expect(result.isActive).toBe(false);
      expect(prisma.appUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isActive: false,
            tokenVersion: { increment: 1 },
          }),
        }),
      );
      expect(userContext.invalidate).toHaveBeenCalledWith(targetId);
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.deactivated" }),
      );
    });

    it("reactivates a deactivated staff member without touching tokenVersion", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.cashier }],
      });
      prisma.appUser.update.mockResolvedValue({
        id: targetId,
        fullName: "Cashier",
        isActive: true,
        userBranchRoles: [],
      });

      await service.updateUser(tenantId, ownerId, true, targetId, { isActive: true });

      expect(prisma.appUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.not.objectContaining({ tokenVersion: expect.anything() }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.reactivated" }),
      );
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(
        service.updateUser(tenantId, ownerId, true, targetId, { fullName: "Ghost" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("deleteUser", () => {
    it("blocks deleting an account that is still active", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        isActive: true,
        userBranchRoles: [{ role: RoleName.cashier }],
      });

      await expect(
        service.deleteUser(tenantId, ownerId, true, targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("blocks a manager from deleting a deactivated owner's account", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        isActive: false,
        userBranchRoles: [{ role: RoleName.owner }],
      });

      await expect(
        service.deleteUser(tenantId, managerId, false, targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("deletes a clean deactivated account with no linked activity", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        isActive: false,
        email: "gone@pharmaceylon.demo",
        userBranchRoles: [{ role: RoleName.cashier }],
      });
      prisma.userBranchRole.deleteMany.mockResolvedValue({ count: 1 });
      prisma.appUser.delete.mockResolvedValue({ id: targetId });

      const result = await service.deleteUser(tenantId, ownerId, true, targetId);

      expect(result).toEqual({ ok: true });
      expect(prisma.userBranchRole.deleteMany).toHaveBeenCalledWith({
        where: { tenantId, userId: targetId },
      });
      expect(prisma.appUser.delete).toHaveBeenCalledWith({ where: { id: targetId, tenantId } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.deleted" }),
      );
    });

    it("maps a foreign-key constraint failure to a friendly ConflictException", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        isActive: false,
        email: "busy@pharmaceylon.demo",
        userBranchRoles: [{ role: RoleName.cashier }],
      });
      prisma.userBranchRole.deleteMany.mockResolvedValue({ count: 1 });
      prisma.appUser.delete.mockRejectedValue({ code: "P2003" });

      await expect(
        service.deleteUser(tenantId, ownerId, true, targetId),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(
        service.deleteUser(tenantId, ownerId, true, targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("getSecurity", () => {
    it("reports PIN and session state", async () => {
      const future = new Date(Date.now() + 60_000);
      prisma.appUser.findFirst.mockResolvedValue({
        posPinHash: "hash",
        failedPosPinAttempts: 2,
        posPinLockedUntil: future,
      });
      prisma.session.findMany.mockResolvedValue([
        { id: "s1", userAgent: "Chrome", ipAddress: "10.0.0.1", lastUsedAt: new Date(), createdAt: new Date() },
      ]);

      const result = await service.getSecurity(tenantId, targetId);

      expect(result.pin).toEqual({
        isSet: true,
        isLocked: true,
        lockedUntil: future,
        failedAttempts: 2,
      });
      expect(result.sessions).toHaveLength(1);
      expect(prisma.session.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ userId: targetId, revokedAt: null }) }),
      );
    });

    it("reports isSet: false and isLocked: false for a user with no PIN", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        posPinHash: null,
        failedPosPinAttempts: 0,
        posPinLockedUntil: null,
      });
      prisma.session.findMany.mockResolvedValue([]);

      const result = await service.getSecurity(tenantId, targetId);

      expect(result.pin.isSet).toBe(false);
      expect(result.pin.isLocked).toBe(false);
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(service.getSecurity(tenantId, targetId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("resetPosPin", () => {
    it("clears the PIN and lockout state", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.pharmacist }],
      });
      prisma.appUser.update.mockResolvedValue({});

      const result = await service.resetPosPin(tenantId, ownerId, true, targetId);

      expect(result).toEqual({ reset: true });
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: targetId, tenantId },
        data: { posPinHash: null, failedPosPinAttempts: 0, posPinLockedUntil: null },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.pos_pin.admin_reset" }),
      );
    });

    it("blocks a manager from resetting an owner's PIN", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.owner }],
      });

      await expect(
        service.resetPosPin(tenantId, managerId, false, targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.appUser.update).not.toHaveBeenCalled();
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(
        service.resetPosPin(tenantId, ownerId, true, targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("forceLogout", () => {
    it("revokes all sessions and logs the action", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.cashier }],
      });

      const result = await service.forceLogout(tenantId, ownerId, true, targetId);

      expect(result).toEqual({ ok: true });
      expect(authService.revokeAllSessions).toHaveBeenCalledWith(targetId, "admin_invalidated");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "user.sessions.force_logout" }),
      );
    });

    it("blocks a manager from force-logging-out an owner", async () => {
      prisma.appUser.findFirst.mockResolvedValue({
        id: targetId,
        userBranchRoles: [{ role: RoleName.owner }],
      });

      await expect(
        service.forceLogout(tenantId, managerId, false, targetId),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(authService.revokeAllSessions).not.toHaveBeenCalled();
    });

    it("404s when the target user does not belong to the tenant", async () => {
      prisma.appUser.findFirst.mockResolvedValue(null);

      await expect(
        service.forceLogout(tenantId, ownerId, true, targetId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
