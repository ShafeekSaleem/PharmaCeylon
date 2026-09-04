import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { ProductOrganizeService } from "./product-organize.service";

const tenantId = "tenant-1";
const unclassifiedId = "cat-unclassified";

function makePrisma() {
  return {
    product: {
      count: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    productCategory: {
      findFirst: jest.fn().mockResolvedValue({ id: unclassifiedId }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeTaxonomy() {
  return { commercialCanonicalIds: jest.fn().mockResolvedValue(new Map()) };
}

describe("ProductOrganizeService.coverage", () => {
  it("reports a fully organized catalog as 100%, not 0%, when nothing is ranged yet", async () => {
    const prisma = makePrisma();
    prisma.product.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    const coverage = await service.coverage(tenantId);

    expect(coverage).toEqual({ ranged: 0, categorized: 0, unplaced: 0, percent: 100 });
  });

  it("derives categorized and percent from ranged vs. unplaced", async () => {
    const prisma = makePrisma();
    prisma.product.count.mockResolvedValueOnce(100).mockResolvedValueOnce(25);
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    const coverage = await service.coverage(tenantId);

    expect(coverage).toEqual({ ranged: 100, categorized: 75, unplaced: 25, percent: 75 });
  });

  it("scopes the unplaced count to the tenant's own ranged products, excluding reference rows", async () => {
    const prisma = makePrisma();
    prisma.product.count.mockResolvedValueOnce(10).mockResolvedValueOnce(3);
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    await service.coverage(tenantId);

    const unplacedCall = prisma.product.count.mock.calls[1][0];
    expect(unplacedCall.where.tenantId).toBe(tenantId);
    expect(unplacedCall.where.rangeStatus).toBe("RANGED");
  });
});

describe("ProductOrganizeService.unplaced", () => {
  it("matches products with no primary commercial category, or only the Unclassified one", async () => {
    const prisma = makePrisma();
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    await service.unplaced(tenantId);

    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(tenantId);
    expect(where.rangeStatus).toBe("RANGED");
    expect(where.OR).toEqual([
      { categoryMaps: { none: { dimension: "COMMERCIAL", isPrimary: true } } },
      {
        categoryMaps: {
          some: { dimension: "COMMERCIAL", isPrimary: true, categoryId: unclassifiedId },
        },
      },
    ]);
  });

  it("falls back to only the no-category clause when the tenant has no Unclassified row", async () => {
    const prisma = makePrisma();
    prisma.productCategory.findFirst.mockResolvedValue(null);
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    await service.unplaced(tenantId);

    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
    expect(where.categoryMaps).toEqual({
      none: { dimension: "COMMERCIAL", isPrimary: true },
    });
  });

  it("clamps take to the page-size ceiling and skip to non-negative", async () => {
    const prisma = makePrisma();
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    await service.unplaced(tenantId, -5, 10000);

    const args = prisma.product.findMany.mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(200);
  });

  it("attaches a suggestion by resolving the classifier's canonicalKey to this tenant's category id", async () => {
    const prisma = makePrisma();
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Metformin 500mg",
        sku: "SKU-1",
        brandName: null,
        genericName: "METFORMIN",
        dosageForm: "TABLET",
        strength: "500mg",
      },
    ]);
    prisma.productCategory.findMany.mockResolvedValue([
      { id: "cat-diabetes", name: "Diabetes Care", parentCategoryId: "cat-medicines" },
      { id: "cat-medicines", name: "Medicines", parentCategoryId: null },
    ]);
    const taxonomy = makeTaxonomy();
    taxonomy.commercialCanonicalIds.mockResolvedValue(
      new Map([["MEDICINES_DIABETES_CARE", "cat-diabetes"]]),
    );
    const service = new ProductOrganizeService(
      prisma as never,
      taxonomy as unknown as CategoryTaxonomyService,
    );

    const { items } = await service.unplaced(tenantId);

    expect(items[0].suggestion).toEqual({
      categoryId: "cat-diabetes",
      categoryName: "Diabetes Care",
      categoryPath: "Medicines › Diabetes Care",
      confidence: 0.85,
    });
  });

  it("returns a null suggestion when the classifier misses or the tenant hasn't seeded that category", async () => {
    const prisma = makePrisma();
    prisma.product.findMany.mockResolvedValue([
      {
        id: "p1",
        name: "Unrecognisable Widget",
        sku: "SKU-1",
        brandName: null,
        genericName: null,
        dosageForm: null,
        strength: null,
      },
    ]);
    const service = new ProductOrganizeService(
      prisma as never,
      makeTaxonomy() as unknown as CategoryTaxonomyService,
    );

    const { items } = await service.unplaced(tenantId);

    expect(items[0].suggestion).toBeNull();
  });
});
