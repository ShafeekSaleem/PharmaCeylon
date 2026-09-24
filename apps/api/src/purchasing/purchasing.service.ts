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
import { StockReadService } from "../inventory/stock/stock-read.service";
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import { createInvoiceFromGoodsReceipt } from "../suppliers/suppliers.service";
import { CreatePurchaseOrderDto, PurchaseOrderItemInputDto } from "./dto/create-purchase-order.dto";
import { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { UpdatePurchaseOrderDto } from "./dto/update-purchase-order.dto";
import {
  effectiveUnitCost,
  maxReceivableQty,
  normalizeUnitsPerPack,
  packCostFromUnit,
  priceRiseNeedsApproval,
  priceVariancePercent,
  resolveQuantity,
  unitCostFromPack,
} from "./pack-math";

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

/**
 * Refuse a delivery because the order is no longer open, in words that help.
 *
 * "PO is not open for receiving" is accurate and useless: it happens when someone else booked
 * the rest of the order in while this form sat open, and what the receiver needs to be told is
 * that, plus how to get current. The code lets the page re-read the order for them.
 */
function poNotOpen(status: PoStatus): BadRequestException {
  const reason: Record<string, string> = {
    [PoStatus.received]: "has already been fully received",
    [PoStatus.short_closed]: "was short-closed, so nothing more can be booked against it",
    [PoStatus.cancelled]: "was cancelled",
    [PoStatus.draft]: "has not been issued to the supplier yet",
    [PoStatus.pending_approval]: "is still waiting for approval",
  };
  return new BadRequestException({
    code: "PO_NOT_OPEN",
    status,
    message: `This purchase order ${reason[status] ?? "is not open for receiving"}. Refresh to see its current state.`,
  });
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
    private readonly stockRead: StockReadService,
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

  /**
   * Turn what the buyer typed into what the order stores: units, a unit cost, and the pack the
   * two were derived from.
   *
   * A line may arrive as packs, as units, priced per pack or per unit, or priced not at all —
   * in which case the supplier's price list answers, and failing that the last cost paid. The
   * pack is snapshotted on the line, so re-packing a product next year does not restate an
   * order placed today.
   */
  private async resolveOrderLines(
    tenantId: string,
    supplierId: string,
    items: PurchaseOrderItemInputDto[],
  ) {
    const productIds = [...new Set(items.map((i) => i.productId))];
    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: productIds }, isActive: true },
      select: { id: true, name: true, unitsPerPack: true },
    });
    if (products.length !== productIds.length) {
      throw new BadRequestException("One or more products are invalid for this tenant");
    }
    const productById = new Map(products.map((p) => [p.id, p]));

    const priceRows = await this.prisma.supplierProductPrice.findMany({
      where: { tenantId, supplierId, productId: { in: productIds } },
    });
    const priceByProduct = new Map(priceRows.map((row) => [row.productId, row]));

    return items.map((item) => {
      const product = productById.get(item.productId)!;
      const price = priceByProduct.get(item.productId);
      const unitsPerPack = normalizeUnitsPerPack(
        item.unitsPerPack ?? price?.unitsPerPack ?? product.unitsPerPack,
      );
      const quantity = resolveQuantity({
        unitsPerPack,
        packs: item.orderedPacks ?? null,
        units: item.orderedQty ?? null,
      });
      if (quantity.units < 1) {
        throw new BadRequestException(`Enter how many to order for ${product.name}`);
      }

      const packCost = item.packCost?.trim() ? decimal(item.packCost) : null;
      const unitCost = item.unitCost?.trim()
        ? decimal(item.unitCost)
        : packCost
          ? unitCostFromPack(packCost, unitsPerPack)
          : (price?.unitCost ?? null);
      if (!unitCost) {
        throw new BadRequestException(
          `Enter a cost for ${product.name} — this supplier has no price on file for it`,
        );
      }

      return {
        productId: item.productId,
        orderedQty: quantity.units,
        orderedPacks: quantity.packs,
        unitsPerPack,
        packCost: packCost ?? (unitsPerPack > 1 ? packCostFromUnit(unitCost, unitsPerPack) : null),
        unitCost,
        discountPercent: item.discountPercent ?? Number(price?.discountPercent ?? 0),
        taxPercent: item.taxPercent ?? 18,
      };
    });
  }

  async listPurchaseOrders(
    tenantId: string,
    branchId: string,
    opts: { canViewCost?: boolean } = {},
  ) {
    const canViewCost = opts.canViewCost !== false;
    const rows = await this.prisma.purchaseOrder.findMany({
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
    if (canViewCost) return rows;
    // Costs are withheld, not hidden in the page: a role without `purchasing.view_cost` can
    // still track what is on order and when it lands, and never sees what it costs.
    return rows.map((po) => ({
      ...po,
      shippingCharges: null,
      items: po.items.map((item) => ({ ...item, unitCost: null, packCost: null })),
    }));
  }

  async getPurchaseOrder(
    tenantId: string,
    branchId: string,
    id: string,
    opts: { canViewCost?: boolean } = {},
  ) {
    const canViewCost = opts.canViewCost !== false;
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
      shippingCharges: canViewCost ? po.shippingCharges : null,
      // The deliveries on this order carry the same money as its lines do — on the delivery line
      // itself and on the batch it created. Blanking only the order lines left the cost on screen
      // one panel further down, so the permission has to reach both.
      goodsReceipts: (po.goodsReceipts ?? []).map((receipt) => ({
        ...receipt,
        items: (receipt.items ?? []).map((item) => ({
          ...item,
          unitCost: canViewCost ? item.unitCost : null,
          orderedUnitCost: canViewCost ? item.orderedUnitCost : null,
          batch: item.batch
            ? { ...item.batch, costPrice: canViewCost ? item.batch.costPrice : null }
            : item.batch,
        })),
      })),
      items: po.items.map((item) => {
        const last = lastByProduct.get(item.productId);
        // Outstanding drives the receiving form. Free and rejected units are reported but do
        // not close the line: a bonus was never ordered, and a damaged unit still owes a
        // replacement.
        const outstandingQty = Math.max(item.orderedQty - item.receivedQty, 0);
        return {
          ...item,
          unitCost: canViewCost ? item.unitCost : null,
          packCost: canViewCost ? item.packCost : null,
          outstandingQty,
          outstandingPacks:
            item.unitsPerPack > 1 ? Math.ceil(outstandingQty / item.unitsPerPack) : null,
          lastBatchPrices:
            canViewCost && last
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

    const lines = await this.resolveOrderLines(tenantId, supplier.id, dto.items);

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
      lines.map((line) => ({
        qty: line.orderedQty,
        unitAmount: line.unitCost,
        discountPercent: line.discountPercent,
        taxPercent: line.taxPercent,
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
            create: lines.map((line) => ({
              tenantId,
              productId: line.productId,
              orderedQty: line.orderedQty,
              orderedPacks: line.orderedPacks,
              unitsPerPack: line.unitsPerPack,
              packCost: line.packCost,
              unitCost: line.unitCost,
              discountPercent: decimal(line.discountPercent),
              taxPercent: decimal(line.taxPercent),
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
    access: ActorAccess,
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
      throw poNotOpen(po.status);
    }
    if (
      po.status === PoStatus.cancelled ||
      po.status === PoStatus.draft ||
      po.status === PoStatus.pending_approval
    ) {
      throw poNotOpen(po.status);
    }
    if (po.status !== PoStatus.issued && po.status !== PoStatus.partially_received) {
      throw poNotOpen(po.status);
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

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: {
        goodsReceiptOverTolerancePercent: true,
        purchasePriceVarianceTolerancePercent: true,
      },
    });
    const tolerancePercent = Number(settings?.goodsReceiptOverTolerancePercent ?? 0);
    const priceTolerancePercent = Number(settings?.purchasePriceVarianceTolerancePercent ?? 0);

    const receiptProductIds = [...new Set(dto.lines.map((l) => l.productId))];
    const receiptProducts = await this.prisma.product.findMany({
      where: { tenantId, id: { in: receiptProductIds } },
      select: { id: true, name: true, unitsPerPack: true },
    });
    const receiptProductById = new Map(receiptProducts.map((p) => [p.id, p]));
    const supplierPrices = await this.prisma.supplierProductPrice.findMany({
      where: { tenantId, supplierId: po.supplierId, productId: { in: receiptProductIds } },
    });
    const supplierPriceByProduct = new Map(supplierPrices.map((row) => [row.productId, row]));

    // What the delivery note says, resolved once: units, what was billed per unit, and what a
    // unit really costs once the free ones are counted.
    const resolvedLines = dto.lines.map((line) => {
      const product = receiptProductById.get(line.productId);
      if (!product) throw new BadRequestException("A product on this delivery no longer exists");
      const priceRow = supplierPriceByProduct.get(line.productId);
      const poItem = poItemsByProduct.get(line.productId)!;
      const unitsPerPack = normalizeUnitsPerPack(
        line.unitsPerPack ?? poItem.unitsPerPack ?? priceRow?.unitsPerPack ?? product.unitsPerPack,
      );
      const paid = resolveQuantity({
        unitsPerPack,
        packs: line.packs ?? null,
        units: line.receivedQty ?? null,
      });
      const freeQty = Math.max(0, Math.floor(line.freeQty ?? 0));
      const rejectedQty = Math.max(0, Math.floor(line.rejectedQty ?? 0));
      if (paid.units + freeQty + rejectedQty <= 0) {
        throw new BadRequestException(
          `Enter how many units of ${product.name} arrived, or leave the line out of this delivery`,
        );
      }
      if (rejectedQty > 0 && !line.rejectedReason?.trim()) {
        throw new BadRequestException(
          `Say what is wrong with the ${rejectedQty} rejected unit(s) of ${product.name} — it is recorded against the held stock`,
        );
      }

      const packCost = line.packCost?.trim() ? decimal(line.packCost) : null;
      const unitCost = line.costPrice?.trim()
        ? decimal(line.costPrice)
        : packCost
          ? unitCostFromPack(packCost, unitsPerPack)
          : (poItem.unitCost ?? priceRow?.unitCost ?? null);
      if (!unitCost) {
        throw new BadRequestException(`Enter the cost per unit for ${product.name}`);
      }

      const batchNo = line.batchNo.trim();
      if (!batchNo) {
        throw new BadRequestException("Enter the batch number printed on each product received");
      }
      const expiryDate = parseDateOnly(line.expiryDate, "Expiry date");
      if (expiryDate <= receivedOn) {
        throw new BadRequestException(
          `Batch ${batchNo} expires on ${line.expiryDate.slice(0, 10)}, on or before the day it was received. Check the date on the pack — expired stock can't be received into sellable inventory.`,
        );
      }

      const orderedUnitCost = poItem.unitCost ?? null;

      return {
        productId: line.productId,
        productName: product.name,
        batchNo,
        expiryDate,
        unitsPerPack,
        packs: paid.packs,
        paidQty: paid.units,
        freeQty,
        rejectedQty,
        rejectedReason: line.rejectedReason?.trim() || null,
        unitCost,
        orderedUnitCost,
        variancePercent: priceVariancePercent(orderedUnitCost, unitCost),
        effectiveCost: effectiveUnitCost({
          unitCost,
          paidQty: paid.units,
          freeQty,
          rejectedQty,
        }),
        sellingPrice: decimal(line.sellingPrice),
        onCostConflict: line.onCostConflict ?? null,
        onExpiryConflict: line.onExpiryConflict ?? null,
      };
    });

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
          throw poNotOpen(locked.status);
        }
        if (
          locked.status !== PoStatus.issued &&
          locked.status !== PoStatus.partially_received
        ) {
          throw poNotOpen(locked.status);
        }

        const lockedItemByProduct = new Map(locked.items.map((item) => [item.productId, item]));

        // How much more than the outstanding quantity this delivery may contain. Suppliers do
        // round up to a carton; refusing outright used to leave the goods un-bookable, with the
        // shelf holding units the system denied existed.
        const overDeliveries: Array<{ product: string; outstanding: number; arriving: number }> = [];
        for (const line of resolvedLines) {
          const item = lockedItemByProduct.get(line.productId)!;
          const outstanding = Math.max(item.orderedQty - item.receivedQty, 0);
          if (line.paidQty <= outstanding) continue;
          const allowed = maxReceivableQty(outstanding, item.orderedQty, tolerancePercent);
          if (line.paidQty > allowed) {
            overDeliveries.push({
              product: line.productName,
              outstanding,
              arriving: line.paidQty,
            });
          }
        }
        if (overDeliveries.length > 0) {
          const mayAccept = access.has("purchasing.approve");
          if (!dto.acceptOverDelivery || !mayAccept) {
            const first = overDeliveries[0]!;
            // "only 0 are outstanding" is true but reads like nonsense. When a line is already
            // complete the useful thing to say is that it is complete — usually the form was
            // loaded before someone else booked the rest of it in.
            const situation =
              first.outstanding === 0
                ? `${first.product} is already fully received on this order, and ${first.arriving} more units have been entered`
                : `${first.arriving} units of ${first.product} arrived but only ${first.outstanding} are outstanding`;
            throw new BadRequestException({
              code: "OVER_DELIVERY",
              message: mayAccept
                ? `${situation}. Refresh the order to check, or accept the extra to book it in.`
                : `${situation}. Refresh the order to check — if it is right, someone who can approve purchase orders has to accept it.`,
              overDeliveries,
            });
          }
        }

        // The same question about money. A price *drop* passes silently — nobody disputes
        // paying less — but it is still recorded on the delivery line.
        const priceRises = resolvedLines
          .filter((line) => priceRiseNeedsApproval(line.variancePercent, priceTolerancePercent))
          .map((line) => ({
            productId: line.productId,
            product: line.productName,
            orderedUnitCost: line.orderedUnitCost!.toFixed(2),
            billedUnitCost: line.unitCost.toFixed(2),
            variancePercent: line.variancePercent!,
          }));
        if (priceRises.length > 0) {
          const mayAccept = access.has("purchasing.approve");
          if (!dto.acceptPriceVariance || !mayAccept) {
            const first = priceRises[0]!;
            const movement = `${first.product} was ordered at Rs ${first.orderedUnitCost} a unit and is billed at Rs ${first.billedUnitCost} (+${first.variancePercent}%)`;
            throw new BadRequestException({
              code: "PRICE_VARIANCE",
              message: mayAccept
                ? `${movement}. Accept the new price to book the delivery in.`
                : `${movement}. Someone who can approve purchase orders has to accept it.`,
              priceRises,
            });
          }
        }

        const grnNumber = await this.nextGrnNumber(tx, tenantId, branchId);
        const gr = await tx.goodsReceipt.create({
          data: {
            tenantId,
            branchId,
            purchaseOrderId: locked.id,
            grnNumber,
            supplierDeliveryNote: dto.supplierDeliveryNote?.trim() || null,
            receivedOn,
            receivedBy: userId,
          },
        });

        let receiptValue = new Prisma.Decimal(0);
        const arrivals: Array<{ productId: string; batchId: string; qty: number }> = [];
        const holds: Array<{
          productId: string;
          batchId: string;
          qty: number;
          reason: string | null;
        }> = [];
        const costConflicts: Array<{
          productId: string;
          batchNo: string;
          product: string;
          existingCost: string;
          incomingCost: string;
        }> = [];
        const expiryConflicts: Array<{
          productId: string;
          product: string;
          batchNo: string;
          existingExpiry: string;
          enteredExpiry: string;
          canCorrect: boolean;
        }> = [];

        for (const line of resolvedLines) {
          let batch = await tx.batch.findUnique({
            where: {
              tenantId_branchId_productId_batchNo: {
                tenantId,
                branchId,
                productId: line.productId,
                batchNo: line.batchNo,
              },
            },
          });

          if (batch) {
            const existingExpiry = batch.expiryDate.toISOString().slice(0, 10);
            const incomingExpiry = line.expiryDate.toISOString().slice(0, 10);
            if (existingExpiry !== incomingExpiry) {
              if (line.onExpiryConflict === "use_existing") {
                // Same batch, and the date on file stands.
              } else if (line.onExpiryConflict === "correct_existing") {
                if (!batch.needsExpiryReview) {
                  throw new BadRequestException(
                    `Batch ${line.batchNo} is already in stock with expiry ${existingExpiry}, which was recorded from a pack. Two different expiries mean two different batches — enter a different batch number.`,
                  );
                }
                if (!access.has("inventory.manage")) {
                  throw new BadRequestException(
                    `Batch ${line.batchNo} has an unconfirmed expiry. Correcting it needs someone who can manage inventory.`,
                  );
                }
                const corrected = await tx.batch.updateMany({
                  where: { id: batch.id, tenantId, branchId, needsExpiryReview: true },
                  data: { expiryDate: line.expiryDate, needsExpiryReview: false },
                });
                assertOneScopedMutation(corrected, "Batch");
                await this.audit.log(
                  {
                    tenantId,
                    branchId,
                    actorUserId: userId,
                    eventName: "batch.expiry_confirmed",
                    entityName: "batch",
                    entityId: batch.id,
                    payload: {
                      expiryDate: incomingExpiry,
                      previousExpiryDate: existingExpiry,
                      productId: line.productId,
                      confirmedWhileReceiving: grnNumber,
                    },
                  },
                  tx,
                );
                batch = { ...batch, expiryDate: line.expiryDate, needsExpiryReview: false };
              } else {
                expiryConflicts.push({
                  productId: line.productId,
                  product: line.productName,
                  batchNo: line.batchNo,
                  existingExpiry,
                  enteredExpiry: incomingExpiry,
                  // Only an unconfirmed imported date may be rewritten; anything else means
                  // this is a different batch wearing the same number.
                  canCorrect: batch.needsExpiryReview,
                });
              }
            }
            // The old code silently kept the existing prices while valuing the delivery at the
            // typed cost, so stock and money disagreed with nobody being told. The receiver
            // decides instead.
            if (!batch.costPrice.equals(line.effectiveCost)) {
              if (line.onCostConflict === "update_cost") {
                const repriced = await tx.batch.updateMany({
                  where: { id: batch.id, tenantId, branchId },
                  data: { costPrice: line.effectiveCost, sellingPrice: line.sellingPrice },
                });
                assertOneScopedMutation(repriced, "Batch");
                batch = { ...batch, costPrice: line.effectiveCost, sellingPrice: line.sellingPrice };
              } else if (!line.onCostConflict) {
                costConflicts.push({
                  productId: line.productId,
                  product: line.productName,
                  batchNo: line.batchNo,
                  existingCost: batch.costPrice.toFixed(2),
                  incomingCost: line.effectiveCost.toFixed(2),
                });
              }
            }
          } else {
            batch = await tx.batch.create({
              data: {
                tenantId,
                branchId,
                productId: line.productId,
                batchNo: line.batchNo,
                expiryDate: line.expiryDate,
                costPrice: line.effectiveCost,
                sellingPrice: line.sellingPrice,
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
              receivedQty: line.paidQty,
              freeQty: line.freeQty,
              rejectedQty: line.rejectedQty,
              packs: line.packs,
              unitCost: line.unitCost,
              orderedUnitCost: line.orderedUnitCost,
            },
          });

          // Free units cost nothing; rejected ones were billed and are awaiting a credit, so
          // they are part of what this delivery is worth.
          receiptValue = receiptValue.plus(
            line.unitCost.mul(line.paidQty + line.rejectedQty),
          );

          const arriving = line.paidQty + line.freeQty + line.rejectedQty;
          if (arriving > 0) {
            arrivals.push({ productId: line.productId, batchId: batch.id, qty: arriving });
          }
          if (line.rejectedQty > 0) {
            holds.push({
              productId: line.productId,
              batchId: batch.id,
              qty: line.rejectedQty,
              reason: line.rejectedReason,
            });
          }

          const item = lockedItemByProduct.get(line.productId)!;
          const lineUpdate = await tx.purchaseOrderItem.updateMany({
            where: { id: item.id, tenantId, purchaseOrderId: locked.id },
            data: {
              receivedQty: { increment: line.paidQty },
              freeQty: { increment: line.freeQty },
              rejectedQty: { increment: line.rejectedQty },
            },
          });
          assertOneScopedMutation(lineUpdate, "Purchase order line");

          // The price list learns what was actually paid, without overwriting the agreed price
          // a buyer negotiated.
          await tx.supplierProductPrice.upsert({
            where: {
              tenantId_supplierId_productId: {
                tenantId,
                supplierId: locked.supplierId,
                productId: line.productId,
              },
            },
            create: {
              tenantId,
              supplierId: locked.supplierId,
              productId: line.productId,
              unitsPerPack: line.unitsPerPack,
              unitCost: line.unitCost,
              lastUnitCost: line.unitCost,
              lastPurchasedAt: receivedOn,
            },
            update: {
              lastUnitCost: line.unitCost,
              lastPurchasedAt: receivedOn,
              // Only on the receiver's say-so: an agreed price is a negotiation, not a
              // side-effect of one delivery arriving dearer than the last.
              ...(dto.updateSupplierPrice
                ? {
                    unitCost: line.unitCost,
                    packCost: packCostFromUnit(line.unitCost, line.unitsPerPack),
                    unitsPerPack: line.unitsPerPack,
                  }
                : {}),
            },
          });
        }

        if (expiryConflicts.length > 0) {
          const first = expiryConflicts[0]!;
          throw new BadRequestException({
            code: "EXPIRY_CONFLICT",
            message: `Batch ${first.batchNo} of ${first.product} is already on file expiring ${first.existingExpiry}, and ${first.enteredExpiry} was entered.`,
            expiryConflicts,
          });
        }

        if (costConflicts.length > 0) {
          const first = costConflicts[0]!;
          throw new BadRequestException({
            code: "COST_CONFLICT",
            message: `Batch ${first.batchNo} of ${first.product} is already in stock at Rs ${first.existingCost} per unit, and this delivery works out at Rs ${first.incomingCost}. Choose whether to keep the old cost or update it.`,
            costConflicts,
          });
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
          arrivals.map((line) => ({
            ...line,
            movementType: StockMovementType.purchase_in,
            reason: `${locked.poNumber} / ${grnNumber}`,
          })),
        );

        // Damaged units are on the premises, so they are received — then held, in the same
        // posting, so they show as quarantined stock against this delivery instead of being
        // quietly dropped or silently sold.
        if (holds.length > 0) {
          await this.stock.quarantine(
            tx,
            {
              tenantId,
              branchId,
              userId,
              referenceId: gr.id,
              referenceType: "goods_receipt",
            },
            holds.map((hold) => ({
              productId: hold.productId,
              batchId: hold.batchId,
              qty: hold.qty,
              reasonCode: "damaged" as const,
              reason: hold.reason ?? `Damaged on delivery ${grnNumber}`,
            })),
          );
        }

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

        // Only good units close a line: a bonus was never ordered, and a rejected unit still
        // owes a replacement.
        const receivedTotals = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: locked.id },
          select: { orderedQty: true, receivedQty: true },
        });
        const allFullyReceived = receivedTotals.every((i) => i.receivedQty >= i.orderedQty);
        const anyReceived = receivedTotals.some((i) => i.receivedQty > 0);

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
            payload: {
              grnNumber,
              purchaseOrderId: locked.id,
              paidUnits: resolvedLines.reduce((sum, line) => sum + line.paidQty, 0),
              freeUnits: resolvedLines.reduce((sum, line) => sum + line.freeQty, 0),
              rejectedUnits: resolvedLines.reduce((sum, line) => sum + line.rejectedQty, 0),
              value: receiptValue.toFixed(2),
              // Who accepted more than was ordered is exactly the question an auditor asks.
              overDeliveryAccepted: overDeliveries.length > 0,
              priceRisesAccepted: priceRises.map((rise) => ({
                product: rise.product,
                orderedUnitCost: rise.orderedUnitCost,
                billedUnitCost: rise.billedUnitCost,
                variancePercent: rise.variancePercent,
              })),
              supplierPriceUpdated: !!dto.updateSupplierPrice,
              costsUpdated: resolvedLines
                .filter((line) => line.onCostConflict === "update_cost")
                .map((line) => line.batchNo),
            },
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

  /**
   * What this supplier charges, as an order form needs it: product, cost, pack. Nothing else.
   *
   * The price *list* is a commercial screen behind `suppliers.manage_prices`. A clerk raising an
   * order still needs the line to price itself correctly, and that is all this returns — the
   * same numbers the server would fall back to anyway if the line arrived with no cost.
   */
  async supplierPriceMap(tenantId: string, supplierId: string) {
    const rows = await this.prisma.supplierProductPrice.findMany({
      where: { tenantId, supplierId },
      select: {
        productId: true,
        unitCost: true,
        unitsPerPack: true,
        discountPercent: true,
      },
    });
    return rows.map((row) => ({
      productId: row.productId,
      unitCost: row.unitCost.toFixed(2),
      unitsPerPack: row.unitsPerPack,
      discountPercent: Number(row.discountPercent),
    }));
  }

  /**
   * Is this batch number already on the shelf here?
   *
   * The receiving form asks as the number is typed, so the expiry it already has can be filled
   * in for the person instead of being demanded from them and then rejected. Batch number and
   * expiry are what recalls and FEFO run on: if a number is already known, its expiry is a fact
   * the system holds, not a question.
   */
  async lookupBatch(
    tenantId: string,
    branchId: string,
    productId: string,
    batchNo: string,
    opts: { canViewCost?: boolean } = {},
  ) {
    const trimmed = batchNo.trim();
    if (!trimmed) return { exists: false as const };

    const batch = await this.prisma.batch.findUnique({
      where: {
        tenantId_branchId_productId_batchNo: { tenantId, branchId, productId, batchNo: trimmed },
      },
      include: { stock: true, supplier: { select: { id: true, name: true } } },
    });
    if (!batch) return { exists: false as const };

    return {
      exists: true as const,
      batchId: batch.id,
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate.toISOString().slice(0, 10),
      /// An imported placeholder expiry nobody has confirmed yet — the one case where a
      /// delivery may correct the date rather than adopt it.
      needsExpiryReview: batch.needsExpiryReview,
      onHand: batch.stock?.onHandQty ?? 0,
      quarantined: batch.stock?.quarantinedQty ?? 0,
      supplier: batch.supplier,
      costPrice: opts.canViewCost !== false ? batch.costPrice.toFixed(2) : null,
      sellingPrice: batch.sellingPrice.toFixed(2),
    };
  }

  /**
   * Deliveries, newest first — the Purchasing workspace's second tab.
   *
   * A delivery is the operational record people actually chase ("did the Kandy order land?"),
   * and until now it could only be reached by opening the order it belonged to.
   */
  async listGoodsReceipts(
    tenantId: string,
    branchId: string,
    filters: {
      supplierId?: string;
      from?: string;
      to?: string;
      q?: string;
      canViewCost?: boolean;
    } = {},
  ) {
    const canViewCost = filters.canViewCost !== false;
    const receivedOn: Prisma.DateTimeFilter = {};
    if (filters.from) receivedOn.gte = parseDateOnly(filters.from, "From date");
    if (filters.to) receivedOn.lte = parseDateOnly(filters.to, "To date");

    const q = filters.q?.trim();
    const rows = await this.prisma.goodsReceipt.findMany({
      where: {
        tenantId,
        branchId,
        ...(Object.keys(receivedOn).length > 0 ? { receivedOn } : {}),
        ...(filters.supplierId
          ? { purchaseOrder: { supplierId: filters.supplierId } }
          : {}),
        ...(q
          ? {
              OR: [
                { grnNumber: { contains: q, mode: "insensitive" } },
                { purchaseOrder: { poNumber: { contains: q, mode: "insensitive" } } },
                {
                  purchaseOrder: {
                    supplier: { name: { contains: q, mode: "insensitive" } },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ receivedOn: "desc" }, { createdAt: "desc" }],
      take: 200,
      include: {
        purchaseOrder: {
          select: {
            id: true,
            poNumber: true,
            status: true,
            supplier: { select: { id: true, code: true, name: true } },
          },
        },
        receiver: { select: { id: true, fullName: true } },
        items: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
            batch: { select: { id: true, batchNo: true, expiryDate: true } },
          },
        },
        supplierInvoice: { select: { id: true, invoiceNumber: true, status: true } },
      },
    });

    return rows.map((gr) => {
      const paidUnits = gr.items.reduce((sum, item) => sum + item.receivedQty, 0);
      const freeUnits = gr.items.reduce((sum, item) => sum + item.freeQty, 0);
      const rejectedUnits = gr.items.reduce((sum, item) => sum + item.rejectedQty, 0);
      const value = gr.items.reduce(
        (sum, item) =>
          sum.plus((item.unitCost ?? new Prisma.Decimal(0)).mul(item.receivedQty + item.rejectedQty)),
        new Prisma.Decimal(0),
      );
      return {
        id: gr.id,
        grnNumber: gr.grnNumber,
        supplierDeliveryNote: gr.supplierDeliveryNote,
        receivedOn: gr.receivedOn.toISOString().slice(0, 10),
        createdAt: gr.createdAt.toISOString(),
        purchaseOrder: gr.purchaseOrder,
        supplier: gr.purchaseOrder.supplier,
        receivedBy: gr.receiver,
        invoice: gr.supplierInvoice,
        lineCount: gr.items.length,
        paidUnits,
        freeUnits,
        rejectedUnits,
        value: canViewCost ? value.toFixed(2) : null,
        items: gr.items.map((item) => ({
          id: item.id,
          product: item.product,
          batch: {
            ...item.batch,
            expiryDate: item.batch.expiryDate.toISOString().slice(0, 10),
          },
          receivedQty: item.receivedQty,
          freeQty: item.freeQty,
          rejectedQty: item.rejectedQty,
          packs: item.packs,
          unitCost: canViewCost ? (item.unitCost?.toFixed(2) ?? null) : null,
          orderedUnitCost: canViewCost ? (item.orderedUnitCost?.toFixed(2) ?? null) : null,
          // What the price did between agreeing and being billed, for anyone reading the
          // delivery back later.
          variancePercent: canViewCost
            ? priceVariancePercent(item.orderedUnitCost, item.unitCost ?? new Prisma.Decimal(0))
            : null,
        })),
      };
    });
  }

  /**
   * What to order, per supplier.
   *
   * The old recommendation summed the whole ledger, so it counted quarantined and expired units
   * as stock and — worse — ignored what was already on its way, cheerfully telling a pharmacy to
   * reorder a product arriving the next morning. This reads available stock and subtracts
   * everything already ordered but not yet received.
   */
  async reorderSuggestions(
    tenantId: string,
    branchId: string,
    opts: { canViewCost?: boolean } = {},
  ) {
    const canViewCost = opts.canViewCost !== false;
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const today = businessToday(safeTimeZone(tenant?.timezone));

    const products = await this.prisma.product.findMany({
      where: { tenantId, isActive: true, rangeStatus: "RANGED" },
      select: {
        id: true,
        sku: true,
        name: true,
        reorderLevel: true,
        unitsPerPack: true,
        packLabel: true,
      },
    });
    if (products.length === 0) return { branchId, generatedAt: new Date().toISOString(), suppliers: [] };

    const totals = await this.stockRead.productTotals({
      tenantId,
      branchId,
      today,
      nearExpiryCutoff: today,
      productIds: products.map((p) => p.id),
    });

    // Units ordered and not yet received. Draft and awaiting-approval orders are counted
    // separately: they are a decision someone has made, but not stock anyone can rely on.
    const openItems = await this.prisma.purchaseOrderItem.findMany({
      where: {
        tenantId,
        purchaseOrder: {
          branchId,
          status: {
            in: [
              PoStatus.draft,
              PoStatus.pending_approval,
              PoStatus.issued,
              PoStatus.partially_received,
            ],
          },
        },
      },
      select: {
        productId: true,
        orderedQty: true,
        receivedQty: true,
        purchaseOrder: { select: { status: true, supplierId: true, expectedOn: true } },
      },
    });
    const onOrder = new Map<string, number>();
    const planned = new Map<string, number>();
    for (const item of openItems) {
      const outstanding = Math.max(item.orderedQty - item.receivedQty, 0);
      if (outstanding === 0) continue;
      const bucket =
        item.purchaseOrder.status === PoStatus.issued ||
        item.purchaseOrder.status === PoStatus.partially_received
          ? onOrder
          : planned;
      bucket.set(item.productId, (bucket.get(item.productId) ?? 0) + outstanding);
    }

    const prices = await this.prisma.supplierProductPrice.findMany({
      where: { tenantId, productId: { in: products.map((p) => p.id) } },
      include: {
        supplier: { select: { id: true, code: true, name: true, status: true, leadTimeDays: true } },
      },
    });
    const pricesByProduct = new Map<string, typeof prices>();
    for (const price of prices) {
      if (price.supplier.status !== "active") continue;
      const list = pricesByProduct.get(price.productId) ?? [];
      list.push(price);
      pricesByProduct.set(price.productId, list);
    }

    type Suggestion = {
      productId: string;
      sku: string;
      name: string;
      available: number;
      onOrderQty: number;
      plannedQty: number;
      reorderLevel: number;
      suggestedQty: number;
      suggestedPacks: number | null;
      unitsPerPack: number;
      packLabel: string | null;
      unitCost: string | null;
      supplierSku: string | null;
      reason: string;
    };
    const bySupplier = new Map<
      string,
      {
        supplier: { id: string; code: string; name: string; leadTimeDays: number };
        items: Suggestion[];
      }
    >();
    const unassigned: Suggestion[] = [];

    for (const product of products) {
      const stock = totals.get(product.id);
      const available = stock?.available ?? 0;
      const ordered = onOrder.get(product.id) ?? 0;
      const plannedQty = planned.get(product.id) ?? 0;
      const covered = available + ordered + plannedQty;
      if (product.reorderLevel <= 0 || covered > product.reorderLevel) continue;

      const target = Math.max(product.reorderLevel * 2, product.reorderLevel + 1);
      const shortfall = target - covered;
      if (shortfall <= 0) continue;

      const unitsPerPack = normalizeUnitsPerPack(product.unitsPerPack);
      const suggestedPacks = unitsPerPack > 1 ? Math.ceil(shortfall / unitsPerPack) : null;
      const suggestedQty = suggestedPacks ? suggestedPacks * unitsPerPack : shortfall;

      // Cheapest active supplier who lists it; failing that, whoever supplied it last.
      const candidates = (pricesByProduct.get(product.id) ?? []).slice().sort((a, b) => {
        const diff = Number(a.unitCost) - Number(b.unitCost);
        return diff !== 0 ? diff : a.supplier.name.localeCompare(b.supplier.name);
      });
      const chosen = candidates[0];

      const suggestion: Suggestion = {
        productId: product.id,
        sku: product.sku,
        name: product.name,
        available,
        onOrderQty: ordered,
        plannedQty,
        reorderLevel: product.reorderLevel,
        suggestedQty,
        suggestedPacks,
        unitsPerPack,
        packLabel: product.packLabel,
        unitCost: canViewCost && chosen ? chosen.unitCost.toFixed(2) : null,
        supplierSku: chosen?.supplierSku ?? null,
        reason: available <= 0 ? "out_of_stock" : "at_or_below_reorder_level",
      };

      if (!chosen) {
        unassigned.push(suggestion);
        continue;
      }
      const entry = bySupplier.get(chosen.supplierId) ?? {
        supplier: {
          id: chosen.supplier.id,
          code: chosen.supplier.code,
          name: chosen.supplier.name,
          leadTimeDays: chosen.supplier.leadTimeDays,
        },
        items: [],
      };
      entry.items.push(suggestion);
      bySupplier.set(chosen.supplierId, entry);
    }

    const suppliers = [...bySupplier.values()]
      .map((entry) => ({
        ...entry,
        items: entry.items.sort((a, b) => a.available - b.available),
        estimatedValue: canViewCost
          ? entry.items
              .reduce(
                (sum, item) => sum.plus(new Prisma.Decimal(item.unitCost ?? 0).mul(item.suggestedQty)),
                new Prisma.Decimal(0),
              )
              .toFixed(2)
          : null,
      }))
      .sort((a, b) => b.items.length - a.items.length);

    return {
      branchId,
      generatedAt: new Date().toISOString(),
      suppliers,
      // Products nobody has a price for still need ordering; they just can't be grouped.
      unassigned: unassigned.sort((a, b) => a.available - b.available),
    };
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
