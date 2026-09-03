import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { assertOneScopedMutation } from "../common/scoped-mutation.util";
import {
  BulkProductsDto,
  type BulkProductAction,
} from "./dto/bulk-products.dto";
import { CreateProductDto } from "./dto/create-product.dto";
import { UpdateProductDto } from "./dto/update-product.dto";
import { ProductMetaService } from "./product-meta.service";
import { buildProductWhere } from "./product-query.util";
import {
  attachStockFields,
  resolveStockStatus,
  stockQtyByProductId,
  type StockStatus,
} from "./stock-qty.util";
import { buildProductDetailExtras } from "./product-detail.util";

const SORTABLE_FIELDS = new Set([
  "name",
  "sku",
  "brandName",
  "registrationNo",
  "schedule",
  "reorderLevel",
  "createdAt",
  "updatedAt",
]);

/** Hard cap so a full-catalog export stays bounded (covers large NMRA loads). */
const EXPORT_MAX_ROWS = 25_000;

/**
 * Ceiling on a "select all matching" bulk action. Generous enough to un-range a whole NMRA
 * load in one go, bounded so a single request can't rewrite an unbounded slice of the catalog.
 */
const BULK_PRODUCT_MATCH_LIMIT = 25_000;
const EXPORT_BATCH_SIZE = 500;

const CSV_HEADER = [
  "SKU",
  "Name",
  "Generic name",
  "Brand",
  "Manufacturer",
  "Dosage form",
  "Strength",
  "Unit",
  "Pack size",
  "Pack type",
  "Barcode",
  "Registration no.",
  "Schedule",
  "Registration type",
  "Dossier no.",
  "Country of origin",
  "Local agent",
  "Commercial Category",
  "In my range",
  "Status",
  "Requires prescription",
  "Controlled",
  "Reorder level",
  "Qty on hand",
  "Stock status",
] as const;

type ProductListQuery = {
  q?: string;
  skip?: number;
  take?: number;
  dosageForm?: string;
  brandName?: string;
  schedule?: string;
  isControlled?: string;
  requiresPrescription?: boolean;
  status?: string;
  rangeStatus?: string;
  lowStock?: boolean;
  categoryId?: string;
  commercialCategoryId?: string;
  tagId?: string;
  sortBy?: string;
  sortDir?: string;
};

