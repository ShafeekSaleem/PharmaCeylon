import { ConflictException, NotFoundException } from "@nestjs/common";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { ProductMetaService } from "./product-meta.service";

type PrismaMock = {
  productCategory: {
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
  };
  productCategoryMap: {
    deleteMany: jest.Mock;
    count: jest.Mock;
  };
};

function makePrisma(): PrismaMock {
  return {
    productCategory: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
    productCategoryMap: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn(),
    },
  };
}

describe("ProductMetaService — commercial category scoping", () => {
  const tenantId = "tenant-1";
  const productId = "product-1";
  let prisma: PrismaMock;
  let taxonomy: { setPrimaryCommercialCategory: jest.Mock; addSecondaryCommercialCategory: jest.Mock };
  let service: ProductMetaService;

  beforeEach(() => {
    prisma = makePrisma();
    taxonomy = {
      setPrimaryCommercialCategory: jest.fn().mockResolvedValue(undefined),
      addSecondaryCommercialCategory: jest.fn().mockResolvedValue(undefined),
    };
    service = new ProductMetaService(prisma as never, taxonomy as unknown as CategoryTaxonomyService);
  });

  describe("syncProductCategories", () => {
    it("only deletes COMMERCIAL-dimension maps, never NMRA Schedule/Dosage Form/Registration Type maps", async () => {
      prisma.productCategory.count.mockResolvedValue(1);

      await service.syncProductCategories(tenantId, productId, ["cat-commercial-1"]);

      expect(prisma.productCategoryMap.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId, productId, dimension: "COMMERCIAL" }),
        }),
      );
    });

    it("validates every id is a COMMERCIAL category before applying", async () => {
      prisma.productCategory.count.mockResolvedValue(0); // one of the ids isn't COMMERCIAL

      await expect(
        service.syncProductCategories(tenantId, productId, ["cat-1", "dosage-form-cat"]),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.productCategory.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ dimension: "COMMERCIAL" }),
        }),
      );
    });

    it("sets the first id as primary and the rest as secondary associations", async () => {
      prisma.productCategory.count.mockResolvedValue(2);

      await service.syncProductCategories(tenantId, productId, ["primary-cat", "secondary-cat"]);

      expect(taxonomy.setPrimaryCommercialCategory).toHaveBeenCalledWith(
        tenantId,
        productId,
        "primary-cat",
        expect.objectContaining({ assignmentSource: "MANUAL" }),
      );
      expect(taxonomy.addSecondaryCommercialCategory).toHaveBeenCalledWith(tenantId, productId, "secondary-cat");
    });

    it("clears all commercial maps when given an empty list, without calling setPrimary", async () => {
      await service.syncProductCategories(tenantId, productId, []);

      expect(prisma.productCategoryMap.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ dimension: "COMMERCIAL" }) }),
      );
      expect(taxonomy.setPrimaryCommercialCategory).not.toHaveBeenCalled();
    });

    it("is a no-op when categoryIds is undefined (partial update didn't touch categories)", async () => {
      await service.syncProductCategories(tenantId, productId, undefined);
      expect(prisma.productCategoryMap.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("deleteCategory", () => {
    it("blocks deleting a system (template/NMRA) category — must be disabled instead", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({
        id: "cat-1",
        tenantId,
        dimension: "COMMERCIAL",
        isSystem: true,
      });

      await expect(service.deleteCategory(tenantId, "cat-1")).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.productCategory.delete).not.toHaveBeenCalled();
    });

    it("blocks deleting a category that still has products or subcategories", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({
        id: "cat-1",
        tenantId,
        dimension: "COMMERCIAL",
        isSystem: false,
      });
      prisma.productCategoryMap.count.mockResolvedValue(3);
      prisma.productCategory.count.mockResolvedValue(0);

      await expect(service.deleteCategory(tenantId, "cat-1")).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.productCategory.delete).not.toHaveBeenCalled();
    });

    it("allows deleting an empty, childless, tenant-created category", async () => {
      prisma.productCategory.findFirst.mockResolvedValue({
        id: "cat-1",
        tenantId,
        dimension: "COMMERCIAL",
        isSystem: false,
      });
      prisma.productCategoryMap.count.mockResolvedValue(0);
      prisma.productCategory.count.mockResolvedValue(0);
      prisma.productCategory.delete.mockResolvedValue({});

      const result = await service.deleteCategory(tenantId, "cat-1");
      expect(result).toEqual({ ok: true });
      expect(prisma.productCategory.delete).toHaveBeenCalledWith({
        where: { id: "cat-1", tenantId },
      });
    });

    it("throws NotFoundException for a category outside the tenant (tenant isolation)", async () => {
      prisma.productCategory.findFirst.mockResolvedValue(null);
      await expect(service.deleteCategory(tenantId, "other-tenant-cat")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.productCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId, dimension: "COMMERCIAL" }) }),
      );
    });
  });

  describe("createCategory", () => {
    it("always creates with dimension COMMERCIAL and source TENANT, regardless of input", async () => {
      prisma.productCategory.create.mockResolvedValue({ id: "new-cat" });

      await service.createCategory(tenantId, { name: "Snacks" } as never);

      expect(prisma.productCategory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ dimension: "COMMERCIAL", source: "TENANT" }),
        }),
      );
    });
  });
});
