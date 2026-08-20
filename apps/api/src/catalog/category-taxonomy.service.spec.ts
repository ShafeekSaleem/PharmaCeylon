import { ConflictException, NotFoundException } from "@nestjs/common";
import { CategoryTaxonomyOps } from "./category-taxonomy.util";
import { COMMERCIAL_CATEGORY_TEMPLATE } from "./commercial-category-template";

type PrismaMock = {
  productCategory: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  productCategoryMap: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    upsert: jest.Mock;
    createMany: jest.Mock;
  };
  $transaction: jest.Mock;
};

function makePrisma(): PrismaMock {
  return {
    productCategory: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: `new-${data.name}`, ...data })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    productCategoryMap: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockResolvedValue({}),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
}

describe("CategoryTaxonomyOps", () => {
  const tenantId = "tenant-1";
  let prisma: PrismaMock;
  let ops: CategoryTaxonomyOps;

  beforeEach(() => {
    prisma = makePrisma();
    ops = new CategoryTaxonomyOps(prisma as never);
  });

  describe("ensureCommercialTemplate", () => {
    it("is idempotent — skips categories that already exist by canonicalKey", async () => {
      const totalNodes = COMMERCIAL_CATEGORY_TEMPLATE.reduce(
        (sum, dept) => sum + 1 + (dept.children?.length ?? 0),
        0,
      );
      // Pretend every canonicalKey already exists.
      const existing = COMMERCIAL_CATEGORY_TEMPLATE.flatMap((dept) => [
        { id: `id-${dept.canonicalKey}`, canonicalKey: dept.canonicalKey },
        ...(dept.children ?? []).map((c) => ({ id: `id-${c.canonicalKey}`, canonicalKey: c.canonicalKey })),
      ]);
      prisma.productCategory.findMany.mockResolvedValue(existing);

      await ops.ensureCommercialTemplate(tenantId);

      expect(prisma.productCategory.create).not.toHaveBeenCalled();
      expect(existing.length).toBe(totalNodes);
    });

    it("creates only missing categories on a partial rerun", async () => {
      // Only the MEDICINES department root already exists — everything else is missing.
      prisma.productCategory.findMany.mockResolvedValue([{ id: "id-MEDICINES", canonicalKey: "MEDICINES" }]);

      await ops.ensureCommercialTemplate(tenantId);

      const createdKeys = prisma.productCategory.create.mock.calls.map((c) => c[0].data.canonicalKey);
      expect(createdKeys).not.toContain("MEDICINES");
      expect(createdKeys).toContain("MEDICINES_PAIN_FEVER");
      expect(createdKeys).toContain("FOOD_BEVERAGE");
    });

    it("seeds Medicines as active and other departments inactive by default", async () => {
      await ops.ensureCommercialTemplate(tenantId);
      const calls = prisma.productCategory.create.mock.calls.map((c) => c[0].data);
      const medicines = calls.find((d) => d.canonicalKey === "MEDICINES");
      const foodBeverage = calls.find((d) => d.canonicalKey === "FOOD_BEVERAGE");
      expect(medicines.isActive).toBe(true);
      expect(foodBeverage.isActive).toBe(false);
    });
  });

  describe("setPrimaryCommercialCategory", () => {
    it("rejects a non-COMMERCIAL category", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({ id: "cat-1", dimension: "DOSAGE_FORM" });
      await expect(
        ops.setPrimaryCommercialCategory(tenantId, "product-1", "cat-1"),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("throws NotFoundException for an unknown category", async () => {
      prisma.productCategory.findFirst.mockResolvedValue(null);
      await expect(
        ops.setPrimaryCommercialCategory(tenantId, "product-1", "missing"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("unsets any existing primary COMMERCIAL map before setting the new one (at most one primary invariant)", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({ id: "cat-2", dimension: "COMMERCIAL" });

      await ops.setPrimaryCommercialCategory(tenantId, "product-1", "cat-2");

      expect(prisma.productCategoryMap.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId,
            productId: "product-1",
            dimension: "COMMERCIAL",
            isPrimary: true,
            categoryId: { not: "cat-2" },
          }),
          data: { isPrimary: false },
        }),
      );
      expect(prisma.productCategoryMap.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ categoryId: "cat-2", isPrimary: true }),
          update: expect.objectContaining({ isPrimary: true }),
        }),
      );
    });
  });

  describe("assignMissingPrimaryCommercial", () => {
    it("only assigns products that don't already have a primary COMMERCIAL category (idempotent)", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({ id: "unclassified-id" });
      prisma.productCategoryMap.findMany.mockResolvedValue([{ productId: "p1" }]);

      const count = await ops.assignMissingPrimaryCommercial(
        tenantId,
        ["p1", "p2", "p3"],
        "MEDICINES_UNCLASSIFIED",
      );

      expect(prisma.productCategoryMap.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ productId: "p2", categoryId: "unclassified-id", isPrimary: true }),
            expect.objectContaining({ productId: "p3", categoryId: "unclassified-id", isPrimary: true }),
          ]),
          skipDuplicates: true,
        }),
      );
      const data = prisma.productCategoryMap.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(count).toBe(0); // mocked createMany returns count: 0 by default
    });

    it("is a no-op when every product already has a primary category", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({ id: "unclassified-id" });
      prisma.productCategoryMap.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p2" }]);

      await ops.assignMissingPrimaryCommercial(tenantId, ["p1", "p2"], "MEDICINES_UNCLASSIFIED");

      expect(prisma.productCategoryMap.createMany).not.toHaveBeenCalled();
    });
  });

  describe("primaryCommercialCategoryByProductIds", () => {
    it("only resolves isPrimary COMMERCIAL maps (never a secondary association)", async () => {
      await ops.primaryCommercialCategoryByProductIds(tenantId, ["p1"]);
      expect(prisma.productCategoryMap.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dimension: "COMMERCIAL", isPrimary: true }),
        }),
      );
    });
  });
});
