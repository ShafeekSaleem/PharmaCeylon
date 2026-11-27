import { NotFoundException } from "@nestjs/common";
import { DesktopPosRollout, NotificationCategory, RoleName } from "@prisma/client";
import { SALES_RECOVERY_DAILY_WORK_KINDS, type DailyWorkItem } from "@pharmaceylon/shared";
import { SALES_RECOVERY_NOTIFICATION_CAP } from "./notifications.service";
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
      branch: {
        findFirst: jest.fn().mockResolvedValue({
          name: "Colombo 03",
          desktopPosRollout: DesktopPosRollout.not_live,
          desktopPosLiveAt: null,
          posFallbackStartedAt: null,
          posFallbackEndsAt: null,
        }),
      },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      role: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((operations: unknown[]) => Promise.all(operations)),
    };
    const permissions = {
      resolveGrantedKeys: jest.fn().mockResolvedValue(new Set()),
    };
    const work = {
      get: jest.fn().mockResolvedValue({ items: [], counterLive: false }),
    };
    const service = new NotificationsService(
      prisma as never,
      permissions as never,
      work as never,
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
    return { prisma, permissions, service, user, work };
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

  describe("counter work and counter alerts (W9)", () => {
    const waiting: DailyWorkItem = {
      id: "adjustment:held-1",
      kind: "held_adjustment.post",
      where: "counter",
      category: "inventory",
      title: "Post approved write-off",
      detail: "Amoxicillin · 3 units · damaged",
      reference: "B-12",
      status: "approved",
      href: "/inventory?heldAdjustment=held-1",
      action: "View details",
      createdAt: "2026-10-28T08:00:00.000Z",
      dueAt: null,
      owner: "Branch approvers",
      mine: false,
      approval: false,
      blocked: false,
      overdue: false,
      priority: 1,
    };

    const legacyItems = () => [
      waiting,
      { ...waiting, id: "adjustment:held-2", where: "web" as const },
      {
        ...waiting,
        id: "return:r-1",
        kind: "goods_return.approve" as const,
        category: "returns" as const,
        approval: true,
        blocked: true,
      },
    ];

    it("deep-links approved documents waiting at a live branch's counter, read through daily work", async () => {
      const { prisma, service, user, work } = setup();
      work.get.mockImplementation((_u, _b, _q, opts) =>
        Promise.resolve({
          counterLive: true,
          items: opts?.kinds?.includes("sale_incident.review")
            ? []
            : legacyItems(),
        }),
      );

      await service.list(user, "branch-1", {});

      expect(work.get).toHaveBeenCalledWith(
        user,
        "branch-1",
        { filter: "all", page: 1 },
        expect.objectContaining({
          pageSize: 25,
          kinds: expect.arrayContaining(["held_adjustment.post", "goods_return.approve"]),
        }),
      );
      expect(work.get).toHaveBeenCalledWith(
        user,
        "branch-1",
        { filter: "all", page: 1 },
        expect.objectContaining({
          pageSize: SALES_RECOVERY_NOTIFICATION_CAP,
          kinds: [...SALES_RECOVERY_DAILY_WORK_KINDS],
        }),
      );
      expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            tenantId: "tenant-1",
            recipientUserId: "user-1",
            branchId: "branch-1",
            dedupeKey: "operational:branch-1:work:adjustment:held-1:held_adjustment.post",
            title: "Approved — waiting at the counter · B-12",
            actionHref: "/inventory?heldAdjustment=held-1",
            category: NotificationCategory.inventory,
            entityType: "held_adjustment",
            entityId: "held-1",
          }),
        }),
      );
    });

    it("notifies supplier returns waiting for an approval the viewer may give", async () => {
      const { prisma, service, user, work } = setup();
      work.get.mockImplementation((_u, _b, _q, opts) =>
        Promise.resolve({
          counterLive: false,
          items: opts?.kinds?.includes("sale_incident.review")
            ? []
            : [
                {
                  ...waiting,
                  id: "return:r-1",
                  kind: "goods_return.approve",
                  where: "web",
                  category: "returns",
                  title: "Review supplier return",
                  reference: "RET-1",
                  href: "/returns?return=r-1",
                  action: "Review return",
                  approval: true,
                },
              ],
        }),
      );
      await service.list(user, "branch-1", {});
      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            title: "Review supplier return RET-1",
            actionHref: "/returns?return=r-1",
            category: NotificationCategory.purchasing,
          }),
        }),
      );
    });

    it("notifies sales recovery tasks from daily work without treating them as counter work", async () => {
      const { prisma, service, user, work } = setup();
      const recovery = {
        ...waiting,
        id: "incident:rec-1",
        kind: "sale_incident.review",
        where: "web",
        category: "counter",
        title: "Review incident note",
        reference: "rec-1",
        href: "/sales?view=incident-notes&recordId=rec-1",
        action: "Open in Sales",
        approval: false,
      };
      work.get.mockImplementation((_u, _b, _q, opts) =>
        Promise.resolve({
          counterLive: true,
          items: opts?.kinds?.includes("sale_incident.review") ? [recovery] : [],
        }),
      );
      await service.list(user, "branch-1", {});
      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            dedupeKey: "operational:branch-1:work:incident:rec-1:sale_incident.review",
            actionHref: "/sales?view=incident-notes&recordId=rec-1",
            category: NotificationCategory.sales,
            title: "Review incident note rec-1",
          }),
        }),
      );
    });

    it("reopens an operational work notification when the task returns after resolving", async () => {
      const { prisma, service, user, work } = setup();
      const recovery = {
        ...waiting,
        id: "collected_money:p-1",
        kind: "collected_money.review",
        where: "web",
        category: "counter",
        title: "Resolve collected card money",
        reference: "RRN-1",
        href: "/sales?view=unresolved-money&paymentId=p-1",
        action: "Open in Sales",
        approval: false,
      };
      let recoveryPass = 0;
      work.get.mockImplementation((_u, _b, _q, opts) => {
        if (!opts?.kinds?.includes("sale_incident.review")) {
          return Promise.resolve({ counterLive: true, items: [] });
        }
        recoveryPass += 1;
        return Promise.resolve({
          counterLive: true,
          items: recoveryPass === 2 ? [] : [recovery],
        });
      });
      prisma.notification.findMany.mockResolvedValue([
        {
          id: "n-1",
          dedupeKey:
            "operational:branch-1:work:collected_money:p-1:collected_money.review",
          resolvedAt: null,
        },
      ]);
      prisma.notification.upsert.mockResolvedValue({ id: "n-1" });

      await service.list(user, "branch-1", {});
      await service.updatePreferences("tenant-1", "user-1", {});
      prisma.notification.findMany.mockResolvedValue([
        {
          id: "n-1",
          dedupeKey:
            "operational:branch-1:work:collected_money:p-1:collected_money.review",
          resolvedAt: new Date("2026-11-27T00:00:00.000Z"),
        },
      ]);
      await service.list(user, "branch-1", {});
      await service.updatePreferences("tenant-1", "user-1", {});
      await service.list(user, "branch-1", {});

      const lastUpsert = prisma.notification.upsert.mock.calls.at(-1)?.[0] as {
        update: { resolvedAt: Date | null };
      };
      expect(lastUpsert.update.resolvedAt).toBeNull();
    });

    it("notifies actionable refund approvals and excludes self-blocked ones", async () => {
      const { prisma, service, user, work } = setup();
      const refund = { ...waiting, id: "refund:rr-1", kind: "sale_refund.approve", where: "web", category: "counter", title: "Approve prepared refund", reference: "RFR-1", href: "/sales?view=pending-approvals&request=rr-1", action: "Review refund", approval: true };
      work.get.mockImplementation((_u, _b, _q, opts) =>
        Promise.resolve({
          counterLive: true,
          items: opts?.kinds?.includes("sale_incident.review")
            ? []
            : [refund, { ...refund, id: "refund:rr-2", blocked: true }],
        }),
      );
      await service.list(user, "branch-1", {});
      expect(prisma.notification.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.notification.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({
        title: "Approve prepared refund RFR-1", actionHref: "/sales?view=pending-approvals&request=rr-1", category: NotificationCategory.sales,
      }) }));
    });

    it("sends a counter alert to the roles chosen in the tenant's counter alert settings", async () => {
      const { prisma, service } = setup();
      prisma.tenantSettings.findUnique.mockResolvedValue({
        counterAlertPolicy: {
          schemaVersion: 1,
          rules: [{ type: "fallback_changed", enabled: true, recipientRoleKeys: ["shift-lead"] }],
        },
      });
      prisma.userBranchRole.findMany.mockResolvedValue([
        { userId: "lead-1", branchId: "branch-1", role: RoleName.custom, roleRef: { key: "shift-lead" } },
        { userId: "lead-2", branchId: "branch-2", role: RoleName.custom, roleRef: { key: "shift-lead" } },
        { userId: "manager-1", branchId: "branch-1", role: RoleName.manager, roleRef: { key: "manager" } },
      ]);

      const sent = await service.notifyCounterAlert(
        "tenant-1",
        "branch-1",
        "fallback_changed",
        { title: "Web POS fallback is on", actionHref: "/settings/branches" },
        "actor-1",
      );

      expect(sent).toBe(1);
      expect(prisma.userBranchRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: "tenant-1", userId: { not: "actor-1" } },
        }),
      );
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            tenantId: "tenant-1",
            recipientUserId: "lead-1",
            branchId: "branch-1",
            category: NotificationCategory.system,
            actionHref: "/settings/branches",
            entityType: "counter_alert.fallback_changed",
          }),
        ],
      });
    });

    it("warns the alert's recipients that a running fallback is about to end", async () => {
      const { prisma, service, user } = setup();
      const manager = {
        ...user,
        branchRoles: [{ branchId: "branch-1", role: RoleName.manager, roleId: "role-m" }],
      };
      prisma.role.findMany.mockResolvedValue([{ id: "role-m", key: "manager" }]);
      prisma.branch.findFirst.mockResolvedValue({
        name: "Colombo 03",
        desktopPosRollout: DesktopPosRollout.live,
        desktopPosLiveAt: new Date(Date.now() - 86_400_000),
        posFallbackStartedAt: new Date(Date.now() - 3_600_000),
        posFallbackEndsAt: new Date(Date.now() + 30 * 60_000),
      });

      await service.list(manager, "branch-1", {});

      expect(prisma.notification.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            category: NotificationCategory.system,
            entityType: "counter_alert.fallback_changed",
            actionHref: "/settings/branches",
          }),
        }),
      );
    });
  });
});
