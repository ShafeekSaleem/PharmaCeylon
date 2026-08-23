import { Prisma } from "@prisma/client";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { ReportsService } from "./reports.service";

type PrismaMock = {
  saleItem: { findMany: jest.Mock };
  goodsReturnItem: { findMany: jest.Mock };
};

function saleItem(productId: string, qty: number, lineTotal: number, costPrice: number) {
  return {
    productId,
    qty,
    lineTotal: new Prisma.Decimal(lineTotal),
    batch: { costPrice: new Prisma.Decimal(costPrice) },
  };
}

/** A completed customer return — the only status `netCustomerReturnItems` nets. Omit `costPrice`
 *  to simulate a batch-less return item (COGS reversal skipped, not fabricated). */
function returnItem(productId: string, qty: number, unitPrice: number, costPrice?: number) {
  return {
    productId,
    qty,
    unitPrice: new Prisma.Decimal(unitPrice),
    batchId: costPrice != null ? "batch-1" : null,
    batch: costPrice != null ? { costPrice: new Prisma.Decimal(costPrice) } : null,
    product: { sku: "SKU-RET", name: "Returned Product", brandName: null, schedule: null },
    goodsReturn: { createdAt: new Date() },
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
    prisma = { saleItem: { findMany: jest.fn() }, goodsReturnItem: { findMany: jest.fn().mockResolvedValue([]) } };
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

describe("ReportsService.marginTrendByCategory", () => {
  const tenantId = "tenant-1";
  let prisma: PrismaMock;
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;

  function trendItem(productId: string, qty: number, lineTotal: number, costPrice: number, soldAt: Date) {
    return { ...saleItem(productId, qty, lineTotal, costPrice), sale: { soldAt } };
  }

  beforeEach(() => {
    prisma = { saleItem: { findMany: jest.fn() }, goodsReturnItem: { findMany: jest.fn().mockResolvedValue([]) } };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("rolls a leaf category up to its parent department and keys points by (date, departmentId)", async () => {
    const day1 = new Date("2026-01-01T09:00:00Z");
    prisma.saleItem.findMany.mockResolvedValue([trendItem("p1", 2, 100, 40, day1)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const result = await service.marginTrendByCategory(tenantId, "branch-1", 30);

    expect(result.points).toEqual([
      { date: "2026-01-01", categoryId: "cat-medicines", name: "Medicines", revenue: "100", cost: "80" },
    ]);
  });

  it("keeps separate days as separate points instead of collapsing the whole range into one total", async () => {
    const day1 = new Date("2026-01-01T09:00:00Z");
    const day2 = new Date("2026-01-02T09:00:00Z");
    prisma.saleItem.findMany.mockResolvedValue([
      trendItem("p1", 1, 50, 20, day1),
      trendItem("p1", 1, 30, 20, day2),
    ]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-medicines", name: "Medicines", parentCategoryId: null, parent: null }]]),
    );

    const result = await service.marginTrendByCategory(tenantId, null, 30);

    expect(result.points).toHaveLength(2);
    expect(result.points.find((p) => p.date === "2026-01-01")).toEqual(expect.objectContaining({ revenue: "50" }));
    expect(result.points.find((p) => p.date === "2026-01-02")).toEqual(expect.objectContaining({ revenue: "30" }));
  });

  it("buckets a product with no commercial mapping as Uncategorized instead of dropping it", async () => {
    const day1 = new Date("2026-01-01T09:00:00Z");
    prisma.saleItem.findMany.mockResolvedValue([trendItem("p-unmapped", 1, 30, 10, day1)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.marginTrendByCategory(tenantId, null, 30);

    expect(result.points).toEqual([
      expect.objectContaining({ categoryId: "uncategorized", name: "Uncategorized", revenue: "30" }),
    ]);
  });

  it("nets a completed return into the bucket for the return's own date, not the original sale's date", async () => {
    const saleDay = new Date("2026-01-01T09:00:00Z");
    const returnDay = new Date("2026-01-05T09:00:00Z");
    prisma.saleItem.findMany.mockResolvedValue([trendItem("p1", 2, 100, 20, saleDay)]);
    prisma.goodsReturnItem.findMany.mockResolvedValue([
      { ...saleItem("p1", 1, 0, 0), unitPrice: new Prisma.Decimal(50), batchId: "b1", batch: { costPrice: new Prisma.Decimal(20) }, goodsReturn: { createdAt: returnDay } },
    ]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-medicines", name: "Medicines", parentCategoryId: null, parent: null }]]),
    );

    const result = await service.marginTrendByCategory(tenantId, null, 30);

    expect(result.points).toEqual([
      expect.objectContaining({ date: "2026-01-01", revenue: "100", cost: "40" }),
      expect.objectContaining({ date: "2026-01-05", revenue: "-50", cost: "-20" }),
    ]);
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
    goodsReturnItem: { findMany: jest.Mock };
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
      goodsReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
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

  it("still reconciles with a completed customer return present — both methods net it identically", async () => {
    const rows = [
      {
        productId: "p1",
        qty: 2,
        lineTotal: new Prisma.Decimal(100),
        batch: { costPrice: new Prisma.Decimal(20) },
        product: { id: "p1", sku: "SKU1", name: "Product 1" },
        sale: { id: "s1", soldAt: new Date() },
      },
    ];
    prisma.saleItem.findMany.mockResolvedValue(rows);
    prisma.goodsReturnItem.findMany.mockResolvedValue([returnItem("p1", 1, 50, 20)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const marginRows = await service.marginByProduct(tenantId, null, 30);
    const categoryResult = await service.salesByCategory(tenantId, null, 30, "commercial");

    const marginTotal = marginRows.reduce((s, r) => s + Number(r.margin), 0);
    const categoryTotal = categoryResult.categories.reduce((s, r) => s + Number(r.margin), 0);

    // Sale: revenue 100, cost 40. Return: revenue -50, cost -20. Net: revenue 50, cost 20, margin 30.
    expect(marginTotal).toBeCloseTo(30, 5);
    expect(categoryTotal).toBeCloseTo(30, 5);
    expect(marginTotal).toBeCloseTo(categoryTotal, 5);
  });

  it("marginByProduct nets a completed return against its matching in-window sale", async () => {
    prisma.saleItem.findMany.mockResolvedValue([
      { productId: "p1", qty: 3, lineTotal: new Prisma.Decimal(150), batch: { costPrice: new Prisma.Decimal(20) }, product: { id: "p1", sku: "SKU1", name: "Product 1" }, sale: { id: "s1", soldAt: new Date() } },
    ]);
    prisma.goodsReturnItem.findMany.mockResolvedValue([returnItem("p1", 1, 50, 20)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const [row] = await service.marginByProduct(tenantId, null, 30);

    // Revenue: 150 - 50 = 100. Cost: 60 - 20 = 40. Units: 3 - 1 = 2.
    expect(row).toEqual(expect.objectContaining({ revenue: "100", cost: "40", margin: "60", unitsSold: 2 }));
  });

  it("marginByProduct still nets a return for a product with no in-window sale, instead of dropping it", async () => {
    prisma.saleItem.findMany.mockResolvedValue([]);
    prisma.goodsReturnItem.findMany.mockResolvedValue([returnItem("p-returned-only", 1, 40, 15)]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const rows = await service.marginByProduct(tenantId, null, 30);

    expect(rows).toEqual([
      expect.objectContaining({ productId: "p-returned-only", revenue: "-40", cost: "-15", margin: "-25", unitsSold: -1 }),
    ]);
  });

  it("marginByProduct skips the COGS reversal (but still nets revenue) for a return with no resolvable batch", async () => {
    prisma.saleItem.findMany.mockResolvedValue([
      { productId: "p1", qty: 2, lineTotal: new Prisma.Decimal(100), batch: { costPrice: new Prisma.Decimal(20) }, product: { id: "p1", sku: "SKU1", name: "Product 1" }, sale: { id: "s1", soldAt: new Date() } },
    ]);
    prisma.goodsReturnItem.findMany.mockResolvedValue([returnItem("p1", 1, 50)]); // no costPrice → batchId/batch both null
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const [row] = await service.marginByProduct(tenantId, null, 30);

    // Revenue nets (100 - 50 = 50); cost does not (stays 40, the full original sale cost).
    expect(row).toEqual(expect.objectContaining({ revenue: "50", cost: "40" }));
  });

  it("only requests completed customer returns within the window, not other statuses/types", async () => {
    prisma.saleItem.findMany.mockResolvedValue([]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    await service.marginByProduct(tenantId, "branch-1", 30);

    expect(prisma.goodsReturnItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId,
          goodsReturn: expect.objectContaining({ type: "customer", status: "completed", branchId: "branch-1" }),
        }),
      }),
    );
  });

  it("excludes voided sales from marginByProduct (only posted/partially_refunded count)", async () => {
    prisma.saleItem.findMany.mockResolvedValue([]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    await service.marginByProduct(tenantId, "branch-1", 30);

    expect(prisma.saleItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sale: expect.objectContaining({ status: { in: ["posted", "partially_refunded"] } }),
        }),
      }),
    );
  });

  it("marginByProduct passes through the product's brand name (null when unset)", async () => {
    prisma.saleItem.findMany.mockResolvedValue([
      {
        productId: "p1",
        qty: 1,
        lineTotal: new Prisma.Decimal(20),
        batch: { costPrice: new Prisma.Decimal(8) },
        product: { id: "p1", sku: "SKU1", name: "Product 1", brandName: "Zylo" },
      },
      {
        productId: "p2",
        qty: 1,
        lineTotal: new Prisma.Decimal(15),
        batch: { costPrice: new Prisma.Decimal(5) },
        product: { id: "p2", sku: "SKU2", name: "Product 2", brandName: null },
      },
    ]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const marginRows = await service.marginByProduct(tenantId, null, 30);

    expect(marginRows.find((r) => r.productId === "p1")?.brandName).toBe("Zylo");
    expect(marginRows.find((r) => r.productId === "p2")?.brandName).toBeNull();
  });
});

describe("ReportsService.branchMargin", () => {
  const tenantId = "tenant-1";
  let prisma: {
    branch: { findMany: jest.Mock };
    saleItem: { findMany: jest.Mock };
    goodsReturnItem: { findMany: jest.Mock };
  };
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      branch: { findMany: jest.fn().mockResolvedValue([]) },
      saleItem: { findMany: jest.fn().mockResolvedValue([]) },
      goodsReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ReportsService(prisma as never, {} as unknown as CategoryTaxonomyService);
  });

  it("returns every active branch, including one with zero activity in the window, instead of only branches with sales", async () => {
    prisma.branch.findMany.mockResolvedValue([
      { id: "b1", code: "MAIN", name: "Main", city: "Colombo" },
      { id: "b2", code: "QUIET", name: "Quiet Branch", city: "Galle" },
    ]);
    prisma.saleItem.findMany.mockResolvedValue([
      { qty: 2, lineTotal: new Prisma.Decimal(100), batch: { costPrice: new Prisma.Decimal(20) }, sale: { branchId: "b1" } },
    ]);

    const result = await service.branchMargin(tenantId, 30);

    expect(result.branches).toEqual([
      expect.objectContaining({ branchId: "b1", revenue: "100", cost: "40", margin: "60", unitsSold: 2 }),
      expect.objectContaining({ branchId: "b2", revenue: "0", cost: "0", margin: "0", unitsSold: 0 }),
    ]);
  });

  it("nets a completed customer return against the branch it was returned at, even across two branches", async () => {
    prisma.branch.findMany.mockResolvedValue([
      { id: "b1", code: "MAIN", name: "Main", city: "Colombo" },
      { id: "b2", code: "OTHER", name: "Other", city: "Kandy" },
    ]);
    prisma.saleItem.findMany.mockResolvedValue([
      { qty: 1, lineTotal: new Prisma.Decimal(100), batch: { costPrice: new Prisma.Decimal(40) }, sale: { branchId: "b1" } },
    ]);
    // Bought at b1, returned at b2 (e.g. a customer who moved cities) — the return should net
    // against b2, not silently against b1 just because that's where the original sale happened.
    prisma.goodsReturnItem.findMany.mockResolvedValue([
      { ...returnItem("p1", 1, 30, 10), goodsReturn: { createdAt: new Date(), branchId: "b2" } },
    ]);

    const result = await service.branchMargin(tenantId, 30);

    expect(result.branches).toEqual([
      expect.objectContaining({ branchId: "b1", revenue: "100", cost: "40", margin: "60" }),
      expect.objectContaining({ branchId: "b2", revenue: "-30", cost: "-10", margin: "-20" }),
    ]);
  });

  it("excludes voided sales and only requests completed customer returns", async () => {
    await service.branchMargin(tenantId, 30);

    expect(prisma.saleItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ sale: expect.objectContaining({ status: { in: ["posted", "partially_refunded"] } }) }) }),
    );
    expect(prisma.goodsReturnItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ goodsReturn: expect.objectContaining({ type: "customer", status: "completed" }) }) }),
    );
  });
});

