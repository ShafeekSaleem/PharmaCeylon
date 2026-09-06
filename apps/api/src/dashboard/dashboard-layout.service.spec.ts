import { DashboardLayoutService } from "./dashboard-layout.service";

describe("DashboardLayoutService", () => {
  const tenantId = "tenant-a";
  const userId = "user-a";
  const widgets = [{ key: "owner.inventory-health", x: 0, y: 0 }];

  function makeService() {
    const dashboardLayout = {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = { dashboardLayout };
    return { service: new DashboardLayoutService(prisma as never), dashboardLayout };
  }

  it("returns null when the user has no saved layout", async () => {
    const { service, dashboardLayout } = makeService();
    dashboardLayout.findUnique.mockResolvedValue(null);

    const result = await service.getLayout(tenantId, userId);

    expect(result).toBeNull();
    expect(dashboardLayout.findUnique).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId, userId } },
      select: { widgets: true, updatedAt: true },
    });
  });

  it("returns the saved layout when one exists", async () => {
    const { service, dashboardLayout } = makeService();
    const updatedAt = new Date("2026-08-25T00:00:00.000Z");
    dashboardLayout.findUnique.mockResolvedValue({ widgets, updatedAt });

    const result = await service.getLayout(tenantId, userId);

    expect(result).toEqual({ widgets, updatedAt });
  });

  it("upserts by userId, passing tenantId only on create", async () => {
    const { service, dashboardLayout } = makeService();
    dashboardLayout.upsert.mockResolvedValue({ widgets, updatedAt: new Date() });

    await service.saveLayout(tenantId, userId, { widgets });

    expect(dashboardLayout.upsert).toHaveBeenCalledWith({
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, widgets },
      update: { widgets },
      select: { widgets: true, updatedAt: true },
    });
  });

  it("scopes reset by both tenantId and userId", async () => {
    const { service, dashboardLayout } = makeService();

    const result = await service.resetLayout(tenantId, userId);

    expect(dashboardLayout.deleteMany).toHaveBeenCalledWith({ where: { tenantId, userId } });
    expect(result).toEqual({ widgets: null });
  });
});
