import { NotFoundException } from "@nestjs/common";
import { NotificationCategory, RoleName } from "@prisma/client";
import { NotificationsService } from "./notifications.service";

describe("NotificationsService", () => {
  function setup() {
    const prisma = {
      notification: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn(),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      notificationPreference: {
        upsert: jest.fn().mockResolvedValue({
          tenantId: "tenant-1",
          userId: "user-1",
          inventoryEnabled: true,
          expiryEnabled: true,
          purchasingEnabled: true,
          transfersEnabled: true,
          stocktakesEnabled: true,
          salesEnabled: true,
          complianceEnabled: true,
          systemEnabled: true,
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userBranchRole: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
    };
    const permissions = {
      resolveGrantedKeys: jest.fn().mockResolvedValue(new Set()),
    };
    const service = new NotificationsService(
      prisma as never,
      permissions as never,
    );
    const user = {
      userId: "user-1",
      tenantId: "tenant-1",
      email: "person@example.com",
      fullName: "Person",
      authMethod: "cookie" as const,
      branchRoles: [
        { branchId: "branch-1", role: RoleName.cashier, roleId: "role-1" },
      ],
    };
    return { prisma, permissions, service, user };
  }

  it("lists only the authenticated user's tenant-owned notifications", async () => {
    const { prisma, service, user } = setup();

    await service.list(user, undefined, { status: "unread", take: 10 });

    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          recipientUserId: "user-1",
          archivedAt: null,
          resolvedAt: null,
          readAt: null,
        }),
        take: 10,
      }),
    );
  });

  it("scopes notification mutations by tenant and recipient", async () => {
    const { prisma, service } = setup();
    prisma.notification.findFirst.mockResolvedValue({
      id: "notice-1",
      readAt: null,
    });
    prisma.notification.update.mockResolvedValue({ id: "notice-1" });

    await service.markRead("tenant-1", "user-1", "notice-1");

    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: {
        id: "notice-1",
        tenantId: "tenant-1",
        recipientUserId: "user-1",
      },
      data: { readAt: expect.any(Date) },
    });
  });

  it("does not reveal another user's notification", async () => {
    const { prisma, service } = setup();
    prisma.notification.findFirst.mockResolvedValue(null);

    await expect(
      service.archive("tenant-1", "user-1", "notice-2"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  describe("notifyByPermission", () => {
    it("notifies an owner regardless of the required permission and excludes the actor", async () => {
      const { prisma, permissions, service } = setup();
      prisma.userBranchRole.findMany.mockResolvedValue([
        { userId: "owner-1", branchId: "branch-1", role: RoleName.owner, roleId: null },
      ]);
      permissions.resolveGrantedKeys.mockResolvedValue(new Set());

      await service.notifyByPermission(
        "tenant-1",
        "users.view",
        NotificationCategory.compliance,
        { title: "New staff member" },
        "actor-1",
      );

      expect(prisma.userBranchRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: "tenant-1", userId: { not: "actor-1" } }),
        }),
      );
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            tenantId: "tenant-1",
            recipientUserId: "owner-1",
            category: NotificationCategory.compliance,
            title: "New staff member",
          }),
        ],
      });
    });

    it("only notifies non-owners who actually hold the required permission", async () => {
      const { prisma, permissions, service } = setup();
      prisma.userBranchRole.findMany.mockResolvedValue([
        { userId: "manager-1", branchId: "branch-1", role: RoleName.manager, roleId: "role-1" },
        { userId: "cashier-1", branchId: "branch-1", role: RoleName.cashier, roleId: "role-2" },
      ]);
      permissions.resolveGrantedKeys.mockImplementation(
        async (entries: Array<{ role: RoleName }>) =>
          entries[0]?.role === RoleName.manager ? new Set(["users.view"]) : new Set(),
      );

      await service.notifyByPermission(
        "tenant-1",
        "users.view",
        NotificationCategory.compliance,
        { title: "Role changed" },
      );

      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ recipientUserId: "manager-1" })],
      });
    });

    it("skips a recipient who has turned the category off in their preferences", async () => {
      const { prisma, service } = setup();
      prisma.userBranchRole.findMany.mockResolvedValue([
        { userId: "owner-1", branchId: "branch-1", role: RoleName.owner, roleId: null },
      ]);
      prisma.notificationPreference.findMany.mockResolvedValue([
        { userId: "owner-1", complianceEnabled: false, systemEnabled: true },
      ]);

      await service.notifyByPermission(
        "tenant-1",
        "users.view",
        NotificationCategory.compliance,
        { title: "New staff member" },
      );

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it("is a no-op when no one holds the required permission", async () => {
      const { prisma, service } = setup();
      prisma.userBranchRole.findMany.mockResolvedValue([]);

      await service.notifyByPermission(
        "tenant-1",
        "tenant.management",
        NotificationCategory.system,
        { title: "Branch updated" },
      );

      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });
  });
});
