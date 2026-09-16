import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PoStatus,
  Prisma,
  StockBucket,
  StockMovementType,
  TransferStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import {
  addDays,
  businessDateKey,
  businessToday,
  daysBetween,
  safeTimeZone,
  startOfBusinessDay,
} from "../common/business-date.util";
import { expandCommercialCategoryIds } from "../products/product-query.util";
import { reorderGap, resolveStockStatus } from "../products/stock-qty.util";
import type { ActorAccess } from "../security/access.service";
import { AUTO_QUARANTINE_EXPIRED_REASON } from "./quarantine.constants";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import { QuarantineBatchDto, ReleaseQuarantineDto } from "./dto/quarantine-batch.dto";
import { StockReadService, type ProductStockTotals } from "./stock/stock-read.service";
import { StockService } from "./stock/stock.service";
import { toBalance, ZERO_QUANTITIES } from "./stock/stock-balance";
import {
  QUARANTINE_REASON_LABELS,
  TRANSFER_RESERVATION_SOURCE,
} from "./stock/stock-reasons";

export type StockListQuery = {
  q?: string;
  status?: "all" | "ok" | "low" | "out";
  skip?: number;
  take?: number;
  productId?: string;
  controlled?: "all" | "controlled" | "regular";
  batchFilter?: "all" | "expiring" | "with_batches" | "no_batches";
  /** One of the "needs attention" buckets the overview links to. */
  attention?: StockAttention;
  categoryIds?: string[];
  brands?: string[];
  tagIds?: string[];
  dosageForms?: string[];
  /** Only products with stock records at this branch (excludes never-stocked catalog). */
  ledgerOnly?: boolean;
  /**
   * "RANGED" (default) keeps the imported NMRA registry out of the stock picker; "all" is the
   * explicit escape hatch for stocking a reference product for the first time.
   */
  rangeStatus?: "RANGED" | "all";
  sort?: "name" | "onHand" | "available";
  dir?: "asc" | "desc";
};

export type StockAttention =
  | "expired"
  | "near_expiry"
  | "quarantined"
  | "reserved"
  | "expiry_review";

export type BatchListQuery = {
  productId?: string;
  nearExpiryDays?: number;
  /** When false, hide batches with nothing on hand. Default true for API compatibility. */
  includeZero?: boolean;
  /** true: only batches holding quarantined units; false: only batches holding none. */
  quarantined?: boolean;
  /** When true, only expired batches; when false, only non-expired. */
  expired?: boolean;
  /**
   * When true, only batches imported without a real expiry date. They carry a far-future
   * placeholder, so they never surface in the expiry filters above — this is how a pharmacy
   * finds them after a migration import and puts the real dates in.
   */
  needsExpiryReview?: boolean;
  controlled?: "all" | "controlled" | "regular";
  /**
   * Same default as the stock overview: "RANGED" keeps the imported NMRA registry out of the
   * batch list, "all" is the explicit escape hatch. Stock arriving on a reference product
   * promotes it (see ensureProductsRanged), so a ranged-only list still shows every lot the
   * pharmacy actually received.
   */
  rangeStatus?: "RANGED" | "all";
  /** Batch number, product name or SKU. */
  q?: string;
};

export type MovementCategory =
  | "all"
  | "adjustments"
  | "sales"
  | "purchases"
  | "transfers"
  | "returns"
  | "stocktakes"
  | "opening"
  | "quarantine";

export type MovementListQuery = {
  productId?: string;
  batchId?: string;
  category?: MovementCategory;
  userId?: string;
  /** Tenant-local calendar dates, inclusive. */
  from?: string;
  to?: string;
  referenceType?: string;
  referenceId?: string;
  skip?: number;
  take?: number;
};

export const MOVEMENT_CATEGORY_TYPES: Record<
  Exclude<MovementCategory, "all">,
  StockMovementType[]
> = {
  adjustments: [StockMovementType.adjustment_in, StockMovementType.adjustment_out],
  sales: [
    StockMovementType.sale_out,
    StockMovementType.sale_void_in,
    StockMovementType.sale_refund_in,
  ],
  purchases: [StockMovementType.purchase_in],
  transfers: [StockMovementType.transfer_in, StockMovementType.transfer_out],
  returns: [StockMovementType.customer_return_in, StockMovementType.supplier_return_out],
  stocktakes: [StockMovementType.stocktake_in, StockMovementType.stocktake_out],
  opening: [StockMovementType.opening_stock],
  quarantine: [StockMovementType.quarantine_hold, StockMovementType.quarantine_release],
};

const QUARANTINE_TYPES = MOVEMENT_CATEGORY_TYPES.quarantine;
const LEGACY_RESERVE_TYPES = [
  StockMovementType.transfer_reserve_out,
  StockMovementType.transfer_reserve_release,
];

/**
 * Rows the movement history never shows: legacy reservation entries (reservations were never
 * physical movements), and the sellable half of each quarantine pair — the quarantine half is
 * shown instead, as "N moved into / out of quarantine, on hand unchanged".
 */
const HIDDEN_MOVEMENTS: Prisma.StockLedgerWhereInput[] = [
  { movementType: { in: LEGACY_RESERVE_TYPES } },
  { movementType: { in: QUARANTINE_TYPES }, bucket: StockBucket.sellable },
];

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

