import { PostHeldDto } from "../security/dto/approve-held.dto";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { heldDeliveryMaterial, heldReview } from "../security/held-approval-material";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HeldDeliveryStatus,
  NotificationCategory,
  NotificationSeverity,
  Prisma,
  PoStatus,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService, assertMayApprove, type ActorAccess } from "../security/access.service";
import type {
  AcceptHeldDeliveryDto,
  PrepareHeldDeliveryDto,
  HoldDeliveryDto,
  RejectHeldDeliveryDto,
} from "./dto/held-delivery.dto";
import type { ReceiveGoodsDto } from "./dto/receive-goods.dto";
import { PurchasingService } from "./purchasing.service";

/** How long a resend of the same delivery is treated as the same request. */
const REPEAT_WINDOW_MS = 10 * 60_000;

const WHAT: Record<string, string> = {
  over_delivery: "more arrived than was ordered",
  price_variance: "it is billed above the price the order agreed",
};

const RECEIVABLE: PoStatus[] = [
  PoStatus.issued,
  PoStatus.partially_received,
];

const HELD_INCLUDE = {
  requester: { select: { id: true, fullName: true, email: true } },
  decider: { select: { id: true, fullName: true } },
  purchaseOrder: {
    select: { id: true, poNumber: true, approvalVersion: true, status: true, supplier: { select: { id: true, name: true } } },
  },
} satisfies Prisma.HeldDeliveryInclude;

type HeldRow = Prisma.HeldDeliveryGetPayload<{ include: typeof HELD_INCLUDE }>;

/** The receiving form as stored: everything the receiver typed, never an accept flag. */
function storedPayload(delivery: ReceiveGoodsDto, purchaseOrderId: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { acceptOverDelivery, acceptPriceVariance, updateSupplierPrice, ...rest } = delivery;
  return { ...rest, purchaseOrderId };
}

/** Lines the approver changed: a quantity, a price, a batch or an expiry. */
function differs(typed: ReceiveGoodsDto, accepted: ReceiveGoodsDto): boolean {
  const key = (l: ReceiveGoodsDto["lines"][number]) =>
    [
      l.productId,
      l.batchNo.trim(),
      l.expiryDate.slice(0, 10),
      l.receivedQty ?? "",
      l.packs ?? "",
      l.freeQty ?? 0,
      l.rejectedQty ?? 0,
      Number(l.costPrice ?? 0).toFixed(2),
      Number(l.packCost ?? 0).toFixed(2),
      Number(l.sellingPrice).toFixed(2),
    ].join("|");
  const a = typed.lines.map(key).sort();
  const b = accepted.lines.map(key).sort();
  return a.length !== b.length || a.some((value, i) => value !== b[i]);
}

/**
 * A delivery the receiver could not book in themselves, kept until an approver decides.
 *
 * Over-delivery beyond the tolerance and a price above the agreed one both need
 * `purchasing.approve`. Module 3 let the receiver *ask*, but threw away what they had typed, so
 * the approver was told something needed them and then had to rebuild the delivery from the
 * order. Now the delivery itself waits: the approver opens it, sees it beside the order, and
 * approves it (as typed or corrected) or rejects it. Posting is a separate receiving action;
 * approval leaves stock and the supplier ledger unchanged.
 */
