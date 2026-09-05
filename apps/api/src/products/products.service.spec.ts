import { AuditService } from "../audit/audit.service";
import { ProductMetaService } from "./product-meta.service";
import { ProductsService } from "./products.service";

/**
 * Regression coverage for a real bug: `getById`/`list` used to include ALL of a product's
 * `ProductCategoryMap` rows (every dimension) under a single `categories` field. The web edit
 * form round-trips that field straight back as `categoryIds` on save — and
 * `ProductMetaService.syncProductCategories` now rejects any non-COMMERCIAL id — so editing
 * *any* NMRA product (which always has Dosage Form/Schedule/Registration Type maps) failed
 * with "One or more categories are invalid" even when the user never touched categories.
 */
describe("ProductsService — category dimension scoping", () => {
  const tenantId = "tenant-1";
  const productId = "product-1";

  type PrismaMock = {
    product: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  function makeService() {
    const prisma: PrismaMock = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: productId,
          tenantId,
          name: "Amoxicillin 500mg",
          categoryMaps: [
            { category: { id: "cat-commercial-1", name: "Anti-infectives" } },
          ],
          tagMaps: [],
          aliases: [],
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(1),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const meta = {
      syncProductCategories: jest.fn(),
      syncProductTags: jest.fn(),
    } as unknown as ProductMetaService;
    const service = new ProductsService(prisma as never, audit, meta);
    return { service, prisma };
  }

  it("getById only requests COMMERCIAL-dimension category maps (never Dosage Form/Schedule/RegType)", async () => {
    const { service, prisma } = makeService();

    await service.getById(tenantId, productId);

    const call = prisma.product.findFirst.mock.calls[0][0];
    expect(call.include.categoryMaps.where).toEqual({
      dimension: "COMMERCIAL",
    });
  });

  it("list() only requests COMMERCIAL-dimension category maps for the products table", async () => {
    const { service, prisma } = makeService();
    // $transaction in the real PrismaService runs an array of promises — mock it the same way.
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn(
      (ops: Promise<unknown>[]) => Promise.all(ops),
    );
    prisma.product.findMany.mockResolvedValue([]);

    await service.list(tenantId, undefined, {});

    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.include.categoryMaps.where).toEqual({
      dimension: "COMMERCIAL",
    });
  });

  it("a product's returned `categories` never includes a non-COMMERCIAL map, so editing round-trips safely", async () => {
    const { service } = makeService();

    const product = await service.getById(tenantId, productId);

    // Every id in here is what the web edit form sends back as `categoryIds` on save —
    // if this ever includes a Dosage Form/Schedule/RegType id, ProductMetaService.
    // syncProductCategories will reject the save with "One or more categories are invalid".
    expect(product.categories).toEqual([
      { id: "cat-commercial-1", name: "Anti-infectives" },
    ]);
  });

  it("scopes the final product update by tenant as well as id", async () => {
    const { service, prisma } = makeService();
    await service.update(tenantId, "user-1", productId, {
      name: "Updated name",
    });
    expect(prisma.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: productId, tenantId } }),
    );
  });

  it("scopes the final product delete by tenant as well as id", async () => {
    const { service, prisma } = makeService();
    await service.remove(tenantId, "user-1", productId);
    expect(prisma.product.deleteMany).toHaveBeenCalledWith({
      where: { id: productId, tenantId },
    });
  });
});

/**
 * Range status is the field that lets "we sell this" be said out loud, separately from
 * `isActive` ("this record is enabled"). Bulk actions are the escape hatch for a catalog that
 * was imported too broadly, so they must move exactly the rows they claim to and must never
 * collapse the two flags back into one.
 */
