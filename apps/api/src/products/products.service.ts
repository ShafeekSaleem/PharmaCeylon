import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductMetaService } from "./product-meta.service";
import { buildProductWhere } from "./product-query.util";
import {
  attachStockFields,
  stockQtyByProductId,
} from "./stock-qty.util";

const SORTABLE_FIELDS = new Set([
  "name",
  "sku",
  "brandName",
  "reorderLevel",
  "createdAt",
  "updatedAt",
]);

const productInclude = {
  categoryMaps: { include: { category: true } },
  tagMaps: { include: { tag: true } },
  aliases: { orderBy: { aliasText: "asc" as const } },
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly meta: ProductMetaService,
  ) {}

  async list(
    tenantId: string,
    branchId: string | undefined,
    query: {
      q?: string;
      skip?: number;
      take?: number;
      dosageForm?: string;
      brandName?: string;
      isControlled?: string;
      status?: string;
      lowStock?: boolean;
      categoryId?: string;
      tagId?: string;
      sortBy?: string;
      sortDir?: string;
    },
  ) {
    const take = Math.min(query.take ?? 50, 200);
    const skip = query.skip ?? 0;

    const { where, isEmpty } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
    );

    if (isEmpty) {
      return { items: [], total: 0, skip, take };
    }

    const sortField = SORTABLE_FIELDS.has(query.sortBy ?? "")
      ? query.sortBy!
      : "name";
    const sortDirection: Prisma.SortOrder =
      query.sortDir === "desc" ? "desc" : "asc";

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: { [sortField]: sortDirection },
        skip,
        take,
        include: {
          categoryMaps: { include: { category: true } },
          tagMaps: { include: { tag: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    const stockMap = branchId
      ? await stockQtyByProductId(
          this.prisma,
          tenantId,
          branchId,
          rows.map((r) => r.id),
        )
      : null;

    const items = attachStockFields(
      rows.map((p) => this.mapProductWithRelations({ ...p, aliases: [] })),
      stockMap,
    );

    return { items, total, skip, take };
  }

  async getById(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      include: productInclude,
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    return this.mapProductWithRelations(product);
  }

  async getDetail(tenantId: string, branchId: string | undefined, id: string) {
    const product = await this.getById(tenantId, id);

    let qtyOnHand: number | null = null;
    let stockStatus: "out" | "low" | "ok" | null = null;
    let reorderGapVal: number | null = null;
    let batches: Awaited<ReturnType<typeof this.prisma.batch.findMany>> = [];
    let pricing: {
      minSellingPrice: string | null;
      maxSellingPrice: string | null;
      minCostPrice: string | null;
      maxCostPrice: string | null;
      batchCount: number;
    } = {
      minSellingPrice: null,
      maxSellingPrice: null,
      minCostPrice: null,
      maxCostPrice: null,
      batchCount: 0,
    };

    if (branchId) {
      const stockMap = await stockQtyByProductId(this.prisma, tenantId, branchId, [id]);
      qtyOnHand = stockMap.get(id) ?? 0;
      const attached = attachStockFields([{ ...product, reorderLevel: product.reorderLevel }], stockMap)[0]!;
      stockStatus = attached.stockStatus;
      reorderGapVal = attached.reorderGap;

      batches = await this.prisma.batch.findMany({
        where: { tenantId, branchId, productId: id },
        orderBy: { expiryDate: "asc" },
      });

      if (batches.length) {
        const selling = batches.map((b) => Number(b.sellingPrice));
        const cost = batches.map((b) => Number(b.costPrice));
        pricing = {
          minSellingPrice: String(Math.min(...selling)),
          maxSellingPrice: String(Math.max(...selling)),
          minCostPrice: String(Math.min(...cost)),
          maxCostPrice: String(Math.max(...cost)),
          batchCount: batches.length,
        };
      }
    }

    const history = await this.prisma.auditEvent.findMany({
      where: { tenantId, entityName: "product", entityId: id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: {
        actor: { select: { id: true, fullName: true, email: true } },
      },
    });

    return {
      product,
      qtyOnHand,
      stockStatus,
      reorderGap: reorderGapVal,
      batches,
      pricing,
      history,
    };
  }

  async create(tenantId: string, userId: string, dto: CreateProductDto) {
    try {
      const product = await this.prisma.product.create({
        data: {
          tenantId,
          sku: dto.sku.trim(),
          barcode: dto.barcode?.trim() || null,
          name: dto.name.trim(),
          brandName: dto.brandName?.trim() || null,
          genericName: dto.genericName?.trim() || null,
          manufacturer: dto.manufacturer?.trim() || null,
          dosageForm: dto.dosageForm?.trim() || null,
          strength: dto.strength?.trim() || null,
          unit: dto.unit?.trim() || null,
          imageUrl: dto.imageUrl?.trim() || null,
          isControlled: dto.isControlled ?? false,
          reorderLevel: dto.reorderLevel ?? 0,
        },
      });
      await this.meta.syncProductCategories(tenantId, product.id, dto.categoryIds);
      await this.meta.syncProductTags(tenantId, product.id, dto.tagIds);
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "product.created",
        entityName: "product",
        entityId: product.id,
        payload: { sku: product.sku },
      });
      return this.getById(tenantId, product.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        throw new ConflictException("SKU must be unique within the tenant");
      }
      throw e;
    }
  }

  async update(tenantId: string, userId: string, id: string, dto: UpdateProductDto) {
    await this.getById(tenantId, id);
    await this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.barcode !== undefined ? { barcode: dto.barcode?.trim() || null } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.brandName !== undefined ? { brandName: dto.brandName?.trim() || null } : {}),
        ...(dto.genericName !== undefined ? { genericName: dto.genericName?.trim() || null } : {}),
        ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer?.trim() || null } : {}),
        ...(dto.dosageForm !== undefined ? { dosageForm: dto.dosageForm?.trim() || null } : {}),
        ...(dto.strength !== undefined ? { strength: dto.strength?.trim() || null } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit?.trim() || null } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl?.trim() || null } : {}),
        ...(dto.isControlled !== undefined ? { isControlled: dto.isControlled } : {}),
        ...(dto.reorderLevel !== undefined ? { reorderLevel: dto.reorderLevel } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    await this.meta.syncProductCategories(tenantId, id, dto.categoryIds);
    await this.meta.syncProductTags(tenantId, id, dto.tagIds);
    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "product.updated",
      entityName: "product",
      entityId: id,
    });
    return this.getById(tenantId, id);
  }

  async remove(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Product not found");
    try {
      await this.prisma.product.delete({ where: { id } });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "product.deleted",
        entityName: "product",
        entityId: id,
        payload: { sku: existing.sku },
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
        throw new ConflictException(
          "Product cannot be deleted because it is referenced by inventory or sales records",
        );
      }
      throw e;
    }
  }

  private mapProductWithRelations(
    product: Prisma.ProductGetPayload<{ include: typeof productInclude }>,
  ) {
    const { categoryMaps, tagMaps, aliases, ...rest } = product;
    return {
      ...rest,
      categories: categoryMaps.map((m) => m.category),
      tags: tagMaps.map((m) => m.tag),
      aliases: aliases ?? [],
    };
  }
}
