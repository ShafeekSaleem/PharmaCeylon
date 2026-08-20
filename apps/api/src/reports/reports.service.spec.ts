import { Prisma } from "@prisma/client";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { ReportsService } from "./reports.service";

type PrismaMock = {
  saleItem: { findMany: jest.Mock };
};

function saleItem(productId: string, qty: number, lineTotal: number, costPrice: number) {
  return {
    productId,
    qty,
    lineTotal: new Prisma.Decimal(lineTotal),
    batch: { costPrice: new Prisma.Decimal(costPrice) },
  };
}

describe("ReportsService.salesByCategory", () => {
  const tenantId = "tenant-1";
  let prisma: PrismaMock;
  let taxonomy: {
    primaryCommercialCategoryByProductIds: jest.Mock;
    regulatoryCategoryByProductIds: jest.Mock;
  };
  let service: ReportsService;

  beforeEach(() => {
    prisma = { saleItem: { findMany: jest.fn() } };
    taxonomy = {
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()),
      regulatoryCategoryByProductIds: jest.fn().mockResolvedValue(new Map()),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("rolls up the primary COMMERCIAL category to its parent department, carrying the leaf as a child", async () => {
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 2, 100, 40)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        [
          "p1",
          {
            id: "cat-pain-fever",
            name: "Pain & Fever",
            parentCategoryId: "cat-medicines",
            parent: { id: "cat-medicines", name: "Medicines" },
          },
        ],
      ]),
    );

    const result = await service.salesByCategory(tenantId, "branch-1", 30);

    expect(result.groupedBy).toBe("commercial");
    expect(taxonomy.primaryCommercialCategoryByProductIds).toHaveBeenCalledWith(tenantId, ["p1"]);
    expect(result.categories).toEqual([
      expect.objectContaining({
        categoryId: "cat-medicines",
        name: "Medicines",
        revenue: "100",
        cost: "80",
        margin: "20",
        unitsSold: 2,
        children: [
          expect.objectContaining({ categoryId: "cat-pain-fever", name: "Pain & Fever", revenue: "100", unitsSold: 2 }),
        ],
      }),
    ]);
  });

  it("sums two leaf categories under the same department into one parent row with two children", async () => {
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 1, 60, 20), saleItem("p2", 1, 40, 15)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-derma", name: "Dermatology", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const result = await service.salesByCategory(tenantId, null, 30);

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]).toEqual(
      expect.objectContaining({ categoryId: "cat-medicines", name: "Medicines", revenue: "100", unitsSold: 2 }),
    );
    // Children sorted descending by revenue — the higher-selling leaf comes first.
    expect(result.categories[0]!.children!.map((c) => c.categoryId)).toEqual(["cat-pain-fever", "cat-derma"]);
  });

  it("a product tagged directly on a root department (no leaf) rolls up to itself", async () => {
    // primaryCommercialCategoryByProductIds only ever returns the isPrimary map (asserted in
    // category-taxonomy.service.spec.ts) — this test locks in that salesByCategory attributes
    // 100% of a sale line to exactly one category, never splitting/duplicating it.
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 1, 50, 20)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-primary", name: "Primary Category", parentCategoryId: null, parent: null }]]),
    );

    const result = await service.salesByCategory(tenantId, null, 30);

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0]).toEqual(
      expect.objectContaining({ categoryId: "cat-primary", revenue: "50" }),
    );
  });

  it("buckets products with no commercial mapping as Uncategorized instead of dropping them", async () => {
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p-unmapped", 1, 30, 10)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.salesByCategory(tenantId, null, 30);

    expect(result.categories).toEqual([
      expect.objectContaining({ categoryId: "uncategorized", name: "Uncategorized", revenue: "30" }),
    ]);
  });

  it("groupBy=dosageForm delegates to the DOSAGE_FORM regulatory lens, not commercial", async () => {
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 1, 10, 5)]);
    taxonomy.regulatoryCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "tablet-id", name: "Tablet" }]]),
    );

    const result = await service.salesByCategory(tenantId, null, 30, "dosageForm");

    expect(result.groupedBy).toBe("dosageForm");
    expect(taxonomy.regulatoryCategoryByProductIds).toHaveBeenCalledWith(tenantId, ["p1"], "DOSAGE_FORM");
    expect(taxonomy.primaryCommercialCategoryByProductIds).not.toHaveBeenCalled();
    expect(result.categories[0]).toEqual(expect.objectContaining({ name: "Tablet" }));
  });

  it("groupBy=registrationType delegates to the REGISTRATION_TYPE lens and falls back to Unspecified", async () => {
    prisma.saleItem.findMany.mockResolvedValue([saleItem("p-unmapped", 1, 10, 5)]);
    taxonomy.regulatoryCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.salesByCategory(tenantId, null, 30, "registrationType");

    expect(taxonomy.regulatoryCategoryByProductIds).toHaveBeenCalledWith(tenantId, ["p-unmapped"], "REGISTRATION_TYPE");
    expect(result.categories[0]).toEqual(expect.objectContaining({ name: "Unspecified" }));
  });

  it("groupBy=schedule still groups by the plain Product.schedule field (no category lookup)", async () => {
    prisma.saleItem.findMany.mockResolvedValue([
      { productId: "p1", qty: 1, lineTotal: new Prisma.Decimal(20), batch: { costPrice: new Prisma.Decimal(8) }, product: { schedule: "II A" } },
    ]);

    const result = await service.salesByCategory(tenantId, null, 30, "schedule");

    expect(result.groupedBy).toBe("schedule");
    expect(taxonomy.primaryCommercialCategoryByProductIds).not.toHaveBeenCalled();
    expect(taxonomy.regulatoryCategoryByProductIds).not.toHaveBeenCalled();
    expect(result.categories[0]).toEqual(expect.objectContaining({ name: "II A", revenue: "20" }));
  });

  describe("isUnclassified", () => {
    it("flags the real 'Unclassified Medicines' commercial category by its stable canonicalKey on the child row, not the parent department", async () => {
      prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 1, 10, 5)]);
      taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
        new Map([
          [
            "p1",
            {
              id: "cat-unclassified",
              name: "Unclassified Medicines",
              parentCategoryId: "cat-medicines",
              canonicalKey: UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
              parent: { id: "cat-medicines", name: "Medicines" },
            },
          ],
        ]),
      );

      const result = await service.salesByCategory(tenantId, null, 30);

      // The department itself ("Medicines") isn't unclassified — only the leaf safety-net
      // bucket rolled up underneath it is.
      expect(result.categories[0]).toEqual(expect.objectContaining({ categoryId: "cat-medicines", isUnclassified: false }));
      expect(result.categories[0]!.children![0]).toEqual(expect.objectContaining({ isUnclassified: true }));
    });

    it("does not flag a normal commercial category", async () => {
      prisma.saleItem.findMany.mockResolvedValue([saleItem("p1", 1, 10, 5)]);
      taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
        new Map([
          [
            "p1",
            {
              id: "cat-pain-fever",
              name: "Pain & Fever",
              parentCategoryId: "cat-medicines",
              canonicalKey: "PAIN_FEVER",
              parent: { id: "cat-medicines", name: "Medicines" },
            },
          ],
        ]),
      );

      const result = await service.salesByCategory(tenantId, null, 30);

      expect(result.categories[0]).toEqual(expect.objectContaining({ isUnclassified: false }));
      expect(result.categories[0]!.children![0]).toEqual(expect.objectContaining({ isUnclassified: false }));
    });

    it("flags the synthetic 'uncategorized' bucket for commercial, dosageForm, and registrationType", async () => {
      prisma.saleItem.findMany.mockResolvedValue([saleItem("p-unmapped", 1, 30, 10)]);
      taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());
      taxonomy.regulatoryCategoryByProductIds.mockResolvedValue(new Map());

      const commercial = await service.salesByCategory(tenantId, null, 30, "commercial");
      const dosageForm = await service.salesByCategory(tenantId, null, 30, "dosageForm");
      const registrationType = await service.salesByCategory(tenantId, null, 30, "registrationType");

      expect(commercial.categories[0]).toEqual(expect.objectContaining({ isUnclassified: true }));
      expect(dosageForm.categories[0]).toEqual(expect.objectContaining({ isUnclassified: true }));
      expect(registrationType.categories[0]).toEqual(expect.objectContaining({ isUnclassified: true }));
    });

    it("flags 'Unscheduled' for groupBy=schedule but not a real schedule value", async () => {
      prisma.saleItem.findMany.mockResolvedValue([
        { productId: "p1", qty: 1, lineTotal: new Prisma.Decimal(20), batch: { costPrice: new Prisma.Decimal(8) }, product: { schedule: "II A" } },
        { productId: "p2", qty: 1, lineTotal: new Prisma.Decimal(15), batch: { costPrice: new Prisma.Decimal(5) }, product: { schedule: null } },
      ]);

      const result = await service.salesByCategory(tenantId, null, 30, "schedule");

      const scheduled = result.categories.find((c) => c.name === "II A");
      const unscheduled = result.categories.find((c) => c.name === "Unscheduled");
      expect(scheduled).toEqual(expect.objectContaining({ isUnclassified: false }));
      expect(unscheduled).toEqual(expect.objectContaining({ isUnclassified: true }));
    });
  });
});