describe("ProductsService — bulk range/status actions", () => {
  const tenantId = "tenant-1";
  const userId = "user-1";

  /**
   * `rows` are what `applyRangeExit` sees when it loads the products it was asked to remove;
   * `stock` is the per-product on-hand total the ledger reports. Both default to the easy case
   * (a register-derived product with no history and no stock) so a test only states the part
   * it is actually about.
   */
  function makeService(
    opts: {
      rows?: unknown[];
      stock?: Array<{ productId: string; qty: number }>;
    } = {},
  ) {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue(opts.rows ?? []),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      productCategory: { findMany: jest.fn().mockResolvedValue([]) },
      stockLedger: {
        groupBy: jest
          .fn()
          .mockResolvedValue(
            (opts.stock ?? []).map((s) => ({
              productId: s.productId,
              _sum: { qtyDelta: s.qty },
            })),
          ),
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const meta = {
      syncProductCategories: jest.fn(),
      syncProductTags: jest.fn(),
    } as unknown as ProductMetaService;
    const service = new ProductsService(prisma as never, audit, meta);
    return { service, prisma, audit };
  }

  it("ranging only touches REFERENCE rows, so an already-ranged product keeps its original rangedAt", async () => {
    const { service, prisma } = makeService();

    await service.bulkUpdate(tenantId, userId, {
      action: "range",
      productIds: ["p1", "p2"],
    });

    const call = prisma.product.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      tenantId,
      id: { in: ["p1", "p2"] },
      rangeStatus: "REFERENCE",
    });
    expect(call.data.rangeStatus).toBe("RANGED");
    expect(call.data.rangedAt).toBeInstanceOf(Date);
  });

  const registerDerived = {
    id: "p1",
    name: "Amlodipine 5mg Tablet",
    source: "NMRA",
    rangeStatus: "RANGED",
    nmraReferenceId: "ref-1",
    _count: { saleItems: 0, purchaseItems: 0, receiptItems: 0 },
  };

  it("un-ranging a register-derived product leaves isActive alone — the two flags answer different questions", async () => {
    const { service, prisma } = makeService({ rows: [registerDerived] });

    await service.bulkUpdate(tenantId, userId, {
      action: "unrange",
      productIds: ["p1"],
    });

    const call = prisma.product.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ rangeStatus: "REFERENCE", rangedAt: null });
    expect(call.data).not.toHaveProperty("isActive");
  });

  /**
   * The reference catalog is the NMRA register. A product the shop typed in itself has no
   * business appearing there, so "stop selling this" deactivates it instead — otherwise one
   * bulk action files local records into the authoritative registry.
   */
  it("un-ranging a locally created product deactivates it instead of filing it into the register", async () => {
    const { service, prisma } = makeService({
      rows: [
        {
          id: "p2",
          name: "House-brand Cotton Wool 100g",
          source: "MANUAL",
          rangeStatus: "RANGED",
          nmraReferenceId: null,
          _count: { saleItems: 0, purchaseItems: 0, receiptItems: 0 },
        },
      ],
    });

    await service.bulkUpdate(tenantId, userId, {
      action: "unrange",
      productIds: ["p2"],
    });

    const call = prisma.product.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ isActive: false });
    expect(call.where.id).toEqual({ in: ["p2"] });
  });

  it("refuses to un-range a product that still has stock on hand", async () => {
    const { service, prisma } = makeService({
      rows: [registerDerived],
      stock: [{ productId: "p1", qty: 42 }],
    });

    const result = await service.applyRangeExit(tenantId, ["p1"]);

    expect(result.changed).toBe(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].reason).toContain("42 units on hand");
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it("keeps a register-derived product with sales history in the range, deactivated", async () => {
    const { service } = makeService({
      rows: [
        {
          ...registerDerived,
          _count: { saleItems: 3, purchaseItems: 0, receiptItems: 0 },
        },
      ],
    });

    const result = await service.applyRangeExit(tenantId, ["p1"]);

    expect(result.unranged).toEqual([]);
    expect(result.deactivated).toEqual(["p1"]);
    expect(result.notes[0]).toContain("sales or purchasing history");
  });

  it("activate/deactivate leave rangeStatus alone", async () => {
    const { service, prisma } = makeService();

    await service.bulkUpdate(tenantId, userId, {
      action: "deactivate",
      productIds: ["p1"],
    });

    const call = prisma.product.updateMany.mock.calls[0][0];
    expect(call.data).toEqual({ isActive: false });
    expect(call.data).not.toHaveProperty("rangeStatus");
  });

  it("rejects a request that sends both an id list and a filter", async () => {
    const { service } = makeService();

    await expect(
      service.bulkUpdate(tenantId, userId, {
        action: "range",
        productIds: ["p1"],
        filter: { rangeStatus: "REFERENCE" },
      }),
    ).rejects.toThrow(/either productIds or filter/i);
  });

  it("resolves the filter form server-side and scopes the update by tenant", async () => {
    const { service, prisma } = makeService();
    prisma.product.count.mockResolvedValue(2);
    prisma.product.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);

    const result = await service.bulkUpdate(tenantId, userId, {
      action: "range",
      filter: { rangeStatus: "REFERENCE", commercialCategoryId: undefined },
    });

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } }),
    );
    expect(prisma.product.updateMany.mock.calls[0][0].where.tenantId).toBe(
      tenantId,
    );
    expect(result).toEqual({ matched: 2, updated: 2, action: "range" });
  });

  it("refuses a filter selection above the bulk ceiling instead of rewriting the catalog", async () => {
    const { service, prisma } = makeService();
    prisma.product.count.mockResolvedValue(25_001);

    await expect(
      service.bulkUpdate(tenantId, userId, { action: "unrange", filter: {} }),
    ).rejects.toThrow(/above the limit/i);
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
  });

  it("does not write an audit event when nothing actually changed", async () => {
    const { service, prisma, audit } = makeService();
    prisma.product.updateMany.mockResolvedValue({ count: 0 });

    await service.bulkUpdate(tenantId, userId, {
      action: "range",
      productIds: ["p1"],
    });

    expect(audit.log).not.toHaveBeenCalled();
  });
});
