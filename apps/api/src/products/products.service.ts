import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
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
import { scoreMatch } from "../catalog/catalog-match.util";
import { decideRangeExit, decideReferencePromotion } from "./range-transition.util";

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

/** Row batch for bulk category/tag relation writes — keeps one statement bounded. */
const BULK_RELATION_BATCH = 400;

const EXPORT_BATCH_SIZE = 500;

/** What a bulk action would do, for the confirmation dialog to state before it happens. */
export type BulkProductPreview = {
  action: BulkProductAction;
  /** Products the selection resolves to. */
  matched: number;
  /** Products this action would actually change. */
  willChange: number;
  /** Products already in the requested state — nothing to do for these. */
  alreadyOnTarget: number;
  /** Products whose existing primary category would be replaced. */
  replacingExisting: number;
  /** Of those, the ones a person filed by hand rather than the classifier. */
  replacingManual: number;
  categoryName: string | null;
  tagNames: string[];
};

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
  importId?: string;
  sortBy?: string;
  sortDir?: string;
};

function escapeCsv(value: string | number | boolean | null | undefined): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * The actions that write a column on `product` itself. The category/tag actions are relation
 * writes and take their own paths — keeping them out of this union is what makes the switch
 * below exhaustive.
 */
type BulkColumnAction = Exclude<
  BulkProductAction,
  "set_category" | "clear_category" | "add_tags" | "remove_tags"
>;

/**
 * The `data` each bulk action writes, plus a `scope` clause narrowing it to rows the action
 * can actually change. The scope keeps `updated` an honest count of what moved, and stops
 * `range` from re-stamping `rangedAt` on products that were already in the range.
 */
