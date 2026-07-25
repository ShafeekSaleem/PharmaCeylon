import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { RoleName, StockMovementType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { reorderGap, resolveStockStatus } from "../products/stock-qty.util";
import { StockBalanceService } from "./stock-balance.service";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import { CustomerReturnDto } from "./dto/customer-return.dto";
import { SupplierReturnDto } from "./dto/supplier-return.dto";

export type StockListQuery = {
  q?: string;
  status?: "all" | "ok" | "low" | "out";
};

export type BatchListQuery = {
  productId?: string;
  nearExpiryDays?: number;
  /** When false, hide batches with qtyOnHand <= 0. Default true for API compatibility. */
  includeZero?: boolean;
  /** When set, filter by quarantine flag. */
  quarantined?: boolean;
  /** When true, only expired batches; when false, only non-expired. */
  expired?: boolean;
};

export type MovementCategory =
  | "all"
  | "adjustments"
  | "sales"
  | "purchases"
  | "transfers"
  | "returns";

export type MovementListQuery = {
  productId?: string;
  category?: MovementCategory;
  skip?: number;
  take?: number;
};

const MOVEMENT_CATEGORY_TYPES: Record<
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
  returns: [
    StockMovementType.customer_return_in,
    StockMovementType.supplier_return_out,
  ],
};

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

