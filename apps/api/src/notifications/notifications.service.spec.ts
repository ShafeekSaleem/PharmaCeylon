import { NotFoundException } from "@nestjs/common";
import { RoleName } from "@prisma/client";
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
      },
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
});
