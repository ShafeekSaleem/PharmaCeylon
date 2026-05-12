import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { RoleName, StockMovementType } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StockBalanceService } from "./stock-balance.service";
import { StockAdjustmentDto } from "./dto/stock-adjustment.dto";
import { CustomerReturnDto } from "./dto/customer-return.dto";
import { SupplierReturnDto } from "./dto/supplier-return.dto";

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockBalanceService,
  ) {}

  async listBatches(tenantId: string, branchId: string) {
    return this.prisma.batch.findMany({
      where: { tenantId, branchId },
      include: { product: { select: { id: true, sku: true, name: true } } },
      orderBy: { expiryDate: "asc" },
    });
  }

  async stockByProduct(tenantId: string, branchId: string) {
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, branchId },
      _sum: { qtyDelta: true },
    });
    const productIds = grouped.map((g) => g.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, sku: true, name: true, reorderLevel: true },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));
    return grouped.map((g) => ({
      productId: g.productId,
      qtyOnHand: g._sum.qtyDelta ?? 0,
      product: pmap.get(g.productId) ?? { id: g.productId },
    }));
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

    let batchId: string | null = dto.batchId ?? null;
    if (dto.movementType === "adjustment_out" && !batchId) {
      throw new BadRequestException("batchId is required for stock decreases");
    }
    if (batchId) {
      const batch = await this.prisma.batch.findFirst({
        where: { id: batchId, tenantId, branchId, productId: dto.productId },
      });
      if (!batch) throw new BadRequestException("Batch does not match product/branch");
    }

    const qtyDelta = dto.movementType === "adjustment_in" ? dto.qty : -dto.qty;

    if (dto.movementType === "adjustment_out") {
      const available = batchId
        ? await this.stock.qtyForBatch(tenantId, branchId, batchId)
        : await this.stock.qtyForProductBranch(tenantId, branchId, dto.productId);
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