function escapeCsv(value: string | number | boolean | null | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The `data` each bulk action writes, plus a `scope` clause narrowing it to rows the action
 * can actually change. The scope keeps `updated` an honest count of what moved, and stops
 * `range` from re-stamping `rangedAt` on products that were already in the range.
 */
function bulkActionUpdate(action: BulkProductAction): {
  data: Prisma.ProductUpdateManyMutationInput;
  scope: Prisma.ProductWhereInput;
} {
  switch (action) {
    case "range":
      return {
        data: { rangeStatus: "RANGED", rangedAt: new Date() },
        scope: { rangeStatus: "REFERENCE" },
      };
    case "unrange":
      return {
        data: { rangeStatus: "REFERENCE", rangedAt: null },
        scope: { rangeStatus: "RANGED" },
      };
    case "activate":
      return { data: { isActive: true }, scope: { isActive: false } };
    case "deactivate":
      return { data: { isActive: false }, scope: { isActive: true } };
  }
}

function stockStatusLabel(status: StockStatus | null | undefined): string {
  if (status === "out") return "Out of stock";
  if (status === "low") return "Low stock";
  if (status === "ok") return "Healthy";
  return "—";
}

/** Default browse order: stable pseudo-random via UUID id (not alphabetical by name). */
function resolveOrderBy(
  sortBy?: string,
  sortDir?: string,
): Prisma.ProductOrderByWithRelationInput {
  if (!sortBy || sortBy === "random") {
    return { id: "asc" };
  }
  if (!SORTABLE_FIELDS.has(sortBy)) {
    return { id: "asc" };
  }
  return {
    [sortBy]: sortDir === "desc" ? "desc" : "asc",
  };
}

const productInclude = {
  // COMMERCIAL only. This feeds the edit form's `categoryIds` field, which round-trips
  // unchanged through `ProductMetaService.syncProductCategories` on every save — that method
  // now validates every id is a COMMERCIAL category, so returning Dosage Form/Schedule/
  // Registration Type maps here would make saving ANY NMRA product fail with "One or more
  // categories are invalid" even when the user never touched categories.
  categoryMaps: { where: { dimension: "COMMERCIAL" as const }, include: { category: true } },
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
    query: ProductListQuery,
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

    const orderBy = resolveOrderBy(query.sortBy, query.sortDir);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        orderBy,
        skip,
        take,
        include: {
          // COMMERCIAL only — see productInclude above for why this must never leak
          // Dosage Form/Schedule/Registration Type maps into the same "categories" field.
          categoryMaps: { where: { dimension: "COMMERCIAL" }, include: { category: true } },
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

    const mapped = rows.map((p) =>
      this.mapProductWithRelations({ ...p, aliases: [] }),
    );
    const items = attachStockFields(mapped, stockMap);

    // Duplicate display-name hint for multi-registration groups.
    const names = [...new Set(items.map((p) => p.name).filter(Boolean))];
    if (names.length > 0) {
      const nameCounts = await this.prisma.product.groupBy({
        by: ["name"],
        where: { tenantId, name: { in: names } },
        _count: { _all: true },
      });
      const countByName = new Map(nameCounts.map((n) => [n.name, n._count._all]));
      for (const item of items) {
        (item as { sameNameCount?: number }).sameNameCount =
          countByName.get(item.name) ?? 1;
      }
    }

    return { items, total, skip, take };
  }

  /**
   * Full CSV for all products matching list filters/sort (same columns as the
   * web Products list export). Caps at EXPORT_MAX_ROWS.
   */
  async exportCsv(
    tenantId: string,
    branchId: string | undefined,
    query: Omit<ProductListQuery, "skip" | "take">,
  ): Promise<string> {
    const { where, isEmpty } = await buildProductWhere(
      this.prisma,
      tenantId,
      branchId,
      query,
    );

    if (isEmpty) {
      return CSV_HEADER.join(",");
    }

    const total = await this.prisma.product.count({ where });
    if (total > EXPORT_MAX_ROWS) {
      throw new BadRequestException(
        `Export exceeds the maximum of ${EXPORT_MAX_ROWS} products (${total} match). Narrow your filters and try again.`,
      );
    }

    const orderBy = resolveOrderBy(query.sortBy, query.sortDir);
    const stockMap = branchId
      ? await stockQtyByProductId(this.prisma, tenantId, branchId)
      : null;

    const lines: string[] = [CSV_HEADER.join(",")];
    let skip = 0;
    while (skip < total) {
      const rows = await this.prisma.product.findMany({
        where,
        orderBy,
        skip,
        take: EXPORT_BATCH_SIZE,
        include: {
          // Primary COMMERCIAL category only — Dosage Form/Schedule/Registration Type already
          // have their own explicit columns below and must never be blended into this one.
          categoryMaps: {
            where: { dimension: "COMMERCIAL", isPrimary: true },
            include: { category: { include: { parent: true } } },
          },
        },
      });
      if (rows.length === 0) break;

      for (const p of rows) {
        const qtyOnHand = stockMap ? (stockMap.get(p.id) ?? 0) : null;
        const stockStatus =
          qtyOnHand === null
            ? null
            : resolveStockStatus(qtyOnHand, p.reorderLevel);
        const primaryCategory = p.categoryMaps[0]?.category;
        const commercialCategory = primaryCategory
          ? primaryCategory.parent
            ? `${primaryCategory.parent.name} / ${primaryCategory.name}`
            : primaryCategory.name
          : "";
        lines.push(
          [
            p.sku,
            p.name,
            p.genericName,
            p.brandName,
            p.manufacturer,
            p.dosageForm,
            p.strength,
            p.unit,
            p.packSize,
            p.packType,
            p.barcode,
            p.registrationNo,
            p.schedule,
            p.regType,
            p.dossierNo,
            p.countryOfOrigin,
            p.localAgent,
            commercialCategory,
            p.rangeStatus === "RANGED" ? "Yes" : "No",
            p.isActive ? "Active" : "Inactive",
            p.requiresPrescription || p.isControlled ? "Yes" : "No",
            p.isControlled ? "Yes" : "No",
            p.reorderLevel,
            qtyOnHand ?? "",
            stockStatusLabel(stockStatus),
          ]
            .map(escapeCsv)
            .join(","),
        );
      }
      skip += rows.length;
    }

    return lines.join("\n");
  }

  async getById(tenantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, tenantId },
      include: productInclude,
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    const mapped = this.mapProductWithRelations(product);
    const sameNameCount = await this.prisma.product.count({
      where: { tenantId, name: product.name },
    });
    return { ...mapped, sameNameCount };
  }

  async getDetail(tenantId: string, branchId: string | undefined, id: string) {
    const product = await this.getById(tenantId, id);

    let qtyOnHand: number | null = null;
    let stockStatus: "out" | "low" | "ok" | null = null;
    let reorderGapVal: number | null = null;
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

    const extras = await buildProductDetailExtras(
      this.prisma,
      tenantId,
      branchId,
      id,
      product.reorderLevel,
    );

    if (branchId) {
      const stockMap = await stockQtyByProductId(this.prisma, tenantId, branchId, [id]);
      qtyOnHand = stockMap.get(id) ?? 0;
      const attached = attachStockFields(
        [{ ...product, reorderLevel: product.reorderLevel }],
        stockMap,
      )[0]!;
      stockStatus = attached.stockStatus;
      reorderGapVal = attached.reorderGap;

      if (extras.batches.length) {
        const selling = extras.batches.map((b) => Number(b.sellingPrice));
        const cost = extras.batches.map((b) => Number(b.costPrice));
        pricing = {
          minSellingPrice: String(Math.min(...selling)),
          maxSellingPrice: String(Math.max(...selling)),
          minCostPrice: String(Math.min(...cost)),
          maxCostPrice: String(Math.max(...cost)),
          batchCount: extras.batches.length,
        };
      }
    }

    const [productHistory, ledgerHistory] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { tenantId, entityName: "product", entityId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: {
          actor: { select: { id: true, fullName: true, email: true } },
        },
      }),
      branchId
        ? this.prisma.stockLedger.findMany({
            where: { tenantId, branchId, productId: id },
            orderBy: { occurredAt: "desc" },
            take: 40,
            include: {
              actor: { select: { id: true, fullName: true, email: true } },
              batch: { select: { batchNo: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const ledgerAsHistory = ledgerHistory.map((m) => ({
      id: `ledger:${m.id}`,
      eventName: `stock.${m.movementType}`,
      createdAt: m.occurredAt,
      payload: {
        qty: m.qtyDelta,
        batchNo: m.batch?.batchNo ?? null,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        reason: m.reason ?? null,
      },
      actor: m.actor,
    }));

    const historyMap = new Map<
      string,
      (typeof productHistory)[number] | (typeof ledgerAsHistory)[number]
    >();
    for (const item of [...productHistory, ...ledgerAsHistory]) {
      historyMap.set(item.id, item);
    }
    const history = [...historyMap.values()]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 60)
      .map((item) => ({
        id: item.id,
        eventName: item.eventName,
        createdAt:
          item.createdAt instanceof Date
            ? item.createdAt.toISOString()
            : String(item.createdAt),
        payload: item.payload,
        actor: item.actor,
      }));

    return {
      product,
      qtyOnHand,
      stockStatus,
      reorderGap: reorderGapVal,
      branchName: extras.branchName,
      batches: extras.batches,
      branchStock: extras.branchStock,
      movements: extras.movements,
      branchSummary: extras.branchSummary
        ? { ...extras.branchSummary, avgMonthlyUsage: extras.avgMonthlyUsage }
        : null,
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
          source: dto.source ?? "MANUAL",
          barcode: dto.barcode?.trim() || null,
          name: dto.name.trim(),
          brandName: dto.brandName?.trim() || null,
          genericName: dto.genericName?.trim() || null,
          manufacturer: dto.manufacturer?.trim() || null,
          dosageForm: dto.dosageForm?.trim() || null,
          strength: dto.strength?.trim() || null,
          unit: dto.unit?.trim() || null,
          packSize: dto.packSize?.trim() || null,
          packType: dto.packType?.trim() || null,
          storage: dto.storage?.trim() || null,
          shelfLife: dto.shelfLife?.trim() || null,
          taxCategory: dto.taxCategory?.trim() || null,
          imageUrl: dto.imageUrl?.trim() || null,
          registrationNo: dto.registrationNo?.trim() || null,
          registrationDate: dto.registrationDate
            ? new Date(dto.registrationDate)
            : null,
          schedule: dto.schedule?.trim() || null,
          regType: dto.regType?.trim() || null,
          dossierNo: dto.dossierNo?.trim() || null,
          countryOfOrigin: dto.countryOfOrigin?.trim() || null,
          localAgent: dto.localAgent?.trim() || null,
          isControlled: dto.isControlled ?? false,
          requiresPrescription:
            dto.isControlled === true
              ? true
              : (dto.requiresPrescription ?? false),
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
    const before = await this.getById(tenantId, id);
    const mutation = await this.prisma.product.updateMany({
      where: { id, tenantId },
      data: {
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        ...(dto.barcode !== undefined ? { barcode: dto.barcode?.trim() || null } : {}),
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.brandName !== undefined ? { brandName: dto.brandName?.trim() || null } : {}),
        ...(dto.genericName !== undefined ? { genericName: dto.genericName?.trim() || null } : {}),
        ...(dto.manufacturer !== undefined ? { manufacturer: dto.manufacturer?.trim() || null } : {}),
        ...(dto.dosageForm !== undefined ? { dosageForm: dto.dosageForm?.trim() || null } : {}),
        ...(dto.strength !== undefined ? { strength: dto.strength?.trim() || null } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit?.trim() || null } : {}),
        ...(dto.packSize !== undefined ? { packSize: dto.packSize?.trim() || null } : {}),
        ...(dto.packType !== undefined ? { packType: dto.packType?.trim() || null } : {}),
        ...(dto.storage !== undefined ? { storage: dto.storage?.trim() || null } : {}),
        ...(dto.shelfLife !== undefined ? { shelfLife: dto.shelfLife?.trim() || null } : {}),
        ...(dto.taxCategory !== undefined ? { taxCategory: dto.taxCategory?.trim() || null } : {}),
        ...(dto.imageUrl !== undefined ? { imageUrl: dto.imageUrl?.trim() || null } : {}),
        ...(dto.registrationNo !== undefined
          ? { registrationNo: dto.registrationNo?.trim() || null }
          : {}),
        ...(dto.registrationDate !== undefined
          ? {
              registrationDate: dto.registrationDate
                ? new Date(dto.registrationDate)
                : null,
            }
          : {}),
        ...(dto.schedule !== undefined ? { schedule: dto.schedule?.trim() || null } : {}),
        ...(dto.regType !== undefined ? { regType: dto.regType?.trim() || null } : {}),
        ...(dto.dossierNo !== undefined ? { dossierNo: dto.dossierNo?.trim() || null } : {}),
        ...(dto.countryOfOrigin !== undefined
          ? { countryOfOrigin: dto.countryOfOrigin?.trim() || null }
          : {}),
        ...(dto.localAgent !== undefined ? { localAgent: dto.localAgent?.trim() || null } : {}),
        ...(dto.isControlled !== undefined ? { isControlled: dto.isControlled } : {}),
        ...(dto.isControlled === true
          ? { requiresPrescription: true }
          : dto.requiresPrescription !== undefined
            ? { requiresPrescription: dto.requiresPrescription }
            : {}),
        ...(dto.reorderLevel !== undefined ? { reorderLevel: dto.reorderLevel } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
    assertOneScopedMutation(mutation, "Product");
    await this.meta.syncProductCategories(tenantId, id, dto.categoryIds);
    await this.meta.syncProductTags(tenantId, id, dto.tagIds);

    const after = await this.getById(tenantId, id);
    const tracked = [
      "name",
      "source",
      "barcode",
      "genericName",
      "brandName",
      "manufacturer",
      "dosageForm",
      "strength",
      "unit",
      "packSize",
      "packType",
      "storage",
      "shelfLife",
      "taxCategory",
      "registrationNo",
      "registrationDate",
      "schedule",
      "regType",
      "dossierNo",
      "countryOfOrigin",
      "localAgent",
      "reorderLevel",
      "isControlled",
      "requiresPrescription",
      "isActive",
    ] as const;
    const changes: { field: string; from: unknown; to: unknown }[] = [];
    for (const field of tracked) {
      const from = (before as Record<string, unknown>)[field];
      const to = (after as Record<string, unknown>)[field];
      if (String(from ?? "") !== String(to ?? "")) {
        changes.push({ field, from: from ?? null, to: to ?? null });
      }
    }

    await this.audit.log({
      tenantId,
      actorUserId: userId,
      eventName: "product.updated",
      entityName: "product",
      entityId: id,
      payload: {
        sku: after.sku,
        changes,
        ...(changes.length === 1
          ? { field: changes[0].field, from: changes[0].from, to: changes[0].to }
          : {}),
      } as Prisma.InputJsonValue,
    });
    return after;
  }

  /**
   * Range / un-range / activate / deactivate many products at once — the escape hatch for a
   * catalog that was imported too broadly, where fixing it product-by-product isn't realistic.
   *
   * Takes either an explicit id list (page selection) or the current list filters
   * ("select all N matching"), never both. Ranging stamps `rangedAt` only on rows that were
   * REFERENCE, so re-ranging an already-ranged product doesn't rewrite when it joined the
   * range. Un-ranging deliberately leaves `isActive` alone: the two flags answer different
   * questions, and collapsing them again is the bug this whole change exists to fix.
   */
  async bulkUpdate(tenantId: string, userId: string, dto: BulkProductsDto) {
    const hasIds = Boolean(dto.productIds?.length);
    const hasFilter = dto.filter !== undefined;
    if (hasIds === hasFilter) {
      throw new BadRequestException(
        "Provide either productIds or filter — exactly one of the two.",
      );
    }

    let ids: string[];
    if (hasIds) {
      ids = [...new Set(dto.productIds!)];
    } else {
      const { where, isEmpty } = await buildProductWhere(
        this.prisma,
        tenantId,
        undefined,
        dto.filter!,
      );
      if (isEmpty) {
        return { matched: 0, updated: 0, action: dto.action };
      }
      const matched = await this.prisma.product.count({ where });
      if (matched > BULK_PRODUCT_MATCH_LIMIT) {
        throw new BadRequestException(
          `This action would affect ${matched.toLocaleString()} products, above the limit of ${BULK_PRODUCT_MATCH_LIMIT.toLocaleString()}. Narrow your filters and try again.`,
        );
      }
      const rows = await this.prisma.product.findMany({ where, select: { id: true } });
      ids = rows.map((r) => r.id);
    }

    if (ids.length === 0) {
      return { matched: 0, updated: 0, action: dto.action };
    }

    const { data, scope } = bulkActionUpdate(dto.action);
    const result = await this.prisma.product.updateMany({
      where: { tenantId, id: { in: ids }, ...scope },
      data,
    });

    if (result.count > 0) {
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: `products.bulk_${dto.action}`,
        entityName: "product",
        // Catalog-wide event with no single subject — same convention as the NMRA import.
        entityId: tenantId,
        payload: {
          action: dto.action,
          matched: ids.length,
          updated: result.count,
          selection: hasIds ? "ids" : "filter",
        },
      });
    }

    return { matched: ids.length, updated: result.count, action: dto.action };
  }

  async remove(tenantId: string, userId: string, id: string) {
    const existing = await this.prisma.product.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Product not found");
    try {
      const mutation = await this.prisma.product.deleteMany({ where: { id, tenantId } });
      assertOneScopedMutation(mutation, "Product");
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