function resolveSummaryPeriod(period: SummaryPeriod): {
  from: Date;
  to: Date;
  label: string;
} {
  const now = new Date();
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  switch (period) {
    case "last_7_days":
      from.setDate(from.getDate() - 6);
      return { from, to, label: "Last 7 days" };
    case "last_30_days":
      from.setDate(from.getDate() - 29);
      return { from, to, label: "Last 30 days" };
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return {
        from: start,
        to: end,
        label: start.toLocaleString(undefined, { month: "long", year: "numeric" }),
      };
    }
    case "this_quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const start = new Date(now.getFullYear(), q * 3, 1);
      return { from: start, to, label: `Q${q + 1} ${now.getFullYear()}` };
    }
    case "this_year": {
      const start = new Date(now.getFullYear(), 0, 1);
      return { from: start, to, label: String(now.getFullYear()) };
    }
    case "this_month":
    default: {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        from: start,
        to,
        label: start.toLocaleString(undefined, { month: "long", year: "numeric" }),
      };
    }
  }
}

type Clock = { timeZone: string; today: Date; expiryWarningDays: number };

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly stockRead: StockReadService,
  ) {}

  /** The tenant's calendar and expiry window, read once per request. */
  private async clock(tenantId: string): Promise<Clock> {
    const [tenant, settings] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { expiryWarningDays: true },
      }),
    ]);
    const timeZone = safeTimeZone(tenant?.timezone);
    return {
      timeZone,
      today: businessToday(timeZone),
      expiryWarningDays: settings?.expiryWarningDays ?? 30,
    };
  }

  async listBatches(
    tenantId: string,
    branchId: string,
    query: BatchListQuery = {},
    opts: { canViewCost: boolean } = { canViewCost: false },
  ) {
    const includeZero = query.includeZero !== false;
    const { today, expiryWarningDays } = await this.clock(tenantId);

    const nearWindowDays =
      query.nearExpiryDays != null &&
      Number.isFinite(query.nearExpiryDays) &&
      query.nearExpiryDays > 0
        ? Math.min(365, Math.round(query.nearExpiryDays))
        : undefined;

    const expiryWhere: Prisma.BatchWhereInput =
      nearWindowDays != null
        ? { expiryDate: { gte: today, lte: addDays(today, nearWindowDays) } }
        : query.expired === true
          ? { expiryDate: { lt: today } }
          : query.expired === false
            ? { expiryDate: { gte: today } }
            : {};

    const stockFilters: Prisma.BatchWhereInput[] = [];
    if (!includeZero) stockFilters.push({ stock: { is: { onHandQty: { gt: 0 } } } });
    if (query.quarantined === true) {
      stockFilters.push({ stock: { is: { quarantinedQty: { gt: 0 } } } });
    } else if (query.quarantined === false) {
      stockFilters.push({
        OR: [{ stock: { is: null } }, { stock: { is: { quarantinedQty: { lte: 0 } } } }],
      });
    }

    const q = query.q?.trim();
    const batches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        ...(query.productId ? { productId: query.productId } : {}),
        ...expiryWhere,
        ...(query.needsExpiryReview ? { needsExpiryReview: true } : {}),
        ...(stockFilters.length ? { AND: stockFilters } : {}),
        ...(q
          ? {
              OR: [
                { batchNo: { contains: q, mode: "insensitive" } },
                { product: { name: { contains: q, mode: "insensitive" } } },
                { product: { sku: { contains: q, mode: "insensitive" } } },
              ],
            }
          : {}),
        product: {
          ...(query.controlled === "controlled"
            ? { isControlled: true }
            : query.controlled === "regular"
              ? { isControlled: false }
              : {}),
          ...(query.rangeStatus === "all" ? {} : { rangeStatus: "RANGED" as const }),
        },
      },
      select: {
        id: true,
        batchNo: true,
        expiryDate: true,
        receivedAt: true,
        costPrice: true,
        sellingPrice: true,
        productId: true,
        isQuarantined: true,
        quarantinedAt: true,
        quarantineReason: true,
        needsExpiryReview: true,
        stock: { select: { onHandQty: true, quarantinedQty: true, reservedQty: true } },
        supplier: { select: { id: true, name: true } },
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            reorderLevel: true,
            isControlled: true,
            unit: true,
            // Prefer lightweight http(s) paths; omit huge data: URLs that blow JSON payloads.
            imageUrl: true,
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    const windowDays = nearWindowDays ?? expiryWarningDays;
    return batches.map((b) => {
      const balance = toBalance(
        b.stock
          ? {
              onHand: b.stock.onHandQty,
              quarantined: b.stock.quarantinedQty,
              reserved: b.stock.reservedQty,
            }
          : ZERO_QUANTITIES,
      );
      const daysToExpiry = daysBetween(today, b.expiryDate);
      const expired = daysToExpiry < 0;
      const nearExpiry = !expired && !b.needsExpiryReview && daysToExpiry <= windowDays;
      const sellableNow = !expired && !b.needsExpiryReview;
      const imageUrl =
        b.product.imageUrl &&
        !b.product.imageUrl.startsWith("data:") &&
        b.product.imageUrl.length < 2048
          ? b.product.imageUrl
          : null;
      return {
        id: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate.toISOString(),
        receivedAt: b.receivedAt.toISOString(),
        costPrice: opts.canViewCost ? b.costPrice.toString() : null,
        sellingPrice: b.sellingPrice.toString(),
        productId: b.productId,
        qtyOnHand: balance.onHand,
        quarantinedQty: balance.quarantined,
        reservedQty: balance.reserved,
        /** Can be sold or transferred right now: in date, confirmed expiry, not held or promised. */
        availableQty: sellableNow ? Math.max(0, balance.available) : 0,
        daysToExpiry,
        expired,
        nearExpiry,
        isQuarantined: b.isQuarantined,
        quarantinedAt: b.quarantinedAt?.toISOString() ?? null,
        quarantineReason: b.quarantineReason,
        needsExpiryReview: b.needsExpiryReview,
        supplier: b.supplier ? { id: b.supplier.id, name: b.supplier.name } : null,
        product: {
          id: b.product.id,
          sku: b.product.sku,
          name: b.product.name,
          reorderLevel: b.product.reorderLevel,
          isControlled: b.product.isControlled,
          unit: b.product.unit,
          imageUrl,
        },
      };
    });
  }

  async listExpiredBatches(tenantId: string, branchId: string, opts: { canViewCost: boolean }) {
    return this.listBatches(tenantId, branchId, { expired: true, includeZero: true }, opts);
  }

  async confirmBatchExpiry(
    tenantId: string,
    branchId: string,
    userId: string,
    batchId: string,
    value: string,
  ) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== value
    ) {
      throw new BadRequestException("Enter the actual expiry date printed on the batch");
    }
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({
        where: { id: batchId, tenantId, branchId },
      });
      if (!batch) throw new NotFoundException("Batch not found");
      const updated = await tx.batch.updateMany({
        where: { id: batchId, tenantId, branchId, needsExpiryReview: true },
        data: { expiryDate: date, needsExpiryReview: false },
      });
      if (updated.count !== 1)
        throw new BadRequestException("This batch has already been reviewed. Refresh the list.");
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "batch.expiry_confirmed",
          entityName: "batch",
          entityId: batchId,
          payload: {
            expiryDate: value,
            previousExpiryDate: batch.expiryDate.toISOString(),
            productId: batch.productId,
          },
        },
        tx,
      );
      return { id: batchId, expiryDate: value, needsExpiryReview: false };
    });
  }

  async quarantineBatch(
    tenantId: string,
    branchId: string,
    userId: string,
    batchId: string,
    dto: QuarantineBatchDto,
  ) {
    const reason = dto.reason?.trim() || QUARANTINE_REASON_LABELS[dto.reasonCode];
    if (dto.reasonCode === "other" && !dto.reason?.trim()) {
      throw new BadRequestException("Describe why the stock is being held");
    }

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({
        where: { id: batchId, tenantId, branchId },
        select: { id: true, productId: true, batchNo: true },
      });
      if (!batch) throw new NotFoundException("Batch not found");

      await this.stock.lockBatches(tx, tenantId, [batchId]);
      const balance =
        (await this.stock.balances(tx, tenantId, [batchId])).get(batchId) ??
        toBalance(ZERO_QUANTITIES);
      const qty = dto.qty ?? balance.available;
      if (qty <= 0) {
        throw new BadRequestException(
          balance.onHand <= 0
            ? "There is no stock on this batch to quarantine"
            : "Nothing left to quarantine — every unit on this batch is already held or reserved",
        );
      }

      const referenceId = randomUUID();
      await this.stock.quarantine(
        tx,
        { tenantId, branchId, userId, referenceId },
        { productId: batch.productId, batchId, qty, reasonCode: dto.reasonCode, reason },
      );
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "batch.quarantined",
          entityName: "batch",
          entityId: batchId,
          payload: {
            productId: batch.productId,
            batchNo: batch.batchNo,
            qty,
            reasonCode: dto.reasonCode,
            reason,
            referenceId,
          },
        },
        tx,
      );
      return this.batchStockSnapshot(tx, tenantId, batchId);
    });
  }

  async releaseQuarantine(
    tenantId: string,
    branchId: string,
    userId: string,
    batchId: string,
    dto: ReleaseQuarantineDto = {},
  ) {
    const { today } = await this.clock(tenantId);
    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.batch.findFirst({
        where: { id: batchId, tenantId, branchId },
        select: { id: true, productId: true, batchNo: true, expiryDate: true, quarantineReason: true },
      });
      if (!batch) throw new NotFoundException("Batch not found");
      if (batch.expiryDate < today) {
        throw new BadRequestException(
          `This batch expired on ${batch.expiryDate.toISOString().slice(0, 10)}. Expired stock can't go back on sale — write it off or return it to the supplier.`,
        );
      }

      await this.stock.lockBatches(tx, tenantId, [batchId]);
      const balance =
        (await this.stock.balances(tx, tenantId, [batchId])).get(batchId) ??
        toBalance(ZERO_QUANTITIES);
      const qty = dto.qty ?? balance.quarantined;
      if (qty <= 0) throw new BadRequestException("Nothing is quarantined on this batch");

      const referenceId = randomUUID();
      const reason = dto.reason?.trim() || null;
      await this.stock.release(
        tx,
        { tenantId, branchId, userId, referenceId },
        { productId: batch.productId, batchId, qty, reason },
      );
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "batch.quarantine_released",
          entityName: "batch",
          entityId: batchId,
          payload: {
            productId: batch.productId,
            batchNo: batch.batchNo,
            qty,
            reason,
            previousReason: batch.quarantineReason,
            referenceId,
          },
        },
        tx,
      );
      return this.batchStockSnapshot(tx, tenantId, batchId);
    });
  }

  /** Every expired batch with sellable units left: hold those units. */
  async quarantineExpired(tenantId: string, branchId: string, userId: string) {
    const { today } = await this.clock(tenantId);
    const candidates = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        expiryDate: { lt: today },
        stock: { is: { onHandQty: { gt: 0 } } },
      },
      select: {
        id: true,
        productId: true,
        batchNo: true,
        expiryDate: true,
      },
    });
    if (candidates.length === 0) {
      return { quarantined: 0, units: 0, batchIds: [] as string[] };
    }

    const referenceId = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const ids = candidates.map((b) => b.id);
      await this.stock.lockBatches(tx, tenantId, ids);
      const balances = await this.stock.balances(tx, tenantId, ids);
      const held: string[] = [];
      let units = 0;
      for (const batch of candidates) {
        const qty = balances.get(batch.id)?.available ?? 0;
        if (qty <= 0) continue;
        await this.stock.quarantine(
          tx,
          { tenantId, branchId, userId, referenceId },
          {
            productId: batch.productId,
            batchId: batch.id,
            qty,
            reasonCode: "expired",
            reason: AUTO_QUARANTINE_EXPIRED_REASON,
          },
        );
        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: "batch.quarantined",
            entityName: "batch",
            entityId: batch.id,
            payload: {
              productId: batch.productId,
              batchNo: batch.batchNo,
              qty,
              reasonCode: "expired",
              reason: AUTO_QUARANTINE_EXPIRED_REASON,
              auto: true,
              expiryDate: batch.expiryDate.toISOString(),
              referenceId,
            },
          },
          tx,
        );
        held.push(batch.id);
        units += qty;
      }
      return { quarantined: held.length, units, batchIds: held };
    });
  }

  async stockByProduct(
    tenantId: string,
    branchId: string,
    query: StockListQuery = {},
  ) {
    const skip = Math.max(0, query.skip ?? 0);
    const take = Math.min(Math.max(1, query.take ?? 50), 200);
    const { today, expiryWarningDays } = await this.clock(tenantId);
    const totals = await this.stockRead.productTotals({
      tenantId,
      branchId,
      today,
      nearExpiryCutoff: addDays(today, expiryWarningDays),
    });

    const q = query.q?.trim() ?? "";
    const productWhere: Prisma.ProductWhereInput = {
      tenantId,
      isActive: true,
      // Default to the shop's own range so a 15,000-row registry import doesn't flood the
      // picker. Callers opt into the full catalog explicitly; receiving stock against a
      // reference product promotes it (see ensureProductsRanged).
      ...(query.rangeStatus === "all" ? {} : { rangeStatus: "RANGED" as const }),
    };

    if (query.productId) {
      productWhere.id = query.productId;
    } else if (query.ledgerOnly) {
      const stockedIds = [...totals.keys()];
      if (stockedIds.length === 0) return { items: [], total: 0, skip, take };
      productWhere.id = { in: stockedIds };
    }

    if (query.controlled === "controlled") productWhere.isControlled = true;
    if (query.controlled === "regular") productWhere.isControlled = false;
    if (query.brands?.length) productWhere.brandName = { in: query.brands };
    if (query.dosageForms?.length) productWhere.dosageForm = { in: query.dosageForms };
    if (query.categoryIds?.length) {
      // "Category" filter is commercial-only — the web filter dropdown is fed exclusively
      // from COMMERCIAL categories, so this is enforced here too rather than assumed.
      const expandedCategoryIds = await expandCommercialCategoryIds(
        this.prisma,
        tenantId,
        query.categoryIds,
      );
      productWhere.categoryMaps = {
        some: { categoryId: { in: expandedCategoryIds }, dimension: "COMMERCIAL" },
      };
    }
    if (query.tagIds?.length) {
      productWhere.tagMaps = { some: { tagId: { in: query.tagIds } } };
    }
    if (q) {
      productWhere.OR = [
        { sku: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { barcode: { contains: q, mode: "insensitive" } },
        { genericName: { contains: q, mode: "insensitive" } },
        { brandName: { contains: q, mode: "insensitive" } },
        { registrationNo: { contains: q, mode: "insensitive" } },
      ];
    }

    const products = await this.prisma.product.findMany({
      where: productWhere,
      select: {
        id: true,
        sku: true,
        name: true,
        barcode: true,
        genericName: true,
        brandName: true,
        reorderLevel: true,
        isControlled: true,
        isActive: true,
        unit: true,
        imageUrl: true,
        dosageForm: true,
        strength: true,
      },
      orderBy: { name: "asc" },
    });

    const statusFilter = query.status && query.status !== "all" ? query.status : null;
    const batchFilter =
      query.batchFilter && query.batchFilter !== "all" ? query.batchFilter : null;

    const matched: Array<{
      product: (typeof products)[number];
      totals: ProductStockTotals;
      stockStatus: ReturnType<typeof resolveStockStatus>;
    }> = [];

    for (const product of products) {
      const t = totals.get(product.id) ?? emptyTotals(product.id);
      // Status reads available, not on hand: a shelf of expired or quarantined units is not
      // stock the pharmacy can sell, and calling it "healthy" hides the reorder.
      const stockStatus = resolveStockStatus(t.available, product.reorderLevel);
      if (statusFilter && stockStatus !== statusFilter) continue;
      if (batchFilter === "expiring" && t.nearExpiryBatchCount <= 0) continue;
      if (batchFilter === "with_batches" && t.batchCount <= 0) continue;
      if (batchFilter === "no_batches" && t.batchCount > 0) continue;
      if (query.attention && !matchesAttention(t, query.attention)) continue;
      matched.push({ product, totals: t, stockStatus });
    }

    if (query.sort === "onHand" || query.sort === "available") {
      const key = query.sort;
      const sign = query.dir === "desc" ? -1 : 1;
      matched.sort(
        (a, b) =>
          sign * (a.totals[key] - b.totals[key]) ||
          a.product.name.localeCompare(b.product.name),
      );
    } else if (query.dir === "desc") {
      matched.reverse();
    }

    const total = matched.length;
    const page = matched.slice(skip, skip + take);
    const pageIds = page.map((row) => row.product.id);

    const [lastMoves, pageRelations] = await Promise.all([
      pageIds.length === 0
        ? Promise.resolve([])
        : this.prisma.stockLedger.findMany({
            where: {
              tenantId,
              branchId,
              productId: { in: pageIds },
              NOT: HIDDEN_MOVEMENTS,
            },
            orderBy: { occurredAt: "desc" },
            distinct: ["productId"],
            select: { productId: true, occurredAt: true, movementType: true },
          }),
      pageIds.length === 0
        ? Promise.resolve([])
        : this.prisma.product.findMany({
            where: { id: { in: pageIds }, tenantId },
            select: {
              id: true,
              // Primary COMMERCIAL category only — this is the "Category" the Inventory UI
              // means; Dosage Form/Schedule/Registration Type maps are never mixed in here.
              categoryMaps: {
                where: { dimension: "COMMERCIAL", isPrimary: true },
                select: { category: { select: { id: true, name: true } } },
              },
              tagMaps: { select: { tag: { select: { id: true, name: true } } } },
            },
          }),
    ]);

    const lastMoveByProduct = new Map(
      lastMoves.map((m) => [m.productId, { at: m.occurredAt.toISOString(), type: m.movementType }]),
    );
    const relationsByProduct = new Map(
      pageRelations.map((p) => [
        p.id,
        {
          categories: p.categoryMaps.map((map) => map.category),
          tags: p.tagMaps.map((map) => map.tag),
        },
      ]),
    );

    const items = page.map((row) => {
      const last = lastMoveByProduct.get(row.product.id) ?? null;
      const relations = relationsByProduct.get(row.product.id) ?? { categories: [], tags: [] };
      return {
        productId: row.product.id,
        qtyOnHand: row.totals.onHand,
        availableQty: row.totals.available,
        quarantinedQty: row.totals.quarantined,
        reservedQty: row.totals.reserved,
        expiredQty: row.totals.expiredSellable,
        stockStatus: row.stockStatus,
        reorderGap: reorderGap(row.totals.available, row.product.reorderLevel),
        batchCount: row.totals.batchCount,
        nearExpiryBatchCount: row.totals.nearExpiryBatchCount,
        expiredBatchCount: row.totals.expiredBatchCount,
        expiryReviewBatchCount: row.totals.expiryReviewBatchCount,
        lastMovementAt: last?.at ?? null,
        lastMovementType: last?.type ?? null,
        product: { ...row.product, ...relations },
      };
    });

    return { items, total, skip, take };
  }

  async summary(
    tenantId: string,
    branchId: string,
    period: SummaryPeriod = "this_month",
    opts: { canViewCost: boolean } = { canViewCost: false },
  ) {
    const { today, expiryWarningDays } = await this.clock(tenantId);
    const [totals, activeProducts, stockValue, incomingTransfers, openReservations] =
      await Promise.all([
        this.stockRead.productTotals({
          tenantId,
          branchId,
          today,
          nearExpiryCutoff: addDays(today, expiryWarningDays),
        }),
        // Only the pharmacy's own range. Counting reference records here reported an imported
        // NMRA registry as thousands of SKUs, nearly all of them "out of stock" — the shop was
        // never carrying them, so they were never out of anything.
        this.prisma.product.findMany({
          where: { tenantId, isActive: true, rangeStatus: "RANGED" },
          select: { id: true, reorderLevel: true },
        }),
        opts.canViewCost ? this.stockRead.stockValue(tenantId, branchId) : Promise.resolve(null),
        this.prisma.transfer.count({
          where: {
            tenantId,
            toBranchId: branchId,
            status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
          },
        }),
        this.prisma.stockReservation.count({
          where: { tenantId, branchId, status: "active" },
        }),
      ]);

    let skuCount = 0;
    let lowStock = 0;
    let outOfStock = 0;
    for (const product of activeProducts) {
      skuCount += 1;
      const status = resolveStockStatus(
        totals.get(product.id)?.available ?? 0,
        product.reorderLevel,
      );
      if (status === "low") lowStock += 1;
      if (status === "out") outOfStock += 1;
    }

    let totalUnits = 0;
    let availableUnits = 0;
    let quarantinedUnits = 0;
    let reservedUnits = 0;
    let expiredUnits = 0;
    let nearExpiry = 0;
    let nearExpiryProducts = 0;
    let expired = 0;
    let expiryReview = 0;
    let quarantinedProducts = 0;
    for (const t of totals.values()) {
      totalUnits += t.onHand;
      availableUnits += t.available;
      quarantinedUnits += t.quarantined;
      reservedUnits += t.reserved;
      expiredUnits += t.expiredSellable;
      nearExpiry += t.nearExpiryBatchCount;
      if (t.nearExpiryBatchCount > 0) nearExpiryProducts += 1;
      expired += t.expiredBatchCount;
      expiryReview += t.expiryReviewBatchCount;
      if (t.quarantined > 0) quarantinedProducts += 1;
    }

    const range = resolveSummaryPeriod(period);
    const periodLedger = await this.prisma.stockLedger.groupBy({
      by: ["movementType"],
      where: {
        tenantId,
        branchId,
        occurredAt: { gte: range.from, lte: range.to },
      },
      _sum: { qtyDelta: true },
    });
    let received = 0;
    let issued = 0;
    let adjustments = 0;
    for (const g of periodLedger) {
      const qty = g._sum.qtyDelta ?? 0;
      if (
        g.movementType === "purchase_in" ||
        g.movementType === "transfer_in" ||
        g.movementType === "customer_return_in" ||
        g.movementType === "sale_void_in" ||
        g.movementType === "sale_refund_in" ||
        g.movementType === "opening_stock"
      ) {
        received += Math.max(0, qty);
      } else if (
        g.movementType === "sale_out" ||
        g.movementType === "transfer_out" ||
        g.movementType === "supplier_return_out"
      ) {
        issued += Math.abs(Math.min(0, qty));
      } else if (
        g.movementType === "adjustment_in" ||
        g.movementType === "adjustment_out" ||
        g.movementType === "stocktake_in" ||
        g.movementType === "stocktake_out"
      ) {
        adjustments += qty;
      }
    }

    return {
      skuCount,
      totalUnits,
      availableUnits,
      stockValue,
      lowStock,
      outOfStock,
      nearExpiry,
      nearExpiryProducts,
      expired,
      expiredUnits,
      quarantinedUnits,
      quarantinedProducts,
      reservedUnits,
      openReservations,
      expiryReview,
      incomingTransfers,
      healthy: Math.max(0, skuCount - lowStock - outOfStock),
      expiryWarningDays,
      period: {
        key: period,
        label: range.label,
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        received,
        issued,
        adjustments,
        net: received - issued + adjustments,
      },
      /** @deprecated Prefer `period`. Kept for older clients. */
      month: { received, issued, adjustments, net: received - issued + adjustments },
    };
  }

  /** Everything the product stock panel shows, in one request. */
  async productStock(
    tenantId: string,
    branchId: string,
    productId: string,
    opts: { canViewCost: boolean; accessibleBranchIds: string[] | "all" },
  ) {
    const { today, expiryWarningDays } = await this.clock(tenantId);
    const product = await this.prisma.product.findFirst({
      where: { id: productId, tenantId },
      select: {
        id: true,
        sku: true,
        name: true,
        genericName: true,
        brandName: true,
        strength: true,
        dosageForm: true,
        unit: true,
        imageUrl: true,
        reorderLevel: true,
        isControlled: true,
        isActive: true,
        rangeStatus: true,
      },
    });
    if (!product) throw new NotFoundException("Product not found");

    const [totalsMap, batches, reservations, incoming, openPoItems, branches, movements] =
      await Promise.all([
        this.stockRead.productTotals({
          tenantId,
          branchId,
          today,
          nearExpiryCutoff: addDays(today, expiryWarningDays),
          productIds: [productId],
        }),
        this.listBatches(tenantId, branchId, { productId, rangeStatus: "all" }, opts),
        this.prisma.stockReservation.findMany({
          where: { tenantId, branchId, productId, status: "active" },
          select: { qty: true, sourceType: true, sourceId: true, batchId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        }),
        this.prisma.transferItem.findMany({
          where: {
            tenantId,
            productId,
            transfer: {
              toBranchId: branchId,
              status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
            },
          },
          select: {
            qty: true,
            receivedQty: true,
            transfer: {
              select: {
                id: true,
                transferNumber: true,
                expectedOn: true,
                fromBranch: { select: { id: true, name: true } },
              },
            },
          },
        }),
        this.prisma.purchaseOrderItem.findMany({
          where: {
            tenantId,
            productId,
            purchaseOrder: {
              branchId,
              status: { in: [PoStatus.issued, PoStatus.partially_received] },
            },
          },
          select: {
            orderedQty: true,
            purchaseOrder: {
              select: {
                id: true,
                poNumber: true,
                expectedOn: true,
                supplier: { select: { id: true, name: true } },
                goodsReceipts: {
                  select: { items: { where: { productId }, select: { receivedQty: true } } },
                },
              },
            },
          },
        }),
        this.prisma.branch.findMany({
          where: {
            tenantId,
            isActive: true,
            id: {
              not: branchId,
              ...(opts.accessibleBranchIds === "all" ? {} : { in: opts.accessibleBranchIds }),
            },
          },
          select: { id: true, name: true, code: true },
          orderBy: { name: "asc" },
        }),
        this.listMovements(tenantId, branchId, { productId, take: 8 }),
      ]);

    const transferIds = reservations
      .filter((r) => r.sourceType === TRANSFER_RESERVATION_SOURCE)
      .map((r) => r.sourceId);
    const reservingTransfers = transferIds.length
      ? await this.prisma.transfer.findMany({
          where: { tenantId, id: { in: transferIds } },
          select: {
            id: true,
            transferNumber: true,
            toBranch: { select: { name: true } },
          },
        })
      : [];
    const transferById = new Map(reservingTransfers.map((t) => [t.id, t]));
    const batchNoById = new Map(batches.map((b) => [b.id, b.batchNo]));

    const otherBranchTotals = await this.stockRead.productTotalsByBranch({
      tenantId,
      productId,
      branchIds: branches.map((b) => b.id),
      today,
    });
    const otherByBranch = new Map(otherBranchTotals.map((row) => [row.branchId, row]));

    const totals = totalsMap.get(productId) ?? emptyTotals(productId);
    return {
      product,
      stockStatus: resolveStockStatus(totals.available, product.reorderLevel),
      totals: {
        onHand: totals.onHand,
        available: totals.available,
        quarantined: totals.quarantined,
        reserved: totals.reserved,
        expired: totals.expiredSellable,
        incoming: incoming.reduce((sum, row) => sum + Math.max(0, row.qty - row.receivedQty), 0),
        onOrder: openPoItems.reduce((sum, row) => sum + outstandingPoQty(row), 0),
      },
      batches: batches.filter(
        (b) => b.qtyOnHand !== 0 || b.reservedQty > 0 || b.quarantinedQty > 0,
      ),
      reservations: reservations.map((r) => {
        const transfer = transferById.get(r.sourceId);
        return {
          qty: r.qty,
          batchNo: batchNoById.get(r.batchId) ?? null,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          label: transfer
            ? `${transfer.transferNumber} to ${transfer.toBranch.name}`
            : r.sourceType,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      incoming: incoming
        .map((row) => ({
          transferId: row.transfer.id,
          transferNumber: row.transfer.transferNumber,
          fromBranch: row.transfer.fromBranch,
          qty: Math.max(0, row.qty - row.receivedQty),
          expectedOn: row.transfer.expectedOn?.toISOString().slice(0, 10) ?? null,
        }))
        .filter((row) => row.qty > 0),
      onOrder: openPoItems
        .map((row) => ({
          purchaseOrderId: row.purchaseOrder.id,
          poNumber: row.purchaseOrder.poNumber,
          supplier: row.purchaseOrder.supplier,
          qty: outstandingPoQty(row),
          expectedOn: row.purchaseOrder.expectedOn?.toISOString().slice(0, 10) ?? null,
        }))
        .filter((row) => row.qty > 0),
      otherBranches: branches.map((branch) => ({
        branchId: branch.id,
        name: branch.name,
        code: branch.code,
        onHand: otherByBranch.get(branch.id)?.onHand ?? 0,
        available: otherByBranch.get(branch.id)?.available ?? 0,
      })),
      recentMovements: movements.items,
      today: businessDateKey("UTC", today),
    };
  }

  async adjustment(
    tenantId: string,
    branchId: string,
    access: ActorAccess,
    dto: StockAdjustmentDto,
  ) {
    const userId = access.userId;
    const increase = dto.movementType === "adjustment_in";
    if (increase && !access.has("inventory.manage")) {
      throw new ForbiddenException("Your role can't add stock");
    }
    if (!increase && !access.has("inventory.write_off")) {
      throw new ForbiddenException("Your role can't write off stock");
    }
    if (dto.newBatch && !increase) {
      throw new BadRequestException("New batches can only be created with stock increases");
    }
    if (!dto.batchId && !dto.newBatch) {
      throw new BadRequestException("Select an existing batch or provide new batch details");
    }
    if (dto.batchId && dto.newBatch) {
      throw new BadRequestException(
        "Provide either an existing batch or new batch details, not both",
      );
    }
    if (dto.fromQuarantine && increase) {
      throw new BadRequestException("Only a write-off can take stock from quarantine");
    }
    const reason = dto.reason?.trim() || null;
    if (!increase && !reason) {
      throw new BadRequestException("Enter a reason for the write-off");
    }

    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, tenantId, isActive: true },
    });
    if (!product) throw new BadRequestException("Invalid product");

    const { today } = await this.clock(tenantId);
    const referenceId = randomUUID();

    const result = await this.prisma.$transaction(async (tx) => {
      let batchId = dto.batchId;

      if (dto.newBatch) {
        const expiryDate = new Date(dto.newBatch.expiryDate);
        if (Number.isNaN(expiryDate.getTime())) {
          throw new BadRequestException("Invalid expiry date");
        }
        if (expiryDate < today) {
          throw new BadRequestException("The new batch's expiry date is in the past");
        }
        if (dto.newBatch.supplierId) {
          const supplier = await tx.supplier.findFirst({
            where: { id: dto.newBatch.supplierId, tenantId },
          });
          if (!supplier) throw new BadRequestException("Invalid supplier");
        }
        const batchNo = dto.newBatch.batchNo.trim();
        const existing = await tx.batch.findFirst({
          where: { tenantId, branchId, productId: dto.productId, batchNo },
          select: { id: true },
        });
        if (existing) {
          throw new BadRequestException(
            `Batch ${batchNo} already exists for this product — choose it instead of creating it again`,
          );
        }
        const created = await tx.batch.create({
          data: {
            tenantId,
            branchId,
            productId: dto.productId,
            batchNo,
            expiryDate,
            costPrice: dto.newBatch.costPrice,
            sellingPrice: dto.newBatch.sellingPrice,
            supplierId: dto.newBatch.supplierId,
          },
        });
        batchId = created.id;
      }

      const ctx = {
        tenantId,
        branchId,
        userId,
        referenceType: "adjustment",
        referenceId,
      };
      if (increase) {
        await this.stock.receive(tx, ctx, [
          {
            productId: dto.productId,
            batchId: batchId!,
            qty: dto.qty,
            movementType: StockMovementType.adjustment_in,
            reason,
          },
        ]);
      } else {
        await this.stock.issue(tx, ctx, [
          {
            productId: dto.productId,
            batchId: batchId!,
            qty: dto.qty,
            movementType: StockMovementType.adjustment_out,
            from: dto.fromQuarantine ? "quarantine" : "sellable",
            reason,
          },
        ]);
      }

      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "inventory.adjustment",
          entityName: "product",
          entityId: dto.productId,
          payload: {
            movementType: dto.movementType,
            qty: dto.qty,
            reason,
            batchId: batchId!,
            referenceId,
            openedNewBatch: Boolean(dto.newBatch),
            fromQuarantine: Boolean(dto.fromQuarantine),
          },
        },
        tx,
      );
      return { batchId: batchId! };
    });

    return { ok: true, referenceId, batchId: result.batchId };
  }

  async listMovements(tenantId: string, branchId: string, query: MovementListQuery = {}) {
    const take = Math.min(Math.max(query.take ?? 50, 1), 100);
    const skip = Math.max(query.skip ?? 0, 0);
    const category = query.category ?? "all";
    const movementTypes = category !== "all" ? MOVEMENT_CATEGORY_TYPES[category] : undefined;

    let occurredAt: Prisma.DateTimeFilter | undefined;
    if (query.from || query.to) {
      const { timeZone } = await this.clock(tenantId);
      try {
        occurredAt = {
          ...(query.from ? { gte: startOfBusinessDay(timeZone, query.from) } : {}),
          ...(query.to ? { lt: startOfBusinessDay(timeZone, nextDateKey(query.to)) } : {}),
        };
      } catch {
        throw new BadRequestException("Dates must be in YYYY-MM-DD format");
      }
    }

    const where: Prisma.StockLedgerWhereInput = {
      tenantId,
      branchId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.batchId ? { batchId: query.batchId } : {}),
      ...(movementTypes ? { movementType: { in: movementTypes } } : {}),
      ...(query.userId ? { createdBy: query.userId } : {}),
      ...(query.referenceType ? { referenceType: query.referenceType } : {}),
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
      ...(occurredAt ? { occurredAt } : {}),
      NOT: HIDDEN_MOVEMENTS,
    };
    // In/out totals ignore quarantine moves entirely: they never change on hand.
    const physicalWhere: Prisma.StockLedgerWhereInput = {
      ...where,
      AND: [{ movementType: { notIn: QUARANTINE_TYPES } }],
    };

    const [rawItems, total, positiveAgg, negativeAgg] = await Promise.all([
      this.prisma.stockLedger.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
        include: {
          batch: { select: { batchNo: true } },
          actor: { select: { id: true, fullName: true } },
          product: { select: { id: true, sku: true, name: true } },
        },
      }),
      this.prisma.stockLedger.count({ where }),
      this.prisma.stockLedger.aggregate({
        where: { ...physicalWhere, qtyDelta: { gt: 0 } },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockLedger.aggregate({
        where: { ...physicalWhere, qtyDelta: { lt: 0 } },
        _sum: { qtyDelta: true },
      }),
    ]);

    const onHandDelta = (row: { movementType: StockMovementType; qtyDelta: number }) =>
      QUARANTINE_TYPES.includes(row.movementType) ? 0 : row.qtyDelta;

    // A running balance only makes sense for one product's (or batch's) whole timeline; with a
    // type, user, date or document filter the rows in between are missing and it would lie.
    const timelineOnly =
      (query.productId || query.batchId) &&
      category === "all" &&
      !query.userId &&
      !query.from &&
      !query.to &&
      !query.referenceType &&
      !query.referenceId;

    let runningBalance: number | null = null;
    if (timelineOnly) {
      const current = await this.prisma.batchStock.aggregate({
        where: {
          tenantId,
          branchId,
          ...(query.batchId ? { batchId: query.batchId } : { productId: query.productId }),
        },
        _sum: { onHandQty: true },
      });
      runningBalance = current._sum.onHandQty ?? 0;
      if (skip > 0) {
        const newer = await this.prisma.stockLedger.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          take: skip,
          select: { qtyDelta: true, movementType: true },
        });
        runningBalance -= newer.reduce((acc, row) => acc + onHandDelta(row), 0);
      }
    }

    const items = rawItems.map((m) => {
      const delta = onHandDelta(m);
      let balanceBefore: number | null = null;
      let balanceAfter: number | null = null;
      if (runningBalance != null) {
        balanceAfter = runningBalance;
        balanceBefore = runningBalance - delta;
        runningBalance = balanceBefore;
      }
      const isQuarantineMove = QUARANTINE_TYPES.includes(m.movementType);
      return {
        id: m.id,
        occurredAt: m.occurredAt.toISOString(),
        movementType: m.movementType,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        reason: m.reason ?? null,
        reasonCode: m.reasonCode ?? null,
        batchId: m.batchId,
        batchNo: m.batch?.batchNo ?? null,
        /** Change to on hand. Zero for quarantine moves — see `quarantineDelta`. */
        qtyDelta: delta,
        /** Units moved into (+) or out of (−) quarantine. */
        quarantineDelta: isQuarantineMove ? m.qtyDelta : 0,
        balanceBefore,
        balanceAfter,
        actorId: m.actor?.id ?? null,
        actorName: m.actor?.fullName ?? null,
        product: m.product,
      };
    });

    const unitsIn = positiveAgg._sum.qtyDelta ?? 0;
    const unitsOut = Math.abs(negativeAgg._sum.qtyDelta ?? 0);
    return {
      items,
      total,
      skip,
      take,
      balanceAvailable: timelineOnly === true,
      summary: { unitsIn, unitsOut, netDelta: unitsIn - unitsOut },
    };
  }

  /** People who have moved stock at this branch recently — the movement history's user filter. */
  async movementActors(tenantId: string, branchId: string) {
    const since = addDays(new Date(), -365);
    const rows = await this.prisma.stockLedger.findMany({
      where: { tenantId, branchId, occurredAt: { gte: since }, createdBy: { not: null } },
      distinct: ["createdBy"],
      select: { actor: { select: { id: true, fullName: true } } },
      take: 200,
    });
    return rows
      .map((row) => row.actor)
      .filter((actor): actor is { id: string; fullName: string } => actor != null)
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  private async batchStockSnapshot(
    tx: Prisma.TransactionClient,
    tenantId: string,
    batchId: string,
  ) {
    const balance =
      (await this.stock.balances(tx, tenantId, [batchId])).get(batchId) ??
      toBalance(ZERO_QUANTITIES);
    return {
      id: batchId,
      qtyOnHand: balance.onHand,
      quarantinedQty: balance.quarantined,
      reservedQty: balance.reserved,
      availableQty: Math.max(0, balance.available),
    };
  }
}