describe("ReportsService.branchMarginTrend", () => {
  const tenantId = "tenant-1";
  let prisma: {
    branch: { findMany: jest.Mock };
    saleItem: { findMany: jest.Mock };
    goodsReturnItem: { findMany: jest.Mock };
  };
  let service: ReportsService;

  beforeEach(() => {
    prisma = {
      branch: { findMany: jest.fn().mockResolvedValue([]) },
      saleItem: { findMany: jest.fn().mockResolvedValue([]) },
      goodsReturnItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new ReportsService(prisma as never, {} as unknown as CategoryTaxonomyService);
  });

  it("keys points by (date, branchId), keeping two branches on the same day as separate points", async () => {
    const day1 = new Date("2026-01-01T09:00:00Z");
    prisma.branch.findMany.mockResolvedValue([
      { id: "b1", name: "Main" },
      { id: "b2", name: "Other" },
    ]);
    prisma.saleItem.findMany.mockResolvedValue([
      { qty: 1, lineTotal: new Prisma.Decimal(50), batch: { costPrice: new Prisma.Decimal(20) }, sale: { branchId: "b1", soldAt: day1 } },
      { qty: 1, lineTotal: new Prisma.Decimal(30), batch: { costPrice: new Prisma.Decimal(10) }, sale: { branchId: "b2", soldAt: day1 } },
    ]);

    const result = await service.branchMarginTrend(tenantId, 30);

    expect(result.points).toEqual([
      expect.objectContaining({ date: "2026-01-01", branchId: "b1", name: "Main", revenue: "50", cost: "20" }),
      expect.objectContaining({ date: "2026-01-01", branchId: "b2", name: "Other", revenue: "30", cost: "10" }),
    ]);
  });

  it("nets a completed return into the bucket for its own date and branch", async () => {
    const saleDay = new Date("2026-01-01T09:00:00Z");
    const returnDay = new Date("2026-01-05T09:00:00Z");
    prisma.branch.findMany.mockResolvedValue([{ id: "b1", name: "Main" }]);
    prisma.saleItem.findMany.mockResolvedValue([
      { qty: 2, lineTotal: new Prisma.Decimal(100), batch: { costPrice: new Prisma.Decimal(20) }, sale: { branchId: "b1", soldAt: saleDay } },
    ]);
    prisma.goodsReturnItem.findMany.mockResolvedValue([
      { ...returnItem("p1", 1, 50, 20), goodsReturn: { createdAt: returnDay, branchId: "b1" } },
    ]);

    const result = await service.branchMarginTrend(tenantId, 30);

    expect(result.points).toEqual([
      expect.objectContaining({ date: "2026-01-01", revenue: "100", cost: "40" }),
      expect.objectContaining({ date: "2026-01-05", revenue: "-50", cost: "-20" }),
    ]);
  });
});

describe("ReportsService.nearExpiry", () => {
  const tenantId = "tenant-1";
  let prisma: {
    batch: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
    branch: { findMany: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock; commercialCanonicalIds: jest.Mock };
  let service: ReportsService;

  function batchRow(overrides: Partial<{ id: string; productId: string; batchNo: string; expiryDate: Date; costPrice: number }> = {}) {
    const expiryDate = overrides.expiryDate ?? new Date(Date.now() + 10 * 86_400_000);
    return {
      id: overrides.id ?? "b1",
      productId: overrides.productId ?? "p1",
      batchNo: overrides.batchNo ?? "BATCH-1",
      expiryDate,
      costPrice: new Prisma.Decimal(overrides.costPrice ?? 50),
      product: { id: overrides.productId ?? "p1", sku: "SKU1", name: "Product One" },
    };
  }

  beforeEach(() => {
    prisma = {
      batch: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
      branch: { findMany: jest.fn().mockResolvedValue([]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      // Default: "p1" sits under Medicines → Pain & Fever, so most tests (which don't care about
      // category specifically) get a real, in-scope item without having to set this up themselves.
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(
        new Map([
          ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }],
        ]),
      ),
      commercialCanonicalIds: jest.fn().mockResolvedValue(new Map([["MEDICINES", "cat-medicines"]])),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("computes valueAtRisk and daysLeft from the current stock quantity", async () => {
    const expiryDate = new Date();
    expiryDate.setHours(0, 0, 0, 0);
    expiryDate.setDate(expiryDate.getDate() + 10);
    prisma.batch.findMany.mockResolvedValue([batchRow({ expiryDate, costPrice: 50 })]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 20 } }]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ batchId: "b1", qtyOnHand: 20, valueAtRisk: "1000", daysLeft: 10 }));
  });

  it("drops a batch whose current quantity has been fully consumed", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 0 } }]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(0);
  });

  it("resolves the LEAF sub-category, not the Medicines department itself, as categoryId/categoryName", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: "cat-pain-fever", categoryName: "Pain & Fever" }));
  });

  it("excludes a product outside the Medicines department entirely", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-skincare", name: "Skin Care", parentCategoryId: "cat-personal-care", canonicalKey: null, parent: { id: "cat-personal-care", name: "Personal Care" } }]]),
    );

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(0);
  });

  it("excludes a product with no commercial category mapping at all", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(0);
  });

  it("includes a product tagged directly on the Medicines root (no leaf sub-category)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-medicines", name: "Medicines", parentCategoryId: null, canonicalKey: "MEDICINES", parent: null }]]),
    );

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: "cat-medicines", categoryName: "Medicines" }));
  });

  it("traces a batch's supplier through its goods-receipt line, three hops from Batch", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme Pharma" } } } },
    ]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ supplierId: "sup-1", supplierName: "Acme Pharma" }));
  });

  it("falls back to 'Unknown supplier' when no receipt line resolves a supplier", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ supplierId: null, supplierName: "Unknown supplier" }));
  });

  it("filters items by categoryId (leaf sub-category) and supplierId", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    prisma.stockLedger.groupBy.mockResolvedValue([
      { batchId: "b1", _sum: { qtyDelta: 5 } },
      { batchId: "b2", _sum: { qtyDelta: 5 } },
    ]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-anti-infectives", name: "Anti-infectives", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_ANTI_INFECTIVES", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const result = await service.nearExpiry(tenantId, "branch-1", 90, "cat-pain-fever");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.categoryId).toBe("cat-pain-fever");
  });

  it("reconstructs the previous period's snapshot from ledger quantity as of withinDays ago", async () => {
    const expiryDate = new Date();
    expiryDate.setHours(0, 0, 0, 0);
    expiryDate.setDate(expiryDate.getDate() - 2); // already expired as of "today"
    prisma.batch.findMany.mockResolvedValue([batchRow({ expiryDate, costPrice: 10 })]);
    prisma.stockLedger.groupBy.mockImplementation((args: { where: { occurredAt?: unknown } }) => {
      // Fewer units had arrived yet as of withinDays ago than are on hand today.
      if (args.where.occurredAt) return Promise.resolve([{ batchId: "b1", _sum: { qtyDelta: 3 } }]);
      return Promise.resolve([{ batchId: "b1", _sum: { qtyDelta: 8 } }]);
    });

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ qtyOnHand: 8, daysLeft: -2 }));
    expect(result.previousItems[0]).toEqual(expect.objectContaining({ qtyOnHand: 3, daysLeft: 88 }));
  });

  it("transferOpportunity is null under All Branches scope (branchId null) — there's no single 'this branch' to move stock away from", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 20 } }]);
    prisma.branch.findMany.mockResolvedValue([{ id: "branch-2", name: "Kandy Branch 2" }]);
    prisma.saleItem.groupBy.mockResolvedValue([{ productId: "p1", _sum: { qty: 90 } }]);

    const result = await service.nearExpiry(tenantId, null, 90);

    expect(result.items[0]!.transferOpportunity).toBeNull();
  });

  it("transferOpportunity is null for a single-branch tenant (no other branch to check)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 20 } }]);
    prisma.branch.findMany.mockResolvedValue([]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]!.transferOpportunity).toBeNull();
    expect(prisma.saleItem.groupBy).not.toHaveBeenCalled();
  });

  it("recommends transferring to whichever other branch sells this product fastest, capped at qty on hand", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 5 } }]); // only 5 on hand
    prisma.branch.findMany.mockResolvedValue([
      { id: "branch-2", name: "Kandy Branch 2" },
      { id: "branch-3", name: "Colombo Branch" },
    ]);
    prisma.saleItem.groupBy.mockImplementation((args: { where: { sale: { branchId: string } } }) => {
      // Branch 3 sells 1/day (90 over 90 days), Branch 2 sells 0.5/day (45 over 90 days) — Branch 3 wins.
      if (args.where.sale.branchId === "branch-3") return Promise.resolve([{ productId: "p1", _sum: { qty: 90 } }]);
      if (args.where.sale.branchId === "branch-2") return Promise.resolve([{ productId: "p1", _sum: { qty: 45 } }]);
      return Promise.resolve([]);
    });

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]!.transferOpportunity).toEqual(
      expect.objectContaining({ toBranchId: "branch-3", toBranchName: "Colombo Branch", toBranchAvgDailySales: 1, suggestedUnits: 5 }),
    );
  });

  it("transferOpportunity is null when no other branch has any real demand for the product", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockResolvedValue([{ batchId: "b1", _sum: { qtyDelta: 20 } }]);
    prisma.branch.findMany.mockResolvedValue([{ id: "branch-2", name: "Kandy Branch 2" }]);
    prisma.saleItem.groupBy.mockResolvedValue([]);

    const result = await service.nearExpiry(tenantId, "branch-1", 90);

    expect(result.items[0]!.transferOpportunity).toBeNull();
  });
});

