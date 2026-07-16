import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
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

    const batches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        ...(query.productId ? { productId: query.productId } : {}),
        ...(expiryLimit ? { expiryDate: { lte: expiryLimit } } : {}),
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

    const now = Date.now();
    const mapped = batches.map((b) => {
      const qtyOnHand = qtyMap.get(b.id) ?? 0;
      const expiryMs = b.expiryDate.getTime();
      const daysToExpiry = Math.ceil((expiryMs - now) / (1000 * 60 * 60 * 24));
      const expired = daysToExpiry < 0;
      const nearExpiry = !expired && daysToExpiry <= 30;
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
        product: b.product,
      };
    });

    return includeZero ? mapped : mapped.filter((b) => b.qtyOnHand > 0);
  }

  async stockByProduct(tenantId: string, branchId: string, query: StockListQuery = {}) {
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, branchId },
      _sum: { qtyDelta: true },
    });

    const productIds = grouped.map((g) => g.productId);
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

    const rows = grouped
      .map((g) => {
        const product = pmap.get(g.productId);
        if (!product) return null;
        const qtyOnHand = g._sum.qtyDelta ?? 0;
        const stockStatus = resolveStockStatus(qtyOnHand, product.reorderLevel);
        const last = lastMoveByProduct.get(g.productId) ?? null;
        const { categoryMaps, tagMaps, ...productFields } = product;
        return {
          productId: g.productId,
          qtyOnHand,
          stockStatus,
          reorderGap: reorderGap(qtyOnHand, product.reorderLevel),
          batchCount: batchCountByProduct.get(g.productId) ?? 0,
          nearExpiryBatchCount: nearExpiryByProduct.get(g.productId) ?? 0,
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

    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, tenantId, isActive: true },
    });
    if (!product) throw new BadRequestException("Invalid product");

    const batchId = dto.batchId;
    const batch = await this.prisma.batch.findFirst({
      where: { id: batchId, tenantId, branchId, productId: dto.productId },
    });
    if (!batch) throw new BadRequestException("Batch does not match product/branch");

    const qtyDelta = dto.movementType === "adjustment_in" ? dto.qty : -dto.qty;

    if (dto.movementType === "adjustment_out") {
      const available = await this.stock.qtyForBatch(tenantId, branchId, batchId);
      if (available < dto.qty) {
        throw new BadRequestException("Insufficient stock for adjustment out");
      }
    }

    const referenceId = randomUUID();
    await this.prisma.stockLedger.create({
      data: {
        tenantId,
        branchId,
        productId: dto.productId,
        batchId,
        movementType: dto.movementType as StockMovementType,
        qtyDelta,
        referenceType: "adjustment",
        referenceId,
        createdBy: userId,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "inventory.adjustment",
      entityName: "stock_ledger",
      entityId: referenceId,
      payload: { movementType: dto.movementType, qty: dto.qty, reason: dto.reason ?? null },
    });

    return { ok: true, referenceId };
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
        createdBy: userId,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "inventory.customer_return",
      entityName: "stock_ledger",
      entityId: referenceId,
      payload: { saleId: dto.saleId, qty: dto.qty },
    });

    return { ok: true, referenceId };
  }

  async supplierReturn(tenantId: string, branchId: string, userId: string, dto: SupplierReturnDto) {
    const batch = await this.prisma.batch.findFirst({
      where: { id: dto.batchId, tenantId, branchId, productId: dto.productId },
    });
    if (!batch) throw new BadRequestException("Invalid batch");

    const available = await this.stock.qtyForBatch(tenantId, branchId, dto.batchId);
    if (available < dto.qty) {
      throw new BadRequestException("Insufficient stock for supplier return");
    }

    const referenceId = randomUUID();
    await this.prisma.stockLedger.create({
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

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "inventory.supplier_return",
      entityName: "stock_ledger",
      entityId: referenceId,
      payload: { qty: dto.qty },
    });

    return { ok: true, referenceId };
  }
}
