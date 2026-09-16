import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PoPriority, PoStatus, Prisma, StockMovementType } from "@prisma/client";
import {
  linesValue,
  meetsApprovalThreshold,
} from "../common/approval-threshold.util";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { assertOneScopedMutation } from "../common/scoped-mutation.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { businessToday, dateKeyToUtc, safeTimeZone } from "../common/business-date.util";
import { StockService } from "../inventory/stock/stock.service";
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import { createInvoiceFromGoodsReceipt } from "../suppliers/suppliers.service";
import { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";

function decimal(value: string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function parseDateOnly(value: string, label: string): Date {
  try {
    return dateKeyToUtc(value.slice(0, 10));
  } catch {
    throw new BadRequestException(`${label} must be a valid date`);
  }
}

function assertNoDuplicateProductIds(productIds: string[], label: string) {
  const seen = new Set<string>();
  for (const id of productIds) {
    if (seen.has(id)) {
      throw new BadRequestException(`Duplicate product in ${label}: ${id}`);
    }
    seen.add(id);
  }
}

@Injectable()
export class PurchasingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  /**
   * Move a PO from one of `from` to `to`, only if it is still in one of `from` when the write
   * lands. Reading the status and then updating by id let a cancel and an approval both
   * "succeed" on the same order, and let a cancelled order be issued afterwards.
   */
  private async transition(
    tenantId: string,
    branchId: string,
    id: string,
    from: PoStatus[],
    to: PoStatus,
    conflictMessage: string,
  ) {
    const mutation = await this.prisma.purchaseOrder.updateMany({
      where: { id, tenantId, branchId, status: { in: from } },
      data: { status: to },
    });
    if (mutation.count !== 1) {
      const exists = await this.prisma.purchaseOrder.count({ where: { id, tenantId, branchId } });
      if (exists === 0) assertOneScopedMutation(mutation, "Purchase order");
      throw new BadRequestException(conflictMessage);
    }
  }

  private async nextPoNumber(tx: Prisma.TransactionClient, tenantId: string, branchId: string) {
    return nextDocumentNumber(tx, tenantId, branchId, "po", "PO-");
  }

  private async nextGrnNumber(tx: Prisma.TransactionClient, tenantId: string, branchId: string) {
    return nextDocumentNumber(tx, tenantId, branchId, "grn", "GRN-");
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

    // What this branch last paid and charged for each product — the receiving form offers
    // these as starting values instead of inventing a price from the order's unit cost.
    const lastBatches = await this.prisma.batch.findMany({
      where: {
        tenantId,
        branchId,
        productId: { in: po.items.map((item) => item.productId) },
      },
      orderBy: { receivedAt: "desc" },
      distinct: ["productId"],
      select: { productId: true, costPrice: true, sellingPrice: true },
    });
    const lastByProduct = new Map(lastBatches.map((b) => [b.productId, b]));
    return {
      ...po,
      items: po.items.map((item) => {
        const last = lastByProduct.get(item.productId);
        return {
          ...item,
          lastBatchPrices: last
            ? { costPrice: last.costPrice.toString(), sellingPrice: last.sellingPrice.toString() }
            : null,
        };
      }),
    };
  }

  async createPurchaseOrder(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: CreatePurchaseOrderDto,
  ) {
    assertNoDuplicateProductIds(
      dto.items.map((i) => i.productId),
      "purchase order",
    );

    const supplier = await this.prisma.supplier.findFirst({
      where: { id: dto.supplierId, tenantId, status: "active" },
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

    // The tenant's configured ceiling decides, not the caller. `submitForApproval`
    // only chooses between draft and pending_approval *below* the threshold —
    // above it, approval is mandatory however the request was framed.
    const orderValue = linesValue(
      dto.items.map((i) => ({
        qty: i.orderedQty,
        unitAmount: i.unitCost,
        discountPercent: i.discountPercent ?? 0,
        taxPercent: i.taxPercent ?? 18,
      })),
      dto.shippingCharges?.trim() || 0,
    );
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredPurchaseOrderThreshold: true },
    });
    const approvalForced = meetsApprovalThreshold(
      orderValue,
      settings?.approvalRequiredPurchaseOrderThreshold,
    );

    const status =
      approvalForced || dto.submitForApproval
        ? PoStatus.pending_approval
        : PoStatus.draft;
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
        payload: {
          poNumber: po.poNumber,
          status: po.status,
          orderValue: orderValue.toFixed(2),
          // Records *why* it is awaiting approval — a reviewer can tell a
          // threshold trip from a voluntary submission.
          approvalForcedByThreshold: approvalForced,
        },
      });
      return po;
    });
  }

  async cancelPurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status === PoStatus.cancelled) {
      return po;
    }
    if (
      po.status === PoStatus.received ||
      po.status === PoStatus.partially_received ||
      po.status === PoStatus.short_closed
    ) {
      throw new BadRequestException("Cannot cancel a PO that already has receipts");
    }
    // Receiving locks the PO row and moves it to partially_received, so a delivery posted
    // while this cancel waits leaves nothing matching and the cancel is refused.
    await this.transition(
      tenantId,
      branchId,
      id,
      [PoStatus.draft, PoStatus.pending_approval, PoStatus.issued],
      PoStatus.cancelled,
      "This purchase order changed while you were cancelling it — refresh and try again",
    );
    const updated = { ...po, status: PoStatus.cancelled };
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
      po.status === PoStatus.received ||
      po.status === PoStatus.short_closed
    ) {
      throw new BadRequestException(
        "Cannot update a cancelled, fully received, or short-closed PO",
      );
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

    const mutation = await this.prisma.purchaseOrder.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        // Header fields limited to open orders stay limited if the order moved on meanwhile.
        status: isOpenHeader
          ? { in: [PoStatus.draft, PoStatus.pending_approval] }
          : { in: [PoStatus.issued, PoStatus.partially_received] },
      },
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
    });
    if (mutation.count !== 1) {
      throw new BadRequestException(
        "This purchase order changed while you were editing it — refresh and try again",
      );
    }
    const updated = await this.getPurchaseOrder(tenantId, branchId, id);

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
    assertNoDuplicateProductIds(
      dto.lines.map((l) => l.productId),
      "goods receipt",
    );

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
    if (po.status === PoStatus.short_closed) {
      throw new BadRequestException("Cannot receive against a short-closed purchase order");
    }
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

    // Batch number and expiry are what recalls, FEFO picking and expiry alerts all run on, so
    // they must be what is printed on the pack — never a value the form made up.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const today = businessToday(safeTimeZone(tenant?.timezone));
    const receivedOn = parseDateOnly(dto.receivedOn, "Received date");
    if (receivedOn > today) {
      throw new BadRequestException("The received date can't be in the future");
    }
    for (const line of dto.lines) {
      if (!line.batchNo.trim()) {
        throw new BadRequestException("Enter the batch number printed on each product received");
      }
      const expiry = parseDateOnly(line.expiryDate, "Expiry date");
      if (expiry <= receivedOn) {
        throw new BadRequestException(
          `Batch ${line.batchNo.trim()} expires on ${line.expiryDate.slice(0, 10)}, on or before the day it was received. Check the date on the pack — expired stock can't be received into sellable inventory.`,
        );
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM purchase_order
          WHERE id = ${dto.purchaseOrderId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND branch_id = ${branchId}::uuid
          FOR UPDATE
        `;

        const locked = await tx.purchaseOrder.findFirst({
          where: { id: dto.purchaseOrderId, tenantId, branchId },
          include: { items: true },
        });
        if (!locked) throw new NotFoundException("Purchase order not found");
        if (locked.status === PoStatus.short_closed) {
          throw new BadRequestException("Cannot receive against a short-closed purchase order");
        }
        if (
          locked.status !== PoStatus.issued &&
          locked.status !== PoStatus.partially_received
        ) {
          throw new BadRequestException("PO is not open for receiving");
        }

        const orderedByProduct = new Map<string, number>();
        for (const item of locked.items) {
          orderedByProduct.set(
            item.productId,
            (orderedByProduct.get(item.productId) ?? 0) + item.orderedQty,
          );
        }

        const alreadyReceivedByProduct = new Map<string, number>();
        const priorReceipts = await tx.goodsReceipt.findMany({
          where: { purchaseOrderId: locked.id },
          include: { items: true },
        });
        for (const r of priorReceipts) {
          for (const it of r.items) {
            alreadyReceivedByProduct.set(
              it.productId,
              (alreadyReceivedByProduct.get(it.productId) ?? 0) + it.receivedQty,
            );
          }
        }

        const incomingByProduct = new Map<string, number>();
        for (const line of dto.lines) {
          incomingByProduct.set(
            line.productId,
            (incomingByProduct.get(line.productId) ?? 0) + line.receivedQty,
          );
        }

        for (const [productId, incomingQty] of incomingByProduct) {
          const ordered = orderedByProduct.get(productId) ?? 0;
          const already = alreadyReceivedByProduct.get(productId) ?? 0;
          const remaining = ordered - already;
          if (incomingQty > remaining) {
            throw new BadRequestException(
              `Received quantity exceeds remaining for product ${productId} (remaining ${remaining})`,
            );
          }
        }

        const grnNumber = await this.nextGrnNumber(tx, tenantId, branchId);
        const gr = await tx.goodsReceipt.create({
          data: {
            tenantId,
            branchId,
            purchaseOrderId: locked.id,
            grnNumber,
            receivedOn,
            receivedBy: userId,
          },
        });

        let receiptValue = new Prisma.Decimal(0);
        const stockLines: Array<{ productId: string; batchId: string; qty: number }> = [];

        for (const line of dto.lines) {
          const batchNo = line.batchNo.trim();
          const expiryDate = parseDateOnly(line.expiryDate, "Expiry date");

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
            const incomingExpiry = expiryDate.toISOString().slice(0, 10);
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
                expiryDate,
                costPrice: decimal(line.costPrice),
                sellingPrice: decimal(line.sellingPrice),
                supplierId: locked.supplierId,
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

          receiptValue = receiptValue.plus(decimal(line.costPrice).mul(line.receivedQty));
          stockLines.push({ productId: line.productId, batchId: batch.id, qty: line.receivedQty });
        }

        // One posting for the whole delivery: the stock service locks every batch at once, adds
        // the units, and ranges any product still sitting in the reference catalog.
        await this.stock.receive(
          tx,
          {
            tenantId,
            branchId,
            userId,
            referenceType: "goods_receipt",
            referenceId: gr.id,
          },
          stockLines.map((line) => ({
            ...line,
            movementType: StockMovementType.purchase_in,
            reason: `${locked.poNumber} / ${grnNumber}`,
          })),
        );

        const termsDays =
          locked.paymentTermsDays ??
          (
            await tx.supplier.findFirst({
              where: { id: locked.supplierId, tenantId },
              select: { paymentTermsDays: true },
            })
          )?.paymentTermsDays ??
          30;

        await createInvoiceFromGoodsReceipt(tx, {
          tenantId,
          branchId,
          supplierId: locked.supplierId,
          goodsReceiptId: gr.id,
          grnNumber,
          invoiceDate: receivedOn,
          paymentTermsDays: termsDays,
          totalAmount: receiptValue,
        });

        const receivedByProduct = new Map(alreadyReceivedByProduct);
        for (const [productId, qty] of incomingByProduct) {
          receivedByProduct.set(productId, (receivedByProduct.get(productId) ?? 0) + qty);
        }

        let allFullyReceived = true;
        let anyReceived = false;
        for (const [productId, ordered] of orderedByProduct) {
          const rec = receivedByProduct.get(productId) ?? 0;
          if (rec > ordered) {
            throw new BadRequestException(
              `Received quantity exceeds ordered for product ${productId}`,
            );
          }
          if (rec < ordered) allFullyReceived = false;
          if (rec > 0) anyReceived = true;
        }

        const newStatus = allFullyReceived
          ? PoStatus.received
          : anyReceived
            ? PoStatus.partially_received
            : locked.status;

        await tx.purchaseOrder.update({
          where: { id: locked.id, tenantId, branchId },
          data: { status: newStatus },
        });

        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: "goods_receipt.posted",
            entityName: "goods_receipt",
            entityId: gr.id,
            payload: { grnNumber, purchaseOrderId: locked.id },
          },
          tx,
        );

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

  /** Issue a draft PO → issued. Clerks may issue drafts; pending_approval requires approve. */
  async issuePurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status === PoStatus.pending_approval) {
      throw new BadRequestException(
        "This order is waiting for approval — an approver has to approve it before it is issued",
      );
    }
    if (po.status !== PoStatus.draft) {
      throw new BadRequestException("Only draft POs can be issued");
    }
    await this.transition(
      tenantId,
      branchId,
      id,
      [PoStatus.draft],
      PoStatus.issued,
      "This purchase order changed while you were issuing it — refresh and try again",
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.issued",
      entityName: "purchase_order",
      entityId: id,
    });
    return { ...po, status: PoStatus.issued };
  }

  /**
   * Approve a pending_approval PO → issued. The route requires `purchasing.approve`; whether
   * the person who raised the order may approve it is the tenant's self-approval setting.
   */
  async approvePurchaseOrder(
    tenantId: string,
    branchId: string,
    access: ActorAccess,
    id: string,
  ) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status !== PoStatus.pending_approval) {
      throw new BadRequestException("Only pending approval POs can be approved");
    }
    assertMayApprove(access, [po.createdBy], "purchase order");
    await this.transition(
      tenantId,
      branchId,
      id,
      [PoStatus.pending_approval],
      PoStatus.issued,
      "This purchase order is no longer waiting for approval — refresh to see its status",
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: access.userId,
      eventName: "purchase_order.approved",
      entityName: "purchase_order",
      entityId: id,
      payload: { selfApproved: po.createdBy === access.userId },
    });
    return { ...po, status: PoStatus.issued };
  }

  /** Reject a pending_approval PO → cancelled. Requires `purchasing.approve` (controller). */
  async rejectPurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status !== PoStatus.pending_approval) {
      throw new BadRequestException("Only pending approval POs can be rejected");
    }
    await this.transition(
      tenantId,
      branchId,
      id,
      [PoStatus.pending_approval],
      PoStatus.cancelled,
      "This purchase order is no longer waiting for approval — refresh to see its status",
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.rejected",
      entityName: "purchase_order",
      entityId: id,
    });
    return { ...po, status: PoStatus.cancelled };
  }

  /** Short-close a partially_received PO → short_closed. Requires `purchasing.approve`. */
  async shortClosePurchaseOrder(tenantId: string, branchId: string, userId: string, id: string) {
    const po = await this.getPurchaseOrder(tenantId, branchId, id);
    if (po.status !== PoStatus.partially_received) {
      throw new BadRequestException("Only partially received POs can be short-closed");
    }
    await this.transition(
      tenantId,
      branchId,
      id,
      [PoStatus.partially_received],
      PoStatus.short_closed,
      "This purchase order changed while you were closing it — refresh and try again",
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.short_closed",
      entityName: "purchase_order",
      entityId: id,
    });
    return { ...po, status: PoStatus.short_closed };
  }
}
