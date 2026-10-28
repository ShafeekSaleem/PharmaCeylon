import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  NotificationCategory,
  NotificationSeverity,
  PoStatus,
  Prisma,
  PreparedReceiptStatus,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { businessDateKey, safeTimeZone } from "../common/business-date.util";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { ApproveHeldDto, PostHeldDto } from "../security/dto/approve-held.dto";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import { documentReview, preparedReceiptMaterial } from "../security/receiving-approval-material";
import type { CommandProvenance } from "../terminals/command-provenance";
import type {
  CancelPreparedReceiptDto,
  CreatePreparedReceiptDto,
  PreparedDeliveryDto,
  UpdatePreparedReceiptDto,
} from "./dto/prepared-receipt.dto";
import type { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { PurchasingService } from "./purchasing.service";

type Tx = Prisma.TransactionClient;

const RECEIVABLE: PoStatus[] = [PoStatus.issued, PoStatus.partially_received];
const OPEN: PreparedReceiptStatus[] = [PreparedReceiptStatus.draft, PreparedReceiptStatus.approved];

const PREPARED_INCLUDE = {
  preparer: { select: { id: true, fullName: true } },
  purchaseOrder: {
    select: {
      id: true, poNumber: true, status: true, approvalVersion: true,
      supplier: { select: { id: true, name: true } },
      items: { select: { id: true, receivedQty: true, freeQty: true, rejectedQty: true }, orderBy: { id: "asc" } },
    },
  },
} satisfies Prisma.PreparedReceiptInclude;

type PreparedRow = Prisma.PreparedReceiptGetPayload<{ include: typeof PREPARED_INCLUDE }>;

/** The stored delivery: only what was typed, never `undefined` placeholders. */
function storedDelivery(delivery: PreparedDeliveryDto): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify({
    supplierDeliveryNote: delivery.supplierDeliveryNote?.trim() || undefined,
    acceptOverDelivery: delivery.acceptOverDelivery || undefined,
    acceptPriceVariance: delivery.acceptPriceVariance || undefined,
    updateSupplierPrice: delivery.updateSupplierPrice || undefined,
    lines: delivery.lines,
  })) as Prisma.InputJsonObject;
}

const hasCost = (line: PreparedDeliveryDto["lines"][number]) =>
  !!line.costPrice?.trim() || !!line.packCost?.trim();

/**
 * A delivery prepared away from the counter — from the supplier's delivery note, say — reviewed
 * and approved remotely, then posted by the counter when the goods are there (D10).
 *
 * Preparing and approving touch neither stock nor the supplier ledger. Approval is exact
 * evidence of the delivery, its exception choices and the order as it then stood. Posting is the
 * physical step: it goes through `PurchasingService.receiveGoods`, so tolerances, price
 * variance, cost and expiry conflicts, damaged-unit quarantine and the placeholder supplier
 * invoice all behave exactly as they do for a delivery typed at the counter.
 */