@Injectable()
export class HeldDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchasing: PurchasingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
  ) {}

  async hold(
    tenantId: string,
    branchId: string,
    userId: string,
    purchaseOrderId: string,
    dto: HoldDeliveryDto,
  ): Promise<{ held: ReturnType<HeldDeliveryService["map"]>; notified: number; alreadyAsked: boolean }> {
    const { po, reasons, detail, row, isRepeat } = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${purchaseOrderId}::uuid FOR UPDATE`;
      const po = await tx.purchaseOrder.findFirst({
        where: { id: purchaseOrderId, tenantId, branchId },
        select: { id: true, poNumber: true, status: true, supplier: { select: { name: true } } },
      });
      if (!po) throw new NotFoundException("Purchase order not found");
      if (!RECEIVABLE.includes(po.status)) {
        throw new BadRequestException("This order isn't open for receiving any more — refresh to see it");
      }

      const reasons = [...new Set(dto.reasons)].sort();
      const payload = storedPayload(dto.delivery, po.id) as unknown as Prisma.InputJsonValue;
      const detail = dto.detail.trim();

      // One delivery waiting per receiver per order: sending again replaces what they typed, and
      // only re-notifies when there is a new reason or the last ask has gone stale.
      const existing = await tx.heldDelivery.findFirst({
        where: {
          tenantId,
          branchId,
          purchaseOrderId: po.id,
          requestedBy: userId,
          status: HeldDeliveryStatus.awaiting_approval,
        },
      });
      if (!existing) {
        const other = await tx.heldDelivery.findFirst({
          where: {
            tenantId,
            branchId,
            purchaseOrderId: po.id,
            status: { in: [HeldDeliveryStatus.awaiting_approval, HeldDeliveryStatus.approved] },
          },
          select: { requester: { select: { fullName: true } } },
        });
        if (other) {
          throw new BadRequestException({
            code: "DELIVERY_AWAITING_APPROVAL",
            message: `A delivery on this order from ${other.requester.fullName || "a colleague"} is already waiting for approval. It has to be decided first.`,
          });
        }
      }

      const isRepeat =
        existing != null &&
        reasons.every((reason) => existing.reasons.includes(reason)) &&
        Date.now() - existing.requestedAt.getTime() < REPEAT_WINDOW_MS;

      const row = existing
        ? await tx.heldDelivery.update({
            where: { id: existing.id, tenantId, branchId, status: "awaiting_approval" },
            data: {
              reasons: [...new Set([...existing.reasons, ...reasons])].sort(),
              detail,
              payload,
              preparedPayload: Prisma.DbNull, corrected: false,
              ...(isRepeat ? {} : { requestedAt: new Date() }),
            },
            include: HELD_INCLUDE,
          })
        : await tx.heldDelivery.create({
            data: {
              tenantId,
              branchId,
              purchaseOrderId: po.id,
              reasons,
              detail,
              payload,
              requestedBy: userId,
            },
            include: HELD_INCLUDE,
          });

      await this.audit.log({ tenantId, branchId, actorUserId: userId, eventName: "purchase_order.delivery_held",
        entityName: "purchase_order", entityId: po.id, payload: { heldDeliveryId: row.id, reasons, detail, alreadyAsked: isRepeat } }, tx);
      return { po, reasons, detail, row, isRepeat };
    });

    if (isRepeat) {
      return { held: this.map(row, true), notified: 0, alreadyAsked: true };
    }

    const who = row.requester.fullName || row.requester.email || "A colleague";
    const why = reasons.map((reason) => WHAT[reason]).join(", and ");
    const notified = await this.notifications.notifyByPermission(
      tenantId,
      "purchasing.approve",
      NotificationCategory.purchasing,
      {
        severity: NotificationSeverity.warning,
        title: `Approve a delivery on ${po.poNumber}`,
        message: `${who} · ${po.supplier.name} · ${why}. ${detail}`,
        actionLabel: "Review the delivery",
        actionHref: `/purchasing?po=${po.id}&held=${row.id}`,
        // Its own entity, so the request can be marked done once someone decides it.
        entityType: "held_delivery",
        entityId: row.id,
        requiresAction: true,
      },
      userId,
      { branchId },
    );

    return { held: this.map(row, true), notified, alreadyAsked: false };
  }

  async list(
    tenantId: string,
    branchId: string,
    opts: { status?: HeldDeliveryStatus; purchaseOrderId?: string; canViewCost: boolean },
  ) {
    // Anything still waiting on an order that can no longer be received is closed first, so a
    // banner never offers to accept a delivery the order can't take.
    const stale = await this.prisma.heldDelivery.findMany({
      where: {
        tenantId,
        branchId,
        status: { in: [HeldDeliveryStatus.awaiting_approval, HeldDeliveryStatus.approved] },
        purchaseOrder: { status: { notIn: RECEIVABLE } },
      },
      select: { id: true },
    });
    if (stale.length > 0) {
      await this.closeAsUnreceivable(tenantId, branchId, stale.map((row) => row.id));
    }

    const rows = await this.prisma.heldDelivery.findMany({
      where: {
        tenantId,
        branchId,
        status: opts.status ?? { in: [HeldDeliveryStatus.awaiting_approval, HeldDeliveryStatus.approved] },
        ...(opts.purchaseOrderId ? { purchaseOrderId: opts.purchaseOrderId } : {}),
      },
      include: HELD_INCLUDE,
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((row) => this.map(row, opts.canViewCost));
  }

  /** Save corrections separately, then approve the returned exact preview. */
  async prepare(user: RequestUser, branchId: string, id: string, dto: PrepareHeldDeliveryDto) {
    const actor = await this.prisma.$transaction(async tx => {
      const held = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("purchasing.approve")) throw new ForbiddenException("Approval permission required");
      assertMayApprove(actor, [held.requestedBy], "delivery");
      if (!["awaiting_approval", "approved"].includes(held.status) || held.approvalVersion !== dto.expectedVersion
        || heldReview("held_delivery", held.approvalVersion, heldDeliveryMaterial(held, held.purchaseOrder.approvalVersion)).expectedDigest !== dto.expectedDigest)
        throw new ConflictException("This delivery changed; refresh before saving corrections");
      if (dto.delivery.purchaseOrderId !== held.purchaseOrderId) throw new BadRequestException("Delivery belongs to another purchase order");
      const original = held.payload as unknown as ReceiveGoodsDto;
      const previous = (held.preparedPayload ?? held.payload) as unknown as ReceiveGoodsDto;
      const lines = dto.delivery.lines.map(line => {
        const stored = previous.lines.find(l => l.productId === line.productId);
        // Omission means retain saved fields (including redacted costs and exception choices).
        const changes = Object.fromEntries(Object.entries(line).filter(([, value]) => value !== undefined));
        if (!actor.has("costs.view")) {
          if (!stored || line.costPrice !== undefined && line.costPrice !== stored.costPrice
            || line.packCost !== undefined && line.packCost !== stored.packCost || dto.updateSupplierPrice)
            throw new BadRequestException("Cost changes require permission to view costs");
          return { ...line, ...stored, ...changes, costPrice: stored.costPrice, packCost: stored.packCost };
        }
        return { ...line, ...stored, ...changes,
          ...(line.costPrice !== undefined && line.packCost === undefined ? { packCost: undefined } : {}),
        };
      });
      const changes = Object.fromEntries(Object.entries(storedPayload({ ...dto.delivery, lines }, held.purchaseOrderId))
        .filter(([, value]) => value !== undefined));
      const delivery = { ...previous, ...changes, purchaseOrderId: held.purchaseOrderId, lines,
        updateSupplierPrice: dto.updateSupplierPrice ?? previous.updateSupplierPrice ?? false };
      // JSON persistence deliberately omits optional undefined fields, matching the displayed preview.
      const payload = JSON.parse(JSON.stringify(delivery)) as Prisma.InputJsonValue;
      await tx.heldDelivery.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        preparedPayload: payload, corrected: differs(original, delivery),
      } });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.held_delivery_prepared", entityName: "held_delivery", entityId: id,
        payload: { purchaseOrderId: held.purchaseOrderId } }, tx);
      return actor;
    });
    return this.map(await this.load(user.tenantId, branchId, id), actor.has("costs.view"));
  }

  async accept(user: RequestUser, branchId: string, id: string, input: AcceptHeldDeliveryDto) {
    let changed = false;
    const actor = await this.prisma.$transaction(async tx => {
      const held = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!["awaiting_approval", "approved"].includes(held.status)) throw new ConflictException("This delivery has already been decided");
      const evidence = await this.approvals.issue(tx, user, branchId, "held_delivery.post", id,
        { ...input, reason: "Approve exact held delivery and exceptions", expiresAt: null });
      if (held.status === "approved" && held.executionApprovalId === evidence.approvalId) return actor;
      await tx.heldDelivery.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        status: "approved", executionApprovalId: evidence.approvalId, decidedBy: user.userId, decidedAt: new Date(),
      } });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.held_delivery_approved", entityName: "held_delivery", entityId: id,
        payload: { approvalId: evidence.approvalId, requestedByUserId: held.requestedBy, stockPosted: false } }, tx);
      await this.resolveRequests(user.tenantId, [id], tx);
      changed = true;
      return actor;
    });
    const row = await this.load(user.tenantId, branchId, id);
    if (changed) await this.notifications.notifyUser(user.tenantId, row.requestedBy, NotificationCategory.purchasing, {
      severity: NotificationSeverity.info, title: "Delivery approved", message: "The delivery is approved. Receiving must post the receipt before stock changes.",
      actionLabel: "Open request", actionHref: `/purchasing?po=${row.purchaseOrderId}`, entityType: "held_delivery", entityId: id,
    }, { branchId });
    return this.map(row, actor.has("costs.view"));
  }

  async post(user: RequestUser, branchId: string, id: string, input: PostHeldDto) {
    let changed = false;
    const actor = await this.prisma.$transaction(async tx => {
      const held = await this.lock(tx, user.tenantId, branchId, id);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("purchasing.receive")) throw new ForbiddenException("Receiving permission required");
      if (held.executionApprovalId !== input.approvalId) throw new ConflictException("Approval changed; refresh and review before posting");
      if (held.status === "accepted" && held.goodsReceiptId) return actor;
      if (held.status !== "approved" || !held.executionApprovalId) throw new ConflictException("Approve this delivery before posting");
      const authorize = () => this.approvals.requireForExecution(tx, user, branchId, "held_delivery.post", id, held.executionApprovalId!);
      const evidence = await authorize();
      const dto = { ...(held.preparedPayload ?? held.payload) as unknown as ReceiveGoodsDto,
        purchaseOrderId: held.purchaseOrderId, acceptOverDelivery: true, acceptPriceVariance: true };
      const receipt = await this.purchasing.receiveGoods(user.tenantId, branchId, user.userId, actor, dto, undefined,
        { heldDeliveryId: id, tx, authorizeHeldDelivery: authorize });
      if (!receipt) throw new BadRequestException("The delivery could not be posted");
      await tx.heldDelivery.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        status: "accepted", goodsReceiptId: receipt.id, executedBy: user.userId, executedAt: new Date(),
      } });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "purchase_order.held_delivery_posted", entityName: "held_delivery", entityId: id,
        payload: { approvalId: evidence.approvalId, goodsReceiptId: receipt.id, requestedByUserId: held.requestedBy,
          approvedByUserId: evidence.approvedByUserId, executedByUserId: user.userId } }, tx);
      changed = true;
      return actor;
    });
    const row = await this.load(user.tenantId, branchId, id);
    if (changed) await this.notifications.notifyUser(user.tenantId, row.requestedBy, NotificationCategory.purchasing, {
      severity: NotificationSeverity.info, title: "Delivery posted", message: "The approved delivery has been received. Open the order for the receipt.",
      actionLabel: "Open request", actionHref: `/purchasing?po=${row.purchaseOrderId}`, entityType: "held_delivery", entityId: id,
    }, { branchId });
    return this.map(row, actor.has("costs.view"));
  }

  private async lock(tx: Prisma.TransactionClient, tenantId: string, branchId: string, id: string) {
    const binding = await tx.heldDelivery.findFirst({ where: { id, tenantId, branchId }, select: { purchaseOrderId: true } });
    if (!binding) throw new NotFoundException("Held delivery not found");
    await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${binding.purchaseOrderId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM held_delivery WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    return this.load(tenantId, branchId, id, tx);
  }

  async reject(
    tenantId: string,
    branchId: string,
    userId: string,
    access: ActorAccess,
    id: string,
    dto: RejectHeldDeliveryDto,
  ) {
    const held = await this.load(tenantId, branchId, id);
    if (![HeldDeliveryStatus.awaiting_approval, HeldDeliveryStatus.approved].includes(held.status as "awaiting_approval" | "approved")) {
      throw new ConflictException("This delivery has already been decided — refresh to see it");
    }
    const reason = dto.reason.trim();
    const claimed = await this.prisma.heldDelivery.updateMany({
      where: { id, tenantId, branchId, status: { in: [HeldDeliveryStatus.awaiting_approval, HeldDeliveryStatus.approved] } },
      data: {
        status: HeldDeliveryStatus.rejected,
        decidedBy: userId,
        decidedAt: new Date(),
        decisionNote: reason,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Someone else is deciding this delivery — refresh to see it");
    }
    await this.resolveRequests(tenantId, [id]);
    await this.notifications.notifyUser(
      tenantId,
      held.requestedBy,
      NotificationCategory.purchasing,
      {
        severity: NotificationSeverity.warning,
        title: `Delivery rejected · ${held.purchaseOrder.poNumber}`,
        message: reason,
        actionLabel: "Open the order",
        actionHref: `/purchasing?po=${held.purchaseOrderId}`,
        entityType: "purchase_order",
        entityId: held.purchaseOrderId,
      },
      { branchId },
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.held_delivery_rejected",
      entityName: "purchase_order",
      entityId: held.purchaseOrderId,
      payload: { heldDeliveryId: id, reason },
    });
    return this.map(await this.load(tenantId, branchId, id), access.has("costs.view"));
  }

  /** Once a held delivery is decided, the approvers' "review this" notices are done with. */
  private async resolveRequests(tenantId: string, ids: string[], tx: Prisma.TransactionClient = this.prisma) {
    await tx.notification.updateMany({
      where: { tenantId, entityType: "held_delivery", entityId: { in: ids }, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  /** Close held deliveries whose order can't be received any more, and tell the receivers. */
  private async closeAsUnreceivable(tenantId: string, branchId: string, ids: string[]) {
    const rows = await this.prisma.heldDelivery.findMany({
      where: { id: { in: ids }, tenantId, branchId },
      include: HELD_INCLUDE,
    });
    const note = "The order was received, closed or cancelled before this delivery was accepted.";
    for (const candidate of rows) {
      const closed = await this.prisma.$transaction(async tx => {
        const row = await this.lock(tx, tenantId, branchId, candidate.id);
        if (!["awaiting_approval", "approved"].includes(row.status) || RECEIVABLE.includes(row.purchaseOrder.status)) return false;
        await tx.heldDelivery.update({ where: { id: row.id, tenantId, branchId }, data: {
          status: "rejected", decidedBy: null, decidedAt: new Date(), decisionNote: note,
        } });
        await this.resolveRequests(tenantId, [row.id], tx);
        await this.audit.log({ tenantId, branchId, eventName: "purchase_order.held_delivery_closed",
          entityName: "held_delivery", entityId: row.id, payload: { reason: note } }, tx);
        return true;
      });
      if (!closed) continue;
      const row = candidate;
      await this.notifications.notifyUser(
        tenantId,
        row.requestedBy,
        NotificationCategory.purchasing,
        {
          severity: NotificationSeverity.info,
          title: `Delivery for ${row.purchaseOrder.poNumber} closed`,
          message: note,
          actionLabel: "Open the order",
          actionHref: `/purchasing?po=${row.purchaseOrderId}`,
          entityType: "purchase_order",
          entityId: row.purchaseOrderId,
        },
        { branchId },
      );
    }
  }

  private async load(tenantId: string, branchId: string, id: string, tx: Prisma.TransactionClient = this.prisma): Promise<HeldRow> {
    const row = await tx.heldDelivery.findFirst({
      where: { id, tenantId, branchId },
      include: HELD_INCLUDE,
    });
    if (!row) throw new NotFoundException("Held delivery not found");
    return row;
  }

  /** Costs the receiver typed follow the cost permission, like every other cost in Purchasing. */
  private map(row: HeldRow, canViewCost: boolean) {
    const payload = (row.preparedPayload ?? row.payload) as unknown as ReceiveGoodsDto;
    return {
      id: row.id,
      status: row.status,
      executionApprovalId: row.executionApprovalId, executedBy: row.executedBy, executedAt: row.executedAt?.toISOString() ?? null,
      approvalReview: heldReview("held_delivery", row.approvalVersion, heldDeliveryMaterial(row, row.purchaseOrder.approvalVersion)),
      reasons: row.reasons,
      detail: row.detail,
      requestedAt: row.requestedAt.toISOString(),
      requester: { id: row.requester.id, fullName: row.requester.fullName },
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decider: row.decider,
      decisionNote: row.decisionNote,
      corrected: row.corrected,
      goodsReceiptId: row.goodsReceiptId,
      purchaseOrder: row.purchaseOrder,
      delivery: {
        ...payload,
        lines: payload.lines.map((line) => ({
          ...line,
          costPrice: canViewCost ? line.costPrice : undefined,
          packCost: canViewCost ? line.packCost : undefined,
        })),
      },
    };
  }
}