describe("ReportsService.stockAgeing", () => {
  const tenantId = "tenant-1";
  let prisma: {
    batch: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock; commercialCanonicalIds: jest.Mock };
  let service: ReportsService;

  function daysAgo(n: number): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - n);
    return d;
  }

  function batchRow(
    overrides: Partial<{ id: string; productId: string; batchNo: string; receivedAt: Date; costPrice: number; sellingPrice: number }> = {},
  ) {
    return {
      id: overrides.id ?? "b1",
      productId: overrides.productId ?? "p1",
      batchNo: overrides.batchNo ?? "BATCH-1",
      receivedAt: overrides.receivedAt ?? daysAgo(100),
      costPrice: new Prisma.Decimal(overrides.costPrice ?? 50),
      sellingPrice: new Prisma.Decimal(overrides.sellingPrice ?? 100),
    };
  }

  /** Constant on-hand qty regardless of the as-of date being queried (current, 30-days-ago,
   *  every trend month) — fine for every test except the ones that specifically exercise the
   *  `receivedAt`-based existence check, which doesn't depend on ledger quantity at all. */
  function mockConstantQty(qtyByBatch: Record<string, number>) {
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id in qtyByBatch).map((id) => ({ batchId: id, _sum: { qtyDelta: qtyByBatch[id] } }))),
    );
  }

  /** `qtyByBatch` sums are per 90-day velocity window — 90 => 1/day, 9 => 0.1/day, etc. Own-branch
   *  vs. other-branches calls are distinguished by whether `where.sale.branchId` is a `{ not }`
   *  clause (the cross-branch-demand check) or a plain branch id (this branch's own velocity). */
  function mockVelocity(ownQty: number, otherBranchQty = 0, productId = "p1") {
    prisma.saleItem.groupBy.mockImplementation(({ where }: { where: { sale?: { branchId?: unknown } } }) => {
      const branchClause = where.sale?.branchId;
      const isOtherBranches = !!branchClause && typeof branchClause === "object" && "not" in (branchClause as object);
      return Promise.resolve([{ productId, _sum: { qty: isOtherBranches ? otherBranchQty : ownQty } }]);
    });
  }

  beforeEach(() => {
    prisma = {
      batch: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One" }]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      // Default: "p1" sits under Medicines → Pain & Fever, so most tests (which don't care about
      // category specifically) get a real, in-scope item without having to set this up themselves.
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(
        new Map([["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }]]),
      ),
      commercialCanonicalIds: jest.fn().mockResolvedValue(new Map([["MEDICINES", "cat-medicines"]])),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
    mockConstantQty({ b1: 20 });
  });

  it("computes ageDays, ageBucket, and value from receivedAt and current stock quantity", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(45), costPrice: 50 })]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ batchId: "b1", ageDays: 45, ageBucket: "31-60", qtyOnHand: 20, value: "1000" }));
  });

  it("drops a batch whose current quantity has been fully consumed", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 0 });

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items).toHaveLength(0);
  });

  it("resolves the LEAF sub-category, not the Medicines department itself, as categoryId/categoryName", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: "cat-pain-fever", categoryName: "Pain & Fever" }));
  });

  it("includes a product tagged directly on the Medicines root (no leaf sub-category)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-medicines", name: "Medicines", parentCategoryId: null, canonicalKey: "MEDICINES", parent: null }]]),
    );

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: "cat-medicines", categoryName: "Medicines" }));
  });

  it("excludes a product outside the Medicines department entirely", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-skincare", name: "Skin Care", parentCategoryId: "cat-personal-care", canonicalKey: null, parent: { id: "cat-personal-care", name: "Personal Care" } }]]),
    );

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items).toHaveLength(0);
  });

  it("excludes a product with no commercial category mapping at all", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items).toHaveLength(0);
  });

  it("traces a batch's supplier through its goods-receipt line", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme Pharma" } } } },
    ]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ supplierId: "sup-1", supplierName: "Acme Pharma" }));
  });

  it("falls back to 'Unknown supplier' when no receipt line resolves a supplier", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ supplierId: null, supplierName: "Unknown supplier" }));
  });

  it("filters the batch population by categoryId (leaf sub-category) before any quantity query", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: null, parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-anti-infectives", name: "Anti-infectives", parentCategoryId: "cat-medicines", canonicalKey: null, parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const result = await service.stockAgeing(tenantId, "branch-1", "cat-pain-fever");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.categoryId).toBe("cat-pain-fever");
  });

  it("filters the batch population by supplierId", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p1" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme Pharma" } } } },
      { batchId: "b2", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-2", name: "Other Supplier" } } } },
    ]);

    const result = await service.stockAgeing(tenantId, "branch-1", undefined, "sup-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.supplierId).toBe("sup-1");
  });

  it("computes daysOfCover from qty on hand and average daily sales", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 90 });
    mockVelocity(45); // 45 units / 90 days = 0.5/day

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ avgDailySales: 0.5, daysOfCover: 180 }));
  });

  it("returns null daysOfCover (not Infinity or a fabricated number) when there is no sales history", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockVelocity(0);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ avgDailySales: 0, daysOfCover: null }));
  });

  it("recommends Review for very old stock with almost no velocity anywhere", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(200) })]);
    mockVelocity(0);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]!.recommendation).toEqual({ key: "review", label: "Review" });
  });

  it("recommends Transfer when another branch sells this meaningfully faster than here", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(100) })]);
    mockVelocity(0, 20); // this branch: 0/day; other branches: 20/90 ≈ 0.22/day

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]!.recommendation).toEqual({ key: "transfer", label: "Transfer" });
  });

  it("recommends Discount for ageing stock with low velocity and no stronger demand elsewhere", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(100) })]);
    mockVelocity(9); // 9/90 = 0.1/day, below the low-velocity threshold

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]!.recommendation).toEqual({ key: "discount", label: "Discount" });
  });

  it("recommends Promote for ageing stock with healthy margin and decent velocity", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(100), costPrice: 50, sellingPrice: 100 })]);
    mockVelocity(45); // 0.5/day — comfortably above the low-velocity threshold

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]!.recommendation).toEqual({ key: "promote", label: "Promote" });
  });

  it("never flags stock 90 days old or younger — that's Near Expiry/Dead Stock's territory, not Stock Ageing's", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(90) })]);
    mockVelocity(0);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items[0]!.recommendation).toEqual({ key: "monitor", label: "Monitor" });
  });

  it("excludes a batch from previousItems if it hadn't been received yet 30 days ago", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(10) })]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.previousItems).toHaveLength(0);
  });

  it("includes a long-held batch in previousItems with age measured as of 30 days ago", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(100) })]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.previousItems[0]).toEqual(expect.objectContaining({ ageDays: 70, value: 1000, categoryId: "cat-pain-fever" }));
  });

  it("returns exactly 6 trend points, each bucket set summing back to that point's totalValue", async () => {
    // 200 days safely predates even the oldest (~5-month-back) trend point regardless of which
    // calendar month the test happens to run in, so the batch exists for the whole horizon.
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: daysAgo(200) })]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result.trend).toHaveLength(6);
    for (const point of result.trend) {
      const bucketSum = point.buckets.reduce((s, b) => s + b.value, 0);
      expect(bucketSum).toBeCloseTo(point.totalValue, 6);
    }
    // The batch has existed (and held the same qty) for the entire trend horizon, so every
    // point's total should reconcile to the same value — nothing silently dropped or double-counted.
    expect(result.trend.every((p) => p.totalValue === 1000)).toBe(true);
  });

  it("excludes a batch from earlier trend points if it wasn't received yet at that point in time", async () => {
    // The 1st of the current month is always strictly after every past trend point (each is the
    // *previous* month's last day) and always on/before "now" — safe regardless of today's date.
    const startOfThisMonth = new Date();
    startOfThisMonth.setHours(0, 0, 0, 0);
    startOfThisMonth.setDate(1);
    prisma.batch.findMany.mockResolvedValue([batchRow({ receivedAt: startOfThisMonth })]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    // Only the final ("now") point should include this batch — every past month-end predates it.
    const withoutLast = result.trend.slice(0, -1);
    expect(withoutLast.every((p) => p.totalValue === 0)).toBe(true);
    expect(result.trend[result.trend.length - 1]!.totalValue).toBe(1000);
  });

  it("returns nothing when the tenant/branch has no batches at all", async () => {
    prisma.batch.findMany.mockResolvedValue([]);

    const result = await service.stockAgeing(tenantId, "branch-1");

    expect(result).toEqual({ items: [], previousItems: [], trend: [] });
  });
});

describe("ReportsService.inventorySummary", () => {
  const tenantId = "tenant-1";
  let prisma: {
    batch: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    saleItem: { groupBy: jest.Mock; findMany: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;

  function batchRow(overrides: Partial<{ id: string; productId: string; costPrice: number; sellingPrice: number }> = {}) {
    return {
      id: overrides.id ?? "b1",
      productId: overrides.productId ?? "p1",
      costPrice: new Prisma.Decimal(overrides.costPrice ?? 50),
      sellingPrice: new Prisma.Decimal(overrides.sellingPrice ?? 100),
    };
  }

  /** Constant on-hand qty regardless of the as-of date queried (current, 30/20/10-days-ago) —
   *  fine for every test except the ones specifically exercising quantity-over-time. */
  function mockConstantQty(qtyByBatch: Record<string, number>) {
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id in qtyByBatch).map((id) => ({ batchId: id, _sum: { qtyDelta: qtyByBatch[id] } }))),
    );
  }

  /** `qty` is summed over the 90-day velocity window — 90 => 1/day, 0 => no sales at all. */
  function mockVelocity(qty: number, productId = "p1") {
    prisma.saleItem.groupBy.mockResolvedValue(qty > 0 ? [{ productId, _sum: { qty } }] : []);
  }

  beforeEach(() => {
    prisma = {
      batch: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 0 }]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]), findMany: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(
        new Map([["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }]]),
      ),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
    mockConstantQty({ b1: 20 });
  });

  it("computes value (at cost) and retailValue (at MRP) from qty and the batch's own prices", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 50, sellingPrice: 90 })]);
    mockConstantQty({ b1: 10 });

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ productId: "p1", qtyOnHand: 10, value: "500", retailValue: "900" }),
    );
  });

  it("sums two batches of the same product into one item", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", costPrice: 50 }), batchRow({ id: "b2", costPrice: 40 })]);
    mockConstantQty({ b1: 5, b2: 5 });

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ qtyOnHand: 10, value: "450" }));
  });

  it("rolls a leaf category up to its parent department", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]).toEqual(
      expect.objectContaining({ categoryId: "cat-pain-fever", categoryName: "Pain & Fever", departmentId: "cat-medicines", departmentName: "Medicines" }),
    );
  });

  it("a product mapped directly onto a top-level department (no parent) rolls up to itself", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-medicines", name: "Medicines", parentCategoryId: null, canonicalKey: "MEDICINES", parent: null }]]),
    );

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ departmentId: "cat-medicines", departmentName: "Medicines" }));
  });

  it("keeps a product with no COMMERCIAL mapping at all as Unclassified, never dropped", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map());

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: null, categoryName: "Unclassified", departmentId: null, departmentName: "Unclassified" }));
  });

  it("categoryId filters by top-level department, excluding products in other departments", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-vitamins", name: "Vitamins", parentCategoryId: null, parent: null }],
      ]),
    );

    const result = await service.inventorySummary(tenantId, "branch-1", "cat-medicines");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productId).toBe("p1");
  });

  it("supplierId filters to only batches sourced from that supplier", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme" } } } },
      { batchId: "b2", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-2", name: "Other Co" } } } },
    ]);

    const result = await service.inventorySummary(tenantId, "branch-1", undefined, "sup-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productId).toBe("p1");
  });

  it("computes daysOfCover from qty and velocity, null when there's no sales history", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 90 });
    mockVelocity(45); // 45/90 days = 0.5/day → 90/0.5 = 180 days of cover

    const withVelocity = await service.inventorySummary(tenantId, "branch-1");
    expect(withVelocity.items[0]).toEqual(expect.objectContaining({ avgDailySales: 0.5, daysOfCover: 180 }));

    mockVelocity(0);
    const withoutVelocity = await service.inventorySummary(tenantId, "branch-1");
    expect(withoutVelocity.items[0]).toEqual(expect.objectContaining({ avgDailySales: 0, daysOfCover: null }));
  });

  it("flags isLowStock when qty on hand is at or below a positive reorder level", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 5 });
    prisma.product.findMany.mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 10 }]);

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ qtyOnHand: 5, reorderLevel: 10, isLowStock: true }));
  });

  it("does not flag isLowStock when reorder level is unset (0)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 1 });

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ isLowStock: false }));
  });

  it("flags isAtRisk (capital at risk) only when there IS sales velocity but cover exceeds 180 days — never for zero-velocity stock", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 1000 });

    mockVelocity(45); // 0.5/day → 1000/0.5 = 2000 days of cover, well above 180 → at risk
    const slowMoving = await service.inventorySummary(tenantId, "branch-1");
    expect(slowMoving.items[0]!.isAtRisk).toBe(true);

    mockVelocity(0); // no sales at all → Dead Stock's territory, not Capital at Risk
    const zeroVelocity = await service.inventorySummary(tenantId, "branch-1");
    expect(zeroVelocity.items[0]!.isAtRisk).toBe(false);
  });

  it("does not flag isAtRisk when cover is within the healthy threshold", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 90 });
    mockVelocity(90); // 1/day → 90 days of cover, at the threshold's low side

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]!.isAtRisk).toBe(false);
  });

  it("previousItems reconstructs the 30-days-ago snapshot, including department rollup", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 50, sellingPrice: 90 })]);
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] }; occurredAt?: { lte: Date } } }) =>
      Promise.resolve(where.occurredAt ? [{ batchId: "b1", _sum: { qtyDelta: 8 } }] : [{ batchId: "b1", _sum: { qtyDelta: 10 } }]),
    );

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ qtyOnHand: 10, value: "500" }));
    expect(result.previousItems).toHaveLength(1);
    expect(result.previousItems[0]).toEqual(
      expect.objectContaining({ productId: "p1", qtyOnHand: 8, value: 400, retailValue: 720, departmentId: "cat-medicines", departmentName: "Medicines" }),
    );
  });

  it("trend has exactly 4 points (30/20/10 days ago, now) that each reconcile to their own department sum", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 50 })]);
    mockConstantQty({ b1: 20 });

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.trend.map((p) => p.key)).toEqual(["30d-ago", "20d-ago", "10d-ago", "now"]);
    for (const point of result.trend) {
      const deptSum = point.departments.reduce((s, d) => s + d.value, 0);
      expect(deptSum).toBeCloseTo(point.totalValue, 6);
      // Constant qty across every as-of date → every point should reconcile to the same value.
      expect(point.totalValue).toBe(1000);
    }
  });

  it("returns empty when the tenant/branch has no batches at all", async () => {
    prisma.batch.findMany.mockResolvedValue([]);

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result).toEqual({ items: [], previousItems: [], trend: [], skuUniverseCount: 0, salesByDepartment: [] });
  });

  it("aggregates across all branches when branchId is null, without deduplicating quantities", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" })]);
    mockConstantQty({ b1: 30 });

    await service.inventorySummary(tenantId, null);

    const call = prisma.batch.findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    expect("branchId" in call.where).toBe(false);
  });

  it("skuUniverseCount counts every distinct in-scope product, including ones currently out of stock (qty 0, absent from items)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id === "b1").map((id) => ({ batchId: id, _sum: { qtyDelta: 10 } }))),
    );

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.items).toHaveLength(1); // p2 has zero qty at every as-of date, so it never appears in items
    expect(result.skuUniverseCount).toBe(2); // but both p1 and p2 count toward the carried-SKU universe
  });

  it("salesByDepartment sums trailing-30-day revenue for in-scope products, rolled up to the same department id as items[].departmentId", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" })]);
    mockConstantQty({ b1: 10 });
    prisma.saleItem.findMany.mockResolvedValue([
      { productId: "p1", lineTotal: new Prisma.Decimal(300) },
      { productId: "p1", lineTotal: new Prisma.Decimal(200) },
    ]);

    const result = await service.inventorySummary(tenantId, "branch-1");

    expect(result.salesByDepartment).toEqual([
      { departmentId: "cat-medicines", departmentName: "Medicines", revenue: 500 },
    ]);
  });

  it("salesByDepartment excludes revenue from products outside the category/supplier filter scope", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 10, b2: 10 });
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-vitamins", name: "Vitamins", parentCategoryId: null, parent: null }],
      ]),
    );
    prisma.saleItem.findMany.mockImplementation(({ where }: { where: { productId: { in: string[] } } }) =>
      Promise.resolve(
        [
          { productId: "p1", lineTotal: new Prisma.Decimal(300) },
          { productId: "p2", lineTotal: new Prisma.Decimal(900) },
        ].filter((line) => where.productId.in.includes(line.productId)),
      ),
    );

    const result = await service.inventorySummary(tenantId, "branch-1", "cat-medicines");

    expect(result.salesByDepartment).toEqual([
      { departmentId: "cat-medicines", departmentName: "Medicines", revenue: 300 },
    ]);
  });
});

