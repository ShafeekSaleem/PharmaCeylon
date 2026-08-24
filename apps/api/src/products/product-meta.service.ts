import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { CategoryDimension, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { ONBOARDING_DEPARTMENT_GROUPS } from "../catalog/commercial-category-template";
import {
  CreateProductAliasDto,
  CreateProductCategoryDto,
  CreateProductTagDto,
  MoveProductsCategoryDto,
  ReorderCategoriesDto,
  UpdateProductCategoryDto,
} from "./dto/product-relations.dto";

export type CommercialCategoryTreeNode = {
  id: string;
  name: string;
  canonicalKey: string | null;
  source: string;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
  children: CommercialCategoryTreeNode[];
};

/**
 * This service manages COMMERCIAL categories (merchandise/business categories — Settings →
 * Catalog → Categories and the Products create/edit form's "Category" field). Dosage Form /
 * NMRA Schedule / Registration Type are import-derived classification facets managed
 * exclusively by the NMRA import pipeline (`nmra-import.service.ts`) — they are intentionally
 * NOT editable through these endpoints, per the "Category = merchandise, not regulatory
 * classification" architecture (see root CLAUDE.md).
 */
@Injectable()
export class ProductMetaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoryTaxonomy: CategoryTaxonomyService,
  ) {}

  async listCategories(tenantId: string, dimension: CategoryDimension = "COMMERCIAL") {
    const rows = await this.prisma.productCategory.findMany({
      where: { tenantId, dimension },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { categoryMaps: true } } },
    });

    // Products are filed on leaf categories, not the parent/department row itself, so a
    // parent's own direct count is normally 0 — roll children's counts up into every
    // ancestor so `productCount` reflects everything under it (matches the "Category"
    // filter facet's rollup in catalog.service.ts).
    const directCount = new Map(rows.map((r) => [r.id, r._count.categoryMaps]));
    const childrenOf = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.parentCategoryId) continue;
      const list = childrenOf.get(r.parentCategoryId) ?? [];
      list.push(r.id);
      childrenOf.set(r.parentCategoryId, list);
    }
    const rolledUpCache = new Map<string, number>();
    const rolledUpCount = (id: string): number => {
      const cached = rolledUpCache.get(id);
      if (cached !== undefined) return cached;
      const total =
        (directCount.get(id) ?? 0) +
        (childrenOf.get(id) ?? []).reduce((sum, childId) => sum + rolledUpCount(childId), 0);
      rolledUpCache.set(id, total);
      return total;
    };

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentCategoryId: r.parentCategoryId,
      dimension: r.dimension,
      canonicalKey: r.canonicalKey,
      source: r.source,
      isSystem: r.isSystem,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      productCount: rolledUpCount(r.id),
    }));
  }

  /** Full COMMERCIAL Department → Category tree (all rows, active or not) for Settings management. */
  async listCommercialTree(tenantId: string) {
    const [rows, counts] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: { tenantId, dimension: "COMMERCIAL" },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      this.prisma.productCategoryMap.groupBy({
        by: ["categoryId"],
        where: { tenantId, dimension: "COMMERCIAL" },
        _count: true,
      }),
    ]);
    const countByCategory = new Map(counts.map((c) => [c.categoryId, c._count]));
    const byParent = new Map<string | null, typeof rows>();
    for (const r of rows) {
      const key = r.parentCategoryId;
      const list = byParent.get(key) ?? [];
      list.push(r);
      byParent.set(key, list);
    }
    // Products are filed on leaf categories, not the department row itself, so a
    // department's own direct count is normally 0 — roll children's counts up into
    // every ancestor (children are built first, so their own rollup is already final).
    const build = (parentId: string | null): CommercialCategoryTreeNode[] =>
      (byParent.get(parentId) ?? []).map((r) => {
        const children = build(r.id);
        const ownCount = countByCategory.get(r.id) ?? 0;
        const childrenTotal = children.reduce((sum, c) => sum + c.productCount, 0);
        return {
          id: r.id,
          name: r.name,
          canonicalKey: r.canonicalKey,
          source: r.source,
          isSystem: r.isSystem,
          isActive: r.isActive,
          sortOrder: r.sortOrder,
          productCount: ownCount + childrenTotal,
          children,
        };
      });
    return build(null);
  }

  /** Onboarding "what does your pharmacy sell" status — which department groups are enabled. */
  async onboardingStatus(tenantId: string) {
    await this.categoryTaxonomy.ensureCommercialTemplate(tenantId);
    const departments = await this.prisma.productCategory.findMany({
      where: { tenantId, dimension: "COMMERCIAL", parentCategoryId: null, canonicalKey: { not: null } },
      select: { canonicalKey: true, isActive: true },
    });
    const activeByKey = new Map(departments.map((d) => [d.canonicalKey!, d.isActive]));
    return ONBOARDING_DEPARTMENT_GROUPS.map((group) => ({
      label: group.label,
      enabled: group.departmentKeys.every((key) => activeByKey.get(key) ?? false),
    }));
  }

  async applyOnboardingSelection(tenantId: string, departments: string[]) {
    await this.categoryTaxonomy.applyOnboardingSelection(tenantId, departments);
    return this.onboardingStatus(tenantId);
  }

  async createCategory(tenantId: string, dto: CreateProductCategoryDto) {
    if (dto.parentCategoryId) {
      const parent = await this.prisma.productCategory.findFirst({
        where: { id: dto.parentCategoryId, tenantId, dimension: "COMMERCIAL" },
      });
      if (!parent) throw new NotFoundException("Parent category not found");
    }
    try {
      return await this.prisma.productCategory.create({
        data: {
          tenantId,
          dimension: "COMMERCIAL",
          source: "TENANT",
          name: dto.name.trim(),
          parentCategoryId: dto.parentCategoryId ?? null,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Category name already exists");
      }
      throw e;
    }
  }

  async updateCategory(tenantId: string, id: string, dto: UpdateProductCategoryDto) {
    const existing = await this.ensureCommercialCategory(tenantId, id);
    if (dto.parentCategoryId) {
      if (dto.parentCategoryId === id) {
        throw new ConflictException("A category cannot be its own parent");
      }
      const parent = await this.prisma.productCategory.findFirst({
        where: { id: dto.parentCategoryId, tenantId, dimension: "COMMERCIAL" },
      });
      if (!parent) throw new NotFoundException("Parent category not found");
    }
    if (existing.isSystem && dto.parentCategoryId !== undefined) {
      throw new ConflictException("System categories can't be moved to a different parent");
    }
    return this.prisma.productCategory.update({
      where: { id, tenantId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.parentCategoryId !== undefined
          ? { parentCategoryId: dto.parentCategoryId }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async reorderCategories(tenantId: string, dto: ReorderCategoriesDto) {
    const ids = dto.items.map((i) => i.id);
    const count = await this.prisma.productCategory.count({
      where: { tenantId, dimension: "COMMERCIAL", id: { in: ids } },
    });
    if (count !== ids.length) {
      throw new ConflictException("One or more categories are invalid");
    }
    await this.prisma.$transaction(
      dto.items.map((item) =>
        this.prisma.productCategory.update({
          where: { id: item.id, tenantId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );
    return { ok: true };
  }

  /** Reassign a batch of products' primary COMMERCIAL category (e.g. before disabling a category). */
  async moveProductsCategory(tenantId: string, dto: MoveProductsCategoryDto) {
    for (const productId of dto.productIds) {
      await this.categoryTaxonomy.setPrimaryCommercialCategory(tenantId, productId, dto.toCategoryId, {
        assignmentSource: "MANUAL",
      });
    }
    return { ok: true, moved: dto.productIds.length };
  }

  /**
   * Deleting a COMMERCIAL category is only allowed for tenant-created, empty, childless
   * categories — everything else (system/template categories, categories with products or
   * subcategories, and anything with historical sales resolved through it) must be disabled
   * instead, so historical reporting never loses its category relationships.
   */
  async deleteCategory(tenantId: string, id: string) {
    const existing = await this.ensureCommercialCategory(tenantId, id);
    if (existing.isSystem) {
      throw new ConflictException(
        "System categories can't be deleted — disable them instead (Settings → Catalog → Categories).",
      );
    }
    const [productCount, childCount] = await Promise.all([
      this.prisma.productCategoryMap.count({ where: { tenantId, categoryId: id } }),
      this.prisma.productCategory.count({ where: { tenantId, parentCategoryId: id } }),
    ]);
    if (productCount > 0 || childCount > 0) {
      throw new ConflictException(
        "Category still has products or subcategories — move or reassign them, or disable this category instead of deleting it.",
      );
    }
    await this.prisma.productCategory.delete({ where: { id, tenantId } });
    return { ok: true };
  }

  async listTags(tenantId: string) {
    const rows = await this.prisma.productTag.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
      include: { _count: { select: { tagMaps: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      productCount: r._count.tagMaps,
    }));
  }

  async createTag(tenantId: string, dto: CreateProductTagDto) {
    try {
      return await this.prisma.productTag.create({
        data: { tenantId, name: dto.name.trim() },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Tag name already exists");
      }
      throw e;
    }
  }

  async updateTag(tenantId: string, id: string, dto: { name?: string }) {
    await this.ensureTag(tenantId, id);
    try {
      return await this.prisma.productTag.update({
        where: { id, tenantId },
        data: dto.name !== undefined ? { name: dto.name.trim() } : {},
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Tag name already exists");
      }
      throw e;
    }
  }

  async deleteTag(tenantId: string, id: string) {
    await this.ensureTag(tenantId, id);
    await this.prisma.productTag.delete({ where: { id, tenantId } });
    return { ok: true };
  }

  listAllAliases(tenantId: string) {
    return this.prisma.productAlias.findMany({
      where: { tenantId },
      orderBy: [{ aliasText: "asc" }],
      include: {
        product: { select: { id: true, sku: true, name: true } },
      },
    });
  }

  listAliases(tenantId: string, productId: string) {
    return this.prisma.productAlias.findMany({
      where: { tenantId, productId },
      orderBy: { aliasText: "asc" },
    });
  }

  async addAlias(tenantId: string, productId: string, dto: CreateProductAliasDto) {
    try {
      return await this.prisma.productAlias.create({
        data: {
          tenantId,
          productId,
          aliasText: dto.aliasText.trim(),
          aliasType: dto.aliasType?.trim() || "synonym",
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("Alias already exists for this product");
      }
      throw e;
    }
  }

  async removeAlias(tenantId: string, productId: string, aliasId: string) {
    const row = await this.prisma.productAlias.findFirst({
      where: { id: aliasId, tenantId, productId },
    });
    if (!row) throw new NotFoundException("Alias not found");
    await this.prisma.productAlias.delete({ where: { id: aliasId, tenantId, productId } });
    return { ok: true };
  }

  /**
   * Sets a product's COMMERCIAL category associations (the Products create/edit form's
   * "Category" field). Only touches COMMERCIAL-dimension maps — Dosage Form / NMRA Schedule /
   * Registration Type maps written by the NMRA import are left untouched, so editing a
   * product's commercial category can never wipe its regulatory classification.
   *
   * The first id becomes the primary category (all financial/profitability reporting groups
   * by this); any further ids are secondary, discovery-only associations.
   */
  async syncProductCategories(
    tenantId: string,
    productId: string,
    categoryIds: string[] | undefined,
  ) {
    if (categoryIds === undefined) return;
    const unique = [...new Set(categoryIds)];
    if (unique.length) {
      const count = await this.prisma.productCategory.count({
        where: { tenantId, id: { in: unique }, dimension: "COMMERCIAL" },
      });
      if (count !== unique.length) {
        throw new ConflictException("One or more categories are invalid");
      }
    }

    await this.prisma.productCategoryMap.deleteMany({
      where: { tenantId, productId, dimension: "COMMERCIAL", categoryId: { notIn: unique } },
    });
    if (unique.length === 0) return;

    const [primaryId, ...secondaryIds] = unique;
    await this.categoryTaxonomy.setPrimaryCommercialCategory(tenantId, productId, primaryId, {
      assignmentSource: "MANUAL",
    });
    for (const categoryId of secondaryIds) {
      await this.categoryTaxonomy.addSecondaryCommercialCategory(tenantId, productId, categoryId);
    }
  }

  async syncProductTags(tenantId: string, productId: string, tagIds: string[] | undefined) {
    if (tagIds === undefined) return;
    const unique = [...new Set(tagIds)];
    if (unique.length) {
      const count = await this.prisma.productTag.count({
        where: { tenantId, id: { in: unique } },
      });
      if (count !== unique.length) {
        throw new ConflictException("One or more tags are invalid");
      }
    }
    await this.prisma.productTagMap.deleteMany({ where: { tenantId, productId } });
    if (unique.length) {
      await this.prisma.productTagMap.createMany({
        data: unique.map((tagId) => ({ tenantId, productId, tagId })),
      });
    }
  }

  async loadProductRelations(tenantId: string, productId: string) {
    const [categoryMaps, tagMaps, aliases] = await this.prisma.$transaction([
      // COMMERCIAL only — see the productInclude comment in products.service.ts for why
      // "categories" must never mix in Dosage Form/Schedule/Registration Type maps.
      this.prisma.productCategoryMap.findMany({
        where: { tenantId, productId, dimension: "COMMERCIAL" },
        include: { category: true },
      }),
      this.prisma.productTagMap.findMany({
        where: { tenantId, productId },
        include: { tag: true },
      }),
      this.prisma.productAlias.findMany({
        where: { tenantId, productId },
        orderBy: { aliasText: "asc" },
      }),
    ]);
    return {
      categories: categoryMaps.map((m) => m.category),
      tags: tagMaps.map((m) => m.tag),
      aliases,
    };
  }

  private async ensureCommercialCategory(tenantId: string, id: string) {
    const row = await this.prisma.productCategory.findFirst({
      where: { id, tenantId, dimension: "COMMERCIAL" },
    });
    if (!row) throw new NotFoundException("Category not found");
    return row;
  }

  private async ensureTag(tenantId: string, id: string) {
    const row = await this.prisma.productTag.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Tag not found");
    return row;
  }
}