function bulkActionUpdate(action: BulkColumnAction): {
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
          // Loaded only when there is a term to match — the alias tier is the whole reason
          // "panadol" finds a row registered as "PARACETAMOL TABLETS BP 500MG".
          ...(query.q?.trim() ? { aliases: { select: { aliasText: true } } } : {}),
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

    /*
     * Why the shop's product list now scores matches the way Search Catalog did:
     * Search Catalog and the Reference tab were two searches over the same reference rows,
     * and only one of them could tell you *why* a row came back. Consolidating them means
     * this list has to answer that too — a register row surfaced because the term matched a
     * shop alias is a very different result from one where it matched the registration
     * number, and hiding that difference is what made the two screens feel unrelated.
     */
    const term = query.q?.trim();
    if (term) {
      const aliasesById = new Map(
        rows.map((r) => [
          r.id,
          ((r as { aliases?: Array<{ aliasText: string }> }).aliases ?? []),
        ]),
      );
      for (const item of items) {
        const info = scoreMatch(
          term,
          {
            sku: item.sku,
            barcode: item.barcode,
            name: item.name,
            brandName: item.brandName,
            genericName: item.genericName,
            registrationNo: item.registrationNo,
            aliases: aliasesById.get(item.id),
          },
          false,
        );
        const target = item as { matchType?: string; matchField?: string };
        target.matchType = info?.matchType;
        target.matchField = info?.matchField;
      }
    }

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
          // Provenance is the server's to state: this endpoint is a person typing a product
          // in. The importers set NMRA / CSV_IMPORT on their own paths.
          source: "MANUAL",
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
        // `source` is deliberately absent: an edit can change what a product is, never how it
        // arrived. It used to be a dropdown offering "CSV import" and "Barcode lookup" as
        // things to pick, which described the record's history rather than the product.
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
  /**
   * Resolve a bulk request's selection to product ids — either the explicit list, or everything
   * matching the list filters, bounded so one request can't rewrite an unbounded slice of the
   * catalog. Shared by the preview and the apply, so the number the confirmation dialog shows
   * and the number the action touches are computed the same way.
   */
  private async resolveBulkIds(tenantId: string, dto: BulkProductsDto): Promise<string[]> {
    const hasIds = Boolean(dto.productIds?.length);
    const hasFilter = dto.filter !== undefined;
    if (hasIds === hasFilter) {
      throw new BadRequestException(
        "Provide either productIds or filter — exactly one of the two.",
      );
    }
    if (hasIds) return [...new Set(dto.productIds!)];

    const { where, isEmpty } = await buildProductWhere(
      this.prisma,
      tenantId,
      undefined,
      dto.filter!,
    );
    if (isEmpty) return [];

    const matched = await this.prisma.product.count({ where });
    if (matched > BULK_PRODUCT_MATCH_LIMIT) {
      throw new BadRequestException(
        `This action would affect ${matched.toLocaleString()} products, above the limit of ${BULK_PRODUCT_MATCH_LIMIT.toLocaleString()}. Narrow your filters and try again.`,
      );
    }
    const rows = await this.prisma.product.findMany({ where, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /**
   * Validate the category or tags a relation action targets, and resolve their names for the
   * confirmation dialog and the audit payload. Ids arrive from the client, so each is checked
   * against this tenant before anything is written.
   */
  private async resolveBulkTargets(tenantId: string, dto: BulkProductsDto) {
    if (dto.action === "set_category") {
      if (!dto.categoryId) {
        throw new BadRequestException("Choose a category to file these products under.");
      }
      const category = await this.prisma.productCategory.findFirst({
        where: { id: dto.categoryId, tenantId, dimension: "COMMERCIAL" },
        select: { id: true, name: true },
      });
      if (!category) {
        throw new NotFoundException("Category not found, or is not a merchandising category.");
      }
      return { category, tags: [] as Array<{ id: string; name: string }> };
    }

    if (dto.action === "add_tags" || dto.action === "remove_tags") {
      const wanted = [...new Set(dto.tagIds ?? [])];
      if (wanted.length === 0) {
        throw new BadRequestException("Choose at least one tag.");
      }
      const tags = await this.prisma.productTag.findMany({
        where: { tenantId, id: { in: wanted } },
        select: { id: true, name: true },
      });
      if (tags.length !== wanted.length) {
        throw new NotFoundException("One or more tags not found.");
      }
      return { category: null, tags };
    }

    return { category: null, tags: [] as Array<{ id: string; name: string }> };
  }

  /**
   * What a bulk action would do, before it does it.
   *
   * The counts that matter are the ones about damage: how many products already carry a
   * category this would replace, and how many of those were filed by a person rather than by
   * the classifier. "Set the category on 217 products" is not a decision anyone can make;
   * "43 of them already have one, 12 chosen by hand" is.
   */
  async bulkPreview(tenantId: string, dto: BulkProductsDto): Promise<BulkProductPreview> {
    const ids = await this.resolveBulkIds(tenantId, dto);
    const targets = await this.resolveBulkTargets(tenantId, dto);

    const base: BulkProductPreview = {
      action: dto.action,
      matched: ids.length,
      willChange: 0,
      alreadyOnTarget: 0,
      replacingExisting: 0,
      replacingManual: 0,
      categoryName: targets.category?.name ?? null,
      tagNames: targets.tags.map((t) => t.name),
    };
    if (ids.length === 0) return base;

    switch (dto.action) {
      case "range":
      case "unrange":
      case "activate":
      case "deactivate": {
        const { scope } = bulkActionUpdate(dto.action);
        base.willChange = await this.prisma.product.count({
          where: { tenantId, id: { in: ids }, ...scope },
        });
        return base;
      }

      case "set_category":
      case "clear_category": {
        const targetId =
          dto.action === "set_category"
            ? targets.category!.id
            : await this.unclassifiedCategoryId(tenantId);
        const existing = await this.prisma.productCategoryMap.findMany({
          where: { tenantId, productId: { in: ids }, dimension: "COMMERCIAL", isPrimary: true },
          select: { categoryId: true, assignmentSource: true },
        });
        base.alreadyOnTarget = existing.filter((e) => e.categoryId === targetId).length;
        const replacing = existing.filter((e) => e.categoryId !== targetId);
        base.replacingExisting = replacing.length;
        base.replacingManual = replacing.filter(
          (e) => e.assignmentSource === "MANUAL",
        ).length;
        base.willChange = ids.length - base.alreadyOnTarget;
        return base;
      }

      case "add_tags":
      case "remove_tags": {
        const tagIds = targets.tags.map((t) => t.id);
        // Aggregated in the database — a 25,000-product selection across 25 tags would be
        // hundreds of thousands of rows to count in memory.
        const groups = await this.prisma.productTagMap.groupBy({
          by: ["productId"],
          where: { tenantId, productId: { in: ids }, tagId: { in: tagIds } },
          _count: { tagId: true },
        });
        if (dto.action === "add_tags") {
          const fullyTagged = groups.filter((g) => g._count.tagId >= tagIds.length).length;
          base.alreadyOnTarget = fullyTagged;
          base.willChange = ids.length - fullyTagged;
        } else {
          base.willChange = groups.length;
        }
        return base;
      }
    }
  }

  async bulkUpdate(tenantId: string, userId: string, dto: BulkProductsDto) {
    const ids = await this.resolveBulkIds(tenantId, dto);
    const targets = await this.resolveBulkTargets(tenantId, dto);
    if (ids.length === 0) {
      return { matched: 0, updated: 0, action: dto.action };
    }

    let updated: number;
    switch (dto.action) {
      case "set_category":
        updated = await this.applyBulkCategory(
          tenantId,
          ids,
          targets.category!.id,
          "MANUAL",
        );
        break;
      case "clear_category":
        // Back to the Unclassified floor rather than to nothing: every product keeps a primary
        // commercial category, and SYSTEM_DEFAULT makes it eligible for the classifier again.
        updated = await this.applyBulkCategory(
          tenantId,
          ids,
          await this.unclassifiedCategoryId(tenantId),
          "SYSTEM_DEFAULT",
        );
        break;
      case "add_tags":
        updated = await this.applyBulkTags(
          tenantId,
          ids,
          targets.tags.map((t) => t.id),
          "add",
        );
        break;
      case "remove_tags":
        updated = await this.applyBulkTags(
          tenantId,
          ids,
          targets.tags.map((t) => t.id),
          "remove",
        );
        break;
      case "unrange":
        // Not a plain column write any more — see `decideRangeExit`. A locally created product
        // must never be filed into the NMRA reference catalog, and nothing with stock on hand
        // may leave the list at all.
        updated = (await this.applyRangeExit(tenantId, ids)).changed;
        break;
      default: {
        const { data, scope } = bulkActionUpdate(dto.action);
        const result = await this.prisma.product.updateMany({
          where: { tenantId, id: { in: ids }, ...scope },
          data,
        });
        updated = result.count;
      }
    }

    if (updated > 0) {
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
          updated,
          selection: dto.productIds?.length ? "ids" : "filter",
          ...(targets.category ? { categoryName: targets.category.name } : {}),
          ...(targets.tags.length ? { tagNames: targets.tags.map((t) => t.name) } : {}),
        },
      });
    }

    return { matched: ids.length, updated, action: dto.action };
  }

  /**
   * Take a selection out of the range, routing each product to whatever is actually safe for
   * it: back to the register, deactivated, or refused with a reason.
   *
   * Returns per-product outcomes as well as a count, so the UI can say "12 moved, 3
   * deactivated instead, 2 blocked because they still have stock" rather than a bare number
   * that hides two thirds of what happened.
   */
  async applyRangeExit(
    tenantId: string,
    productIds: string[],
  ): Promise<{
    changed: number;
    unranged: string[];
    deactivated: string[];
    blocked: Array<{ productId: string; reason: string }>;
    notes: string[];
  }> {
    if (productIds.length === 0) {
      return { changed: 0, unranged: [], deactivated: [], blocked: [], notes: [] };
    }

    const [rows, stockByProduct] = await Promise.all([
      this.prisma.product.findMany({
        where: { tenantId, id: { in: productIds } },
        select: {
          id: true,
          name: true,
          source: true,
          rangeStatus: true,
          nmraReferenceId: true,
          _count: { select: { saleItems: true, purchaseItems: true, receiptItems: true } },
        },
      }),
      // Across every branch, not the caller's: a product with units in another shop is still
      // holding stock, and hiding it there would be someone else's missing inventory.
      this.prisma.stockLedger
        .groupBy({
          by: ["productId"],
          where: { tenantId, productId: { in: productIds } },
          _sum: { qtyDelta: true },
        })
        .then((rowsAgg) => new Map(rowsAgg.map((g) => [g.productId, g._sum.qtyDelta ?? 0]))),
    ]);

    const unranged: string[] = [];
    const deactivated: string[] = [];
    const blocked: Array<{ productId: string; reason: string }> = [];
    const notes: string[] = [];

    for (const row of rows) {
      const decision = decideRangeExit({
        productId: row.id,
        name: row.name,
        source: row.source,
        rangeStatus: row.rangeStatus,
        nmraReferenceId: row.nmraReferenceId,
        stockOnHand: stockByProduct.get(row.id) ?? 0,
        saleCount: row._count.saleItems,
        purchasingCount: row._count.purchaseItems + row._count.receiptItems,
      });

      if (decision.action === "blocked") {
        blocked.push({ productId: row.id, reason: decision.reason });
        continue;
      }
      if (decision.action === "unrange") unranged.push(row.id);
      else {
        deactivated.push(row.id);
        notes.push(decision.reason);
      }
    }

    if (unranged.length > 0) {
      await this.prisma.product.updateMany({
        where: { tenantId, id: { in: unranged } },
        data: { rangeStatus: "REFERENCE", rangedAt: null },
      });
    }
    if (deactivated.length > 0) {
      await this.prisma.product.updateMany({
        where: { tenantId, id: { in: deactivated } },
        data: { isActive: false },
      });
    }

    return {
      changed: unranged.length + deactivated.length,
      unranged,
      deactivated,
      blocked,
      // De-duplicated: fifty locally created products produce one explanation, not fifty.
      notes: [...new Set(notes)].slice(0, 5),
    };
  }

  /**
   * What "Add to my products" would do to a set of NMRA reference rows, before it does it.
   *
   * The Reference Catalog is a 15,000-row register and the Add button is one click, so the
   * dangerous case is not the refusal but the silent success: promoting a register row the shop
   * already sells under its own name creates a second product for one real medicine, and from
   * then on the stock count, the reorder level and the sales history are split between them
   * with nothing to say so. Duplicates are looked up on the two identifiers that actually
   * identify — barcode and registration number — and reported as warnings for confirmation
   * rather than being blocked outright, since a genuine second pack size is a real case too.
   */
  async previewReferenceAdd(
    tenantId: string,
    referenceProductIds: string[],
  ): Promise<{
    items: Array<{
      referenceProductId: string;
      name: string;
      allowed: boolean;
      needsReview: boolean;
      reason: string | null;
      warnings: string[];
    }>;
    addable: number;
    needsReview: number;
    blocked: number;
  }> {
    const ids = [...new Set(referenceProductIds)].slice(0, BULK_PRODUCT_MATCH_LIMIT);
    if (ids.length === 0) return { items: [], addable: 0, needsReview: 0, blocked: 0 };

    const rows = await this.prisma.product.findMany({
      where: { tenantId, id: { in: ids } },
      select: {
        id: true,
        name: true,
        source: true,
        rangeStatus: true,
        barcode: true,
        registrationNo: true,
        isControlled: true,
        requiresPrescription: true,
        claimedBy: { select: { id: true } },
      },
    });

    const barcodes = rows.map((r) => r.barcode).filter((v): v is string => Boolean(v?.trim()));
    const registrations = rows
      .map((r) => r.registrationNo)
      .filter((v): v is string => Boolean(v?.trim()));

    // One query for the whole selection rather than two per row.
    const existing =
      barcodes.length || registrations.length
        ? await this.prisma.product.findMany({
            where: {
              tenantId,
              rangeStatus: "RANGED",
              OR: [
                ...(barcodes.length ? [{ barcode: { in: barcodes } }] : []),
                ...(registrations.length ? [{ registrationNo: { in: registrations } }] : []),
              ],
            },
            select: {
              id: true,
              name: true,
              barcode: true,
              registrationNo: true,
              isControlled: true,
              requiresPrescription: true,
            },
          })
        : [];

    const byBarcode = new Map<string, (typeof existing)[number][]>();
    const byRegistration = new Map<string, (typeof existing)[number][]>();
    for (const row of existing) {
      if (row.barcode) byBarcode.set(row.barcode, [...(byBarcode.get(row.barcode) ?? []), row]);
      if (row.registrationNo) {
        byRegistration.set(row.registrationNo, [
          ...(byRegistration.get(row.registrationNo) ?? []),
          row,
        ]);
      }
    }

    const items = rows.map((row) => {
      const dupRows = [
        ...(row.barcode ? (byBarcode.get(row.barcode) ?? []) : []).map((d) => ({
          d,
          matchedOn: "barcode" as const,
        })),
        ...(row.registrationNo ? (byRegistration.get(row.registrationNo) ?? []) : []).map((d) => ({
          d,
          matchedOn: "registrationNo" as const,
        })),
      ];
      const seen = new Set<string>();
      const duplicates = dupRows.filter(({ d }) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      });

      const decision = decideReferencePromotion({
        referenceProductId: row.id,
        name: row.name,
        rangeStatus: row.rangeStatus,
        source: row.source,
        claimedByProductId: row.claimedBy?.id ?? null,
        duplicateCandidates: duplicates.map(({ d, matchedOn }) => ({
          id: d.id,
          name: d.name,
          matchedOn,
        })),
        complianceChange: duplicates.some(
          ({ d }) =>
            d.isControlled !== row.isControlled ||
            d.requiresPrescription !== row.requiresPrescription,
        ),
      });

      return { referenceProductId: row.id, name: row.name, ...decision };
    });

    return {
      items,
      addable: items.filter((i) => i.allowed).length,
      needsReview: items.filter((i) => i.allowed && i.needsReview).length,
      blocked: items.filter((i) => !i.allowed).length,
    };
  }

  /**
   * Promote NMRA reference rows into the pharmacy's range.
   *
   * `acknowledgeWarnings` is the operator saying "yes, I saw the duplicate warning" — without
   * it, anything the preview flagged is held back rather than added, so the review is not
   * something the UI can forget to show.
   */
  async addReferenceProducts(
    tenantId: string,
    userId: string,
    referenceProductIds: string[],
    opts: { acknowledgeWarnings?: boolean } = {},
  ): Promise<{
    added: string[];
    held: Array<{ referenceProductId: string; name: string; reason: string }>;
  }> {
    const preview = await this.previewReferenceAdd(tenantId, referenceProductIds);

    const toAdd: string[] = [];
    const held: Array<{ referenceProductId: string; name: string; reason: string }> = [];
    for (const item of preview.items) {
      if (!item.allowed) {
        held.push({
          referenceProductId: item.referenceProductId,
          name: item.name,
          reason: item.reason ?? "Cannot be added.",
        });
        continue;
      }
      if (item.needsReview && !opts.acknowledgeWarnings) {
        held.push({
          referenceProductId: item.referenceProductId,
          name: item.name,
          reason: item.warnings.join(" "),
        });
        continue;
      }
      toAdd.push(item.referenceProductId);
    }

    if (toAdd.length > 0) {
      await this.prisma.product.updateMany({
        // `rangeStatus: REFERENCE` in the filter is the last line of defence against a race:
        // two operators adding the same row concurrently, where the second must be a no-op
        // rather than a second `rangedAt` stamp.
        where: { tenantId, id: { in: toAdd }, rangeStatus: "REFERENCE" },
        data: { rangeStatus: "RANGED", rangedAt: new Date() },
      });
      await this.audit.log({
        tenantId,
        actorUserId: userId,
        eventName: "products.reference_added",
        entityName: "product",
        entityId: tenantId,
        payload: { count: toAdd.length, productIds: toAdd.slice(0, 100), held: held.length },
      });
    }

    return { added: toAdd, held };
  }

  /** The tenant's Unclassified Medicines id — the floor every product falls back to. */
  private async unclassifiedCategoryId(tenantId: string): Promise<string> {
    const row = await this.prisma.productCategory.findFirst({
      where: {
        tenantId,
        dimension: "COMMERCIAL",
        canonicalKey: UNCLASSIFIED_MEDICINES_CANONICAL_KEY,
      },
      select: { id: true },
    });
    if (!row) {
      throw new ConflictException(
        "This workspace has no Unclassified Medicines category yet — open Products → Categories once to seed the standard tree.",
      );
    }
    return row.id;
  }

  /**
   * Re-file a selection's primary commercial category in batches.
   *
   * The delete has to clear two things, not one: the old primary map, and any *secondary* map
   * already pointing at the new target — otherwise the insert collides with the
   * (tenant, product, category) unique index and the whole batch fails.
   */
  private async applyBulkCategory(
    tenantId: string,
    ids: string[],
    categoryId: string,
    assignmentSource: "MANUAL" | "SYSTEM_DEFAULT",
  ): Promise<number> {
    let created = 0;
    for (let i = 0; i < ids.length; i += BULK_RELATION_BATCH) {
      const group = ids.slice(i, i + BULK_RELATION_BATCH);
      const [, insert] = await this.prisma.$transaction([
        this.prisma.productCategoryMap.deleteMany({
          where: {
            tenantId,
            productId: { in: group },
            dimension: "COMMERCIAL",
            OR: [{ isPrimary: true }, { categoryId }],
          },
        }),
        this.prisma.productCategoryMap.createMany({
          data: group.map((productId) => ({
            tenantId,
            productId,
            categoryId,
            dimension: "COMMERCIAL" as const,
            isPrimary: true,
            assignmentSource,
          })),
          skipDuplicates: true,
        }),
      ]);
      created += insert.count;
    }
    return created;
  }

  private async applyBulkTags(
    tenantId: string,
    ids: string[],
    tagIds: string[],
    mode: "add" | "remove",
  ): Promise<number> {
    if (mode === "remove") {
      let removed = 0;
      for (let i = 0; i < ids.length; i += BULK_RELATION_BATCH) {
        const res = await this.prisma.productTagMap.deleteMany({
          where: {
            tenantId,
            productId: { in: ids.slice(i, i + BULK_RELATION_BATCH) },
            tagId: { in: tagIds },
          },
        });
        removed += res.count;
      }
      return removed;
    }

    // One row per product per tag, so the product batch shrinks as the tag count grows.
    const perBatch = Math.max(1, Math.floor(BULK_RELATION_BATCH / tagIds.length));
    let added = 0;
    for (let i = 0; i < ids.length; i += perBatch) {
      const group = ids.slice(i, i + perBatch);
      const res = await this.prisma.productTagMap.createMany({
        data: group.flatMap((productId) =>
          tagIds.map((tagId) => ({ tenantId, productId, tagId })),
        ),
        skipDuplicates: true,
      });
      added += res.count;
    }
    return added;
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