describe("ReportsService.deadStock", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T00:00:00.000Z");
  let prisma: {
    batch: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function batchRow(overrides: Partial<{ id: string; productId: string; costPrice: number }> = {}) {
    return {
      id: overrides.id ?? "b1",
      productId: overrides.productId ?? "p1",
      costPrice: new Prisma.Decimal(overrides.costPrice ?? 50),
    };
  }

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  /** Constant on-hand qty regardless of the as-of date queried — fine for every test except the
   *  ones specifically exercising quantity-over-time (the trend sparkline). */
  function mockConstantQty(qtyByBatch: Record<string, number>) {
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id in qtyByBatch).map((id) => ({ batchId: id, _sum: { qtyDelta: qtyByBatch[id] } }))),
    );
  }

  type SaleRecord = { productId: string; soldAt: Date; status?: "posted" | "voided" | "refunded" | "partially_refunded"; qty?: number };

  /** Faithfully replays `classifyDeadStock`'s `_max: createdAt` lookups (respecting the
   *  `soldAt: { lte: asOf }` bound each call supplies) and `residualVelocityByProduct`'s /
   *  `avgDailySalesByProduct`'s `_sum: qty` lookups (respecting `soldAt: { gte: since }`) — a
   *  static canned response can't do this since `deadStock` queries `saleItem.groupBy` at two
   *  different `asOf` dates (now and 30 days ago) in the same call. */
  function mockSales(sales: SaleRecord[]) {
    prisma.saleItem.groupBy.mockImplementation((args: { where: { productId: { in: string[] }; sale?: { status?: { in: string[] }; soldAt?: { lte?: Date; gte?: Date } } }; _max?: unknown; _sum?: unknown }) => {
      const ids = args.where.productId.in;
      const statuses = args.where.sale?.status?.in ?? ["posted", "voided", "refunded", "partially_refunded"];
      const lte = args.where.sale?.soldAt?.lte;
      const gte = args.where.sale?.soldAt?.gte;
      const matching = sales.filter(
        (s) =>
          ids.includes(s.productId) &&
          statuses.includes(s.status ?? "posted") &&
          (!lte || s.soldAt.getTime() <= lte.getTime()) &&
          (!gte || s.soldAt.getTime() >= gte.getTime()),
      );
      if (args._max) {
        const byProduct = new Map<string, Date>();
        for (const s of matching) {
          const cur = byProduct.get(s.productId);
          if (!cur || s.soldAt.getTime() > cur.getTime()) byProduct.set(s.productId, s.soldAt);
        }
        return Promise.resolve([...byProduct.entries()].map(([productId, createdAt]) => ({ productId, _max: { createdAt } })));
      }
      if (args._sum) {
        const byProduct = new Map<string, number>();
        for (const s of matching) byProduct.set(s.productId, (byProduct.get(s.productId) ?? 0) + (s.qty ?? 1));
        return Promise.resolve([...byProduct.entries()].map(([productId, qty]) => ({ productId, _sum: { qty } })));
      }
      return Promise.resolve([]);
    });
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });

  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      batch: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One" }]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(
        new Map([["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }]]),
      ),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
    mockConstantQty({ b1: 20 });
  });

  it("classifies a product with no qualifying sale in the threshold window as dead stock", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ productId: "p1", daysSinceLastSale: 120 }));
  });

  it("does not classify a product as dead when it sold within the threshold window", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(30) }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(0);
  });

  it("a product with no sale history at all is dead stock with daysSinceLastSale null", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.daysSinceLastSale).toBeNull();
  });

  it("a voided sale does not count as demand", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(5), status: "voided" }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.daysSinceLastSale).toBeNull();
  });

  it("a fully refunded sale does not count as demand, but a partially refunded one does", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([
      { productId: "p1", soldAt: daysAgo(200), status: "refunded" },
      { productId: "p1", soldAt: daysAgo(150), status: "partially_refunded" },
    ]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]!.daysSinceLastSale).toBe(150);
  });

  it("rolls a leaf category up to its parent department, same convention as Stock Value", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ categoryId: "cat-pain-fever", categoryName: "Pain & Fever", departmentId: "cat-medicines", departmentName: "Medicines" }));
  });

  it("categoryId filters by top-level department", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-vitamins", name: "Vitamins", parentCategoryId: null, parent: null }],
      ]),
    );

    const result = await service.deadStock(tenantId, "branch-1", 90, "cat-medicines");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productId).toBe("p1");
  });

  it("supplierId filters to only batches sourced from that supplier", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme" } } } },
      { batchId: "b2", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-2", name: "Other Co" } } } },
    ]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );

    const result = await service.deadStock(tenantId, "branch-1", 90, undefined, "sup-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productId).toBe("p1");
  });

  it("flags hasKnownSupplier/supplierName from the batch's receipt→PO→supplier chain", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.goodsReceiptItem.findMany.mockResolvedValue([{ batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme" } } } }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ hasKnownSupplier: true, supplierName: "Acme" }));
  });

  it("quadrant: high value + inactivity just past the threshold is recoverFast", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 100 })]);
    mockConstantQty({ b1: 100 }); // value 10,000 — the only item, so it's automatically the median
    mockSales([{ productId: "p1", soldAt: daysAgo(91) }]); // just past the 90-day threshold

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]!.quadrant).toBe("recoverFast");
  });

  it("quadrant: high value + inactivity at 2x the threshold is investigate", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 100 })]);
    mockConstantQty({ b1: 100 });
    mockSales([{ productId: "p1", soldAt: daysAgo(200) }]); // >= 2x the 90-day threshold

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]!.quadrant).toBe("investigate");
  });

  it("quadrant: below-median value + recent-ish inactivity is monitor; below-median + long inactivity is liquidate", async () => {
    // Two high-value anchors (p1, p4) pull the median well above the two low-value test items,
    // so p2/p3 land unambiguously below it — with an odd-length population the middle item's own
    // value *is* the median, which would tie into "high" under a `>=` comparison.
    prisma.batch.findMany.mockResolvedValue([
      batchRow({ id: "b1", productId: "p1", costPrice: 1_000_000 }),
      batchRow({ id: "b2", productId: "p2", costPrice: 5 }), // low value, recent inactivity → monitor
      batchRow({ id: "b3", productId: "p3", costPrice: 6 }), // low value, long inactivity → liquidate
      batchRow({ id: "b4", productId: "p4", costPrice: 900_000 }),
    ]);
    mockConstantQty({ b1: 1, b2: 1, b3: 1, b4: 1 });
    const medicinesCat = { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } };
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(new Map([["p1", medicinesCat], ["p2", medicinesCat], ["p3", medicinesCat], ["p4", medicinesCat]]));
    prisma.product.findMany.mockResolvedValue([
      { id: "p1", sku: "SKU1", name: "One" },
      { id: "p2", sku: "SKU2", name: "Two" },
      { id: "p3", sku: "SKU3", name: "Three" },
      { id: "p4", sku: "SKU4", name: "Four" },
    ]);
    mockSales([
      { productId: "p1", soldAt: daysAgo(91) },
      { productId: "p2", soldAt: daysAgo(91) },
      { productId: "p3", soldAt: daysAgo(200) },
      { productId: "p4", soldAt: daysAgo(91) },
    ]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    const byProduct = new Map(result.items.map((it) => [it.productId, it]));
    expect(byProduct.get("p2")!.quadrant).toBe("monitor");
    expect(byProduct.get("p3")!.quadrant).toBe("liquidate");
  });

  it("suggests transfer when another branch has real recent demand for the product", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    // classifyDeadStock's this-branch lastSold check and residualVelocityByProduct's this-branch
    // window both see only the 120-day-old sale (dead here); the separate cross-branch query
    // (keyed off `where.sale.branchId.not`) is the only one reporting real recent demand.
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);
    const original = prisma.saleItem.groupBy.getMockImplementation()!;
    prisma.saleItem.groupBy.mockImplementation((args: never) => {
      const a = args as { where: { sale?: { branchId?: { not?: string } } }; _sum?: unknown };
      if (a._sum && a.where.sale?.branchId?.not) {
        return Promise.resolve([{ productId: "p1", _sum: { qty: 20 } }]);
      }
      return original(args);
    });

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ crossBranchDemand: true, suggestedAction: "transfer" }));
  });

  it("does not suggest transfer under All Branches scope (branchId null) — there's no 'other branch' to check", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);

    const result = await service.deadStock(tenantId, null, 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ crossBranchDemand: false }));
    expect(result.items[0]!.suggestedAction).not.toBe("transfer");
  });

  it("suggests return_supplier for a known-supplier item worth at least the minimum value, absent cross-branch demand", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 100 })]);
    mockConstantQty({ b1: 10 }); // value 1,000 >= the 500 floor
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);
    prisma.goodsReceiptItem.findMany.mockResolvedValue([{ batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme" } } } }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]!.suggestedAction).toBe("return_supplier");
  });

  it("suggests review_assortment for a never-sold item with no supplier/cross-branch signal", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 1 })]);
    mockConstantQty({ b1: 1 }); // value 1 — well under the supplier-return floor

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]).toEqual(expect.objectContaining({ daysSinceLastSale: null, suggestedAction: "review_assortment" }));
  });

  it("recoveryValue is value × the suggested action's recovery factor", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ costPrice: 10 })]);
    mockConstantQty({ b1: 10 }); // value 100 — the only item, so automatically "high value" (== its own median)
    mockSales([{ productId: "p1", soldAt: daysAgo(200) }]); // >= 2x threshold → long inactivity → investigate → markdown (0.5)

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items[0]!.suggestedAction).toBe("markdown");
    expect(result.items[0]!.recoveryValue).toBe(50); // 100 × 0.5
  });

  it("previousItems independently reclassifies as of 30 days ago — a recently-idled product is dead now but wasn't yet", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    // Last real sale 95 days before "now" → dead now (95 > 90), but only 65 days before the
    // 30-days-ago reference point → not yet dead back then (65 <= 90).
    mockSales([{ productId: "p1", soldAt: daysAgo(95) }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.items).toHaveLength(1);
    expect(result.previousItems).toHaveLength(0);
  });

  it("returns empty when the tenant/branch has no batches at all", async () => {
    prisma.batch.findMany.mockResolvedValue([]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result).toEqual({ daysWithoutSale: 90, items: [], previousItems: [], trend: [] });
  });

  it("trend reconciles: each point's department sum equals its totalValue", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);

    const result = await service.deadStock(tenantId, "branch-1", 90);

    expect(result.trend.map((p) => p.key)).toEqual(["30d-ago", "20d-ago", "10d-ago", "now"]);
    for (const point of result.trend) {
      const deptSum = point.departments.reduce((s, d) => s + d.value, 0);
      expect(deptSum).toBeCloseTo(point.totalValue, 6);
    }
  });
});

