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
  StockMovementType,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { meetsApprovalThreshold } from "../common/approval-threshold.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { StockService } from "../inventory/stock/stock.service";
import { raiseDebitNoteForReturn } from "../purchasing/ledger/supplier-ledger.service";
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import { assertSaleReturnableLines } from "../sales/sale-returnable";
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
  // A completed supplier return's claim on the supplier, so the return shows what it is owed.
  debitNote: {
    select: { id: true, debitNo: true, amount: true, appliedAmount: true, status: true },
  },
} as const;

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  /**
   * May this person's submission count as its own approval? Only if they hold
   * `returns.approve` and their role is allowed to approve its own requests.
   */
  private approvesOwn(access: ActorAccess): boolean {
    return access.has("returns.approve") && access.canSelfApprove;
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

  /**
   * Is this return above the tenant's configured approval ceiling?
   *
   * Scoped to customer returns because that is exactly what the setting says it
   * covers ("Customer returns over a threshold — requires manager approval
   * before a refund is issued"); supplier returns move stock back to a vendor
   * rather than money to a customer, and are governed by the supplier workflow.
   */
  private async requiresThresholdApproval(
    tenantId: string,
    type: GoodsReturnType,
    amount: Prisma.Decimal,
  ): Promise<boolean> {
    if (type !== GoodsReturnType.customer) return false;
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredReturnThreshold: true },
    });
    return meetsApprovalThreshold(
      amount,
      settings?.approvalRequiredReturnThreshold,
    );
  }

  private resolveCreateStatus(
    access: ActorAccess,
    submit: boolean | undefined,
    userId: string,
    /** Above the tenant ceiling the manager auto-approve path is closed off —
     *  that shortcut is the whole thing the threshold exists to interrupt. */
    forceApproval = false,
  ): { status: GoodsReturnStatus; approvedBy: string | null; autoApproved: boolean } {
    if (forceApproval) {
      return {
        status: submit
          ? GoodsReturnStatus.pending_approval
          : GoodsReturnStatus.draft,
        approvedBy: null,
        autoApproved: false,
      };
    }
    if (this.approvesOwn(access)) {
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
    await assertSaleReturnableLines(
      this.prisma,
      tenantId,
      branchId,
      saleId,
      items.map((i) => ({
        productId: i.productId,
        batchId: i.batchId!,
        qty: i.qty,
      })),
      excludeReturnId,
    );
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
    access: ActorAccess,
    dto: CreateReturnDto,
  ) {
    const userId = access.userId;
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
    const forceApproval = await this.requiresThresholdApproval(
      tenantId,
      dto.type,
      amount,
    );
    const resolved = this.resolveCreateStatus(
      access,
      dto.submit,
      userId,
      forceApproval,
    );
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
        where: { id, tenantId, branchId },
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
    access: ActorAccess,
    id: string,
  ) {
    const userId = access.userId;
    const existing = await this.getOne(tenantId, branchId, id);
    if (existing.status !== GoodsReturnStatus.draft) {
      throw new BadRequestException("Only draft returns can be submitted");
    }

    // Same ceiling as create — otherwise saving a large return as a draft and
    // submitting it afterwards would be a way around the threshold.
    const forceApproval = await this.requiresThresholdApproval(
      tenantId,
      existing.type,
      existing.amount,
    );
    const isMgr = !forceApproval && this.approvesOwn(access);
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
    access: ActorAccess,
    id: string,
  ) {
    const userId = access.userId;
    const existing = await this.getOne(tenantId, branchId, id);
    assertMayApprove(access, [existing.requestedBy], "return");

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
  ) {

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
    access: ActorAccess,
    id: string,
  ) {
    const userId = access.userId;
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
      payload: { roles: access.roleKeys },
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

        if (row.saleId && row.type === GoodsReturnType.customer) {
          await assertSaleReturnableLines(
            tx,
            tenantId,
            branchId,
            row.saleId,
            row.items.map((i) => ({
              productId: i.productId,
              batchId: i.batchId!,
              qty: i.qty,
            })),
            row.id,
          );
        }

        for (const line of row.items) {
          if (!line.batchId) {
            throw new BadRequestException("batchId is required on all items to complete a return");
          }
        }
        const stockCtx = {
          tenantId,
          branchId,
          userId,
          referenceType: "goods_return",
          referenceId: row.id,
        };
        if (row.type === GoodsReturnType.supplier) {
          // Stock going back to a supplier is usually the stock already held back — expired,
          // damaged, recalled — so quarantined units are sent before sellable ones.
          await this.stock.issue(
            tx,
            stockCtx,
            row.items.map((line) => ({
              productId: line.productId,
              batchId: line.batchId!,
              qty: line.qty,
              movementType: StockMovementType.supplier_return_out,
              from: "quarantine_first" as const,
            })),
          );

          // The goods have gone back, so the money for them is owed back too. Raised here, in
          // the same transaction, so a completed supplier return can never exist without its
          // claim — it used to reduce the shelf and leave the supplier's bill untouched.
          if (row.supplierId) {
            const batches = await tx.batch.findMany({
              where: { tenantId, id: { in: row.items.map((line) => line.batchId!) } },
              select: { id: true, costPrice: true },
            });
            const costByBatch = new Map(batches.map((batch) => [batch.id, batch.costPrice]));
            await raiseDebitNoteForReturn(tx, {
              tenantId,
              branchId,
              userId,
              goodsReturnId: row.id,
              supplierId: row.supplierId,
              reason: row.reason,
              lines: row.items.map((line) => ({
                qty: line.qty,
                unitPrice: line.unitPrice,
                batchCost: costByBatch.get(line.batchId!) ?? null,
              })),
            });
          }
        } else {
          await this.stock.receive(
            tx,
            stockCtx,
            row.items.map((line) => ({
              productId: line.productId,
              batchId: line.batchId!,
              qty: line.qty,
              movementType: StockMovementType.customer_return_in,
            })),
          );
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
    access: ActorAccess,
    id: string,
  ) {
    const userId = access.userId;
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
    if (!isRequester && !access.has("returns.approve")) {
      throw new ForbiddenException(
        "Only the person who raised this return, or an approver, can cancel it",
      );
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
