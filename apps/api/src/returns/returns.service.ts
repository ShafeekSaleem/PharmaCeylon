import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  GoodsReturnStatus,
  GoodsReturnType,
  Prisma,
  RoleName,
  StockMovementType,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { CreateReturnDto, ReturnLineDto } from "./dto/create-return.dto";
import { UpdateReturnDto } from "./dto/update-return.dto";

const LIST_INCLUDE = {
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true } },
      batch: { select: { id: true, batchNo: true } },
    },
  },
  supplier: { select: { id: true, code: true, name: true } },
  sale: { select: { id: true, invoiceNo: true } },
  purchaseOrder: { select: { id: true, poNumber: true } },
  goodsReceipt: { select: { id: true, grnNumber: true } },
  requester: { select: { id: true, fullName: true } },
  approver: { select: { id: true, fullName: true } },
  processor: { select: { id: true, fullName: true } },
  branch: { select: { id: true, code: true, name: true } },
} as const;

const OPEN_RETURN_STATUSES: GoodsReturnStatus[] = [
  GoodsReturnStatus.draft,
  GoodsReturnStatus.pending_approval,
  GoodsReturnStatus.awaiting_logistics,
  GoodsReturnStatus.in_review,
];

function lineKey(productId: string, batchId: string | null | undefined): string {
  return `${productId}:${batchId ?? ""}`;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private isOwnerOrManager(roles: RoleName[]): boolean {
    return roles.includes(RoleName.owner) || roles.includes(RoleName.manager);
  }

  private async nextReturnNumber(tenantId: string, branchId: string): Promise<string> {
    const year = new Date().getFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));
    try {
      const n = await this.prisma.goodsReturn.count({
        where: {
          tenantId,
          branchId,
          createdAt: { gte: yearStart, lt: yearEnd },
        },
      });
      return `RET-${year}-${String(n + 1).padStart(5, "0")}`;
    } catch {
      return `RET-${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
    }
  }

  private validateTypeFields(
    type: GoodsReturnType | "customer" | "supplier",
    fields: { customerName?: string | null; saleId?: string | null; supplierId?: string | null },
  ) {
    if (type === GoodsReturnType.customer) {
      if (!fields.customerName?.trim() && !fields.saleId) {
        throw new BadRequestException("Customer returns require customerName or saleId");
      }
    } else if (!fields.supplierId) {
      throw new BadRequestException("Supplier returns require supplierId");
    }
  }

  private async validateBatches(
    tenantId: string,
    branchId: string,
    items: ReturnLineDto[],
  ) {
    for (const line of items) {
      if (!line.batchId) {
        throw new BadRequestException("batchId is required on all return lines");
      }
      const batch = await this.prisma.batch.findFirst({
        where: {
          id: line.batchId,
          tenantId,
          branchId,
          productId: line.productId,
        },
      });
      if (!batch) {
        throw new BadRequestException("Invalid batch on return line for this branch");
      }
    }
  }

  private lineAmount(items: ReturnLineDto[]): Prisma.Decimal {
    return items.reduce((sum, line) => {
      const unit = new Prisma.Decimal(line.unitPrice ?? 0);
      return sum.add(unit.mul(line.qty));
    }, new Prisma.Decimal(0));
  }

  private resolveCreateStatus(
    rolesAtBranch: RoleName[],
    submit: boolean | undefined,
    userId: string,
  ): { status: GoodsReturnStatus; approvedBy: string | null; autoApproved: boolean } {
    const isMgr = this.isOwnerOrManager(rolesAtBranch);
    if (isMgr) {
      if (submit === true) {
        return {
          status: GoodsReturnStatus.awaiting_logistics,
          approvedBy: userId,
          autoApproved: true,
        };
      }
      return {
        status: GoodsReturnStatus.draft,
        approvedBy: null,
        autoApproved: false,
      };
    }
    if (submit) {
      return {
        status: GoodsReturnStatus.pending_approval,
        approvedBy: null,
        autoApproved: false,
      };
    }
    return {
      status: GoodsReturnStatus.draft,
      approvedBy: null,
      autoApproved: false,
    };
  }

  /**
   * Cap customer return lines against remaining sale qty:
   * sold − completed GoodsReturns − sale_refund_in − open GoodsReturns − inventory customer_return_in (sale: tagged).
   */
  private async assertSaleLineCaps(
    tenantId: string,
    branchId: string,
    saleId: string,
    items: ReturnLineDto[],
    excludeReturnId?: string,
  ) {
    const sale = await this.prisma.sale.findFirst({
      where: { id: saleId, tenantId, branchId },
      include: { items: true },
    });
    if (!sale) throw new BadRequestException("Sale not found for this branch");

    const soldByKey = new Map<string, number>();
    for (const si of sale.items) {
      const key = lineKey(si.productId, si.batchId);
      soldByKey.set(key, (soldByKey.get(key) ?? 0) + si.qty);
    }

    const usedByKey = new Map<string, number>();
    const addUsed = (productId: string, batchId: string | null | undefined, qty: number) => {
      const key = lineKey(productId, batchId);
      usedByKey.set(key, (usedByKey.get(key) ?? 0) + qty);
    };

    const completedReturns = await this.prisma.goodsReturn.findMany({
      where: {
        tenantId,
        branchId,
        saleId,
        status: GoodsReturnStatus.completed,
        ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
      },
      include: { items: true },
    });
    for (const gr of completedReturns) {
      for (const item of gr.items) {
        addUsed(item.productId, item.batchId, item.qty);
      }
    }

    const openReturns = await this.prisma.goodsReturn.findMany({
      where: {
        tenantId,
        branchId,
        saleId,
        status: { in: OPEN_RETURN_STATUSES },
        ...(excludeReturnId ? { id: { not: excludeReturnId } } : {}),
      },
      include: { items: true },
    });
    for (const gr of openReturns) {
      for (const item of gr.items) {
        addUsed(item.productId, item.batchId, item.qty);
      }
    }

    const refundLedger = await this.prisma.stockLedger.groupBy({
      by: ["productId", "batchId"],
      where: {
        tenantId,
        branchId,
        movementType: StockMovementType.sale_refund_in,
        referenceId: saleId,
      },
      _sum: { qtyDelta: true },
    });
    for (const row of refundLedger) {
      addUsed(row.productId, row.batchId, row._sum.qtyDelta ?? 0);
    }

    // Legacy inventory customer-returns tagged reason sale:{saleId} (not goods_return ledger rows).
    const inventoryTagged = await this.prisma.stockLedger.groupBy({
      by: ["productId", "batchId"],
      where: {
        tenantId,
        branchId,
        movementType: StockMovementType.customer_return_in,
        referenceType: { not: "goods_return" },
        OR: [
          { reason: `sale:${saleId}` },
          { reason: { startsWith: `sale:${saleId}` } },
        ],
      },
      _sum: { qtyDelta: true },
    });
    for (const row of inventoryTagged) {
      addUsed(row.productId, row.batchId, row._sum.qtyDelta ?? 0);
    }

    const requestedByKey = new Map<string, number>();
    for (const line of items) {
      const key = lineKey(line.productId, line.batchId);
      if (!soldByKey.has(key)) {
        throw new BadRequestException(
          "Return line product/batch must match a line on the referenced sale",
        );
      }
      requestedByKey.set(key, (requestedByKey.get(key) ?? 0) + line.qty);
    }

    for (const [key, requested] of requestedByKey) {
      const sold = soldByKey.get(key) ?? 0;
      const used = usedByKey.get(key) ?? 0;
      const remaining = sold - used;
      if (requested > remaining) {
        throw new BadRequestException(
          remaining <= 0
            ? "This sale line has already been fully returned"
            : `Only ${remaining} unit(s) remain returnable on this sale line`,
        );
      }
    }
  }

  private async validateSupplierPoGrn(
    tenantId: string,
    branchId: string,
    supplierId: string | null | undefined,
    purchaseOrderId: string | null | undefined,
    goodsReceiptId: string | null | undefined,
  ): Promise<{ purchaseOrderId: string | null; goodsReceiptId: string | null }> {
    if (!purchaseOrderId && !goodsReceiptId) {
      return { purchaseOrderId: null, goodsReceiptId: null };
    }

    if (goodsReceiptId && !purchaseOrderId) {
      throw new BadRequestException("goodsReceiptId requires purchaseOrderId");
    }

    if (!purchaseOrderId) {
      return { purchaseOrderId: null, goodsReceiptId: null };
    }

    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, tenantId, branchId },
    });
    if (!po) {
      throw new BadRequestException("Purchase order not found for this branch");
    }
    if (supplierId && po.supplierId !== supplierId) {
      throw new BadRequestException("Purchase order supplier does not match return supplier");
    }

    if (goodsReceiptId) {
      const grn = await this.prisma.goodsReceipt.findFirst({
        where: {
          id: goodsReceiptId,
          tenantId,
          purchaseOrderId,
        },
      });
      if (!grn) {
        throw new BadRequestException("Goods receipt not found for this purchase order");
      }
    }

    return {
      purchaseOrderId,
      goodsReceiptId: goodsReceiptId ?? null,
    };
  }

  private createData(
    tenantId: string,
    branchId: string,
    userId: string,
    returnNumber: string,
    dto: CreateReturnDto,
    status: GoodsReturnStatus,
    approvedBy: string | null,
    amount: Prisma.Decimal,
    purchaseOrderId: string | null,
    goodsReceiptId: string | null,
  ) {
    return {
      tenantId,
      branchId,
      returnNumber,
      type: dto.type as GoodsReturnType,
      status,
      customerName: dto.customerName?.trim() || null,
      saleId: dto.saleId ?? null,
      supplierId: dto.supplierId ?? null,
      purchaseOrderId,
      goodsReceiptId,
      reason: dto.reason?.trim() || null,
      notes: dto.notes?.trim() || null,
      amount,
      requestedBy: userId,
      approvedBy,
      items: {
        create: dto.items.map((line) => ({
          tenantId,
          productId: line.productId,
          batchId: line.batchId,
          qty: line.qty,
          unitPrice: new Prisma.Decimal(line.unitPrice ?? 0),
        })),
      },
    };
  }

  async list(tenantId: string, branchId: string) {
    return this.prisma.goodsReturn.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: "desc" },
      include: LIST_INCLUDE,
    });
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.goodsReturn.findFirst({
      where: { id, tenantId, branchId },
      include: LIST_INCLUDE,
    });
    if (!row) throw new NotFoundException("Return not found");
    return row;
  }

  async create(
    tenantId: string,
    branchId: string,
    userId: string,
    rolesAtBranch: RoleName[],
    dto: CreateReturnDto,
  ) {
    this.validateTypeFields(dto.type, dto);
    await this.validateBatches(tenantId, branchId, dto.items);

    if (dto.saleId) {
      const sale = await this.prisma.sale.findFirst({
        where: { id: dto.saleId, tenantId, branchId },
      });
      if (!sale) throw new BadRequestException("Sale not found for this branch");
      await this.assertSaleLineCaps(tenantId, branchId, dto.saleId, dto.items);
    }
    if (dto.supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: dto.supplierId, tenantId, status: "active" },
      });
      if (!supplier) throw new NotFoundException("Supplier not found");
    }

    const poGrn =
      dto.type === "supplier"
        ? await this.validateSupplierPoGrn(
            tenantId,
            branchId,
            dto.supplierId,
            dto.purchaseOrderId,
            dto.goodsReceiptId,
          )
        : { purchaseOrderId: null, goodsReceiptId: null };

    const amount = this.lineAmount(dto.items);
    const resolved = this.resolveCreateStatus(rolesAtBranch, dto.submit, userId);
    const { status, approvedBy } = resolved;
    const returnNumber = await this.nextReturnNumber(tenantId, branchId);

    let created;
    try {
      created = await this.prisma.goodsReturn.create({
        data: this.createData(
          tenantId,
          branchId,
          userId,
          returnNumber,
          dto,
          status,
          approvedBy,
          amount,
          poGrn.purchaseOrderId,
          poGrn.goodsReceiptId,
        ),
        include: LIST_INCLUDE,
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        const fallback = `RET-${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`;
        created = await this.prisma.goodsReturn.create({
          data: this.createData(
            tenantId,
            branchId,
            userId,
            fallback,
            dto,
            status,
            approvedBy,
            amount,
            poGrn.purchaseOrderId,
            poGrn.goodsReceiptId,
          ),
          include: LIST_INCLUDE,
        });
      } else {
        throw e;
      }
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: resolved.autoApproved ? "return.created_and_approved" : "return.created",
      entityName: "goods_return",
      entityId: created.id,
      payload: { status, returnNumber: created.returnNumber, autoApproved: resolved.autoApproved },
    });

    return created;
  }

  async update(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpdateReturnDto,
  ) {
    const existing = await this.getOne(tenantId, branchId, id);
    if (existing.status !== GoodsReturnStatus.draft) {
      throw new BadRequestException("Only draft returns can be updated");
    }

    const type = (dto.type ?? existing.type) as GoodsReturnType;
    const customerName =
      dto.customerName !== undefined ? dto.customerName : existing.customerName;
    const saleId = dto.saleId !== undefined ? dto.saleId : existing.saleId;
    const supplierId =
      dto.supplierId !== undefined ? dto.supplierId : existing.supplierId;
    const purchaseOrderId =
      dto.purchaseOrderId !== undefined
        ? dto.purchaseOrderId
        : existing.purchaseOrderId;
    const goodsReceiptId =
      dto.goodsReceiptId !== undefined
        ? dto.goodsReceiptId
        : existing.goodsReceiptId;

    this.validateTypeFields(type, { customerName, saleId, supplierId });

    if (dto.items) {
      await this.validateBatches(tenantId, branchId, dto.items);
    }
    if (saleId) {
      const sale = await this.prisma.sale.findFirst({
        where: { id: saleId, tenantId, branchId },
      });
      if (!sale) throw new BadRequestException("Sale not found for this branch");
      if (dto.items) {
        await this.assertSaleLineCaps(tenantId, branchId, saleId, dto.items, id);
      }
    }
    if (supplierId) {
      const supplier = await this.prisma.supplier.findFirst({
        where: { id: supplierId, tenantId, status: "active" },
      });
      if (!supplier) throw new NotFoundException("Supplier not found");
    }

    const poGrn =
      type === GoodsReturnType.supplier
        ? await this.validateSupplierPoGrn(
            tenantId,
            branchId,
            supplierId,
            purchaseOrderId,
            goodsReceiptId,
          )
        : { purchaseOrderId: null, goodsReceiptId: null };

    const amount = dto.items ? this.lineAmount(dto.items) : existing.amount;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        await tx.goodsReturnItem.deleteMany({ where: { returnId: id, tenantId } });
        await tx.goodsReturnItem.createMany({
          data: dto.items.map((line) => ({
            tenantId,
            returnId: id,
            productId: line.productId,
            batchId: line.batchId,
            qty: line.qty,
            unitPrice: new Prisma.Decimal(line.unitPrice ?? 0),
          })),
        });
      }

      return tx.goodsReturn.update({
        where: { id },
        data: {
          type,
          customerName: customerName?.trim() || null,
          saleId: saleId ?? null,
          supplierId: supplierId ?? null,
          purchaseOrderId: poGrn.purchaseOrderId,
          goodsReceiptId: poGrn.goodsReceiptId,
          reason:
            dto.reason !== undefined ? dto.reason?.trim() || null : undefined,
          notes: dto.notes !== undefined ? dto.notes?.trim() || null : undefined,
          amount,
        },
        include: LIST_INCLUDE,
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.updated",
      entityName: "goods_return",
      entityId: id,
    });

    return updated;
  }

  async submit(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    rolesAtBranch: RoleName[],
  ) {
    const existing = await this.getOne(tenantId, branchId, id);
    if (existing.status !== GoodsReturnStatus.draft) {
      throw new BadRequestException("Only draft returns can be submitted");
    }

    const isMgr = this.isOwnerOrManager(rolesAtBranch);
    const nextStatus = isMgr
      ? GoodsReturnStatus.awaiting_logistics
      : GoodsReturnStatus.pending_approval;

    const claimed = await this.prisma.goodsReturn.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: GoodsReturnStatus.draft,
      },
      data: {
        status: nextStatus,
        approvedBy: isMgr ? userId : null,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Return can no longer be submitted");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: isMgr ? "return.submitted_and_approved" : "return.submitted",
      entityName: "goods_return",
      entityId: id,
      payload: { status: nextStatus },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async approve(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    rolesAtBranch: RoleName[],
  ) {
    if (!this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to approve return");
    }

    const claimed = await this.prisma.goodsReturn.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: GoodsReturnStatus.pending_approval,
      },
      data: {
        status: GoodsReturnStatus.awaiting_logistics,
        approvedBy: userId,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Return is not awaiting approval at this branch");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.approved",
      entityName: "goods_return",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }

  async reject(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    rolesAtBranch: RoleName[],
  ) {
    if (!this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to reject return");
    }

    const claimed = await this.prisma.goodsReturn.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: GoodsReturnStatus.pending_approval,
      },
      data: {
        status: GoodsReturnStatus.rejected,
        approvedBy: userId,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Only pending returns can be rejected");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.rejected",
      entityName: "goods_return",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }

  async markLogistics(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    rolesAtBranch: RoleName[],
  ) {
    const claimed = await this.prisma.goodsReturn.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: GoodsReturnStatus.awaiting_logistics,
      },
      data: {
        status: GoodsReturnStatus.in_review,
        processedBy: userId,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Return is not awaiting logistics at this branch");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.mark_logistics",
      entityName: "goods_return",
      entityId: id,
      payload: { roles: rolesAtBranch },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async complete(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    idempotencyKeyRaw?: string,
  ) {
    const existing = await this.prisma.goodsReturn.findFirst({
      where: { id, tenantId, branchId },
    });
    if (!existing) throw new NotFoundException("Return not found");
    if (existing.status === GoodsReturnStatus.completed) {
      return this.getOne(tenantId, branchId, id);
    }

    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const row = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.returnComplete,
            idempotencyKey: idemKey,
          },
        },
      });
      if (row) {
        if (row.resourceId !== id) {
          throw new BadRequestException(
            "Idempotency-Key already used for a different return",
          );
        }
        return this.getOne(tenantId, branchId, id);
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.goodsReturn.updateMany({
          where: {
            id,
            tenantId,
            branchId,
            status: {
              in: [GoodsReturnStatus.in_review, GoodsReturnStatus.awaiting_logistics],
            },
          },
          data: {
            status: GoodsReturnStatus.completed,
            processedBy: userId,
          },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException(
            "Return must be in review or awaiting logistics to complete",
          );
        }

        const row = await tx.goodsReturn.findFirst({
          where: { id, tenantId, branchId },
          include: { items: true },
        });
        if (!row) throw new NotFoundException("Return not found");

        for (const line of row.items) {
          if (!line.batchId) {
            throw new BadRequestException("batchId is required on all items to complete a return");
          }

          if (row.type === GoodsReturnType.supplier) {
            const agg = await tx.stockLedger.aggregate({
              where: { tenantId, branchId, batchId: line.batchId },
              _sum: { qtyDelta: true },
            });
            const available = agg._sum.qtyDelta ?? 0;
            if (available < line.qty) {
              throw new BadRequestException(
                `Insufficient stock for supplier return line (need ${line.qty}, have ${available})`,
              );
            }

            await tx.stockLedger.create({
              data: {
                tenantId,
                branchId,
                productId: line.productId,
                batchId: line.batchId,
                movementType: StockMovementType.supplier_return_out,
                qtyDelta: -line.qty,
                referenceType: "goods_return",
                referenceId: row.id,
                createdBy: userId,
              },
            });
          } else {
            await tx.stockLedger.create({
              data: {
                tenantId,
                branchId,
                productId: line.productId,
                batchId: line.batchId,
                movementType: StockMovementType.customer_return_in,
                qtyDelta: line.qty,
                referenceType: "goods_return",
                referenceId: row.id,
                createdBy: userId,
              },
            });
          }
        }

        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.returnComplete,
              idempotencyKey: idemKey,
              resourceId: row.id,
            },
          });
        }
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, branchId, id);
      }
      throw e;
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.completed",
      entityName: "goods_return",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }

  async cancel(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    rolesAtBranch: RoleName[],
  ) {
    const existing = await this.getOne(tenantId, branchId, id);
    if (
      existing.status !== GoodsReturnStatus.draft &&
      existing.status !== GoodsReturnStatus.pending_approval
    ) {
      throw new BadRequestException(
        "Only draft or pending approval returns can be cancelled",
      );
    }

    const isRequester = existing.requestedBy === userId;
    if (!isRequester && !this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to cancel return");
    }

    const claimed = await this.prisma.goodsReturn.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: {
          in: [GoodsReturnStatus.draft, GoodsReturnStatus.pending_approval],
        },
      },
      data: { status: GoodsReturnStatus.cancelled },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Return can no longer be cancelled");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "return.cancelled",
      entityName: "goods_return",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }
}
