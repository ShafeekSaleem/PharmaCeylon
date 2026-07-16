import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CreateProductAliasDto,
  CreateProductCategoryDto,
  CreateProductTagDto,
  UpdateProductCategoryDto,
} from "./dto/product-relations.dto";

@Injectable()
export class ProductMetaService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(tenantId: string) {
    const rows = await this.prisma.productCategory.findMany({
      where: { tenantId },
      orderBy: [{ name: "asc" }],
      include: { _count: { select: { categoryMaps: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentCategoryId: r.parentCategoryId,
      productCount: r._count.categoryMaps,
    }));
  }

  async createCategory(tenantId: string, dto: CreateProductCategoryDto) {
    try {
      return await this.prisma.productCategory.create({
        data: {
          tenantId,
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
    await this.ensureCategory(tenantId, id);
    return this.prisma.productCategory.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.parentCategoryId !== undefined
          ? { parentCategoryId: dto.parentCategoryId }
          : {}),
      },
    });
  }

  async deleteCategory(tenantId: string, id: string) {
    await this.ensureCategory(tenantId, id);
    await this.prisma.productCategory.delete({ where: { id } });
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
        where: { id },
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
    await this.prisma.productTag.delete({ where: { id } });
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
    await this.prisma.productAlias.delete({ where: { id: aliasId } });
    return { ok: true };
  }

  async syncProductCategories(
    tenantId: string,
    productId: string,
    categoryIds: string[] | undefined,
  ) {
    if (categoryIds === undefined) return;
    const unique = [...new Set(categoryIds)];
    if (unique.length) {
      const count = await this.prisma.productCategory.count({
        where: { tenantId, id: { in: unique } },
      });
      if (count !== unique.length) {
        throw new ConflictException("One or more categories are invalid");
      }
    }
    await this.prisma.productCategoryMap.deleteMany({ where: { tenantId, productId } });
    if (unique.length) {
      await this.prisma.productCategoryMap.createMany({
        data: unique.map((categoryId) => ({ tenantId, productId, categoryId })),
      });
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
      this.prisma.productCategoryMap.findMany({
        where: { tenantId, productId },
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

  private async ensureCategory(tenantId: string, id: string) {
    const row = await this.prisma.productCategory.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Category not found");
    return row;
  }

  private async ensureTag(tenantId: string, id: string) {
    const row = await this.prisma.productTag.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException("Tag not found");
    return row;
  }
}