describe("ReportsService.stockHealth", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T00:00:00.000Z");
  let prisma: {
    batch: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function batchRow(overrides: Partial<{ id: string; productId: string; costPrice: number }> = {}) {
    return {
      id: overrides.id ?? "b1",
      productId: overrides.productId ?? "p1",
      costPrice: new Prisma.Decimal(overrides.costPrice ?? 50),
    };
  }

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  function mockConstantQty(qtyByBatch: Record<string, number>) {
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id in qtyByBatch).map((id) => ({ batchId: id, _sum: { qtyDelta: qtyByBatch[id] } }))),
    );
  }

  type SaleRecord = { productId: string; soldAt: Date; status?: "posted" | "voided" | "refunded" | "partially_refunded"; qty?: number };

  /** Same dual-purpose (`_max: createdAt` for last-sale, `_sum: qty` for velocity) replay as
   *  Dead Stock's own `mockSales` helper — `stockHealth` queries `saleItem.groupBy` for both in
   *  the same call. */
  function mockSales(sales: SaleRecord[]) {
    prisma.saleItem.groupBy.mockImplementation((args: { where: { productId: { in: string[] }; sale?: { status?: { in: string[] }; soldAt?: { lte?: Date; gte?: Date } } }; _max?: unknown; _sum?: unknown }) => {
      const ids = args.where.productId.in;
      const statuses = args.where.sale?.status?.in ?? ["posted", "voided", "refunded", "partially_refunded"];
      const lte = args.where.sale?.soldAt?.lte;
      const gte = args.where.sale?.soldAt?.gte;
      const matching = sales.filter(
        (s) =>
          ids.includes(s.productId) &&
          statuses.includes(s.status ?? "posted") &&
          (!lte || s.soldAt.getTime() <= lte.getTime()) &&
          (!gte || s.soldAt.getTime() >= gte.getTime()),
      );
      if (args._max) {
        const byProduct = new Map<string, Date>();
        for (const s of matching) {
          const cur = byProduct.get(s.productId);
          if (!cur || s.soldAt.getTime() > cur.getTime()) byProduct.set(s.productId, s.soldAt);
        }
        return Promise.resolve([...byProduct.entries()].map(([productId, createdAt]) => ({ productId, _max: { createdAt } })));
      }
      if (args._sum) {
        const byProduct = new Map<string, number>();
        for (const s of matching) byProduct.set(s.productId, (byProduct.get(s.productId) ?? 0) + (s.qty ?? 1));
        return Promise.resolve([...byProduct.entries()].map(([productId, qty]) => ({ productId, _sum: { qty } })));
      }
      return Promise.resolve([]);
    });
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });

  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      batch: { findMany: jest.fn() },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 0 }]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = {
      primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(
        new Map([["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", canonicalKey: "MEDICINES_PAIN_FEVER", parent: { id: "cat-medicines", name: "Medicines" } }]]),
      ),
    };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
    mockConstantQty({ b1: 20 });
  });

  it("classifies a never-sold product as deadSlow", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(expect.objectContaining({ zone: "deadSlow", daysSinceLastSale: null }));
  });

  it("classifies a product idle beyond the 90-day threshold as deadSlow", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockSales([{ productId: "p1", soldAt: daysAgo(120) }]);

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ zone: "deadSlow", daysSinceLastSale: 120 }));
  });

  it("classifies a product below reorder level as reorderRisk when it still has recent sales (not dead)", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 5 });
    mockSales([{ productId: "p1", soldAt: daysAgo(2), qty: 5 }]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 10 }]);

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ zone: "reorderRisk", isLowStock: true }));
  });

  it("deadSlow takes priority over reorderRisk — a never-selling product isn't a reorder candidate just because it's also low on stock", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 2 });
    prisma.product.findMany.mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 10 }]);

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]!.zone).toBe("deadSlow");
  });

  it("classifies real-but-slow velocity with cover beyond 180 days as overstocked", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 1000 });
    // 45 units over the 90-day velocity window → 0.5/day → 1000/0.5 = 2000 days of cover.
    mockSales(Array.from({ length: 45 }, (_, i) => ({ productId: "p1", soldAt: daysAgo(i + 1) })));

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]).toEqual(expect.objectContaining({ zone: "overstocked", daysOfCover: 2000 }));
  });

  it("classifies low (but real and not-overstocked) velocity as monitor", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 5 });
    // 9 units over 90 days → 0.1/day (below the ~0.15/day low-velocity bar), 50 days of cover.
    mockSales(Array.from({ length: 9 }, (_, i) => ({ productId: "p1", soldAt: daysAgo(i + 1) })));

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]!.zone).toBe("monitor");
  });

  it("classifies healthy, adequately-stocked, normally-selling stock as healthy", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    mockConstantQty({ b1: 90 });
    // 90 units over 90 days → 1/day, 90 days of cover — comfortably inside every threshold.
    mockSales(Array.from({ length: 90 }, (_, i) => ({ productId: "p1", soldAt: daysAgo(i + 1) })));

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]!.zone).toBe("healthy");
  });

  it("skuUniverseCount counts every distinct in-scope carried product, including ones with zero current stock", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
      ]),
    );
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] } } }) =>
      Promise.resolve(where.batchId.in.filter((id) => id === "b1").map((id) => ({ batchId: id, _sum: { qtyDelta: 10 } }))),
    );

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items).toHaveLength(1);
    expect(result.skuUniverseCount).toBe(2);
  });

  it("previousItems reclassifies today's velocity/reorder lens against the 30-days-ago quantity", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow()]);
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { batchId: { in: string[] }; occurredAt?: { lte: Date } } }) =>
      Promise.resolve(where.occurredAt ? [{ batchId: "b1", _sum: { qtyDelta: 1000 } }] : [{ batchId: "b1", _sum: { qtyDelta: 90 } }]),
    );
    // 1/day velocity → today's 90 units = 90 days of cover (healthy), 30-days-ago's 1000 units = 1000 days of cover (overstocked).
    mockSales(Array.from({ length: 90 }, (_, i) => ({ productId: "p1", soldAt: daysAgo(i + 1) })));

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result.items[0]!.zone).toBe("healthy");
    expect(result.previousItems[0]).toEqual(expect.objectContaining({ qtyOnHand: 1000, zone: "overstocked" }));
  });

  it("categoryId filters by top-level department, excluding products in other departments", async () => {
    prisma.batch.findMany.mockResolvedValue([batchRow({ id: "b1", productId: "p1" }), batchRow({ id: "b2", productId: "p2" })]);
    mockConstantQty({ b1: 5, b2: 5 });
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([
        ["p1", { id: "cat-pain-fever", name: "Pain & Fever", parentCategoryId: "cat-medicines", parent: { id: "cat-medicines", name: "Medicines" } }],
        ["p2", { id: "cat-vitamins", name: "Vitamins", parentCategoryId: null, parent: null }],
      ]),
    );

    const result = await service.stockHealth(tenantId, "branch-1", "cat-medicines");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.productId).toBe("p1");
  });

  it("returns empty when the tenant/branch has no batches at all", async () => {
    prisma.batch.findMany.mockResolvedValue([]);

    const result = await service.stockHealth(tenantId, "branch-1");

    expect(result).toEqual({ items: [], previousItems: [], skuUniverseCount: 0 });
  });
});

