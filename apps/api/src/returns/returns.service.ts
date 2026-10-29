import {
  BadRequestException,
  ConflictException,
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
import { AccessService, type ActorAccess } from "../security/access.service";
import type { ApproveHeldDto, PostHeldDto } from "../security/dto/approve-held.dto";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import { documentReview, goodsReturnMaterial } from "../security/receiving-approval-material";
import type { CommandProvenance } from "../terminals/command-provenance";
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

type Tx = Prisma.TransactionClient;
type ReturnRow = Prisma.GoodsReturnGetPayload<{ include: typeof LIST_INCLUDE }>;
const COMPLETE = "goods_return.complete" as const;
/** Statuses a supplier return can still be (re)approved in; dispatch needs the latter two. */
const APPROVABLE: GoodsReturnStatus[] = [
  GoodsReturnStatus.pending_approval,
  GoodsReturnStatus.awaiting_logistics,
  GoodsReturnStatus.in_review,
];

/**
 * Supplier returns under D10: preparing, reviewing and approving happen anywhere; sending the
 * goods back is physical. Approval records exact evidence of the return as it stood (lines,
 * batches, quantities, prices) and moves nothing. Completion is the counter's step: it is
 * pinned to the approval the operator saw, rechecks it after the stock locks, issues the stock
 * through StockService and raises the supplier debit note in the same transaction.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
  ) {}

  /** The latest exact approval per return. A newer one replaces it; revocation keeps the row. */
  private async latestApprovals(db: Tx | PrismaService, tenantId: string, branchId: string, ids: string[]) {
    const rows = ids.length
      ? await db.managementApproval.findMany({
          where: { tenantId, branchId, documentType: "goods_return", authorizedAction: COMPLETE, documentId: { in: ids } },
          orderBy: [{ approvedAt: "desc" }, { id: "desc" }],
          select: { id: true, documentId: true, revokedAt: true, documentVersion: true, documentDigest: true,
            approvedByUserId: true, approvedAt: true },
        })
      : [];
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.documentId)) latest.set(row.documentId, row);
    return latest;
  }

  /** What the screens need to tell approval apart from dispatch. */
  private async withApproval(tenantId: string, branchId: string, rows: ReturnRow[]) {
    const latest = await this.latestApprovals(this.prisma, tenantId, branchId, rows.map((row) => row.id));
    return rows.map((row) => {
      const reviewable = row.type === GoodsReturnType.supplier && APPROVABLE.includes(row.status);
      const review = reviewable ? documentReview("goods_return", row.approvalVersion, goodsReturnMaterial(row)) : null;
      const approval = latest.get(row.id);
      const usable = !!approval && !approval.revokedAt && !!review
        && approval.documentVersion === review.expectedVersion && approval.documentDigest === review.expectedDigest;
      return {
        ...row,
        approvalReview: review,
        // Dispatch posts against exactly this approval; null means approve (again) first.
        executionApprovalId: usable || row.status === GoodsReturnStatus.completed ? (approval?.id ?? null) : null,
        approvalApprovedBy: approval?.approvedByUserId ?? null,
        approvalApprovedAt: approval?.approvedAt.toISOString() ?? null,
      };
    });
  }

  /** An approver who may approve their own returns submits and approves in one step. */
  private async approveOwn(tx: Tx, user: RequestUser, branchId: string, id: string) {
    const doc = await this.approvals.preview(tx, user, branchId, COMPLETE, id);
    return this.approvals.issue(tx, user, branchId, COMPLETE, id, {
      approvalId: randomUUID(),
      expectedVersion: doc.identity.documentVersion,
      expectedDigest: doc.identity.documentDigest,
      reason: "Submitted and approved by an approver who may approve their own returns",
      expiresAt: null,
    });
  }

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

  /**
   * What a delivery can still send back, batch by batch: what it brought in (paid, free and
   * damaged), less what returns against it have already taken, and never more than the batch
   * still holds. A supplier return raised from a delivery starts from this instead of being typed
   * from scratch, and is capped by it.
   */
  async goodsReceiptReturnable(
    tenantId: string,
    branchId: string,
    goodsReceiptId: string,
    opts: { canViewCost: boolean; excludeReturnId?: string },
  ) {
    const grn = await this.prisma.goodsReceipt.findFirst({
      where: { id: goodsReceiptId, tenantId, branchId },
      include: {
        purchaseOrder: {
          select: { id: true, poNumber: true, supplier: { select: { id: true, name: true } } },
        },
        items: {
          include: {
            product: { select: { id: true, sku: true, name: true } },
            batch: { select: { id: true, batchNo: true, expiryDate: true, costPrice: true } },
          },
        },
      },
    });
    if (!grn) throw new NotFoundException("Delivery not found for this branch");

    const returned = await this.prisma.goodsReturnItem.groupBy({
      by: ["batchId"],
      where: {
        tenantId,
        goodsReturn: {
          goodsReceiptId,
          type: GoodsReturnType.supplier,
          status: { notIn: [GoodsReturnStatus.cancelled, GoodsReturnStatus.rejected] },
          ...(opts.excludeReturnId ? { id: { not: opts.excludeReturnId } } : {}),
        },
      },
      _sum: { qty: true },
    });
    const returnedByBatch = new Map(returned.map((row) => [row.batchId, row._sum.qty ?? 0]));
    const balances = await this.prisma.$transaction((tx) =>
      this.stock.balances(tx, tenantId, grn.items.map((item) => item.batchId)),
    );

    return {
      goodsReceipt: { id: grn.id, grnNumber: grn.grnNumber, receivedOn: grn.receivedOn.toISOString() },
      purchaseOrder: { id: grn.purchaseOrder.id, poNumber: grn.purchaseOrder.poNumber },
      supplier: grn.purchaseOrder.supplier,
      lines: grn.items.map((item) => {
        const delivered = item.receivedQty + item.freeQty + item.rejectedQty;
        const alreadyReturned = returnedByBatch.get(item.batchId) ?? 0;
        const balance = balances.get(item.batchId);
        const onHand = balance?.onHand ?? 0;
        const cost = item.unitCost ?? item.batch.costPrice;
        return {
          productId: item.productId,
          product: item.product,
          batchId: item.batchId,
          batchNo: item.batch.batchNo,
          expiryDate: item.batch.expiryDate.toISOString(),
          delivered,
          damaged: item.rejectedQty,
          alreadyReturned,
          onHand,
          quarantined: balance?.quarantined ?? 0,
          returnable: Math.max(0, Math.min(delivered - alreadyReturned, onHand)),
          unitCost: opts.canViewCost && cost != null ? cost.toFixed(2) : null,
        };
      }),
    };
  }

  /** A supplier return tied to a delivery may only send back what that delivery brought in. */
  private async assertWithinDelivery(
    tenantId: string,
    branchId: string,
    goodsReceiptId: string,
    lines: ReadonlyArray<{ productId: string; batchId?: string | null; qty: number }>,
    excludeReturnId?: string,
  ) {
    const delivery = await this.goodsReceiptReturnable(tenantId, branchId, goodsReceiptId, {
      canViewCost: false,
      excludeReturnId,
    });
    const byBatch = new Map(delivery.lines.map((line) => [line.batchId, line]));
    for (const line of lines) {
      const source = line.batchId ? byBatch.get(line.batchId) : undefined;
      if (!source) {
        throw new BadRequestException(
          `That batch didn't arrive on ${delivery.goodsReceipt.grnNumber}. Choose a batch from the delivery, or leave the delivery blank.`,
        );
      }
      const left = source.delivered - source.alreadyReturned;
      if (line.qty > left) {
        throw new BadRequestException(
          `${source.product.name} batch ${source.batchNo}: ${delivery.goodsReceipt.grnNumber} brought in ${source.delivered}` +
            (source.alreadyReturned ? ` and ${source.alreadyReturned} have already gone back` : "") +
            `, so at most ${left} can be returned against it.`,
        );
      }
    }
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
    const rows = await this.prisma.goodsReturn.findMany({
      where: { tenantId, branchId },
      orderBy: { createdAt: "desc" },
      include: LIST_INCLUDE,
    });
    return this.withApproval(tenantId, branchId, rows);
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.goodsReturn.findFirst({
      where: { id, tenantId, branchId },
      include: LIST_INCLUDE,
    });
    if (!row) throw new NotFoundException("Return not found");
    return (await this.withApproval(tenantId, branchId, [row]))[0]!;
  }

  async create(
    user: RequestUser,
    branchId: string,
    access: ActorAccess,
    dto: CreateReturnDto,
  ) {
    const tenantId = user.tenantId;
    const userId = access.userId;
    // One door for a customer return: the till, where the money is refunded with it. Raised here
    // it put stock back and recorded no refund at all.
    if (dto.type === GoodsReturnType.customer) {
      throw new BadRequestException("Customer returns are refunds at the till now: refund the sale from POS → Returns, where you choose whether each item goes back on the shelf or is held for inspection.");
    }
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
    if (poGrn.goodsReceiptId) {
      await this.assertWithinDelivery(tenantId, branchId, poGrn.goodsReceiptId, dto.items);
    }

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

    // Created, approved (by an approver who may approve their own) and audited together.
    const attempt = (number: string) =>
      this.prisma.$transaction(async (tx) => {
        const created = await tx.goodsReturn.create({
          data: this.createData(
            tenantId,
            branchId,
            userId,
            number,
            dto,
            status,
            approvedBy,
            amount,
            poGrn.purchaseOrderId,
            poGrn.goodsReceiptId,
          ),
        });
        const evidence = resolved.autoApproved ? await this.approveOwn(tx, user, branchId, created.id) : null;
        await this.audit.log(
          {
            tenantId,
            branchId,
            actorUserId: userId,
            eventName: resolved.autoApproved ? "return.created_and_approved" : "return.created",
            entityName: "goods_return",
            entityId: created.id,
            payload: {
              status,
              returnNumber: created.returnNumber,
              autoApproved: resolved.autoApproved,
              approvalId: evidence?.approvalId ?? null,
              stockPosted: false,
            },
          },
          tx,
        );
        return created;
      });

    let created;
    try {
      created = await attempt(returnNumber);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002"
      ) {
        created = await attempt(`RET-${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`);
      } else {
        throw e;
      }
    }

    return this.getOne(tenantId, branchId, created.id);
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
    if (poGrn.goodsReceiptId && dto.items) {
      await this.assertWithinDelivery(tenantId, branchId, poGrn.goodsReceiptId, dto.items, id);
    }

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
    user: RequestUser,
    branchId: string,
    access: ActorAccess,
    id: string,
  ) {
    const tenantId = user.tenantId;
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

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.goodsReturn.updateMany({
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
      const evidence =
        isMgr && existing.type === GoodsReturnType.supplier
          ? await this.approveOwn(tx, user, branchId, id)
          : null;

      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: userId,
          eventName: isMgr ? "return.submitted_and_approved" : "return.submitted",
          entityName: "goods_return",
          entityId: id,
          payload: { status: nextStatus, approvalId: evidence?.approvalId ?? null, stockPosted: false },
        },
        tx,
      );
    });

    return this.getOne(tenantId, branchId, id);
  }

  /**
   * Records exact approval of the return on screen (`approvalReview`) and hands it to the branch
   * for dispatch. Nothing leaves stock here. A return already approved whose evidence is missing
   * (approved before exact approvals existed) or no longer usable can be approved again.
   */
  async approve(user: RequestUser, branchId: string, id: string, input: ApproveHeldDto) {
    const tenantId = user.tenantId;
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM goods_return WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.goodsReturn.findFirst({ where: { id, tenantId, branchId } });
      if (!existing) throw new NotFoundException("Return not found");
      if (!APPROVABLE.includes(existing.status)) {
        throw new BadRequestException("Return is not awaiting approval at this branch");
      }
      // Permission, self-approval, supplier type and the exact revision/digest are checked here.
      const evidence = await this.approvals.issue(tx, user, branchId, COMPLETE, id, {
        ...input,
        reason: "Approve exact supplier return",
        expiresAt: null,
      });
      // Status and approver are bookkeeping, not approved material: the evidence stays usable.
      await tx.goodsReturn.update({
        where: { id, tenantId, branchId },
        data: {
          approvedBy: user.userId,
          ...(existing.status === GoodsReturnStatus.pending_approval
            ? { status: GoodsReturnStatus.awaiting_logistics }
            : {}),
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "return.approved",
          entityName: "goods_return",
          entityId: id,
          payload: {
            approvalId: evidence.approvalId,
            requestedByUserId: existing.requestedBy,
            reapproved: existing.status !== GoodsReturnStatus.pending_approval,
            stockPosted: false,
          },
        },
        tx,
      );
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

  /** Browser dispatch: the shared core plus the optional user-scoped Idempotency-Key. */
  async complete(
    user: RequestUser,
    branchId: string,
    id: string,
    input: PostHeldDto,
    idempotencyKeyRaw?: string,
  ) {
    const { tenantId, userId } = user;
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
        const done = await this.completeInTransaction(tx, user, branchId, id, input);
        if (idemKey && done.changed) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.returnComplete,
              idempotencyKey: idemKey,
              resourceId: id,
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

    return this.getOne(tenantId, branchId, id);
  }

  /**
   * Dispatch core shared by the browser route and the signed terminal executor, in the caller's
   * READ COMMITTED transaction. The goods leave stock (quarantined units first) and the supplier
   * debit note is raised together; `command` is verified provenance for the success audit.
   */
  async completeInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    id: string,
    input: PostHeldDto,
    command?: CommandProvenance,
  ) {
    const { tenantId, userId } = user;
    await tx.$queryRaw`SELECT id FROM goods_return WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    const row = await tx.goodsReturn.findFirst({
      where: { id, tenantId, branchId },
      include: {
        items: { where: { tenantId }, orderBy: { id: "asc" } },
        debitNote: { select: { id: true } },
      },
    });
    if (!row) throw new NotFoundException("Return not found");
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has("returns.process")) {
      throw new ForbiddenException("Return processing permission required");
    }
    // A customer return raised on the old Returns page restocked without refunding anyone.
    // Those still open are cancelled and refunded at the till instead.
    if (row.type === GoodsReturnType.customer) {
      throw new BadRequestException(
        "Cancel this return and refund the sale at the till instead — completing it here would put stock back without refunding the customer.",
      );
    }
    // The approval the operator saw, not whatever is current: a replaced approval is re-reviewed.
    const current = (await this.latestApprovals(tx, tenantId, branchId, [id])).get(id);
    if (!current || current.id !== input.approvalId) {
      throw new ConflictException("Approval changed; refresh and review before dispatching");
    }
    if (row.status === GoodsReturnStatus.completed) {
      return { actor, changed: false, approvalId: current.id, debitNoteId: row.debitNote?.id ?? null };
    }
    if (
      row.status !== GoodsReturnStatus.in_review &&
      row.status !== GoodsReturnStatus.awaiting_logistics
    ) {
      throw new BadRequestException(
        "Return must be in review or awaiting logistics to complete",
      );
    }
    for (const line of row.items) {
      if (!line.batchId) {
        throw new BadRequestException("batchId is required on all items to complete a return");
      }
    }

    const authorize = () =>
      this.approvals.requireForExecution(tx, user, branchId, COMPLETE, id, input.approvalId);
    await authorize();
    // Live approver/executor authority again after waiting for the batch locks.
    await this.stock.lockBatches(tx, tenantId, row.items.map((line) => line.batchId!));
    const evidence = await authorize();

    // Stock going back to a supplier is usually the stock already held back — expired,
    // damaged, recalled — so quarantined units are sent before sellable ones.
    await this.stock.issue(
      tx,
      { tenantId, branchId, userId, referenceType: "goods_return", referenceId: row.id },
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
    let debitNoteId: string | null = null;
    if (row.supplierId) {
      const batches = await tx.batch.findMany({
        where: { tenantId, id: { in: row.items.map((line) => line.batchId!) } },
        select: { id: true, costPrice: true },
      });
      const costByBatch = new Map(batches.map((batch) => [batch.id, batch.costPrice]));
      const note = await raiseDebitNoteForReturn(tx, {
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
      debitNoteId = note?.id ?? null;
    }

    await tx.goodsReturn.update({
      where: { id, tenantId, branchId },
      data: { status: GoodsReturnStatus.completed, processedBy: userId },
    });

    await this.audit.log(
      {
        tenantId,
        branchId,
        actorUserId: userId,
        eventName: "return.completed",
        entityName: "goods_return",
        entityId: id,
        payload: {
          approvalId: evidence.approvalId,
          debitNoteId,
          requestedByUserId: row.requestedBy,
          approvedByUserId: evidence.approvedByUserId,
          executedByUserId: userId,
          ...(command ? { command } : {}),
        },
      },
      tx,
    );
    return { actor, changed: true, approvalId: evidence.approvalId, debitNoteId };
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
