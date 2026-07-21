import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PoPriority, PoStatus, Prisma, StockMovementType } from "@prisma/client";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async nextPoNumber(tx: Prisma.TransactionClient, tenantId: string, branchId: string) {
    const n = await tx.purchaseOrder.count({ where: { tenantId, branchId } });
    return `PO-${String(n + 1).padStart(5, "0")}`;
  }

  private async nextGrnNumber(tx: Prisma.TransactionClient, tenantId: string, branchId: string) {
    const n = await tx.goodsReceipt.count({ where: { tenantId, branchId } });
    return `GRN-${String(n + 1).padStart(5, "0")}`;
  }

  async listPurchaseOrders(tenantId: string, branchId: string) {
    return this.prisma.purchaseOrder.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: "desc" },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        items: { include: { product: { select: { id: true, sku: true, name: true } } } },
        goodsReceipts: {
          select: {
            items: { select: { productId: true, receivedQty: true } },
          },
        },
      },
    });
  }

  async getPurchaseOrder(tenantId: string, branchId: string, id: string) {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId, branchId },
      include: {
        supplier: true,
        items: { include: { product: true } },
        goodsReceipts: { include: { items: { include: { batch: true, product: true } } } },
      },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }

  async createPurchaseOrder(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: CreatePurchaseOrderDto,
  ) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId, isActive: true },
    });
    if (!supplier) throw new NotFoundException("Supplier not found");

    const productIds = [...new Set(dto.items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, isActive: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products are invalid for this tenant");
    }

    if (dto.expectedOn) {
      const expected = new Date(dto.expectedOn);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      expected.setHours(0, 0, 0, 0);
      if (expected < today) {
        throw new BadRequestException("Expected delivery cannot be before today");
      }
    }

    const status = dto.submitForApproval ? PoStatus.pending_approval : PoStatus.draft;
    const priority = (dto.priority as PoPriority | undefined) ?? PoPriority.normal;
    const paymentTermsDays = dto.paymentTermsDays ?? supplier.paymentTermsDays ?? 30;

    return this.prisma.$transaction(async (tx) => {
      const poNumber = await this.nextPoNumber(tx, tenantId, branchId);
      const po = await tx.purchaseOrder.create({
        data: {
          tenantId,
          branchId,
          supplierId: supplier.id,
          poNumber,
          status,
          priority,
          expectedOn: dto.expectedOn ? new Date(dto.expectedOn) : null,
          supplierReference: dto.supplierReference?.trim() || null,
          notes: dto.notes?.trim() || null,
          deliveryInstructions: dto.deliveryInstructions?.trim() || null,
          paymentTermsDays,
          shippingCharges: decimal(dto.shippingCharges?.trim() || "0"),
          createdBy: userId,
          items: {
            create: dto.items.map((i) => ({
              tenantId,
              productId: i.productId,
              orderedQty: i.orderedQty,
              unitCost: decimal(i.unitCost),
              discountPercent: decimal(i.discountPercent ?? 0),
              taxPercent: decimal(i.taxPercent ?? 18),
            })),
          },
        },
        include: { items: { include: { product: true } }, supplier: true },
      });
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: userId,
        eventName: "purchase_order.created",
        entityName: "purchase_order",
        entityId: po.id,
        payload: { poNumber: po.poNumber, status: po.status },
      });
      return po;
    });
  }

  async cancelPurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status === PoStatus.cancelled) {
      return this.prisma.purchaseOrder.findFirst({ where: { id } });
    }
    if (po.status === PoStatus.received || po.status === PoStatus.partially_received) {
      throw new BadRequestException("Cannot cancel a PO that already has receipts");
    }
    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: PoStatus.cancelled },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.cancelled",
      entityName: "purchase_order",
      entityId: id,
    });
    return updated;
  }

  async updatePurchaseOrder(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpdatePurchaseOrderDto,
  ) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (
      po.status === PoStatus.cancelled ||
      po.status === PoStatus.received
    ) {
      throw new BadRequestException("Cannot update a cancelled or fully received PO");
    }

    const isOpenHeader =
      po.status === PoStatus.draft || po.status === PoStatus.pending_approval;
    if (
      !isOpenHeader &&
      (dto.priority !== undefined ||
        dto.supplierReference !== undefined ||
        dto.paymentTermsDays !== undefined)
    ) {
      throw new BadRequestException(
        "Priority, reference, and payment terms can only be edited on draft or pending approval POs",
      );
    }

    if (dto.expectedOn !== undefined && dto.expectedOn !== null) {
      const expected = new Date(dto.expectedOn);
      const created = new Date(po.createdAt);
      created.setHours(0, 0, 0, 0);
      expected.setHours(0, 0, 0, 0);
      if (expected < created) {
        throw new BadRequestException("Expected delivery cannot be before the PO created date");
      }
    }

    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: {
        ...(dto.expectedOn !== undefined
          ? { expectedOn: dto.expectedOn ? new Date(dto.expectedOn) : null }
          : {}),
        ...(dto.priority !== undefined ? { priority: dto.priority as PoPriority } : {}),
        ...(dto.supplierReference !== undefined
          ? { supplierReference: dto.supplierReference?.trim() || null }
          : {}),
        ...(dto.paymentTermsDays !== undefined
          ? { paymentTermsDays: dto.paymentTermsDays }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        ...(dto.deliveryInstructions !== undefined
          ? { deliveryInstructions: dto.deliveryInstructions?.trim() || null }
          : {}),
      },
      include: {
        supplier: true,
        items: { include: { product: true } },
        goodsReceipts: { include: { items: { include: { batch: true, product: true } } } },
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.updated",
      entityName: "purchase_order",
      entityId: id,
      payload: {
        expectedOn: dto.expectedOn,
        priority: dto.priority,
        supplierReference: dto.supplierReference !== undefined,
        paymentTermsDays: dto.paymentTermsDays,
        notes: dto.notes !== undefined,
        deliveryInstructions: dto.deliveryInstructions !== undefined,
      },
    });

    return updated;
  }

  async receiveGoods(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: ReceiveGoodsDto,
    idempotencyKeyRaw?: string,
  ) {
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const existing = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.receiveGoods,
            idempotencyKey: idemKey,
          },
        },
      });
      if (existing) {
        const replay = await this.prisma.goodsReceipt.findFirst({
          where: { id: existing.resourceId, tenantId, branchId },
          include: { items: { include: { batch: true, product: true } } },
        });
        if (replay) {
          if (replay.purchaseOrderId !== dto.purchaseOrderId) {
            throw new BadRequestException(
              "Idempotency-Key already used for a different purchase order / receipt",
            );
          }
          return replay;
        }
        throw new BadRequestException(
          "Idempotency-Key is already recorded but the goods receipt could not be replayed",
        );
      }
    }

    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: dto.purchaseOrderId, tenantId, branchId },
      include: { items: true },
    });
    if (!po) throw new NotFoundException("Purchase order not found");
    if (
      po.status === PoStatus.cancelled ||
      po.status === PoStatus.draft ||
      po.status === PoStatus.pending_approval
    ) {
      throw new BadRequestException("PO must be issued (or partially received) before receiving goods");
    }
    if (po.status !== PoStatus.issued && po.status !== PoStatus.partially_received) {
      throw new BadRequestException("PO is not open for receiving");
    }

    const poItemsByProduct = new Map(po.items.map((i) => [i.productId, i]));

    for (const line of dto.lines) {
      if (!poItemsByProduct.has(line.productId)) {
        throw new BadRequestException(`Product ${line.productId} is not on this PO`);
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const grnNumber = await this.nextGrnNumber(tx, tenantId, branchId);
        const gr = await tx.goodsReceipt.create({
          data: {
            tenantId,
            branchId,
            purchaseOrderId: po.id,
            grnNumber,
            receivedOn: new Date(dto.receivedOn),
            receivedBy: userId,
          },
        });

        for (const line of dto.lines) {
          const batchNo = line.batchNo.trim();
          if (!batchNo) {
            throw new BadRequestException("Batch number is required for each received line");
          }

          let batch = await tx.batch.findUnique({
            where: {
              tenantId_branchId_productId_batchNo: {
                tenantId,
                branchId,
                productId: line.productId,
                batchNo,
              },
            },
          });

          if (batch) {
            const existingExpiry = batch.expiryDate.toISOString().slice(0, 10);
            const incomingExpiry = new Date(line.expiryDate).toISOString().slice(0, 10);
            if (existingExpiry !== incomingExpiry) {
              throw new BadRequestException(
                `Batch ${batchNo} already exists with expiry ${existingExpiry}. Use that expiry, or enter a different batch number.`,
              );
            }
          } else {
            batch = await tx.batch.create({
              data: {
                tenantId,
                branchId,
                productId: line.productId,
                batchNo,
                expiryDate: new Date(line.expiryDate),
                costPrice: decimal(line.costPrice),
                sellingPrice: decimal(line.sellingPrice),
              },
            });
          }

          await tx.goodsReceiptItem.create({
            data: {
              tenantId,
              goodsReceiptId: gr.id,
              productId: line.productId,
              batchId: batch.id,
              receivedQty: line.receivedQty,
            },
          });

          await tx.stockLedger.create({
            data: {
              tenantId,
              branchId,
              productId: line.productId,
              batchId: batch.id,
              movementType: StockMovementType.purchase_in,
              qtyDelta: line.receivedQty,
              referenceType: "goods_receipt",
              referenceId: gr.id,
              reason: `${po.poNumber} / ${grnNumber}`,
              createdBy: userId,
            },
          });
        }

        const receivedByProduct = new Map<string, number>();
        const receipts = await tx.goodsReceipt.findMany({
          where: { purchaseOrderId: po.id },
          include: { items: true },
        });
        for (const r of receipts) {
          for (const it of r.items) {
            receivedByProduct.set(
              it.productId,
              (receivedByProduct.get(it.productId) ?? 0) + it.receivedQty,
            );
          }
        }

        let allFullyReceived = true;
        let anyReceived = false;
        for (const item of po.items) {
          const rec = receivedByProduct.get(item.productId) ?? 0;
          if (rec > item.orderedQty) {
            throw new BadRequestException(
              `Received quantity exceeds ordered for product ${item.productId}`,
            );
          }
          if (rec < item.orderedQty) allFullyReceived = false;
          if (rec > 0) anyReceived = true;
        }

        const newStatus = allFullyReceived
          ? PoStatus.received
          : anyReceived
            ? PoStatus.partially_received
            : po.status;

        await tx.purchaseOrder.update({
          where: { id: po.id },
          data: { status: newStatus },
        });

        await this.audit.log({
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: "goods_receipt.posted",
          entityName: "goods_receipt",
          entityId: gr.id,
          payload: { grnNumber, purchaseOrderId: po.id },
        });

        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.receiveGoods,
              idempotencyKey: idemKey,
              resourceId: gr.id,
            },
          });
        }

        return tx.goodsReceipt.findFirst({
          where: { id: gr.id },
          include: { items: { include: { batch: true, product: true } } },
        });
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        const row = await this.prisma.idempotencyRecord.findUnique({
          where: {
            tenantId_userId_scope_idempotencyKey: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.receiveGoods,
              idempotencyKey: idemKey,
            },
          },
        });
        if (row) {
          return this.prisma.goodsReceipt.findFirst({
            where: { id: row.resourceId, tenantId, branchId },
            include: { items: { include: { batch: true, product: true } } },
          });
        }
      }
      if (isPrismaUniqueFieldError(e, "batch")) {
        throw new BadRequestException(
          "A batch with this number already exists for one of the products. Reuse the existing batch number with matching expiry, or enter a new batch number.",
        );
      }
      throw e;
    }
  }

  /** Issue a draft or pending_approval PO → issued. */
  async issuePurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status !== PoStatus.draft && po.status !== PoStatus.pending_approval) {
      throw new BadRequestException("Only draft or pending approval POs can be issued");
    }
    const updated = await this.prisma.purchaseOrder.update({
      where: { id },
      data: { status: PoStatus.issued },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.issued",
      entityName: "purchase_order",
      entityId: id,
    });
    return updated;
  }
}