/**
 * The Profitability suite (Gross Profit, Margin by Product, Margin by Category) reads the same
 * underlying `SaleItem` rows through two different aggregations (`marginByProduct` groups by
 * product, `salesByCategory` groups by commercial category). Both must sum to the same total
 * gross profit for the same filters — this pins that down as a regression test rather than
 * leaving "the pages must reconcile" as an unverified claim.
 */
describe("ReportsService profitability reconciliation", () => {
  const tenantId = "tenant-1";
  let prisma: {
    saleItem: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
  };
  let taxonomy: {
    primaryCommercialCategoryByProductIds: jest.Mock;
    regulatoryCategoryByProductIds: jest.Mock;
  };
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      saleItem: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      primaryCommercialCategoryByProductIds: jest.fn(),
      regulatoryCategoryByProductIds: jest.fn().mockResolvedValue(new Map()),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("marginByProduct's summed gross profit equals salesByCategory's (commercial) total gross profit", async () => {
    const rows = [
      {
        productId: "p1",
        qty: 2,
        lineTotal: new Prisma.Decimal(100),
        batch: { costPrice: new Prisma.Decimal(20) },
        product: { id: "p1", sku: "SKU1", name: "Product 1" },
        sale: { id: "s1", soldAt: new Date() },
      },
      {
        productId: "p2",
        qty: 1,
        lineTotal: new Prisma.Decimal(50),
        batch: { costPrice: new Prisma.Decimal(30) },
        product: { id: "p2", sku: "SKU2", name: "Product 2" },
        sale: { id: "s2", soldAt: new Date() },
      },
    ];
    prisma.saleItem.findMany.mockResolvedValue(rows);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        [
          "p1",
          {
            id: "cat-pain-fever",
            name: "Pain & Fever",
            parentCategoryId: "cat-medicines",
            parent: { id: "cat-medicines", name: "Medicines" },
          },
        ],
        [
          "p2",
          {
            id: "cat-oral-care",
            name: "Oral Care",
            parentCategoryId: "cat-personal-care",
            parent: { id: "cat-personal-care", name: "Personal Care" },
          },
        ],
      ]),
    );

    const marginRows = await service.marginByProduct(tenantId, null, 30);
    const categoryResult = await service.salesByCategory(tenantId, null, 30, "commercial");

    const marginTotal = marginRows.reduce((s, r) => s + Number(r.margin), 0);
    const categoryTotal = categoryResult.categories.reduce((s, r) => s + Number(r.margin), 0);

    // p1: revenue 100, cost 20*2=40, margin 60. p2: revenue 50, cost 30*1=30, margin 20. Total 80.
    expect(marginTotal).toBeCloseTo(80, 5);
    expect(categoryTotal).toBeCloseTo(80, 5);
    expect(marginTotal).toBeCloseTo(categoryTotal, 5);
  });
});
