import { AuditService } from "../audit/audit.service";
import { ProductMetaService } from "./product-meta.service";
import { ProductsService } from "./products.service";

/**
 * The bulk category/tag actions. These are the tool a pharmacy uses to fix a 2,000-row import
 * that landed in the wrong department, so the parts worth pinning are the ones that decide
 * whether the action is safe to run: the preview's replace counts, and the delete that has to
 * clear a secondary map before the new primary can be inserted.
 */
describe("ProductsService — bulk category and tag actions", () => {
  const tenantId = "tenant-1";
  const ids = ["p1", "p2", "p3"];

  function makeService(overrides: Record<string, unknown> = {}) {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue(ids.map((id) => ({ id }))),
        count: jest.fn().mockResolvedValue(ids.length),
        updateMany: jest.fn().mockResolvedValue({ count: ids.length }),
      },
      productCategory: {
        findFirst: jest.fn().mockResolvedValue({ id: "cat-pain", name: "Pain & Fever" }),
      },
      productCategoryMap: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: ids.length }),
      },
      productTag: {
        findMany: jest.fn().mockResolvedValue([{ id: "tag-1", name: "Fast mover" }]),
      },
      productTagMap: {
        groupBy: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: ids.length }),
        deleteMany: jest.fn().mockResolvedValue({ count: ids.length }),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
      ...overrides,
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const meta = {} as unknown as ProductMetaService;
    return { service: new ProductsService(prisma as never, audit, meta), prisma, audit };
  }

  describe("preview", () => {
    it("separates products already on the target from those whose category would be replaced", async () => {
      const { service, prisma } = makeService();
      prisma.productCategoryMap.findMany.mockResolvedValue([
        { categoryId: "cat-pain", assignmentSource: "AUTO_CLASSIFIED" },
        { categoryId: "cat-other", assignmentSource: "MANUAL" },
        { categoryId: "cat-other", assignmentSource: "SYSTEM_DEFAULT" },
      ]);

      const preview = await service.bulkPreview(tenantId, {
        action: "set_category",
        productIds: ids,
        categoryId: "cat-pain",
      });

      expect(preview.matched).toBe(3);
      expect(preview.alreadyOnTarget).toBe(1);
      expect(preview.replacingExisting).toBe(2);
      // The count that should give someone pause: one of those was filed by a person.
      expect(preview.replacingManual).toBe(1);
      expect(preview.willChange).toBe(2);
      expect(preview.categoryName).toBe("Pain & Fever");
    });

    it("reports nothing to do when every product is already filed under the target", async () => {
      const { service, prisma } = makeService();
      prisma.productCategoryMap.findMany.mockResolvedValue(
        ids.map(() => ({ categoryId: "cat-pain", assignmentSource: "MANUAL" })),
      );

      const preview = await service.bulkPreview(tenantId, {
        action: "set_category",
        productIds: ids,
        categoryId: "cat-pain",
      });

      expect(preview.willChange).toBe(0);
      expect(preview.replacingExisting).toBe(0);
    });

    it("counts a product as already tagged only when it carries every selected tag", async () => {
      const { service, prisma } = makeService();
      prisma.productTag.findMany.mockResolvedValue([
        { id: "tag-1", name: "Fast mover" },
        { id: "tag-2", name: "Fridge" },
      ]);
      prisma.productTagMap.groupBy.mockResolvedValue([
        { productId: "p1", _count: { tagId: 2 } },
        { productId: "p2", _count: { tagId: 1 } },
      ]);

      const preview = await service.bulkPreview(tenantId, {
        action: "add_tags",
        productIds: ids,
        tagIds: ["tag-1", "tag-2"],
      });

      expect(preview.alreadyOnTarget).toBe(1);
      expect(preview.willChange).toBe(2);
    });

    it("writes nothing", async () => {
      const { service, prisma } = makeService();
      await service.bulkPreview(tenantId, {
        action: "set_category",
        productIds: ids,
        categoryId: "cat-pain",
      });
      expect(prisma.productCategoryMap.createMany).not.toHaveBeenCalled();
      expect(prisma.productCategoryMap.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("apply", () => {
    it("clears the old primary AND any secondary map on the target before inserting", async () => {
      const { service, prisma } = makeService();

      await service.bulkUpdate(tenantId, "user-1", {
        action: "set_category",
        productIds: ids,
        categoryId: "cat-pain",
      });

      const where = prisma.productCategoryMap.deleteMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        tenantId,
        dimension: "COMMERCIAL",
        productId: { in: ids },
      });
      // Without the second clause the insert collides with the
      // (tenantId, productId, categoryId) unique index and the whole batch fails.
      expect(where.OR).toEqual([{ isPrimary: true }, { categoryId: "cat-pain" }]);

      const created = prisma.productCategoryMap.createMany.mock.calls[0][0].data;
      expect(created).toHaveLength(3);
      expect(created[0]).toMatchObject({
        tenantId,
        categoryId: "cat-pain",
        dimension: "COMMERCIAL",
        isPrimary: true,
        assignmentSource: "MANUAL",
      });
    });

    it("clear_category returns products to Unclassified rather than to no category at all", async () => {
      const { service, prisma } = makeService();
      prisma.productCategory.findFirst.mockResolvedValue({ id: "cat-unclassified" });

      await service.bulkUpdate(tenantId, "user-1", {
        action: "clear_category",
        productIds: ids,
      });

      expect(prisma.productCategory.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId,
            canonicalKey: "MEDICINES_UNCLASSIFIED",
          }),
        }),
      );
      const created = prisma.productCategoryMap.createMany.mock.calls[0][0].data;
      expect(created[0]).toMatchObject({
        categoryId: "cat-unclassified",
        // SYSTEM_DEFAULT, not MANUAL — this makes them eligible for the classifier again.
        assignmentSource: "SYSTEM_DEFAULT",
      });
    });

    it("writes one tag map per product per tag", async () => {
      const { service, prisma } = makeService();
      prisma.productTag.findMany.mockResolvedValue([
        { id: "tag-1", name: "Fast mover" },
        { id: "tag-2", name: "Fridge" },
      ]);

      await service.bulkUpdate(tenantId, "user-1", {
        action: "add_tags",
        productIds: ids,
        tagIds: ["tag-1", "tag-2"],
      });

      const data = prisma.productTagMap.createMany.mock.calls[0][0].data;
      expect(data).toHaveLength(6);
      expect(prisma.productTagMap.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    });

    it("records the category name in the audit payload, not just the id", async () => {
      const { service, audit } = makeService();
      await service.bulkUpdate(tenantId, "user-1", {
        action: "set_category",
        productIds: ids,
        categoryId: "cat-pain",
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "products.bulk_set_category",
          payload: expect.objectContaining({ categoryName: "Pain & Fever", updated: 3 }),
        }),
      );
    });
  });

  describe("validation", () => {
    it("rejects a category from another tenant", async () => {
      const { service, prisma } = makeService();
      prisma.productCategory.findFirst.mockResolvedValue(null);
      await expect(
        service.bulkUpdate(tenantId, "user-1", {
          action: "set_category",
          productIds: ids,
          categoryId: "cat-from-another-tenant",
        }),
      ).rejects.toThrow(/Category not found/);
    });

    it("rejects a tag id that does not resolve in this tenant", async () => {
      const { service, prisma } = makeService();
      prisma.productTag.findMany.mockResolvedValue([{ id: "tag-1", name: "Fast mover" }]);
      await expect(
        service.bulkUpdate(tenantId, "user-1", {
          action: "add_tags",
          productIds: ids,
          tagIds: ["tag-1", "tag-from-another-tenant"],
        }),
      ).rejects.toThrow(/tags not found/);
    });

    it("rejects set_category with no category chosen", async () => {
      const { service } = makeService();
      await expect(
        service.bulkUpdate(tenantId, "user-1", { action: "set_category", productIds: ids }),
      ).rejects.toThrow(/Choose a category/);
    });

    it("still refuses both a selection and a filter", async () => {
      const { service } = makeService();
      await expect(
        service.bulkUpdate(tenantId, "user-1", {
          action: "set_category",
          productIds: ids,
          filter: {},
          categoryId: "cat-pain",
        }),
      ).rejects.toThrow(/exactly one of the two/);
    });
  });
});
