import { ConflictException } from "@nestjs/common";
import { SetupReadinessService } from "./setup-readiness.service";

describe("SetupReadinessService", () => {
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const branchId = "00000000-0000-4000-8000-000000000002";

  function setup(overrides: Record<string, unknown> = {}) {
    const branch = {
      id: branchId,
      code: "MAIN-01",
      name: "Matale Main",
      addressLine1: "1 Main Street",
      timezone: "Asia/Colombo",
      setupRequired: true,
      setupMode: "migrating",
      setupCompletedAt: null,
      salesSettingsReviewedAt: null,
      checkoutPreparedAt: null,
      tenant: {
        id: tenantId,
        displayName: "Royal Pharmacy",
        legalName: "Royal Pharmacy",
        currency: "LKR",
        timezone: "Asia/Colombo",
        logoUrl: null,
      },
      ...overrides,
    };
    const prisma = {
      branch: {
        findFirst: jest.fn().mockResolvedValue(branch),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      product: { count: jest.fn().mockResolvedValue(1) },
      stockLedger: {
        groupBy: jest.fn().mockResolvedValue([{ batchId: "batch-1", _sum: { qtyDelta: 12 } }]),
      },
      userBranchRole: {
        findMany: jest.fn().mockResolvedValue([{ userId: "owner-1" }, { userId: "staff-1" }]),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new SetupReadinessService(prisma as never, audit as never),
      prisma,
      audit,
    };
  }

  it("derives product and opening-stock completion from operational records", async () => {
    const { service } = setup({
      salesSettingsReviewedAt: new Date(),
      checkoutPreparedAt: new Date(),
    });

    const result = await service.get(tenantId, branchId);

    expect(result.readyForSales).toBe(true);
    expect(result.completedCount).toBe(5);
    expect(result.optional.teamInvited).toBe(true);
    expect(result.tasks.find((task) => task.key === "opening_inventory")?.complete).toBe(true);
  });

  it("does not treat products as opening inventory when net stock is zero", async () => {
    const { service, prisma } = setup();
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "batch-1", _sum: { qtyDelta: 0 } }]);

    const result = await service.get(tenantId, branchId);

    expect(result.tasks.find((task) => task.key === "products")?.complete).toBe(true);
    expect(result.tasks.find((task) => task.key === "opening_inventory")?.complete).toBe(false);
  });

  it("blocks checkout until every required task is complete", async () => {
    const { service } = setup();

    await expect(service.assertCanSell(tenantId, branchId)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("persists explicit settings confirmation and writes an audit event", async () => {
    const { service, prisma, audit } = setup();

    await service.confirm(tenantId, branchId, "owner-1", "sales_settings");

    expect(prisma.branch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { salesSettingsReviewedAt: expect.any(Date) } }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "onboarding.sales_settings_confirmed" }),
    );
  });
});

/**
 * The wizard asks "how are you getting started" and stores the answer; before this it changed
 * nothing downstream, so both answers led to the identical five-step journey. These are the
 * two steps where the answer has to actually show up.
 */
describe("SetupReadinessService — setupMode routes the journey", () => {
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const branchId = "00000000-0000-4000-8000-000000000002";

  function serviceFor(setupMode: string, referenceCount = 1) {
    const prisma = {
      branch: {
        findFirst: jest.fn().mockResolvedValue({
          id: branchId,
          code: "MAIN-01",
          name: "Matale Main",
          addressLine1: "1 Main Street",
          timezone: "Asia/Colombo",
          setupRequired: true,
          setupMode,
          setupCompletedAt: null,
          salesSettingsReviewedAt: null,
          checkoutPreparedAt: null,
          tenant: {
            id: tenantId,
            displayName: "Royal Pharmacy",
            legalName: "Royal Pharmacy",
            currency: "LKR",
            timezone: "Asia/Colombo",
            logoUrl: null,
          },
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // Two counts now: ranged products, then whether a reference catalog exists.
      product: { count: jest.fn().mockResolvedValue(referenceCount) },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      userBranchRole: { findMany: jest.fn().mockResolvedValue([{ userId: "owner-1" }]) },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    return {
      service: new SetupReadinessService(prisma as never, audit as never),
      prisma,
    };
  }

  it("sends a migrating pharmacy to the importer", async () => {
    const { service } = serviceFor("migrating");

    const result = await service.get(tenantId, branchId);
    const products = result.tasks.find((t) => t.key === "products")!;

    expect(products.href).toBe("/products/import");
    expect(products.title).toMatch(/import/i);
  });

  it("sends a fresh pharmacy to the catalog to build a range", async () => {
    const { service } = serviceFor("fresh");

    const result = await service.get(tenantId, branchId);
    const products = result.tasks.find((t) => t.key === "products")!;

    expect(products.href).toBe("/products?scope=reference");
    expect(products.title).not.toMatch(/import/i);
  });

  it("asks a fresh pharmacy to load the register first when it has no catalog to search", async () => {
    // Otherwise "search the catalog and add what you stock" is a link to an empty page —
    // which is exactly what a brand-new workspace would have hit.
    const { service } = serviceFor("fresh", 0);

    const result = await service.get(tenantId, branchId);
    const products = result.tasks.find((t) => t.key === "products")!;

    expect(products.href).toBe("/products?import=nmra");
    expect(products.title).toMatch(/load/i);
  });

  it("keeps the same task keys either way, so completion tracking is unaffected", async () => {
    const migrating = await serviceFor("migrating").service.get(tenantId, branchId);
    const fresh = await serviceFor("fresh").service.get(tenantId, branchId);

    expect(migrating.tasks.map((t) => t.key)).toEqual(fresh.tasks.map((t) => t.key));
    expect(migrating.totalCount).toBe(fresh.totalCount);
  });

  it("counts only the pharmacy's own ranged products, not imported registry rows", async () => {
    const { service, prisma } = serviceFor("fresh");

    await service.get(tenantId, branchId);

    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { tenantId, isActive: true, rangeStatus: "RANGED" },
    });
  });
});