describe("ReportsService.stockMovement", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: {
    stockLedger: { findMany: jest.Mock; groupBy: jest.Mock };
    product: { findMany: jest.Mock };
    batch: { findMany: jest.Mock };
    goodsReceiptItem: { findMany: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  type Row = { productId: string; movementType: string; qtyDelta: number; occurredAt: Date; batchId?: string | null; branchId?: string };

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  /** Discriminates `stockLedger.findMany`/`groupBy` calls by their own `where` clause — needed
   *  because `stockMovement` queries the ledger for the current window, the previous window, and
   *  (via `productQtyAsOf`) two different as-of dates, all against the same mock. */
  function mockLedger(rows: Row[]) {
    prisma.stockLedger.findMany.mockImplementation(({ where }: { where: { branchId?: string; movementType: { in: string[] }; occurredAt: { gte: Date; lte: Date } } }) => {
      const { gte, lte } = where.occurredAt;
      const matching = rows.filter(
        (r) =>
          where.movementType.in.includes(r.movementType) &&
          r.occurredAt.getTime() >= gte.getTime() &&
          r.occurredAt.getTime() <= lte.getTime() &&
          (!("branchId" in where) || r.branchId === where.branchId),
      );
      return Promise.resolve(matching.map((r) => ({ productId: r.productId, movementType: r.movementType, qtyDelta: r.qtyDelta, occurredAt: r.occurredAt, batchId: r.batchId ?? null })));
    });
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { branchId?: string; productId: { in: string[] }; occurredAt?: { lte: Date } } }) => {
      const byProduct = new Map<string, number>();
      for (const r of rows) {
        if (!where.productId.in.includes(r.productId)) continue;
        if ("branchId" in where && r.branchId !== where.branchId) continue;
        if (where.occurredAt?.lte && r.occurredAt.getTime() > where.occurredAt.lte.getTime()) continue;
        byProduct.set(r.productId, (byProduct.get(r.productId) ?? 0) + r.qtyDelta);
      }
      return Promise.resolve([...byProduct.entries()].map(([productId, qty]) => ({ productId, _sum: { qtyDelta: qty } })));
    });
  }

  function mockProducts(products: Array<{ id: string; sku?: string; name?: string; reorderLevel?: number }>) {
    prisma.product.findMany.mockResolvedValue(products.map((p) => ({ id: p.id, sku: p.sku ?? p.id.toUpperCase(), name: p.name ?? p.id, reorderLevel: p.reorderLevel ?? 0 })));
  }

  function mockCategories(byProduct: Record<string, { id: string; name: string; parentId: string | null; parentName?: string }>) {
    const map = new Map(
      Object.entries(byProduct).map(([pid, c]) => [
        pid,
        { id: c.id, name: c.name, parentCategoryId: c.parentId, canonicalKey: null, parent: c.parentId ? { id: c.parentId, name: c.parentName ?? c.name } : null },
      ]),
    );
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(map);
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });

  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      stockLedger: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      batch: { findMany: jest.fn().mockResolvedValue([]) },
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
    mockProducts([{ id: "p1", reorderLevel: 10 }]);
    mockCategories({ p1: { id: "cat-medicines", name: "Medicines", parentId: null } });
  });

  it("returns the empty shape when there are no active products and no ledger activity at all", async () => {
    mockProducts([]);
    const result = await service.stockMovement(tenantId, "branch-1", 30);
    expect(result.kpis).toEqual({
      inboundUnits: 0,
      prevInboundUnits: 0,
      outboundUnits: 0,
      prevOutboundUnits: 0,
      netMovementValue: 0,
      prevNetMovementValue: 0,
      reorderAlerts: 0,
      prevReorderAlerts: 0,
      inventoryTurnover: null,
      prevInventoryTurnover: null,
      sellThroughRate: null,
      prevSellThroughRate: null,
      avgDaysCover: null,
      prevAvgDaysCover: null,
      stockoutEvents: 0,
      prevStockoutEvents: 0,
    });
    expect(result.trend).toEqual([]);
    expect(result.topMovers).toEqual([]);
  });

  it("still reports Reorder Alerts from current stock even when the ledger has no activity in either window", async () => {
    mockProducts([{ id: "p1", reorderLevel: 10 }]); // 0 on-hand, reorderLevel 10 → "out" → 1 alert
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]); // this branch has carried p1 before
    const result = await service.stockMovement(tenantId, "branch-1", 30);
    expect(result.kpis.reorderAlerts).toBe(1);
    expect(result.kpis.inboundUnits).toBe(0);
  });

  it("Stock Flow Bridge reconciles opening + deltas to closing, and Movement Composition omits movement types that didn't occur", async () => {
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]); // carried at this branch
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 50, occurredAt: daysAgo(60), branchId: "branch-1" }, // pre-period → opening balance
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(10), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -30, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "transfer_out", qtyDelta: -10, occurredAt: daysAgo(3), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.stockFlowBridge).toEqual([
      { key: "opening", label: "Opening Stock", kind: "total", value: 50 },
      { key: "purchases", label: "Purchases", kind: "addition", value: 100 },
      { key: "sales", label: "Sales", kind: "deduction", value: 30 },
      { key: "transfersOut", label: "Transfers Out", kind: "deduction", value: 10 },
      { key: "closing", label: "Closing Stock", kind: "total", value: 110 },
    ]);
    expect(result.movementComposition).toEqual([
      { key: "purchases", label: "Purchases", direction: "in", units: 100 },
      { key: "sales", label: "Sales", direction: "out", units: 30 },
      { key: "transfersOut", label: "Transfers Out", direction: "out", units: 10 },
    ]);
  });

  it("computes Inventory Turnover, Sell-Through Rate and Average Days of Cover from opening/closing units and period sales", async () => {
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]);
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(60), branchId: "branch-1" }, // opening = 100
      { productId: "p1", movementType: "sale_out", qtyDelta: -60, occurredAt: daysAgo(10), branchId: "branch-1" }, // closing = 40
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    // sell-through = 60 sold ÷ (100 opening + 0 inbound this period) × 100
    expect(result.kpis.sellThroughRate).toBeCloseTo(60, 6);
    // avg days cover = 40 closing ÷ (60 ÷ 30 days)
    expect(result.kpis.avgDaysCover).toBeCloseTo(20, 6);
    // turnover = (60 ÷ avg-on-hand 70) annualized to 365/30 days
    expect(result.kpis.inventoryTurnover).toBeCloseTo((60 / 70) * (365 / 30), 6);
  });

  it("Stockout Events counts each transition from in-stock to zero-or-below during the period, not the count of times it happened to already be at zero", async () => {
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]);
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 5, occurredAt: daysAgo(60), branchId: "branch-1" }, // opening = 5
      { productId: "p1", movementType: "sale_out", qtyDelta: -5, occurredAt: daysAgo(20), branchId: "branch-1" }, // → 0 (event #1)
      { productId: "p1", movementType: "purchase_in", qtyDelta: 3, occurredAt: daysAgo(10), branchId: "branch-1" }, // → 3 (back in stock)
      { productId: "p1", movementType: "sale_out", qtyDelta: -3, occurredAt: daysAgo(2), branchId: "branch-1" }, // → 0 (event #2)
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.kpis.stockoutEvents).toBe(2);
  });

  it("classifies purchase_in as inbound and sale_out as outbound", async () => {
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -40, occurredAt: daysAgo(4), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.kpis.inboundUnits).toBe(100);
    expect(result.kpis.outboundUnits).toBe(40);
  });

  it("never counts transfer_reserve_out/release or quarantine entries as movement", async () => {
    mockLedger([
      { productId: "p1", movementType: "transfer_reserve_out", qtyDelta: -30, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "transfer_reserve_release", qtyDelta: 30, occurredAt: daysAgo(4), branchId: "branch-1" },
      { productId: "p1", movementType: "quarantine_hold", qtyDelta: -10, occurredAt: daysAgo(3), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.kpis.inboundUnits).toBe(0);
    expect(result.kpis.outboundUnits).toBe(0);
  });

  it("This branch scope: transfer_in counts as inbound, transfer_out as outbound", async () => {
    mockLedger([
      { productId: "p1", movementType: "transfer_in", qtyDelta: 20, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "transfer_out", qtyDelta: -15, occurredAt: daysAgo(4), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.kpis.inboundUnits).toBe(20);
    expect(result.kpis.outboundUnits).toBe(15);
    expect(result.internalTransferUnits).toBe(0);
  });

  it("All branches default view excludes transfer_in/transfer_out from the external KPIs and reports internalTransferUnits separately", async () => {
    mockLedger([
      { productId: "p1", movementType: "transfer_in", qtyDelta: 20, occurredAt: daysAgo(5), branchId: "branch-2" },
      { productId: "p1", movementType: "transfer_out", qtyDelta: -20, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "purchase_in", qtyDelta: 50, occurredAt: daysAgo(4), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, null, 30);

    expect(result.kpis.inboundUnits).toBe(50); // purchase only — transfer_in excluded
    expect(result.kpis.outboundUnits).toBe(0); // transfer_out excluded
    expect(result.internalTransferUnits).toBe(20); // the excluded transfer_out volume
  });

  it("All branches with an explicit transfers_out filter shows the transfer data directly (bypassing the default exclusion)", async () => {
    mockLedger([{ productId: "p1", movementType: "transfer_out", qtyDelta: -20, occurredAt: daysAgo(5), branchId: "branch-1" }]);

    const result = await service.stockMovement(tenantId, null, 30, undefined, undefined, "transfers_out");

    expect(result.kpis.outboundUnits).toBe(20);
  });

  it("movementType=adjustments narrows to only adjustment_in/adjustment_out", async () => {
    mockLedger([
      { productId: "p1", movementType: "adjustment_in", qtyDelta: 5, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "adjustment_out", qtyDelta: -3, occurredAt: daysAgo(4), branchId: "branch-1" },
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(3), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30, undefined, undefined, "adjustments");

    expect(result.kpis.inboundUnits).toBe(5);
    expect(result.kpis.outboundUnits).toBe(3);
  });

  it("movementType=returns_in groups customer_return_in, sale_void_in and sale_refund_in together", async () => {
    mockLedger([
      { productId: "p1", movementType: "customer_return_in", qtyDelta: 2, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_void_in", qtyDelta: 3, occurredAt: daysAgo(4), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_refund_in", qtyDelta: 1, occurredAt: daysAgo(3), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30, undefined, undefined, "returns_in");

    expect(result.kpis.inboundUnits).toBe(6);
  });

  it("categoryId filters ledger rows and Reorder Alerts to the top-level department", async () => {
    mockProducts([{ id: "p1", reorderLevel: 10 }, { id: "p2", reorderLevel: 10 }]);
    mockCategories({
      p1: { id: "cat-a", name: "Cat A", parentId: null },
      p2: { id: "cat-b", name: "Cat B", parentId: null },
    });
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 40, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "purchase_in", qtyDelta: 60, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30, "cat-a");

    expect(result.kpis.inboundUnits).toBe(40);
    expect(result.topMovers.map((t) => t.productId)).toEqual(["p1"]);
  });

  it("supplierId filters to products sourced from that supplier", async () => {
    mockProducts([{ id: "p1", reorderLevel: 10 }, { id: "p2", reorderLevel: 10 }]);
    mockCategories({
      p1: { id: "cat-medicines", name: "Medicines", parentId: null },
      p2: { id: "cat-medicines", name: "Medicines", parentId: null },
    });
    prisma.batch.findMany.mockResolvedValue([
      { id: "b1", productId: "p1" },
      { id: "b2", productId: "p2" },
    ]);
    prisma.goodsReceiptItem.findMany.mockResolvedValue([
      { batchId: "b1", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-1", name: "Acme" } } } },
      { batchId: "b2", goodsReceipt: { purchaseOrder: { supplier: { id: "sup-2", name: "Other Co" } } } },
    ]);
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 40, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "purchase_in", qtyDelta: 60, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30, undefined, "sup-1");

    expect(result.kpis.inboundUnits).toBe(40);
  });

  it("Net Movement Value uses cost-basis batch price, never retail, and ignores rows with no resolvable batch cost", async () => {
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 10, occurredAt: daysAgo(5), batchId: "b1", branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -4, occurredAt: daysAgo(4), batchId: "b1", branchId: "branch-1" },
      { productId: "p1", movementType: "adjustment_in", qtyDelta: 5, occurredAt: daysAgo(3), batchId: null, branchId: "branch-1" },
    ]);
    prisma.batch.findMany.mockImplementation(({ where }: { where: { id?: { in: string[] } } }) =>
      Promise.resolve(where.id?.in.includes("b1") ? [{ id: "b1", costPrice: new Prisma.Decimal(20) }] : []),
    );

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    // inbound value = 10 * 20 = 200 (the batchId:null adjustment_in row is skipped, not fabricated)
    // outbound value = 4 * 20 = 80
    expect(result.kpis.netMovementValue).toBe(120);
  });

  it("Reorder Alerts counts products at/under reorderLevel, independent of the movementType filter", async () => {
    mockProducts([{ id: "p1", reorderLevel: 50 }]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]);
    mockLedger([{ productId: "p1", movementType: "purchase_in", qtyDelta: 20, occurredAt: daysAgo(5), branchId: "branch-1" }]);

    const result = await service.stockMovement(tenantId, "branch-1", 30, undefined, undefined, "adjustments");

    // qtyOnHand (20) <= reorderLevel (50) → low stock, even though the movementType filter
    // excludes the purchase_in row that produced that quantity from the ledger panels.
    expect(result.kpis.reorderAlerts).toBe(1);
  });

  it("excludes a tenant-catalog product this branch has never carried from Reorder Alerts", async () => {
    // p1 is a real, active, understocked product this branch carries; p2 is active tenant-wide
    // (e.g. from a large NMRA-derived catalog) but has no batch at this branch at all — it isn't
    // something this branch needs to "reorder" just because it's active somewhere in the tenant.
    mockProducts([{ id: "p1", reorderLevel: 50 }, { id: "p2", reorderLevel: 50 }]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", productId: "p1" }]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.kpis.reorderAlerts).toBe(1);
  });

  it("Top Movers default-sorts by total movement (units out + in) descending", async () => {
    mockProducts([{ id: "p1" }, { id: "p2" }]);
    mockCategories({
      p1: { id: "cat-medicines", name: "Medicines", parentId: null },
      p2: { id: "cat-medicines", name: "Medicines", parentId: null },
    });
    mockLedger([
      { productId: "p1", movementType: "sale_out", qtyDelta: -10, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "sale_out", qtyDelta: -5, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "purchase_in", qtyDelta: 20, occurredAt: daysAgo(4), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    // p1 total movement = 10, p2 total movement = 25 → p2 first.
    expect(result.topMovers.map((t) => t.productId)).toEqual(["p2", "p1"]);
    expect(result.topMovers.find((t) => t.productId === "p2")!.netChange).toBe(15); // 20 in - 5 out
  });

  it("Top Movers reorderStatus: below reorderLevel wins priority over overstocking/watch", async () => {
    mockProducts([{ id: "p1", reorderLevel: 100 }]);
    mockLedger([{ productId: "p1", movementType: "sale_out", qtyDelta: -5, occurredAt: daysAgo(5), branchId: "branch-1" }]);
    // qtyOnHand ends at -5 clamped to 0 by qty tracking in this mock (no prior stock) — force a
    // known qty by adding an inbound row so on-hand is a deliberately low, non-zero number.
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 10, occurredAt: daysAgo(6), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -5, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    // qtyOnHand = 5, reorderLevel = 100 → "low" status → reorder, regardless of any other signal.
    expect(result.topMovers[0]).toEqual(expect.objectContaining({ productId: "p1", qtyOnHand: 5, reorderStatus: "reorder" }));
  });

  it("Top Movers reorderStatus: healthy stock with no reorder/overstock/watch signal", async () => {
    mockProducts([{ id: "p1", reorderLevel: 5 }]);
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(20), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -20, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    expect(result.topMovers[0]!.reorderStatus).toBe("healthy");
  });

  it("categoryMovement and categoryBreakdown reconcile exactly against the KPI totals", async () => {
    mockProducts([{ id: "p1" }, { id: "p2" }]);
    mockCategories({
      p1: { id: "cat-a", name: "Cat A", parentId: null },
      p2: { id: "cat-b", name: "Cat B", parentId: null },
    });
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 40, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "sale_out", qtyDelta: -15, occurredAt: daysAgo(4), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    const sumInbound = result.categoryMovement.reduce((s, c) => s + c.inboundUnits, 0);
    const sumOutbound = result.categoryMovement.reduce((s, c) => s + c.outboundUnits, 0);
    expect(sumInbound).toBe(result.kpis.inboundUnits);
    expect(sumOutbound).toBe(result.kpis.outboundUnits);
    expect(result.categoryBreakdown).toHaveLength(result.categoryMovement.length);
  });

  it("categoryBreakdown trend series sums to the main trend's netUnits at every bucket", async () => {
    mockProducts([{ id: "p1" }, { id: "p2" }]);
    mockCategories({
      p1: { id: "cat-a", name: "Cat A", parentId: null },
      p2: { id: "cat-b", name: "Cat B", parentId: null },
    });
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 40, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "sale_out", qtyDelta: -15, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "sale_out", qtyDelta: -10, occurredAt: daysAgo(1), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    for (let i = 0; i < result.trend.length; i++) {
      const deptSum = result.categoryBreakdown.reduce((s, c) => s + c.trend[i]!, 0);
      expect(deptSum).toBe(result.trend[i]!.netUnits);
    }
  });

  it("auto-selects daily granularity for short ranges and weekly for longer ones", async () => {
    mockLedger([{ productId: "p1", movementType: "purchase_in", qtyDelta: 10, occurredAt: daysAgo(5), branchId: "branch-1" }]);

    const short = await service.stockMovement(tenantId, "branch-1", 30);
    const long = await service.stockMovement(tenantId, "branch-1", 90);

    expect(short.granularity).toBe("daily");
    expect(long.granularity).toBe("weekly");
  });

  it("fastMovingCategory insight names the department with the most total movement", async () => {
    mockProducts([{ id: "p1" }, { id: "p2" }]);
    mockCategories({
      p1: { id: "cat-a", name: "Medicines", parentId: null },
      p2: { id: "cat-b", name: "Vitamins", parentId: null },
    });
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p2", movementType: "purchase_in", qtyDelta: 10, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    const insight = result.insights.find((i) => i.key === "fastMovingCategory");
    expect(insight?.description).toContain("Medicines");
  });

  it("highTransfersAdjustments insight only appears once the share crosses the materiality threshold", async () => {
    mockLedger([
      { productId: "p1", movementType: "sale_out", qtyDelta: -90, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "adjustment_in", qtyDelta: 5, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);

    const belowThreshold = await service.stockMovement(tenantId, "branch-1", 30);
    expect(belowThreshold.insights.find((i) => i.key === "highTransfersAdjustments")).toBeUndefined();

    mockLedger([
      { productId: "p1", movementType: "sale_out", qtyDelta: -50, occurredAt: daysAgo(5), branchId: "branch-1" },
      { productId: "p1", movementType: "adjustment_in", qtyDelta: 50, occurredAt: daysAgo(5), branchId: "branch-1" },
    ]);
    const aboveThreshold = await service.stockMovement(tenantId, "branch-1", 30);
    expect(aboveThreshold.insights.find((i) => i.key === "highTransfersAdjustments")).toBeDefined();
  });

  it("shrinkageVariance insight counts SKUs with negative stocktake variance above the 2% threshold", async () => {
    mockProducts([{ id: "p1" }]);
    mockLedger([
      { productId: "p1", movementType: "purchase_in", qtyDelta: 100, occurredAt: daysAgo(10), branchId: "branch-1" },
      { productId: "p1", movementType: "stocktake_out", qtyDelta: -10, occurredAt: daysAgo(2), branchId: "branch-1" },
    ]);

    const result = await service.stockMovement(tenantId, "branch-1", 30);

    // qtyOnHand=90, variance=10 → expected≈100 → variance% = 10% > 2%
    const insight = result.insights.find((i) => i.key === "shrinkageVariance");
    expect(insight?.countLabel).toBe("1 SKU");
  });
});

describe("ReportsService.transfersReport", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: {
    branch: { findMany: jest.Mock };
    transfer: { findMany: jest.Mock };
    batch: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }
  function hoursAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 3_600_000);
  }

  function transferRow(overrides: Partial<{
    id: string;
    transferNumber: string;
    fromBranchId: string;
    toBranchId: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
    items: Array<{ productId: string; qty: number; receivedQty: number; batchId: string | null }>;
  }> = {}) {
    return {
      id: overrides.id ?? "t1",
      transferNumber: overrides.transferNumber ?? "TR-0001",
      fromBranchId: overrides.fromBranchId ?? "branch-1",
      toBranchId: overrides.toBranchId ?? "branch-2",
      status: overrides.status ?? "received",
      createdAt: overrides.createdAt ?? daysAgo(5),
      updatedAt: overrides.updatedAt ?? daysAgo(4),
      items: overrides.items ?? [{ productId: "p1", qty: 10, receivedQty: 10, batchId: "b1" }],
    };
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });
  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      branch: { findMany: jest.fn().mockResolvedValue([{ id: "branch-1", name: "Kandy — Branch 1" }, { id: "branch-2", name: "Kandy — Branch 2" }]) },
      transfer: { findMany: jest.fn().mockResolvedValue([]) },
      batch: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("returns the empty shape for a single-branch tenant without querying transfers at all", async () => {
    prisma.branch.findMany.mockResolvedValue([{ id: "branch-1", name: "Only Branch" }]);

    const result = await service.transfersReport(tenantId, 30);

    expect(result.isMultiBranch).toBe(false);
    expect(result.kpis).toEqual({ transferCount: 0, prevTransferCount: 0, valueMoved: 0, prevValueMoved: 0, avgCompletionHours: null, prevAvgCompletionHours: null, successRatePct: null, prevSuccessRatePct: null });
    expect(prisma.transfer.findMany).not.toHaveBeenCalled();
  });

  it("computes transferCount, valueMoved (at cost, receivedQty only), avgCompletionHours and successRatePct", async () => {
    prisma.transfer.findMany.mockImplementation(({ where }: { where: { createdAt: { gte: Date; lte: Date } } }) => {
      const rows = [
        transferRow({ id: "t1", status: "received", createdAt: hoursAgo(48), updatedAt: hoursAgo(24) }), // 24h to complete
        transferRow({ id: "t2", status: "rejected", createdAt: daysAgo(3), items: [{ productId: "p2", qty: 5, receivedQty: 0, batchId: null }] }),
      ];
      return Promise.resolve(rows.filter((r) => r.createdAt.getTime() >= where.createdAt.gte.getTime() && r.createdAt.getTime() <= where.createdAt.lte.getTime()));
    });
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(20) }]);

    const result = await service.transfersReport(tenantId, 30);

    expect(result.kpis.transferCount).toBe(2);
    expect(result.kpis.valueMoved).toBe(200); // 10 units × 20 cost, t2's item has no batchId so contributes 0
    expect(result.kpis.avgCompletionHours).toBeCloseTo(24, 6);
    expect(result.kpis.successRatePct).toBe(50); // 1 received of 2 terminal (received + rejected)
  });

  it("Branch Flow aggregates transfer count, units and value by from→to branch pair", async () => {
    prisma.transfer.findMany.mockResolvedValueOnce([
      transferRow({ id: "t1", fromBranchId: "branch-1", toBranchId: "branch-2", items: [{ productId: "p1", qty: 10, receivedQty: 10, batchId: "b1" }] }),
      transferRow({ id: "t2", fromBranchId: "branch-1", toBranchId: "branch-2", items: [{ productId: "p1", qty: 5, receivedQty: 5, batchId: "b1" }] }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.transfersReport(tenantId, 30);

    expect(result.branchFlow).toEqual([
      { fromBranchId: "branch-1", toBranchId: "branch-2", transferCount: 2, units: 15, value: 150, fromBranchName: "Kandy — Branch 1", toBranchName: "Kandy — Branch 2" },
    ]);
  });

  it("Repeat transfer loops insight fires when the same from/to/product pair recurs within the period", async () => {
    prisma.transfer.findMany.mockResolvedValueOnce([
      transferRow({ id: "t1", items: [{ productId: "p1", qty: 5, receivedQty: 5, batchId: "b1" }] }),
      transferRow({ id: "t2", items: [{ productId: "p1", qty: 5, receivedQty: 5, batchId: "b1" }] }),
    ]);

    const result = await service.transfersReport(tenantId, 30);

    expect(result.insights.find((i) => i.key === "repeatLoops")).toBeDefined();
  });

  it("Transfer Opportunities recommends moving stock from the overstocked branch to the branch running low, sized to ~3 weeks of the target's own demand", async () => {
    prisma.batch.findMany.mockResolvedValue([
      { id: "b1", productId: "p1", branchId: "branch-1", costPrice: new Prisma.Decimal(15) },
      { id: "b2", productId: "p1", branchId: "branch-2", costPrice: new Prisma.Decimal(15) },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 10 }]);
    // branch-1: 1000 on hand, 0.5/day velocity → 2000 days of cover (overstocked source)
    // branch-2: 4 on hand, 0.5/day velocity → 8 days of cover, and below its reorder level of 10 (urgent target)
    prisma.stockLedger.groupBy.mockImplementation(({ where }: { where: { branchId?: string } }) => {
      if (where.branchId === "branch-1") return Promise.resolve([{ productId: "p1", _sum: { qtyDelta: 1000 } }]);
      if (where.branchId === "branch-2") return Promise.resolve([{ productId: "p1", _sum: { qtyDelta: 4 } }]);
      return Promise.resolve([]);
    });
    prisma.saleItem.groupBy.mockImplementation(({ where }: { where: { sale: { branchId: string } } }) =>
      Promise.resolve([{ productId: "p1", _sum: { qty: 45 } }]), // 45 over 90 days → 0.5/day, same for both branches
    );

    const result = await service.transfersReport(tenantId, 30);

    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]).toEqual(
      expect.objectContaining({
        productId: "p1",
        fromBranchId: "branch-1",
        toBranchId: "branch-2",
        suggestedUnits: Math.round(0.5 * 21), // 11
        estimatedValue: 11 * 15,
      }),
    );
  });

  it("does not suggest a transfer when no branch is genuinely overstocked, or no branch genuinely needs it", async () => {
    prisma.batch.findMany.mockResolvedValue([
      { id: "b1", productId: "p1", branchId: "branch-1", costPrice: new Prisma.Decimal(15) },
      { id: "b2", productId: "p1", branchId: "branch-2", costPrice: new Prisma.Decimal(15) },
    ]);
    prisma.product.findMany.mockResolvedValue([{ id: "p1", sku: "SKU1", name: "Product One", reorderLevel: 0 }]);
    // Both branches healthy: 90 units, 1/day velocity → 90 days of cover, well-stocked, not below any reorder level.
    prisma.stockLedger.groupBy.mockResolvedValue([{ productId: "p1", _sum: { qtyDelta: 90 } }]);
    prisma.saleItem.groupBy.mockResolvedValue([{ productId: "p1", _sum: { qty: 90 } }]);

    const result = await service.transfersReport(tenantId, 30);

    expect(result.opportunities).toEqual([]);
  });
});

describe("ReportsService.stocktakesReport", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: {
    branch: { findMany: jest.Mock };
    stocktake: { findMany: jest.Mock };
    stocktakeLine: { findMany: jest.Mock };
    batch: { findMany: jest.Mock };
    product: { findMany: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  type LineRow = {
    id: string;
    productId: string;
    batchId: string;
    systemQty: number;
    countedQty: number | null;
    varianceQty: number | null;
    status?: string;
    countedAt?: Date;
    stocktakeId: string;
    branchId: string;
    stocktakeNumber: string;
    createdAt: Date;
  };

  function lineRow(overrides: Partial<LineRow> = {}): LineRow {
    return {
      id: overrides.id ?? "line1",
      productId: overrides.productId ?? "p1",
      batchId: overrides.batchId ?? "b1",
      systemQty: overrides.systemQty ?? 100,
      countedQty: overrides.countedQty ?? 100,
      varianceQty: overrides.varianceQty ?? 0,
      status: overrides.status ?? "posted",
      countedAt: overrides.countedAt ?? daysAgo(5),
      stocktakeId: overrides.stocktakeId ?? "st1",
      branchId: overrides.branchId ?? "branch-1",
      stocktakeNumber: overrides.stocktakeNumber ?? "ST-0001",
      createdAt: overrides.createdAt ?? daysAgo(5),
    };
  }

  /** Replays all three `stocktakeLine.findMany` shapes `stocktakesReport` issues (current window,
   *  previous window, negative-variance lookback) against one canonical row set. */
  function mockLines(rows: LineRow[]) {
    prisma.stocktakeLine.findMany.mockImplementation(
      ({ where }: { where: { countedQty?: unknown; varianceQty?: { lt: number }; stocktake: { branchId?: string; createdAt: { gte: Date; lte: Date } } } }) => {
        const { gte, lte } = where.stocktake.createdAt;
        let matching = rows.filter((r) => r.createdAt.getTime() >= gte.getTime() && r.createdAt.getTime() <= lte.getTime());
        if (where.stocktake.branchId) matching = matching.filter((r) => r.branchId === where.stocktake.branchId);
        if (where.varianceQty?.lt != null) matching = matching.filter((r) => (r.varianceQty ?? 0) < where.varianceQty!.lt);
        if (where.countedQty) matching = matching.filter((r) => r.countedQty != null);
        return Promise.resolve(
          matching.map((r) => ({
            id: r.id,
            productId: r.productId,
            batchId: r.batchId,
            systemQty: r.systemQty,
            countedQty: r.countedQty,
            varianceQty: r.varianceQty,
            status: r.status,
            countedAt: r.countedAt,
            stocktake: { id: r.stocktakeId, stocktakeNumber: r.stocktakeNumber, branchId: r.branchId, createdAt: r.createdAt },
          })),
        );
      },
    );
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });
  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      branch: { findMany: jest.fn().mockResolvedValue([{ id: "branch-1", name: "Kandy — Branch 1" }]) },
      stocktake: { findMany: jest.fn().mockResolvedValue([]) },
      stocktakeLine: { findMany: jest.fn().mockResolvedValue([]) },
      batch: { findMany: jest.fn().mockResolvedValue([]) },
      product: { findMany: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("returns the empty shape when there are no stocktakes or counted lines at all", async () => {
    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.kpis).toEqual({ accuracyPct: null, prevAccuracyPct: null, varianceValue: 0, prevVarianceValue: 0, shrinkageValue: 0, prevShrinkageValue: 0, completedCount: 0, plannedCount: 0 });
    expect(result.discrepancies).toEqual([]);
  });

  it("scoping to one branch excludes another branch's stocktake lines entirely", async () => {
    prisma.branch.findMany.mockResolvedValue([
      { id: "branch-1", name: "Kandy — Branch 1" },
      { id: "branch-2", name: "Kandy — Branch 2" },
    ]);
    mockLines([
      lineRow({ id: "l1", branchId: "branch-1", varianceQty: -5 }),
      lineRow({ id: "l2", branchId: "branch-2", varianceQty: -20 }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.discrepancies).toHaveLength(1);
    expect(result.discrepancies[0]!.lineId).toBe("l1");
    expect(result.kpis.shrinkageValue).toBe(50); // 5 × 10, not branch-2's 200
  });

  it("computes Inventory Accuracy as the share of counted lines with zero variance", async () => {
    prisma.stocktake.findMany.mockResolvedValueOnce([{ id: "st1", status: "completed" }]);
    mockLines([
      lineRow({ id: "l1", varianceQty: 0 }),
      lineRow({ id: "l2", varianceQty: 0 }),
      lineRow({ id: "l3", varianceQty: -5 }),
      lineRow({ id: "l4", varianceQty: 3 }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.kpis.accuracyPct).toBe(50); // 2 of 4 lines matched exactly
  });

  it("Variance Value sums |variance| × batch cost across all counted lines; Shrinkage only counts negative variance", async () => {
    mockLines([
      lineRow({ id: "l1", batchId: "b1", varianceQty: -5 }), // shrinkage: missing 5 units
      lineRow({ id: "l2", batchId: "b1", varianceQty: 3 }), // overage: found 3 extra units
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.kpis.varianceValue).toBe(80); // (5 + 3) × 10
    expect(result.kpis.shrinkageValue).toBe(50); // 5 × 10 — only the negative-variance line
  });

  it("completedCount / plannedCount reflect every stocktake created in the period, regardless of whether it has counted lines yet", async () => {
    prisma.stocktake.findMany.mockResolvedValueOnce([
      { id: "st1", status: "completed" },
      { id: "st2", status: "counting" },
      { id: "st3", status: "completed" },
    ]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.kpis.plannedCount).toBe(3);
    expect(result.kpis.completedCount).toBe(2);
  });

  it("flags a repeated discrepancy when the same product/branch has negative variance in 2+ stocktakes within the lookback window", async () => {
    mockLines([
      lineRow({ id: "l1", stocktakeId: "st1", stocktakeNumber: "ST-0001", productId: "p1", branchId: "branch-1", varianceQty: -5, createdAt: daysAgo(100) }),
      lineRow({ id: "l2", stocktakeId: "st2", stocktakeNumber: "ST-0002", productId: "p1", branchId: "branch-1", varianceQty: -3, createdAt: daysAgo(5) }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.insights.find((i) => i.key === "repeatedDiscrepancies")).toBeDefined();
    const currentPeriodRow = result.discrepancies.find((d) => d.lineId === "l2");
    expect(currentPeriodRow?.isRepeatDiscrepancy).toBe(true);
  });

  it("does not flag a repeated discrepancy for a single negative-variance occurrence", async () => {
    mockLines([lineRow({ id: "l1", varianceQty: -5 })]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.insights.find((i) => i.key === "repeatedDiscrepancies")).toBeUndefined();
    expect(result.discrepancies[0]?.isRepeatDiscrepancy).toBe(false);
  });

  it("varianceByBranch is populated under All-branches scope for a multi-branch tenant, and empty when scoped to one branch or a single-branch tenant", async () => {
    prisma.branch.findMany.mockResolvedValue([
      { id: "branch-1", name: "Kandy — Branch 1" },
      { id: "branch-2", name: "Kandy — Branch 2" },
    ]);
    mockLines([
      lineRow({ id: "l1", branchId: "branch-1", varianceQty: -5 }),
      lineRow({ id: "l2", branchId: "branch-2", varianceQty: -2 }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(10) }]);

    const allBranches = await service.stocktakesReport(tenantId, null, 30);
    expect(allBranches.isMultiBranch).toBe(true);
    expect(allBranches.varianceByBranch).toHaveLength(2);

    const oneBranchOfMany = await service.stocktakesReport(tenantId, "branch-1", 30);
    expect(oneBranchOfMany.isMultiBranch).toBe(false);
    expect(oneBranchOfMany.varianceByBranch).toEqual([]);

    prisma.branch.findMany.mockResolvedValue([{ id: "branch-1", name: "Only Branch" }]);
    const singleBranch = await service.stocktakesReport(tenantId, null, 30);
    expect(singleBranch.isMultiBranch).toBe(false);
    expect(singleBranch.varianceByBranch).toEqual([]);
  });

  it("discrepancies table only lists lines with nonzero variance, sorted by variance value descending", async () => {
    mockLines([
      lineRow({ id: "l1", batchId: "b1", varianceQty: 0 }),
      lineRow({ id: "l2", batchId: "b1", varianceQty: -2 }),
      lineRow({ id: "l3", batchId: "b1", varianceQty: -10 }),
    ]);
    prisma.batch.findMany.mockResolvedValue([{ id: "b1", costPrice: new Prisma.Decimal(5) }]);

    const result = await service.stocktakesReport(tenantId, "branch-1", 30);

    expect(result.discrepancies.map((d) => d.lineId)).toEqual(["l3", "l2"]);
  });
});

describe("ReportsService.purchaseSummary", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: {
    purchaseOrder: { findMany: jest.Mock };
    stockLedger: { groupBy: jest.Mock };
    saleItem: { groupBy: jest.Mock };
  };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  function poRow(overrides: Partial<{
    id: string;
    poNumber: string;
    supplierId: string;
    branchId: string;
    status: string;
    createdAt: Date;
    items: Array<{ productId: string; orderedQty: number; unitCost: number }>;
    receivedItems: Array<{ productId: string; receivedQty: number }>;
  }> = {}) {
    return {
      id: overrides.id ?? "po1",
      poNumber: overrides.poNumber ?? "PO-0001",
      supplierId: overrides.supplierId ?? "sup1",
      branchId: overrides.branchId ?? "branch-1",
      status: overrides.status ?? "received",
      createdAt: overrides.createdAt ?? daysAgo(5),
      supplier: { id: overrides.supplierId ?? "sup1", name: "Acme Supplies" },
      branch: { id: overrides.branchId ?? "branch-1", name: "Kandy — Branch 1" },
      items: (overrides.items ?? [{ productId: "p1", orderedQty: 100, unitCost: 10 }]).map((i) => ({ ...i, unitCost: new Prisma.Decimal(i.unitCost) })),
      goodsReceipts: overrides.receivedItems ? [{ items: overrides.receivedItems }] : [],
    };
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });
  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      purchaseOrder: { findMany: jest.fn().mockResolvedValue([]) },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      saleItem: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("computes Purchase Spend (ordered value) and Received Value (capped at ordered qty) at PO unit cost", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) =>
      Promise.resolve(where.status ? [] : [poRow({ items: [{ productId: "p1", orderedQty: 100, unitCost: 10 }], receivedItems: [{ productId: "p1", receivedQty: 60 }] })]),
    );

    const result = await service.purchaseSummary(tenantId, "branch-1", 30);

    expect(result.kpis.purchaseSpend).toBe(1000); // 100 × 10
    expect(result.kpis.receivedValue).toBe(600); // 60 × 10
    expect(result.orders[0]!.fillPct).toBe(60);
  });

  it("openCommitments sums (ordered − received) value across every non-terminal PO, independent of `days`", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { status?: { notIn: string[] } } }) =>
      Promise.resolve(
        where.status
          ? [poRow({ id: "po-open", status: "partially_received", items: [{ productId: "p1", orderedQty: 100, unitCost: 10 }], receivedItems: [{ productId: "p1", receivedQty: 40 }] })]
          : [],
      ),
    );

    const result = await service.purchaseSummary(tenantId, "branch-1", 30);

    expect(result.kpis.openCommitments).toBe(600); // (100 − 40) × 10
  });

  it("PO Lifecycle counts every status bucket, including zero-count ones", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) =>
      Promise.resolve(where.status ? [] : [poRow({ status: "received" }), poRow({ id: "po2", status: "received" }), poRow({ id: "po3", status: "cancelled" })]),
    );

    const result = await service.purchaseSummary(tenantId, "branch-1", 30);

    expect(result.lifecycle.find((l) => l.status === "received")?.count).toBe(2);
    expect(result.lifecycle.find((l) => l.status === "cancelled")?.count).toBe(1);
    expect(result.lifecycle.find((l) => l.status === "draft")?.count).toBe(0);
  });

  it("flags Repeated Partial Fulfilment once a supplier has 2+ partially_received/short_closed POs in the period", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { status?: unknown } }) =>
      Promise.resolve(
        where.status
          ? []
          : [
              poRow({ id: "po1", supplierId: "sup1", status: "partially_received" }),
              poRow({ id: "po2", supplierId: "sup1", status: "short_closed" }),
            ],
      ),
    );

    const result = await service.purchaseSummary(tenantId, "branch-1", 30);

    expect(result.insights.find((i) => i.key === "repeatedPartialFulfilment")).toBeDefined();
  });
});

