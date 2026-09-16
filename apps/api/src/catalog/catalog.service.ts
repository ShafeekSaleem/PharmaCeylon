import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { businessToday, safeTimeZone } from "../common/business-date.util";
import {
  buildProductWhere,
  type ProductFilterQuery,
} from "../products/product-query.util";
import {
  looksLikeProductCode,
  scoreMatch,
  stockStatus,
  type MatchInfo,
  type MatchType,
} from "./catalog-match.util";

export type CatalogSearchQuery = ProductFilterQuery & {
  exact?: boolean;
  inStock?: boolean;
  outOfStock?: boolean;
  matchType?: MatchType | "all";
};

const RANK_CANDIDATE_CAP = 1500;

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  private async sellableStockMaps(
    tenantId: string,
    branchId: string,
    productIds: string[],
  ) {
    const qtyByProduct = new Map<string, number>();
    const sellPriceByProduct = new Map<string, number>();
    const costPriceByProduct = new Map<string, number>();
    if (productIds.length === 0) {
      return { qtyByProduct, sellPriceByProduct, costPriceByProduct };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const today = businessToday(safeTimeZone(tenant?.timezone));
    const batches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        productId: { in: productIds },
        needsExpiryReview: false,
        expiryDate: { gte: today },
        stock: { is: { onHandQty: { gt: 0 } } },
      },
      select: {
        id: true,
        stock: { select: { onHandQty: true, quarantinedQty: true, reservedQty: true } },
        productId: true,
        sellingPrice: true,
        costPrice: true,
        expiryDate: true,
      },
      orderBy: { expiryDate: "asc" },
    });

    const qtyByBatch = new Map<string, number>(
      batches.map((b) => [
        b.id,
        b.stock
          ? Math.max(0, b.stock.onHandQty - b.stock.quarantinedQty - b.stock.reservedQty)
          : 0,
      ]),
    );

    for (const b of batches) {
      const q = qtyByBatch.get(b.id) ?? 0;
      qtyByProduct.set(b.productId, (qtyByProduct.get(b.productId) ?? 0) + q);
      if (q > 0 && !sellPriceByProduct.has(b.productId)) {
        sellPriceByProduct.set(b.productId, Number(b.sellingPrice));
        costPriceByProduct.set(b.productId, Number(b.costPrice));
      }
    }

    return { qtyByProduct, sellPriceByProduct, costPriceByProduct };
  }

  async search(
    tenantId: string,
    branchId: string | undefined,
    query: CatalogSearchQuery,
    skip = 0,
    take = 40,
  ) {
    const term = query.q?.trim() ?? "";
    const exact = query.exact === true || looksLikeProductCode(term);
    const pageSize = Math.min(Math.max(Number.isFinite(take) ? take : 40, 1), 100);
    const pageSkip = Math.max(Number.isFinite(skip) ? skip : 0, 0);
    const matchTypeFilter =
      query.matchType && query.matchType !== "all" ? query.matchType : null;

    const hasFilters = Boolean(
      query.dosageForm ||
        query.brandName ||
        query.schedule ||
        query.isControlled ||
        query.categoryId ||
        query.commercialCategoryId ||
        query.tagId ||
        query.lowStock ||
        query.inStock ||
        query.outOfStock,
    );
    if (!term && !hasFilters) {
      return {
        items: [],
        total: 0,
        skip: pageSkip,
        take: pageSize,
        exactCount: 0,
        aliasCount: 0,
        genericCount: 0,
        rangedCount: 0,
        referenceCount: 0,
        truncated: false,
        hasMore: false,
      };
    }

    const filterQuery: ProductFilterQuery = {
      q: term && !looksLikeProductCode(term) && !query.exact ? term : undefined,
      dosageForm: query.dosageForm,
      brandName: query.brandName,
      schedule: query.schedule,
      isControlled: query.isControlled,
      status: "active",
      // Reference (registry) products stay searchable here by default — looking up any
      // medicine registered in Sri Lanka is the point of importing the NMRA catalog. They
      // are pushed below the shop's own products in the ranking, not hidden.
      rangeStatus: query.rangeStatus,
      lowStock: query.lowStock,
      categoryId: query.categoryId,
      commercialCategoryId: query.commercialCategoryId,
      tagId: query.tagId,
    };

    const { where: baseWhere, isEmpty } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      filterQuery,
    );
    if (isEmpty) {
      return {
        items: [],
        total: 0,
        skip: pageSkip,
        take: pageSize,
        exactCount: 0,
        aliasCount: 0,
        genericCount: 0,
        rangedCount: 0,
        referenceCount: 0,
        truncated: false,
        hasMore: false,
      };
    }

    // Barcode / SKU-first path: prefer equality & prefix over broad contains.
    let where: Prisma.ProductWhereInput = baseWhere;
    if (term && (query.exact || looksLikeProductCode(term))) {
      const codeClause: Prisma.ProductWhereInput = {
        OR: [
          { sku: { equals: term, mode: "insensitive" } },
          { barcode: { equals: term, mode: "insensitive" } },
          { registrationNo: { equals: term, mode: "insensitive" } },
          { sku: { startsWith: term, mode: "insensitive" } },
          { barcode: { startsWith: term, mode: "insensitive" } },
          { registrationNo: { startsWith: term, mode: "insensitive" } },
          ...(query.exact
            ? [{ name: { startsWith: term, mode: "insensitive" as const } }]
            : []),
        ],
      };
      where = { AND: [baseWhere, codeClause] };
    } else if (term) {
      // Keep text search from buildProductWhere (q already applied).
      where = baseWhere;
    }

    const candidates = await this.prisma.product.findMany({
      where,
      select: {
        id: true,
        sku: true,
        barcode: true,
        name: true,
        brandName: true,
        genericName: true,
        registrationNo: true,
        reorderLevel: true,
        rangeStatus: true,
        aliases: {
          where: { tenantId },
          select: { aliasText: true },
          take: 40,
        },
      },
      take: RANK_CANDIDATE_CAP,
      // rangeStatus first, and only then name: the candidate pool is capped, and the pool now
      // includes the whole imported registry. Ordering by name alone would let reference rows
      // crowd the shop's own products out of the cap and disappear them from search results.
      // (Postgres orders an enum by declaration order, REFERENCE before RANGED, so "desc"
      // puts the shop's own products first.)
      orderBy: [{ rangeStatus: "desc" }, { name: "asc" }],
    });
    const truncated = candidates.length >= RANK_CANDIDATE_CAP;

    const productIds = candidates.map((p) => p.id);
    let stockByProduct = new Map<string, number>();
    let sellPriceByProduct = new Map<string, number>();

    if (branchId && productIds.length > 0) {
      const maps = await this.sellableStockMaps(tenantId, branchId, productIds);
      stockByProduct = maps.qtyByProduct;
      sellPriceByProduct = maps.sellPriceByProduct;
    }

    type Ranked = {
      id: string;
      match: MatchInfo;
      qtyOnHand: number | null;
      reorderLevel: number;
      isRanged: boolean;
    };

    const ranked: Ranked[] = [];
    for (const p of candidates) {
      const match = scoreMatch(term, p, exact && Boolean(term));
      if (!match) continue;
      if (matchTypeFilter && match.matchType !== matchTypeFilter) continue;

      const qty = branchId ? (stockByProduct.get(p.id) ?? 0) : null;
      if (query.inStock && (qty == null || qty <= 0)) continue;
      if (query.outOfStock && (qty == null || qty > 0)) continue;
      if (query.lowStock && (qty == null || qty <= 0 || qty > p.reorderLevel)) continue;

      ranked.push({
        id: p.id,
        match,
        qtyOnHand: qty,
        reorderLevel: p.reorderLevel,
        isRanged: p.rangeStatus === "RANGED",
      });
    }

    // The shop's own products always come before reference-catalog results, whatever the
    // text match quality — a pharmacist searching "panadol" wants the line they stock first,
    // with the registry underneath as the "we could order this" tier.
    ranked.sort((a, b) => {
      if (a.isRanged !== b.isRanged) return a.isRanged ? -1 : 1;
      if (a.match.rank !== b.match.rank) return a.match.rank - b.match.rank;
      return a.id.localeCompare(b.id);
    });

    // Counts across full ranked set (before matchType already applied when filtering)
    // Recompute type counts from unfiltered-by-type when matchType set: re-score without type filter for tabs
    let exactCount = 0;
    let aliasCount = 0;
    let genericCount = 0;
    if (matchTypeFilter) {
      for (const p of candidates) {
        const match = scoreMatch(term, p, exact && Boolean(term));
        if (!match) continue;
        const qty = branchId ? (stockByProduct.get(p.id) ?? 0) : null;
        if (query.inStock && (qty == null || qty <= 0)) continue;
        if (query.outOfStock && (qty == null || qty > 0)) continue;
        if (query.lowStock && (qty == null || qty <= 0 || qty > p.reorderLevel)) continue;
        if (match.matchType === "exact") exactCount += 1;
        if (match.matchType === "alias") aliasCount += 1;
        if (match.matchType === "generic") genericCount += 1;
      }
    } else {
      exactCount = ranked.filter((r) => r.match.matchType === "exact").length;
      aliasCount = ranked.filter((r) => r.match.matchType === "alias").length;
      genericCount = ranked.filter((r) => r.match.matchType === "generic").length;
    }

    const rangedCount = ranked.filter((r) => r.isRanged).length;
    const referenceCount = ranked.length - rangedCount;

    const total = ranked.length;
    const pageRows = ranked.slice(pageSkip, pageSkip + pageSize);
    const pageIds = pageRows.map((r) => r.id);
    const matchById = new Map(pageRows.map((r) => [r.id, r]));

    const products =
      pageIds.length === 0
        ? []
        : await this.prisma.product.findMany({
            where: { tenantId, id: { in: pageIds } },
            include: {
              aliases: {
                where: { tenantId },
                select: { aliasText: true },
                take: 20,
              },
              // COMMERCIAL only — these are the catalog-search result's category badges, not
              // a mix of merchandising + regulatory (Dosage Form/Schedule/RegType) maps.
              categoryMaps: {
                where: { tenantId, dimension: "COMMERCIAL" },
                include: { category: { select: { id: true, name: true } } },
                take: 6,
              },
              tagMaps: {
                where: { tenantId },
                include: { tag: { select: { id: true, name: true } } },
                take: 8,
              },
            },
          });
    const productById = new Map(products.map((p) => [p.id, p]));

    return {
      items: pageIds
        .map((id) => {
          const p = productById.get(id);
          const row = matchById.get(id);
          if (!p || !row) return null;
          const qty = row.qtyOnHand;
          return {
            id: p.id,
            sku: p.sku,
            barcode: p.barcode,
            name: p.name,
            brandName: p.brandName,
            genericName: p.genericName,
            dosageForm: p.dosageForm,
            strength: p.strength,
            unit: p.unit,
            imageUrl: p.imageUrl,
            registrationNo: p.registrationNo,
            schedule: p.schedule,
            isControlled: p.isControlled,
            isActive: p.isActive,
            rangeStatus: p.rangeStatus,
            reorderLevel: p.reorderLevel,
            qtyOnHand: qty,
            stockStatus: qty == null ? null : stockStatus(qty, p.reorderLevel),
            sellPrice: sellPriceByProduct.get(p.id) ?? null,
            matchType: row.match.matchType,
            matchField: row.match.matchField,
            categories: p.categoryMaps.map((m) => ({
              id: m.category.id,
              name: m.category.name,
            })),
            tags: p.tagMaps.map((m) => ({
              id: m.tag.id,
              name: m.tag.name,
            })),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null),
      total,
      skip: pageSkip,
      take: pageSize,
      exactCount,
      aliasCount,
      genericCount,
      rangedCount,
      referenceCount,
      truncated,
      hasMore: pageSkip + pageSize < total,
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
    const { where: scheduleWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "schedule",
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
    const { where: rxWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "requiresPrescription",
    );
    const { where: rangeWhere } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
      "rangeStatus",
    );

    const [
      brands,
      forms,
      schedules,
      statusGroups,
      controlledGroups,
      rxGroups,
      rangeGroups,
    ] = await this.prisma.$transaction([
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
        by: ["schedule"],
        where: { ...scheduleWhere, schedule: { not: null } },
        orderBy: { schedule: "asc" },
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
      this.prisma.product.groupBy({
        by: ["requiresPrescription"],
        where: rxWhere,
        orderBy: { requiresPrescription: "asc" },
        _count: true,
      }),
      this.prisma.product.groupBy({
        by: ["rangeStatus"],
        where: rangeWhere,
        orderBy: { rangeStatus: "asc" },
        _count: true,
      }),
    ]);

    const statusCount = (active: boolean) =>
      statusGroups.find((s) => s.isActive === active)?._count ?? 0;

    const controlledCount = (controlled: boolean) =>
      controlledGroups.find((c) => c.isControlled === controlled)?._count ?? 0;

    const rxCount = (required: boolean) =>
      rxGroups.find((r) => r.requiresPrescription === required)?._count ?? 0;

    const rangeCount = (value: "RANGED" | "REFERENCE") =>
      rangeGroups.find((r) => r.rangeStatus === value)?._count ?? 0;

    let inStock = 0;
    let lowStock = 0;
    let outOfStock = 0;
    if (branchId) {
      // Only load products that have ledger activity at this branch (not the full catalog).
      const ledgerGroups = await this.prisma.stockLedger.groupBy({
        by: ["productId"],
        where: { tenantId, branchId },
        _sum: { qtyDelta: true },
      });
      const candidateIds = ledgerGroups
        .filter((g) => (g._sum.qtyDelta ?? 0) > 0)
        .map((g) => g.productId);

      const stockedProducts =
        candidateIds.length > 0
          ? await this.prisma.product.findMany({
              where: { AND: [summaryWhere, { id: { in: candidateIds } }] },
              select: { id: true, reorderLevel: true },
            })
          : [];

      const maps = await this.sellableStockMaps(
        tenantId,
        branchId,
        stockedProducts.map((p) => p.id),
      );
      for (const p of stockedProducts) {
        const qty = maps.qtyByProduct.get(p.id) ?? 0;
        if (qty > 0) {
          inStock += 1;
          if (p.reorderLevel > 0 && qty <= p.reorderLevel) lowStock += 1;
        }
      }

      // Only the shop's own range can be "out of stock". Reference records were never
      // carried, so counting them here would report a whole imported registry as a shelf
      // of out-of-stock items.
      const totalMatching = await this.prisma.product.count({
        where: { AND: [summaryWhere, { rangeStatus: "RANGED" }] },
      });
      outOfStock = Math.max(0, totalMatching - inStock);
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

    const [categoryRows, tagRows, parentRows, commercialRows] = await this.prisma.$transaction([
      this.prisma.productCategory.findMany({
        where: { tenantId, id: { in: categoryGroups.map((g) => g.categoryId) } },
        orderBy: { name: "asc" },
      }),
      this.prisma.productTag.findMany({
        where: { tenantId, id: { in: tagGroups.map((g) => g.tagId) } },
        orderBy: { name: "asc" },
      }),
      this.prisma.productCategory.findMany({
        where: { tenantId, parentCategoryId: null },
        select: { id: true, name: true },
      }),
      // Full active COMMERCIAL tree regardless of current product counts, so department/
      // category navigation (Products filter, POS shortcuts) doesn't disappear at 0 products.
      this.prisma.productCategory.findMany({
        where: { tenantId, dimension: "COMMERCIAL", isActive: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, parentCategoryId: true, canonicalKey: true },
      }),
    ]);

    const categoryCountMap = new Map<string, number>(
      categoryGroups.map((g) => [g.categoryId, g._count as number]),
    );
    const tagCountMap = new Map(tagGroups.map((g) => [g.tagId, g._count]));
    const parentNameById = new Map(parentRows.map((p) => [p.id, p.name]));

    const SCHEDULE_LABELS: Record<string, string> = {
      I: "I — Grocery / general retail",
      "II A": "II A — Pharmacy OTC",
      "II B": "II B — Prescription only",
      "II C": "II C — Controlled prescription",
      III: "III — Narcotic (Osusala)",
    };

    const categories = categoryRows.map((c) => ({
      value: c.id,
      label: c.name,
      count: categoryCountMap.get(c.id) ?? 0,
      parentCategoryId: c.parentCategoryId,
      parentName: c.parentCategoryId
        ? (parentNameById.get(c.parentCategoryId) ?? null)
        : null,
      dimension: c.dimension,
    }));

    const byDimension = (dimension: "DOSAGE_FORM" | "NMRA_SCHEDULE" | "REGISTRATION_TYPE") =>
      categories.filter((c) => c.dimension === dimension);

    const commercialDepartments = commercialRows
      .filter((c) => !c.parentCategoryId)
      .map((dept) => {
        const children = commercialRows
          .filter((c) => c.parentCategoryId === dept.id)
          .map((c) => ({
            id: c.id,
            label: c.name,
            canonicalKey: c.canonicalKey,
            parentCategoryId: c.parentCategoryId,
            count: categoryCountMap.get(c.id) ?? 0,
          }));
        // Products are filed on leaf categories, not the department itself, so the
        // department's own direct count is normally 0 — roll up children so the
        // department row shows the total this facet actually matches (selecting a
        // department expands to its descendants, see `expandCommercialCategoryIds`).
        const ownCount = categoryCountMap.get(dept.id) ?? 0;
        const childrenTotal = children.reduce((sum, c) => sum + c.count, 0);
        return {
          id: dept.id,
          label: dept.name,
          canonicalKey: dept.canonicalKey,
          count: ownCount + childrenTotal,
          children,
        };
      });

    return {
      brands: brands.map((b) => ({ value: b.brandName!, count: b._count })),
      dosageForms: forms.map((f) => ({ value: f.dosageForm!, count: f._count })),
      schedules: schedules.map((s) => ({
        value: s.schedule!,
        label: SCHEDULE_LABELS[s.schedule!] ?? s.schedule!,
        count: s._count,
      })),
      categories,
      formGroups: byDimension("DOSAGE_FORM"),
      scheduleCategories: byDimension("NMRA_SCHEDULE"),
      registrationTypes: byDimension("REGISTRATION_TYPE"),
      /** COMMERCIAL department → category tree — active only. This is "Category" on the Products page / POS. */
      commercialDepartments,
      tags: tagRows.map((t) => ({
        value: t.id,
        label: t.name,
        count: tagCountMap.get(t.id) ?? 0,
      })),
      status: [
        { value: "active", count: statusCount(true) },
        { value: "inactive", count: statusCount(false) },
      ],
      // Drives the Products page's "My products" / "Reference catalog" tab counts.
      rangeStatus: [
        { value: "RANGED", count: rangeCount("RANGED") },
        { value: "REFERENCE", count: rangeCount("REFERENCE") },
      ],
      controlled: [
        { value: true, count: controlledCount(true) },
        { value: false, count: controlledCount(false) },
      ],
      requiresPrescription: [
        { value: true, count: rxCount(true) },
        { value: false, count: rxCount(false) },
      ],
      branchStockSummary: branchId
        ? {
            inStockProductCount: inStock,
            lowStockProductCount: lowStock,
            outOfStockProductCount: outOfStock,
          }
        : null,
    };
  }

  async productDetail(tenantId: string, branchId: string | undefined, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      include: {
        aliases: { where: { tenantId }, select: { aliasText: true }, take: 20 },
        // COMMERCIAL only — `dosageForm`/`schedule`/`regType` scalar fields already carry the
        // regulatory classification below; this must not also list Dosage Form/Schedule/
        // Registration Type category-map names under the same "categories" key.
        categoryMaps: {
          where: { tenantId, dimension: "COMMERCIAL" },
          include: { category: { select: { id: true, name: true } } },
        },
        tagMaps: {
          where: { tenantId },
          include: { tag: { select: { id: true, name: true } } },
        },
      },
    });
    if (!product) throw new NotFoundException("Product not found");

    const branches = await this.prisma.branch.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    });

    let sellPrice: number | null = null;
    let costPrice: number | null = null;
    let qtyOnHand: number | null = null;
    const branchAvailability: Array<{
      branchId: string;
      code: string;
      name: string;
      qtyOnHand: number;
      stockStatus: "healthy" | "low" | "out";
      isActiveBranch: boolean;
    }> = [];

    for (const b of branches) {
      const maps = await this.sellableStockMaps(tenantId, b.id, [productId]);
      const qty = maps.qtyByProduct.get(productId) ?? 0;
      if (b.id === branchId) {
        qtyOnHand = qty;
        sellPrice = maps.sellPriceByProduct.get(productId) ?? null;
        costPrice = maps.costPriceByProduct.get(productId) ?? null;
      }
      branchAvailability.push({
        branchId: b.id,
        code: b.code,
        name: b.name,
        qtyOnHand: qty,
        stockStatus: stockStatus(qty, product.reorderLevel),
        isActiveBranch: b.id === branchId,
      });
    }

    return {
      id: product.id,
      sku: product.sku,
      barcode: product.barcode,
      name: product.name,
      brandName: product.brandName,
      genericName: product.genericName,
      manufacturer: product.manufacturer,
      dosageForm: product.dosageForm,
      strength: product.strength,
      unit: product.unit,
      packSize: product.packSize,
      packType: product.packType,
      imageUrl: product.imageUrl,
      registrationNo: product.registrationNo,
      registrationDate: product.registrationDate?.toISOString().slice(0, 10) ?? null,
      schedule: product.schedule,
      regType: product.regType,
      dossierNo: product.dossierNo,
      countryOfOrigin: product.countryOfOrigin,
      localAgent: product.localAgent,
      isControlled: product.isControlled,
      requiresPrescription: product.requiresPrescription,
      isActive: product.isActive,
      reorderLevel: product.reorderLevel,
      aliases: product.aliases.map((a) => a.aliasText),
      categories: product.categoryMaps.map((m) => ({
        id: m.category.id,
        name: m.category.name,
      })),
      tags: product.tagMaps.map((m) => ({
        id: m.tag.id,
        name: m.tag.name,
      })),
      qtyOnHand,
      stockStatus:
        qtyOnHand == null ? null : stockStatus(qtyOnHand, product.reorderLevel),
      sellPrice,
      costPrice,
      branchAvailability,
    };
  }

  async alternatives(tenantId: string, branchId: string | undefined, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
    });
    if (!product) throw new NotFoundException("Product not found");

    const sims = await this.prisma.productSimilarity.findMany({
      where: { tenantId, productId },
      include: { similarProduct: true },
      orderBy: { score: "desc" },
      take: 20,
    });

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

    const merged = new Map<
      string,
      { reason: string; product: typeof product; score?: number }
    >();
    for (const s of sims) {
      if (!s.similarProduct.isActive) continue;
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

    const altIds = [...merged.keys()];
    let stockByProduct = new Map<string, number>();
    if (branchId && altIds.length > 0) {
      const maps = await this.sellableStockMaps(tenantId, branchId, altIds);
      stockByProduct = maps.qtyByProduct;
    }

    return {
      items: [...merged.values()].map((m) => {
        const qty = branchId ? (stockByProduct.get(m.product.id) ?? 0) : null;
        return {
          product: {
            id: m.product.id,
            sku: m.product.sku,
            name: m.product.name,
            brandName: m.product.brandName,
            genericName: m.product.genericName,
            dosageForm: m.product.dosageForm,
            strength: m.product.strength,
            imageUrl: m.product.imageUrl,
            reorderLevel: m.product.reorderLevel,
          },
          reason: m.reason,
          score: m.score ?? null,
          qtyOnHand: qty,
          stockStatus:
            qty == null ? null : stockStatus(qty, m.product.reorderLevel),
        };
      }),
    };
  }
}