function resolveSummaryPeriod(period: SummaryPeriod): { from: Date; to: Date; label: string } {
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

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockBalanceService,
  ) {}

  async listBatches(tenantId: string, branchId: string, query: BatchListQuery = {}) {
    const includeZero = query.includeZero !== false;
    const expiryLimit =
      query.nearExpiryDays != null && query.nearExpiryDays > 0
        ? (() => {
            const d = new Date();
            d.setDate(d.getDate() + query.nearExpiryDays!);
            return d;
          })()
        : undefined;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const batches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        ...(query.productId ? { productId: query.productId } : {}),
        ...(expiryLimit ? { expiryDate: { lte: expiryLimit } } : {}),
        ...(query.quarantined != null ? { isQuarantined: query.quarantined } : {}),
        ...(query.expired === true
          ? { expiryDate: { lt: today } }
          : query.expired === false
            ? { expiryDate: { gte: today } }
            : {}),
      },
      include: {
        product: {
          select: {
            id: true,
            sku: true,
            name: true,
            reorderLevel: true,
            isControlled: true,
            unit: true,
            imageUrl: true,
          },
        },
      },
      orderBy: { expiryDate: "asc" },
    });

    const batchIds = batches.map((b) => b.id);
    const qtyMap = new Map<string, number>();
    if (batchIds.length > 0) {
      const grouped = await this.prisma.stockLedger.groupBy({
        by: ["batchId"],
        where: {
          tenantId,
          branchId,
          batchId: { in: batchIds },
        },
        _sum: { qtyDelta: true },
      });
      for (const g of grouped) {
        if (g.batchId) qtyMap.set(g.batchId, g._sum.qtyDelta ?? 0);
      }
    }

    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const nearWindowDays =
      query.nearExpiryDays != null && query.nearExpiryDays > 0 ? query.nearExpiryDays : 30;
    const mapped = batches.map((b) => {
      const qtyOnHand = qtyMap.get(b.id) ?? 0;
      const exp = new Date(b.expiryDate);
      exp.setHours(0, 0, 0, 0);
      const daysToExpiry = Math.ceil((exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const expired = daysToExpiry < 0;
      const nearExpiry = !expired && daysToExpiry <= nearWindowDays;
      return {
        id: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate.toISOString(),
        receivedAt: b.receivedAt.toISOString(),
        costPrice: b.costPrice.toString(),
        sellingPrice: b.sellingPrice.toString(),
        productId: b.productId,
        qtyOnHand,
        daysToExpiry,
        expired,
        nearExpiry,
        isQuarantined: b.isQuarantined,
        quarantinedAt: b.quarantinedAt?.toISOString() ?? null,
        quarantineReason: b.quarantineReason,
        product: b.product,
      };
    });

    let result = includeZero ? mapped : mapped.filter((b) => b.qtyOnHand > 0);
    if (query.nearExpiryDays != null && query.nearExpiryDays > 0) {
      result = result.filter((b) => b.nearExpiry && !b.expired);
    }
    if (query.expired === true) {
      result = result.filter((b) => b.expired);
    } else if (query.expired === false) {
      result = result.filter((b) => !b.expired);
    }
    return result;
  }

  async listExpiredBatches(tenantId: string, branchId: string) {
    return this.listBatches(tenantId, branchId, {
      expired: true,
      includeZero: true,
    });
  }

  async quarantineBatch(
    tenantId: string,
    branchId: string,
    userId: string,
    batchId: string,
    reason: string,
  ) {
    const trimmed = reason.trim();
    if (!trimmed) throw new BadRequestException("Quarantine reason is required");

    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, tenantId, branchId },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (batch.isQuarantined) {
      throw new BadRequestException("Batch is already quarantined");
    }

    const now = new Date();
    const updated = await this.prisma.batch.update({
      where: { id: batch.id },
      data: {
        isQuarantined: true,
        quarantinedAt: now,
        quarantineReason: trimmed,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "batch.quarantined",
      entityName: "batch",
      entityId: batch.id,
      payload: {
        productId: batch.productId,
        batchNo: batch.batchNo,
        reason: trimmed,
        quarantinedAt: now.toISOString(),
      },
    });

    return {
      id: updated.id,
      productId: updated.productId,
      batchNo: updated.batchNo,
      isQuarantined: updated.isQuarantined,
      quarantinedAt: updated.quarantinedAt?.toISOString() ?? null,
      quarantineReason: updated.quarantineReason,
    };
  }

  async releaseQuarantine(
    tenantId: string,
    branchId: string,
    userId: string,
    batchId: string,
  ) {
    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, tenantId, branchId },
    });
    if (!batch) throw new NotFoundException("Batch not found");
    if (!batch.isQuarantined) {
      throw new BadRequestException("Batch is not quarantined");
    }

    const updated = await this.prisma.batch.update({
      where: { id: batch.id },
      data: {
        isQuarantined: false,
        quarantinedAt: null,
        quarantineReason: null,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "batch.quarantine_released",
      entityName: "batch",
      entityId: batch.id,
      payload: {
        productId: batch.productId,
        batchNo: batch.batchNo,
        previousReason: batch.quarantineReason,
      },
    });

    return {
      id: updated.id,
      productId: updated.productId,
      batchNo: updated.batchNo,
      isQuarantined: updated.isQuarantined,
      quarantinedAt: null,
      quarantineReason: null,
    };
  }

  async quarantineExpired(tenantId: string, branchId: string, userId: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const candidates = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        isQuarantined: false,
        expiryDate: { lt: today },
      },
      select: {
        id: true,
        productId: true,
        batchNo: true,
        expiryDate: true,
      },
    });

    if (candidates.length === 0) {
      return { quarantined: 0, batchIds: [] as string[] };
    }

    const now = new Date();
    const reason = "Auto-quarantined: expired";

    await this.prisma.$transaction(async (tx) => {
      for (const batch of candidates) {
        await tx.batch.update({
          where: { id: batch.id },
          data: {
            isQuarantined: true,
            quarantinedAt: now,
            quarantineReason: reason,
          },
        });
      }
    });

    for (const batch of candidates) {
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: userId,
        eventName: "batch.quarantined",
        entityName: "batch",
        entityId: batch.id,
        payload: {
          productId: batch.productId,
          batchNo: batch.batchNo,
          reason,
          auto: true,
          expiryDate: batch.expiryDate.toISOString(),
          quarantinedAt: now.toISOString(),
        },
      });
    }

    return {
      quarantined: candidates.length,
      batchIds: candidates.map((b) => b.id),
    };
  }

  async stockByProduct(tenantId: string, branchId: string, query: StockListQuery = {}) {
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, branchId },
      _sum: { qtyDelta: true },
    });

    const qtyByProduct = new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));

    // Include active catalog products with no ledger history (qty 0) so they appear
    // on stock overview and can be selected for opening-stock adjustments.
    const catalogProducts = await this.prisma.product.findMany({
      where: { tenantId, isActive: true },
      select: { id: true },
    });
    for (const p of catalogProducts) {
      if (!qtyByProduct.has(p.id)) qtyByProduct.set(p.id, 0);
    }

    const productIds = [...qtyByProduct.keys()];
    if (productIds.length === 0) return [];

    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
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
        categoryMaps: {
          select: {
            category: { select: { id: true, name: true } },
          },
        },
        tagMaps: {
          select: {
            tag: { select: { id: true, name: true } },
          },
        },
      },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));

    const batches = await this.listBatches(tenantId, branchId, { includeZero: false });
    const batchCountByProduct = new Map<string, number>();
    const nearExpiryByProduct = new Map<string, number>();
    for (const b of batches) {
      batchCountByProduct.set(b.productId, (batchCountByProduct.get(b.productId) ?? 0) + 1);
      if (b.nearExpiry) {
        nearExpiryByProduct.set(
          b.productId,
          (nearExpiryByProduct.get(b.productId) ?? 0) + 1,
        );
      }
    }

    const lastMoves = await this.prisma.stockLedger.findMany({
      where: { tenantId, branchId, productId: { in: productIds } },
      orderBy: { occurredAt: "desc" },
      distinct: ["productId"],
      select: { productId: true, occurredAt: true, movementType: true },
    });
    const lastMoveByProduct = new Map(
      lastMoves.map((m) => [
        m.productId,
        { at: m.occurredAt.toISOString(), type: m.movementType },
      ]),
    );

    const q = query.q?.trim().toLowerCase() ?? "";
    const statusFilter = query.status && query.status !== "all" ? query.status : null;

    const rows = productIds
      .map((productId) => {
        const product = pmap.get(productId);
        if (!product) return null;
        const qtyOnHand = qtyByProduct.get(productId) ?? 0;
        const stockStatus = resolveStockStatus(qtyOnHand, product.reorderLevel);
        const last = lastMoveByProduct.get(productId) ?? null;
        const { categoryMaps, tagMaps, ...productFields } = product;
        return {
          productId,
          qtyOnHand,
          stockStatus,
          reorderGap: reorderGap(qtyOnHand, product.reorderLevel),
          batchCount: batchCountByProduct.get(productId) ?? 0,
          nearExpiryBatchCount: nearExpiryByProduct.get(productId) ?? 0,
          lastMovementAt: last?.at ?? null,
          lastMovementType: last?.type ?? null,
          product: {
            ...productFields,
            categories: categoryMaps.map((map) => map.category),
            tags: tagMaps.map((map) => map.tag),
          },
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null)
      .filter((row) => {
        if (statusFilter && row.stockStatus !== statusFilter) return false;
        if (!q) return true;
        const p = row.product;
        return (
          p.sku.toLowerCase().includes(q) ||
          p.name.toLowerCase().includes(q) ||
          (p.barcode?.toLowerCase().includes(q) ?? false) ||
          (p.genericName?.toLowerCase().includes(q) ?? false) ||
          (p.brandName?.toLowerCase().includes(q) ?? false)
        );
      })
      .sort((a, b) => a.product.name.localeCompare(b.product.name));

    return rows;
  }

  async summary(
    tenantId: string,
    branchId: string,
    period: SummaryPeriod = "this_month",
  ) {
    const stock = await this.stockByProduct(tenantId, branchId);
    const batches = await this.listBatches(tenantId, branchId, {
      includeZero: false,
    });

    let totalUnits = 0;
    let skuCount = 0;
    let lowStock = 0;
    let outOfStock = 0;
    let stockValue = 0;
    for (const row of stock) {
      skuCount += 1;
      totalUnits += row.qtyOnHand;
      if (row.stockStatus === "low") lowStock += 1;
      if (row.stockStatus === "out") outOfStock += 1;
    }
    for (const b of batches) {
      stockValue += b.qtyOnHand * Number(b.costPrice);
    }

    const expired = batches.filter((b) => b.expired).length;
    const nearExpiry = batches.filter((b) => b.nearExpiry).length;
    const nearExpiryProducts = new Set(
      batches.filter((b) => b.nearExpiry).map((b) => b.productId),
    ).size;

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
      const q = g._sum.qtyDelta ?? 0;
      if (
        g.movementType === "purchase_in" ||
        g.movementType === "transfer_in" ||
        g.movementType === "customer_return_in" ||
        g.movementType === "sale_void_in" ||
        g.movementType === "sale_refund_in"
      ) {
        received += Math.max(0, q);
      } else if (
        g.movementType === "sale_out" ||
        g.movementType === "transfer_out" ||
        g.movementType === "supplier_return_out"
      ) {
        issued += Math.abs(Math.min(0, q));
      } else if (
        g.movementType === "adjustment_in" ||
        g.movementType === "adjustment_out"
      ) {
        adjustments += q;
      }
    }

    return {
      skuCount,
      totalUnits,
      stockValue: stockValue.toFixed(2),
      lowStock,
      outOfStock,
      nearExpiry,
      nearExpiryProducts,
      expired,
      healthy: Math.max(0, skuCount - lowStock - outOfStock),
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
      month: {
        received,
        issued,
        adjustments,
        net: received - issued + adjustments,
      },
    };
  }

  async adjustment(
    tenantId: string,
    branchId: string,
    userId: string,
    roles: RoleName[],
    dto: StockAdjustmentDto,
  ) {
    if (dto.movementType !== "adjustment_in" && dto.movementType !== "adjustment_out") {
      throw new BadRequestException("Invalid movement type for adjustment");
    }

    const isManager = roles.includes(RoleName.owner) || roles.includes(RoleName.manager);
    const isClerk = roles.includes(RoleName.inventory_clerk);

    if (dto.movementType === "adjustment_out" && !isManager) {
      throw new ForbiddenException("Only manager or owner may post stock decreases");
    }
    if (dto.movementType === "adjustment_in" && !isManager && !isClerk) {
      throw new ForbiddenException("Insufficient role for stock increase");
    }

    if (dto.newBatch && dto.movementType !== "adjustment_in") {
      throw new BadRequestException("New batches can only be created with stock increases");
    }
    if (!dto.batchId && !dto.newBatch) {
      throw new BadRequestException("Select an existing batch or provide new batch details");
    }
    if (dto.batchId && dto.newBatch) {
      throw new BadRequestException("Provide either an existing batch or new batch details, not both");
    }

    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, tenantId, isActive: true },
    });
    if (!product) throw new BadRequestException("Invalid product");

    const qtyDelta = dto.movementType === "adjustment_in" ? dto.qty : -dto.qty;
    const reason = dto.reason?.trim() || null;
    const referenceId = randomUUID();

    const result = await this.prisma.$transaction(async (tx) => {
      let batchId = dto.batchId;

      if (dto.newBatch) {
        const expiryDate = new Date(dto.newBatch.expiryDate);
        if (Number.isNaN(expiryDate.getTime())) {
          throw new BadRequestException("Invalid expiry date");
        }
        const created = await tx.batch.create({
          data: {
            tenantId,
            branchId,
            productId: dto.productId,
            batchNo: dto.newBatch.batchNo.trim(),
            expiryDate,
            costPrice: dto.newBatch.costPrice,
            sellingPrice: dto.newBatch.sellingPrice,
          },
        });
        batchId = created.id;
      } else {
        const batch = await tx.batch.findFirst({
          where: { id: batchId!, tenantId, branchId, productId: dto.productId },
        });
        if (!batch) throw new BadRequestException("Batch does not match product/branch");
      }

      if (dto.movementType === "adjustment_out") {
        const availableAgg = await tx.stockLedger.aggregate({
          where: { tenantId, branchId, batchId: batchId! },
          _sum: { qtyDelta: true },
        });
        const available = availableAgg._sum.qtyDelta ?? 0;
        if (available < dto.qty) {
          throw new BadRequestException("Insufficient stock for adjustment out");
        }
      }

      await tx.stockLedger.create({
        data: {
          tenantId,
          branchId,
          productId: dto.productId,
          batchId: batchId!,
          movementType: dto.movementType as StockMovementType,
          qtyDelta,
          referenceType: "adjustment",
          referenceId,
          reason,
          createdBy: userId,
        },
      });

      return { batchId: batchId! };
    });

    await this.audit.log({
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
        batchId: result.batchId,
        referenceId,
        openedNewBatch: Boolean(dto.newBatch),
      },
    });

    return { ok: true, referenceId, batchId: result.batchId };
  }

  async customerReturn(tenantId: string, branchId: string, userId: string, dto: CustomerReturnDto) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: dto.saleId, tenantId, branchId },
      include: { items: true },
    });
    if (!sale) throw new BadRequestException("Sale not found for this branch");

    const line = sale.items.find((i) => i.batchId === dto.batchId && i.productId === dto.productId);
    if (!line) throw new BadRequestException("Batch/product not on the referenced sale");

    const batch = await this.prisma.batch.findFirst({
      where: { id: dto.batchId, tenantId, branchId, productId: dto.productId },
    });
    if (!batch) throw new BadRequestException("Invalid batch");

    const priorReturned = await this.prisma.stockLedger.aggregate({
      where: {
        tenantId,
        branchId,
        productId: dto.productId,
        batchId: dto.batchId,
        movementType: StockMovementType.customer_return_in,
        OR: [
          { reason: `sale:${dto.saleId}` },
          { reason: { startsWith: `sale:${dto.saleId}` } },
        ],
      },
      _sum: { qtyDelta: true },
    });
    // Fallback for legacy returns without sale-tagged reason: cap by returns since sale for this line.
    const legacyReturned = await this.prisma.stockLedger.aggregate({
      where: {
        tenantId,
        branchId,
        productId: dto.productId,
        batchId: dto.batchId,
        movementType: StockMovementType.customer_return_in,
        occurredAt: { gte: sale.createdAt },
        reason: null,
      },
      _sum: { qtyDelta: true },
    });
    const alreadyReturned =
      (priorReturned._sum.qtyDelta ?? 0) + (legacyReturned._sum.qtyDelta ?? 0);
    const remaining = line.qty - alreadyReturned;
    if (dto.qty > remaining) {
      throw new BadRequestException(
        remaining <= 0
          ? "This sale line has already been fully returned"
          : `Only ${remaining} unit(s) remain returnable on this sale line`,
      );
    }

    const referenceId = randomUUID();
    await this.prisma.stockLedger.create({
      data: {
        tenantId,
        branchId,
        productId: dto.productId,
        batchId: dto.batchId,
        movementType: StockMovementType.customer_return_in,
        qtyDelta: dto.qty,
        referenceType: "customer_return",
        referenceId,
        reason: `sale:${dto.saleId}`,
        createdBy: userId,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "inventory.customer_return",
      entityName: "product",
      entityId: dto.productId,
      payload: { saleId: dto.saleId, qty: dto.qty, batchId: dto.batchId, referenceId },
    });

    return { ok: true, referenceId };
  }

  async supplierReturn(tenantId: string, branchId: string, userId: string, dto: SupplierReturnDto) {
    const batch = await this.prisma.batch.findFirst({
      where: { id: dto.batchId, tenantId, branchId, productId: dto.productId },
    });
    if (!batch) throw new BadRequestException("Invalid batch");

    const referenceId = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const availableAgg = await tx.stockLedger.aggregate({
        where: { tenantId, branchId, batchId: dto.batchId },
        _sum: { qtyDelta: true },
      });
      const available = availableAgg._sum.qtyDelta ?? 0;
      if (available < dto.qty) {
        throw new BadRequestException("Insufficient stock for supplier return");
      }

      await tx.stockLedger.create({
        data: {
          tenantId,
          branchId,
          productId: dto.productId,
          batchId: dto.batchId,
          movementType: StockMovementType.supplier_return_out,
          qtyDelta: -dto.qty,
          referenceType: "supplier_return",
          referenceId,
          createdBy: userId,
        },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "inventory.supplier_return",
      entityName: "product",
      entityId: dto.productId,
      payload: { qty: dto.qty, batchId: dto.batchId, referenceId },
    });

    return { ok: true, referenceId };
  }

  async listMovements(
    tenantId: string,
    branchId: string,
    query: MovementListQuery = {},
  ) {
    const take = Math.min(Math.max(query.take ?? 50, 1), 100);
    const skip = Math.max(query.skip ?? 0, 0);
    const category = query.category ?? "all";

    const movementTypes =
      category !== "all" ? MOVEMENT_CATEGORY_TYPES[category] : undefined;

    const where = {
      tenantId,
      branchId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(movementTypes ? { movementType: { in: movementTypes } } : {}),
    };

    const [rawItems, total, positiveAgg, negativeAgg] = await Promise.all([
      this.prisma.stockLedger.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        skip,
        take,
        include: {
          batch: { select: { batchNo: true } },
          actor: { select: { fullName: true } },
          product: { select: { id: true, sku: true, name: true } },
        },
      }),
      this.prisma.stockLedger.count({ where }),
      this.prisma.stockLedger.aggregate({
        where: { ...where, qtyDelta: { gt: 0 } },
        _sum: { qtyDelta: true },
      }),
      this.prisma.stockLedger.aggregate({
        where: { ...where, qtyDelta: { lt: 0 } },
        _sum: { qtyDelta: true },
      }),
    ]);

    let runningBalance: number | null = null;
    if (query.productId) {
      runningBalance = await this.stock.qtyForProductBranch(
        tenantId,
        branchId,
        query.productId,
      );
      if (skip > 0) {
        const newer = await this.prisma.stockLedger.findMany({
          where,
          orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
          take: skip,
          select: { qtyDelta: true },
        });
        const newerSum = newer.reduce((acc, row) => acc + row.qtyDelta, 0);
        runningBalance -= newerSum;
      }
    }

    const items = rawItems.map((m) => {
      let balanceBefore: number | null = null;
      let balanceAfter: number | null = null;
      if (runningBalance != null) {
        balanceAfter = runningBalance;
        balanceBefore = runningBalance - m.qtyDelta;
        runningBalance = balanceBefore;
      }
      return {
        id: m.id,
        occurredAt: m.occurredAt.toISOString(),
        movementType: m.movementType,
        referenceType: m.referenceType,
        referenceId: m.referenceId,
        reason: m.reason ?? null,
        batchNo: m.batch?.batchNo ?? null,
        qtyDelta: m.qtyDelta,
        balanceBefore,
        balanceAfter,
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
      summary: {
        unitsIn,
        unitsOut,
        netDelta: unitsIn - unitsOut,
      },
    };
  }
}