describe("ReportsService.supplierSpend", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: { purchaseOrder: { findMany: jest.Mock }; supplier: { findMany: jest.Mock } };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  function poRow(supplierId: string, items: Array<{ productId: string; orderedQty: number; unitCost: number }>, createdAt = daysAgo(5)) {
    return { id: `po-${supplierId}-${Math.random()}`, supplierId, createdAt, items: items.map((i) => ({ ...i, unitCost: new Prisma.Decimal(i.unitCost) })) };
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });
  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = { purchaseOrder: { findMany: jest.fn().mockResolvedValue([]) }, supplier: { findMany: jest.fn().mockResolvedValue([]) } };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("ranks suppliers by spend, computing share % and cumulative % correctly", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { createdAt: { gte: Date } } }) =>
      Promise.resolve(where.createdAt.gte.getTime() > NOW.getTime() - 40 * 86_400_000 ? [poRow("sup1", [{ productId: "p1", orderedQty: 10, unitCost: 90 }]), poRow("sup2", [{ productId: "p1", orderedQty: 10, unitCost: 10 }])] : []),
    );
    prisma.supplier.findMany.mockResolvedValue([
      { id: "sup1", name: "Big Supplier", status: "active" },
      { id: "sup2", name: "Small Supplier", status: "active" },
    ]);

    const result = await service.supplierSpend(tenantId, "branch-1", 30);

    expect(result.ranking[0]).toEqual(expect.objectContaining({ supplierId: "sup1", spend: 900, sharePct: 90, cumulativePct: 90 }));
    expect(result.ranking[1]).toEqual(expect.objectContaining({ supplierId: "sup2", spend: 100, sharePct: 10, cumulativePct: 100 }));
    expect(result.kpis.topSupplierSharePct).toBe(90);
  });

  it("flags Category dependency risk when a single supplier accounts for 50%+ of a category's spend", async () => {
    prisma.purchaseOrder.findMany.mockImplementation(({ where }: { where: { createdAt: { gte: Date } } }) =>
      Promise.resolve(where.createdAt.gte.getTime() > NOW.getTime() - 40 * 86_400_000 ? [poRow("sup1", [{ productId: "p1", orderedQty: 10, unitCost: 100 }])] : []),
    );
    prisma.supplier.findMany.mockResolvedValue([{ id: "sup1", name: "Sole Supplier", status: "active" }]);
    taxonomy.primaryCommercialCategoryByProductIds.mockResolvedValue(
      new Map([["p1", { id: "cat-devices", name: "Devices", parentCategoryId: null, parent: null }]]),
    );

    const result = await service.supplierSpend(tenantId, "branch-1", 30);

    expect(result.insights.find((i) => i.key === "categoryDependency")).toBeDefined();
  });
});