@Injectable()
export class PreparedReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchasing: PurchasingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
  ) {}

  async list(
    tenantId: string,
    branchId: string,
    opts: { purchaseOrderId?: string; status?: PreparedReceiptStatus; canViewCost: boolean },
  ) {
    const rows = await this.prisma.preparedReceipt.findMany({
      where: {
        tenantId,
        branchId,
        status: opts.status ?? { in: OPEN },
        ...(opts.purchaseOrderId ? { purchaseOrderId: opts.purchaseOrderId } : {}),
      },
      include: PREPARED_INCLUDE,
      orderBy: { preparedAt: "desc" },
    });
    return this.mapAll(tenantId, rows, opts.canViewCost);
  }

  async create(user: RequestUser, branchId: string, purchaseOrderId: string, dto: CreatePreparedReceiptDto) {
    const { row, actor } = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${user.tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${purchaseOrderId}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({
        where: { id: purchaseOrderId, tenantId: user.tenantId, branchId },
        include: { items: { where: { tenantId: user.tenantId } } },
      });
      if (!po) throw new NotFoundException("Purchase order not found");
      if (!RECEIVABLE.includes(po.status))
        throw new BadRequestException("This order isn't open for receiving any more — refresh to see it");
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("purchasing.manage")) throw new ForbiddenException("Purchasing permission required");
      this.validate(actor.has("costs.view"), dto.delivery, po.items.map((item) => item.productId));
      const open = await tx.preparedReceipt.findFirst({
        where: { tenantId: user.tenantId, branchId, purchaseOrderId, status: { in: OPEN } },
        select: { id: true },
      });
      if (open) throw this.alreadyPrepared(open.id);
      const row = await tx.preparedReceipt.create({
        data: {
          tenantId: user.tenantId,
          branchId,
          purchaseOrderId,
          payload: storedDelivery(dto.delivery),
          notes: dto.notes?.trim() || null,
          preparedBy: user.userId,
        },
        include: PREPARED_INCLUDE,
      });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.receipt_prepared", entityName: "prepared_receipt", entityId: row.id,
        payload: { purchaseOrderId, lines: dto.delivery.lines.length, stockPosted: false } }, tx);
      return { row, actor };
    }).catch((error: unknown) => {
      // Two people preparing the same order at once: the partial unique index decides.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")
        throw this.alreadyPrepared(null);
      throw error;
    });

    await this.notifications.notifyByPermission(user.tenantId, "purchasing.approve", NotificationCategory.purchasing, {
      severity: NotificationSeverity.info,
      title: `Approve a prepared delivery on ${row.purchaseOrder.poNumber}`,
      message: `${row.preparer.fullName || "A colleague"} · ${row.purchaseOrder.supplier.name}. Approving it does not change stock; the counter posts it when the goods arrive.`,
      actionLabel: "Review the delivery",
      actionHref: `/purchasing?po=${purchaseOrderId}`,
      entityType: "prepared_receipt",
      entityId: row.id,
      requiresAction: true,
    }, user.userId, { branchId });
    return (await this.mapAll(user.tenantId, [row], actor.has("costs.view")))[0]!;
  }

  async update(user: RequestUser, branchId: string, id: string, dto: UpdatePreparedReceiptDto) {
    const actor = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("purchasing.manage")) throw new ForbiddenException("Purchasing permission required");
      if (!OPEN.includes(row.status)) throw new ConflictException("This delivery has already been posted or cancelled");
      if (row.approvalVersion !== dto.expectedVersion)
        throw new ConflictException("This delivery changed; refresh before saving");
      let payload: Prisma.InputJsonObject | undefined;
      if (dto.delivery) {
        const po = await tx.purchaseOrderItem.findMany({
          where: { tenantId: user.tenantId, purchaseOrderId: row.purchaseOrderId }, select: { productId: true },
        });
        const stored = row.payload as unknown as PreparedDeliveryDto;
        const delivery = actor.has("costs.view") ? dto.delivery : {
          ...dto.delivery,
          // Costs stay what was saved for someone who cannot see them.
          lines: dto.delivery.lines.map((line) => {
            if (hasCost(line)) throw new BadRequestException("Cost changes require permission to view costs");
            const previous = stored.lines.find((l) => l.productId === line.productId);
            return { ...line, costPrice: previous?.costPrice, packCost: previous?.packCost };
          }),
        };
        // Retained costs were typed by someone who could see them.
        this.validate(true, delivery, po.map((item) => item.productId));
        payload = storedDelivery(delivery);
      }
      const updated = await tx.preparedReceipt.update({
        where: { id, tenantId: user.tenantId, branchId },
        data: {
          ...(payload ? { payload } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
        },
      });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.prepared_receipt_updated", entityName: "prepared_receipt", entityId: id,
        payload: { approvalVersion: updated.approvalVersion, approvalCleared: row.executionApprovalId !== null && updated.executionApprovalId === null } }, tx);
      return actor;
    });
    return this.one(user.tenantId, branchId, id, actor.has("costs.view"));
  }

  async approve(user: RequestUser, branchId: string, id: string, input: ApproveHeldDto) {
    let changed = false;
    const actor = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!OPEN.includes(row.status)) throw new ConflictException("This delivery has already been posted or cancelled");
      // Permission, self-approval and the exact revision/digest on screen are checked here.
      const evidence = await this.approvals.issue(tx, user, branchId, "prepared_receipt.post", id,
        { ...input, reason: "Approve exact prepared delivery and exceptions", expiresAt: null });
      if (row.status === "approved" && row.executionApprovalId === evidence.approvalId) return actor;
      await tx.preparedReceipt.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        status: "approved", executionApprovalId: evidence.approvalId, approvedBy: user.userId, approvedAt: new Date(),
      } });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.prepared_receipt_approved", entityName: "prepared_receipt", entityId: id,
        payload: { approvalId: evidence.approvalId, requestedByUserId: row.preparedBy, stockPosted: false } }, tx);
      await this.resolveRequests(user.tenantId, id, tx);
      changed = true;
      return actor;
    });
    const view = await this.one(user.tenantId, branchId, id, actor.has("costs.view"));
    if (changed && view.preparedBy.id !== user.userId)
      await this.notifications.notifyUser(user.tenantId, view.preparedBy.id, NotificationCategory.purchasing, {
        severity: NotificationSeverity.info, title: `Delivery approved · ${view.purchaseOrder.poNumber}`,
        message: "Stock changes only when the counter posts it after the goods arrive.",
        actionLabel: "Open the order", actionHref: `/purchasing?po=${view.purchaseOrderId}`,
        entityType: "prepared_receipt", entityId: id,
      }, { branchId });
    return view;
  }

  async post(user: RequestUser, branchId: string, id: string, input: PostHeldDto) {
    const { actor, changed } = await this.prisma.$transaction((tx) => this.postInTransaction(tx, user, branchId, id, input));
    if (changed) await this.notifyPosted(user.tenantId, branchId, id);
    return this.one(user.tenantId, branchId, id, actor.has("costs.view"));
  }

  /** Posting core shared by the browser route and the signed terminal executor, in the caller's
   * READ COMMITTED transaction. `command` is verified provenance copied into the success audit.
   */
  async postInTransaction(tx: Tx, user: RequestUser, branchId: string, id: string,
    input: PostHeldDto, command?: CommandProvenance) {
    const row = await this.lock(tx, user.tenantId, branchId, id);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has("purchasing.receive")) throw new ForbiddenException("Receiving permission required");
    // The approval the operator saw, not whatever is current: a replaced approval is re-reviewed.
    if (row.executionApprovalId !== input.approvalId)
      throw new ConflictException("Approval changed; refresh and review before posting");
    if (row.status === "posted" && row.goodsReceiptId)
      return { actor, changed: false, approvalId: row.executionApprovalId, goodsReceiptId: row.goodsReceiptId };
    if (row.status !== "approved" || !row.executionApprovalId)
      throw new ConflictException("Approve this delivery before posting");
    const approvalId = row.executionApprovalId;
    const evidence = await this.approvals.requireForExecution(tx, user, branchId, "prepared_receipt.post", id, approvalId);
    // From here this transaction holds the order and the prepared receipt locked, and receiving
    // itself advances the order's received counters; later checks re-verify live authority.
    const authorize = () => this.approvals.recheckAuthority(tx, user, branchId, evidence);
    const tenant = await tx.tenant.findUnique({ where: { id: user.tenantId }, select: { timezone: true } });
    const dto: ReceiveGoodsDto = {
      ...(row.payload as unknown as PreparedDeliveryDto),
      purchaseOrderId: row.purchaseOrderId,
      // The goods are received on the day the counter books them in.
      receivedOn: businessDateKey(safeTimeZone(tenant?.timezone)),
    };
    const receipt = await this.purchasing.receiveGoods(user.tenantId, branchId, user.userId, actor, dto, undefined,
      { preparedReceiptId: id, tx, authorizePreparedReceipt: authorize });
    if (!receipt) throw new BadRequestException("The delivery could not be posted");
    await tx.preparedReceipt.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
      status: "posted", goodsReceiptId: receipt.id, executedBy: user.userId, executedAt: new Date(),
    } });
    await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
      eventName: "purchase_order.prepared_receipt_posted", entityName: "prepared_receipt", entityId: id,
      payload: { approvalId: evidence.approvalId, goodsReceiptId: receipt.id, requestedByUserId: row.preparedBy,
        approvedByUserId: evidence.approvedByUserId, executedByUserId: user.userId,
        ...(command ? { command } : {}) } }, tx);
    return { actor, changed: true, approvalId: evidence.approvalId, goodsReceiptId: receipt.id };
  }

  /** After commit only: whoever prepared it learns the goods were actually received. */
  async notifyPosted(tenantId: string, branchId: string, id: string) {
    const row = await this.load(tenantId, branchId, id);
    await this.notifications.notifyUser(tenantId, row.preparedBy, NotificationCategory.purchasing, {
      severity: NotificationSeverity.info, title: `Delivery posted · ${row.purchaseOrder.poNumber}`,
      message: "The prepared delivery has been received at the counter. Open the order for the receipt.",
      actionLabel: "Open the order", actionHref: `/purchasing?po=${row.purchaseOrderId}`,
      entityType: "prepared_receipt", entityId: id,
    }, { branchId });
  }

  async cancel(user: RequestUser, branchId: string, id: string, dto: CancelPreparedReceiptDto) {
    const actor = await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("purchasing.manage") && !actor.has("purchasing.approve"))
        throw new ForbiddenException("Purchasing permission required");
      if (!OPEN.includes(row.status)) throw new ConflictException("This delivery has already been posted or cancelled");
      const reason = dto.reason.trim();
      await tx.preparedReceipt.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        status: "cancelled", cancelledBy: user.userId, cancelledAt: new Date(), cancelReason: reason,
      } });
      await this.resolveRequests(user.tenantId, id, tx);
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.prepared_receipt_cancelled", entityName: "prepared_receipt", entityId: id,
        payload: { reason, approvalId: row.executionApprovalId } }, tx);
      return actor;
    });
    return this.one(user.tenantId, branchId, id, actor.has("costs.view"));
  }

  /** Lines must be on the order, once each; costs are typed only by someone who can see them. */
  private validate(canEnterCost: boolean, delivery: PreparedDeliveryDto, orderedProductIds: string[]) {
    const seen = new Set<string>();
    for (const line of delivery.lines) {
      if (seen.has(line.productId)) throw new BadRequestException("A product appears twice on this delivery");
      seen.add(line.productId);
      if (!orderedProductIds.includes(line.productId))
        throw new BadRequestException(`Product ${line.productId} is not on this PO`);
      if (!line.batchNo.trim()) throw new BadRequestException("Enter the batch number printed on each product");
      if (hasCost(line) && !canEnterCost)
        throw new BadRequestException("Entering costs requires permission to view costs");
    }
  }

  private alreadyPrepared(preparedReceiptId: string | null) {
    return new ConflictException({
      code: "RECEIPT_ALREADY_PREPARED",
      preparedReceiptId,
      message: "A delivery is already prepared on this order. Open it to change it, or cancel it first.",
    });
  }

  /** Same order as every receiving path: the purchase order, then the prepared receipt. */
  private async lock(tx: Tx, tenantId: string, branchId: string, id: string) {
    const binding = await tx.preparedReceipt.findFirst({ where: { id, tenantId, branchId }, select: { purchaseOrderId: true } });
    if (!binding) throw new NotFoundException("Prepared delivery not found");
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${binding.purchaseOrderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM prepared_receipt WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    return this.load(tenantId, branchId, id, tx);
  }

  private async load(tenantId: string, branchId: string, id: string, tx: Tx | PrismaService = this.prisma): Promise<PreparedRow> {
    const row = await tx.preparedReceipt.findFirst({ where: { id, tenantId, branchId }, include: PREPARED_INCLUDE });
    if (!row) throw new NotFoundException("Prepared delivery not found");
    return row;
  }

  private async one(tenantId: string, branchId: string, id: string, canViewCost: boolean) {
    return (await this.mapAll(tenantId, [await this.load(tenantId, branchId, id)], canViewCost))[0]!;
  }

  private async resolveRequests(tenantId: string, id: string, tx: Tx) {
    await tx.notification.updateMany({
      where: { tenantId, entityType: "prepared_receipt", entityId: id, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  /** Costs follow the cost permission, like every other cost in Purchasing. */
  private async mapAll(tenantId: string, rows: PreparedRow[], canViewCost: boolean) {
    const userIds = [...new Set(rows.flatMap((row) => [row.approvedBy, row.executedBy, row.cancelledBy])
      .filter((value): value is string => !!value))];
    const users = userIds.length
      ? await this.prisma.appUser.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, fullName: true } })
      : [];
    const person = (userId: string | null) => (userId ? users.find((u) => u.id === userId) ?? { id: userId, fullName: null } : null);
    return rows.map((row) => {
      const delivery = row.payload as unknown as PreparedDeliveryDto;
      const orderOpen = RECEIVABLE.includes(row.purchaseOrder.status);
      return {
        id: row.id,
        purchaseOrderId: row.purchaseOrderId,
        purchaseOrder: { id: row.purchaseOrder.id, poNumber: row.purchaseOrder.poNumber,
          status: row.purchaseOrder.status, supplier: row.purchaseOrder.supplier },
        status: row.status,
        orderOpen,
        notes: row.notes,
        approvalVersion: row.approvalVersion,
        // The exact revision/digest an approver confirms; absent once it can no longer be approved.
        approvalReview: orderOpen && OPEN.includes(row.status)
          ? documentReview("prepared_receipt", row.approvalVersion, preparedReceiptMaterial(row, row.purchaseOrder))
          : null,
        executionApprovalId: row.executionApprovalId,
        preparedBy: row.preparer,
        preparedAt: row.preparedAt.toISOString(),
        approvedBy: person(row.approvedBy),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        executedBy: person(row.executedBy),
        executedAt: row.executedAt?.toISOString() ?? null,
        goodsReceiptId: row.goodsReceiptId,
        cancelledBy: person(row.cancelledBy),
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
        cancelReason: row.cancelReason,
        delivery: {
          ...delivery,
          lines: delivery.lines.map((line) => ({
            ...line,
            costPrice: canViewCost ? line.costPrice : undefined,
            packCost: canViewCost ? line.packCost : undefined,
          })),
        },
      };
    });
  }

}
