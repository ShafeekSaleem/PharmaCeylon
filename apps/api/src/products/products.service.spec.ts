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
    product: { findFirst: jest.Mock; findMany: jest.Mock; count: jest.Mock };
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
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const meta = { syncProductCategories: jest.fn(), syncProductTags: jest.fn() } as unknown as ProductMetaService;
    const service = new ProductsService(prisma as never, audit, meta);
    return { service, prisma };
  }

  it("getById only requests COMMERCIAL-dimension category maps (never Dosage Form/Schedule/RegType)", async () => {
    const { service, prisma } = makeService();

    await service.getById(tenantId, productId);

    const call = prisma.product.findFirst.mock.calls[0][0];
    expect(call.include.categoryMaps.where).toEqual({ dimension: "COMMERCIAL" });
  });

  it("list() only requests COMMERCIAL-dimension category maps for the products table", async () => {
    const { service, prisma } = makeService();
    // $transaction in the real PrismaService runs an array of promises — mock it the same way.
    (prisma as unknown as { $transaction: jest.Mock }).$transaction = jest.fn((ops: Promise<unknown>[]) =>
      Promise.all(ops),
    );
    prisma.product.findMany.mockResolvedValue([]);

    await service.list(tenantId, undefined, {});

    const call = prisma.product.findMany.mock.calls[0][0];
    expect(call.include.categoryMaps.where).toEqual({ dimension: "COMMERCIAL" });
  });

  it("a product's returned `categories` never includes a non-COMMERCIAL map, so editing round-trips safely", async () => {
    const { service } = makeService();

    const product = await service.getById(tenantId, productId);

    // Every id in here is what the web edit form sends back as `categoryIds` on save —
    // if this ever includes a Dosage Form/Schedule/RegType id, ProductMetaService.
    // syncProductCategories will reject the save with "One or more categories are invalid".
    expect(product.categories).toEqual([{ id: "cat-commercial-1", name: "Anti-infectives" }]);
  });
});