describe("ReportsService.supplierPerformance", () => {
  const tenantId = "tenant-1";
  const NOW = new Date("2026-08-22T23:59:59.999Z");
  let prisma: { goodsReceipt: { findMany: jest.Mock }; supplier: { findMany: jest.Mock }; goodsReturn: { findMany: jest.Mock } };
  let taxonomy: { primaryCommercialCategoryByProductIds: jest.Mock };
  let service: ReportsService;
  let realDateNow: DateConstructor;

  function daysAgo(n: number): Date {
    return new Date(NOW.getTime() - n * 86_400_000);
  }

  function receiptRow(overrides: {
    receivedOn: Date;
    supplierId?: string;
    poId?: string;
    poCreatedAt?: Date;
    expectedOn?: Date | null;
    orderedQty?: number;
    unitCost?: number;
    receivedQty?: number;
    actualCost?: number;
  }) {
    return {
      id: `gr-${Math.random()}`,
      receivedOn: overrides.receivedOn,
      items: [{ productId: "p1", receivedQty: overrides.receivedQty ?? 100, batch: { costPrice: new Prisma.Decimal(overrides.actualCost ?? overrides.unitCost ?? 10) } }],
      purchaseOrder: {
        id: overrides.poId ?? "po1",
        supplierId: overrides.supplierId ?? "sup1",
        branchId: "branch-1",
        createdAt: overrides.poCreatedAt ?? daysAgo(10),
        expectedOn: overrides.expectedOn === undefined ? daysAgo(3) : overrides.expectedOn,
        items: [{ productId: "p1", unitCost: new Prisma.Decimal(overrides.unitCost ?? 10), orderedQty: overrides.orderedQty ?? 100 }],
      },
    };
  }

  beforeAll(() => {
    realDateNow = global.Date;
  });
  afterAll(() => {
    global.Date = realDateNow;
  });

  beforeEach(() => {
    class MockDate extends realDateNow {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(NOW.getTime());
        // @ts-expect-error - forwarding whatever constructor args the caller passed
        else super(...args);
      }
      static override now() {
        return NOW.getTime();
      }
    }
    global.Date = MockDate as unknown as DateConstructor;

    prisma = {
      goodsReceipt: { findMany: jest.fn().mockResolvedValue([]) },
      supplier: { findMany: jest.fn().mockResolvedValue([{ id: "sup1", name: "Acme Supplies" }]) },
      goodsReturn: { findMany: jest.fn().mockResolvedValue([]) },
    };
    taxonomy = { primaryCommercialCategoryByProductIds: jest.fn().mockResolvedValue(new Map()) };
    service = new ReportsService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  it("computes On-Time %, Fill Rate % and Price Variance % from real PO vs. receipt/batch data", async () => {
    prisma.goodsReceipt.findMany.mockImplementation(({ where }: { where: { receivedOn: { gte: Date } } }) =>
      Promise.resolve(where.receivedOn.gte.getTime() > NOW.getTime() - 40 * 86_400_000 ? [receiptRow({ receivedOn: daysAgo(5), expectedOn: daysAgo(3), orderedQty: 100, receivedQty: 80, unitCost: 10, actualCost: 11 })] : []),
    );

    const result = await service.supplierPerformance(tenantId, "branch-1", 30);

    expect(result.kpis.onTimePct).toBe(100); // received (daysAgo 5) before expected (daysAgo 3)
    expect(result.kpis.fillRatePct).toBe(80); // 80 of 100
    expect(result.kpis.priceVariancePct).toBeCloseTo(10, 6); // actual 11 vs ordered 10 → +10%
  });

  it("flags a late delivery as not on-time when received after the PO's expectedOn", async () => {
    prisma.goodsReceipt.findMany.mockImplementation(({ where }: { where: { receivedOn: { gte: Date } } }) =>
      Promise.resolve(where.receivedOn.gte.getTime() > NOW.getTime() - 40 * 86_400_000 ? [receiptRow({ receivedOn: daysAgo(1), expectedOn: daysAgo(5) })] : []),
    );

    const result = await service.supplierPerformance(tenantId, "branch-1", 30);

    expect(result.kpis.onTimePct).toBe(0);
    expect(result.insights.find((i) => i.key === "lateDeliveries")).toBeDefined();
  });

  it("computes a supplier's returns value from supplier-type GoodsReturn records in the period", async () => {
    prisma.goodsReceipt.findMany.mockImplementation(({ where }: { where: { receivedOn: { gte: Date } } }) =>
      Promise.resolve(where.receivedOn.gte.getTime() > NOW.getTime() - 40 * 86_400_000 ? [receiptRow({ receivedOn: daysAgo(5) })] : []),
    );
    prisma.goodsReturn.findMany.mockResolvedValue([{ supplierId: "sup1", amount: new Prisma.Decimal(250) }]);

    const result = await service.supplierPerformance(tenantId, "branch-1", 30);

    expect(result.scorecard.find((s) => s.supplierId === "sup1")?.returnsValue).toBe(250);
  });
});
