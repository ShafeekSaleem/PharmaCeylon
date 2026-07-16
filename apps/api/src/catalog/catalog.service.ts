import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  buildProductWhere,
  type ProductFilterQuery,
} from "../products/product-query.util";

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async search(tenantId: string, branchId: string | undefined, q: string, skip = 0, take = 20) {
    const term = q.trim();
    if (!term) {
      return { items: [], total: 0, skip, take };
    }
    const pattern = term;
    const where: Prisma.ProductWhereInput = {
      tenantId,
      isActive: true,
      OR: [
        { sku: { contains: pattern, mode: "insensitive" } },
        { barcode: { contains: pattern, mode: "insensitive" } },
        { name: { contains: pattern, mode: "insensitive" } },
        { brandName: { contains: pattern, mode: "insensitive" } },
        { genericName: { contains: pattern, mode: "insensitive" } },
        {
          aliases: {
            some: { tenantId, aliasText: { contains: pattern, mode: "insensitive" } },
          },
        },
      ],
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy: [{ brandName: "asc" }, { name: "asc" }],
        skip,
        take: Math.min(take, 100),
      }),
      this.prisma.product.count({ where }),
    ]);

    let stockByProduct = new Map<string, number>();
    if (branchId) {
      const grouped = await this.prisma.stockLedger.groupBy({
        by: ["productId"],
        where: { tenantId, branchId },
        _sum: { qtyDelta: true },
      });
      stockByProduct = new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));
    }

    return {
      items: items.map((p) => ({
        ...p,
        qtyOnHand: branchId ? (stockByProduct.get(p.id) ?? 0) : null,
      })),
      total,
      skip,
      take: Math.min(take, 100),
    };
  }

  async facets(
    tenantId: string,
    branchId: string | undefined,
    query: ProductFilterQuery = {},
  ) {
    const { where: summaryWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
    );

    const { where: brandWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "brandName",
    );
    const { where: dosageWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "dosageForm",
    );
    const { where: statusWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "status",
    );
    const { where: controlledWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "isControlled",
    );

    const [brands, forms, statusGroups, controlledGroups] =
      await this.prisma.$transaction([
        this.prisma.product.groupBy({
          by: ["brandName"],
          where: { ...brandWhere, brandName: { not: null } },
          orderBy: { brandName: "asc" },
          _count: true,
        }),
        this.prisma.product.groupBy({
          by: ["dosageForm"],
          where: { ...dosageWhere, dosageForm: { not: null } },
          orderBy: { dosageForm: "asc" },
          _count: true,
        }),
        this.prisma.product.groupBy({
          by: ["isActive"],
          where: statusWhere,
          orderBy: { isActive: "asc" },
          _count: true,
        }),
        this.prisma.product.groupBy({
          by: ["isControlled"],
          where: controlledWhere,
          orderBy: { isControlled: "asc" },
          _count: true,
        }),
      ]);

    const statusCount = (active: boolean) =>
      statusGroups.find((s) => s.isActive === active)?._count ?? 0;

    const controlledCount = (controlled: boolean) =>
      controlledGroups.find((c) => c.isControlled === controlled)?._count ?? 0;

    let inStock = 0;
    let lowStock = 0;
    if (branchId) {
      const grouped = await this.prisma.stockLedger.groupBy({
        by: ["productId"],
        where: { tenantId, branchId },
        _sum: { qtyDelta: true },
      });
      const products = await this.prisma.product.findMany({
        where: summaryWhere,
        select: { id: true, reorderLevel: true },
      });
      const qtyMap = new Map(
        grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]),
      );
      for (const p of products) {
        const qty = qtyMap.get(p.id) ?? 0;
        if (qty > 0) inStock += 1;
        if (qty > 0 && qty <= p.reorderLevel) lowStock += 1;
      }
    }

    const [categoryGroups, tagGroups] = await this.prisma.$transaction([
      this.prisma.productCategoryMap.groupBy({
        by: ["categoryId"],
        where: { tenantId, product: summaryWhere },
        orderBy: { categoryId: "asc" },
        _count: true,
      }),
      this.prisma.productTagMap.groupBy({
        by: ["tagId"],
        where: { tenantId, product: summaryWhere },
        orderBy: { tagId: "asc" },
        _count: true,
      }),
    ]);

    const [categoryRows, tagRows] = await this.prisma.$transaction([
      this.prisma.productCategory.findMany({
        where: { tenantId, id: { in: categoryGroups.map((g) => g.categoryId) } },
        orderBy: { name: "asc" },
      }),
      this.prisma.productTag.findMany({
        where: { tenantId, id: { in: tagGroups.map((g) => g.tagId) } },
        orderBy: { name: "asc" },
      }),
    ]);

    const categoryCountMap = new Map(categoryGroups.map((g) => [g.categoryId, g._count]));
    const tagCountMap = new Map(tagGroups.map((g) => [g.tagId, g._count]));

    return {
      brands: brands.map((b) => ({ value: b.brandName!, count: b._count })),
      dosageForms: forms.map((f) => ({ value: f.dosageForm!, count: f._count })),
      categories: categoryRows.map((c) => ({
        value: c.id,
        label: c.name,
        count: categoryCountMap.get(c.id) ?? 0,
      })),
      tags: tagRows.map((t) => ({
        value: t.id,
        label: t.name,
        count: tagCountMap.get(t.id) ?? 0,
      })),
      status: [
        { value: "active", count: statusCount(true) },
        { value: "inactive", count: statusCount(false) },
      ],
      controlled: [
        { value: true, count: controlledCount(true) },
        { value: false, count: controlledCount(false) },
      ],
      branchStockSummary: branchId
        ? { inStockProductCount: inStock, lowStockProductCount: lowStock }
        : null,
    };
  }

  async alternatives(tenantId: string, branchId: string | undefined, productId: string) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, tenantId } });
    if (!product) return { items: [] };

    const sims = await this.prisma.productSimilarity.findMany({
      where: { tenantId, productId },
      include: { similarProduct: true },
      orderBy: { score: "desc" },
      take: 20,
    });

    let stockByProduct = new Map<string, number>();
    if (branchId) {
      const grouped = await this.prisma.stockLedger.groupBy({
        by: ["productId"],
        where: { tenantId, branchId },
        _sum: { qtyDelta: true },
      });
      stockByProduct = new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));
    }

    const genericMatches =
      product.genericName && product.strength && product.dosageForm
        ? await this.prisma.product.findMany({
            where: {
              tenantId,
              isActive: true,
              id: { not: productId },
              genericName: { equals: product.genericName, mode: "insensitive" },
              strength: { equals: product.strength, mode: "insensitive" },
              dosageForm: { equals: product.dosageForm, mode: "insensitive" },
            },
            take: 15,
          })
        : [];

    const merged = new Map<string, { reason: string; product: typeof product; score?: number }>();
    for (const s of sims) {
      merged.set(s.similarProductId, {
        reason: s.reasonCode,
        product: s.similarProduct,
        score: Number(s.score),
      });
    }
    for (const p of genericMatches) {
      if (!merged.has(p.id)) {
        merged.set(p.id, { reason: "same_generic_form_strength", product: p });
      }
    }

    return {
      items: [...merged.values()].map((m) => ({
        product: m.product,
        reason: m.reason,
        score: m.score ?? null,
        qtyOnHand: branchId ? (stockByProduct.get(m.product.id) ?? 0) : null,
      })),
    };
  }
}