function emptyTotals(productId: string): ProductStockTotals {
  return {
    productId,
    onHand: 0,
    quarantined: 0,
    reserved: 0,
    available: 0,
    expiredSellable: 0,
    batchCount: 0,
    nearExpiryBatchCount: 0,
    expiredBatchCount: 0,
    expiryReviewBatchCount: 0,
  };
}

function matchesAttention(t: ProductStockTotals, attention: StockAttention): boolean {
  switch (attention) {
    case "expired":
      return t.expiredBatchCount > 0;
    case "near_expiry":
      return t.nearExpiryBatchCount > 0;
    case "quarantined":
      return t.quarantined > 0;
    case "reserved":
      return t.reserved > 0;
    case "expiry_review":
      return t.expiryReviewBatchCount > 0;
  }
}

function outstandingPoQty(row: {
  orderedQty: number;
  purchaseOrder: { goodsReceipts: Array<{ items: Array<{ receivedQty: number }> }> };
}): number {
  const received = row.purchaseOrder.goodsReceipts.reduce(
    (sum, gr) => sum + gr.items.reduce((s, item) => s + item.receivedQty, 0),
    0,
  );
  return Math.max(0, row.orderedQty - received);
}

function nextDateKey(key: string): string {
  return addDays(new Date(`${key}T00:00:00.000Z`), 1).toISOString().slice(0, 10);
}
