import {
  BadRequestException,
  ConflictException,
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
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import type {
  AcceptHeldDeliveryDto,
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
    select: { id: true, poNumber: true, supplier: { select: { id: true, name: true } } },
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
 * accepts it (as typed or corrected) or rejects it. Accepting goes through the same receiving
 * code as any delivery; until then nothing touches stock or the supplier ledger.
 */
@Injectable()
export class HeldDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly purchasing: PurchasingService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async hold(
    tenantId: string,
    branchId: string,
    userId: string,
    purchaseOrderId: string,
    dto: HoldDeliveryDto,
  ): Promise<{ held: ReturnType<HeldDeliveryService["map"]>; notified: number; alreadyAsked: boolean }> {
    const po = await this.prisma.purchaseOrder.findFirst({
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
    const existing = await this.prisma.heldDelivery.findFirst({
      where: {
        tenantId,
        branchId,
        purchaseOrderId: po.id,
        requestedBy: userId,
        status: HeldDeliveryStatus.awaiting_approval,
      },
    });
    const isRepeat =
      existing != null &&
      reasons.every((reason) => existing.reasons.includes(reason)) &&
      Date.now() - existing.requestedAt.getTime() < REPEAT_WINDOW_MS;

    const row = existing
      ? await this.prisma.heldDelivery.update({
          where: { id: existing.id, tenantId },
          data: {
            reasons: [...new Set([...existing.reasons, ...reasons])].sort(),
            detail,
            payload,
            ...(isRepeat ? {} : { requestedAt: new Date() }),
          },
          include: HELD_INCLUDE,
        })
      : await this.prisma.heldDelivery.create({
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
        title: `${po.poNumber}: a delivery is waiting for your approval`,
        message: `${who} received a delivery from ${po.supplier.name}, and ${why}. ${detail}`,
        actionLabel: "Review the delivery",
        actionHref: `/purchasing?po=${po.id}&held=${row.id}`,
        entityType: "purchase_order",
        entityId: po.id,
        requiresAction: true,
      },
      userId,
      { branchId },
    );

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "purchase_order.delivery_held",
      entityName: "purchase_order",
      entityId: po.id,
      payload: { heldDeliveryId: row.id, reasons, detail, notified },
    });

    return { held: this.map(row, true), notified, alreadyAsked: false };
  }

  async list(
    tenantId: string,
    branchId: string,
    opts: { status?: HeldDeliveryStatus; purchaseOrderId?: string; canViewCost: boolean },
  ) {
    const rows = await this.prisma.heldDelivery.findMany({
      where: {
        tenantId,
        branchId,
        status: opts.status ?? HeldDeliveryStatus.awaiting_approval,
        ...(opts.purchaseOrderId ? { purchaseOrderId: opts.purchaseOrderId } : {}),
      },
      include: HELD_INCLUDE,
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((row) => this.map(row, opts.canViewCost));
  }

  async accept(
    tenantId: string,
    branchId: string,
    userId: string,
    access: ActorAccess,
    id: string,
    dto: AcceptHeldDeliveryDto,
    idempotencyKey?: string,
  ) {
    const held = await this.load(tenantId, branchId, id);
    if (held.status === HeldDeliveryStatus.accepted && held.goodsReceiptId) {
      // A retried accept: the first one booked it in.
      return this.map(held, access.has("costs.view"));
    }
    if (held.status !== HeldDeliveryStatus.awaiting_approval) {
      throw new ConflictException("This delivery has already been decided — refresh to see it");
    }
    assertMayApprove(access, [held.requestedBy], "delivery");

    const typed = held.payload as unknown as ReceiveGoodsDto;
    const delivery: ReceiveGoodsDto = {
      ...(dto.delivery ?? typed),
      purchaseOrderId: held.purchaseOrderId,
      acceptOverDelivery: true,
      acceptPriceVariance: true,
      updateSupplierPrice: dto.updateSupplierPrice === true,
    };
    const corrected = dto.delivery != null && differs(typed, dto.delivery);

    // Claim it before booking in, so two approvers accepting at once can't both receive it.
    const claimed = await this.prisma.heldDelivery.updateMany({
      where: { id, tenantId, branchId, status: HeldDeliveryStatus.awaiting_approval },
      data: { status: HeldDeliveryStatus.accepted, decidedBy: userId, decidedAt: new Date(), corrected },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Someone else is deciding this delivery — refresh to see it");
    }

    let receipt: { id: string; grnNumber: string } | null;
    try {
      receipt = await this.purchasing.receiveGoods(
        tenantId,
        branchId,
        userId,
        access,
        delivery,
        idempotencyKey,
      );
    } catch (error) {
      // A cost or expiry question (or any refusal) goes back to the approver to answer; the
      // delivery waits for them exactly as before.
      await this.prisma.heldDelivery.updateMany({
        where: { id, tenantId, branchId, status: HeldDeliveryStatus.accepted, goodsReceiptId: null },
        data: { status: HeldDeliveryStatus.awaiting_approval, decidedBy: null, decidedAt: null, corrected: false },
      });
      throw error;
    }
    if (!receipt) throw new BadRequestException("The delivery could not be booked in");

    const row = await this.prisma.heldDelivery.update({
      where: { id, tenantId },
      data: { goodsReceiptId: receipt.id },
      include: HELD_INCLUDE,
    });

    await this.notifications.notifyUser(
      tenantId,
      held.requestedBy,
      NotificationCategory.purchasing,
      {
        severity: NotificationSeverity.info,
        title: `${held.purchaseOrder.poNumber}: your delivery was accepted`,
        message: corrected
          ? `It was booked in as ${receipt.grnNumber}, with corrections — open the order to see what changed.`
          : `It was booked in as ${receipt.grnNumber}.`,
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
      eventName: "purchase_order.held_delivery_accepted",
      entityName: "purchase_order",
      entityId: held.purchaseOrderId,
      payload: { heldDeliveryId: id, goodsReceiptId: receipt.id, corrected },
    });
    return this.map(row, access.has("costs.view"));
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
    if (held.status !== HeldDeliveryStatus.awaiting_approval) {
      throw new ConflictException("This delivery has already been decided — refresh to see it");
    }
    const reason = dto.reason.trim();
    const claimed = await this.prisma.heldDelivery.updateMany({
      where: { id, tenantId, branchId, status: HeldDeliveryStatus.awaiting_approval },
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
    await this.notifications.notifyUser(
      tenantId,
      held.requestedBy,
      NotificationCategory.purchasing,
      {
        severity: NotificationSeverity.warning,
        title: `${held.purchaseOrder.poNumber}: your delivery was not accepted`,
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

  private async load(tenantId: string, branchId: string, id: string): Promise<HeldRow> {
    const row = await this.prisma.heldDelivery.findFirst({
      where: { id, tenantId, branchId },
      include: HELD_INCLUDE,
    });
    if (!row) throw new NotFoundException("Held delivery not found");
    return row;
  }

  /** Costs the receiver typed follow the cost permission, like every other cost in Purchasing. */
  private map(row: HeldRow, canViewCost: boolean) {
    const payload = row.payload as unknown as ReceiveGoodsDto;
    return {
      id: row.id,
      status: row.status,
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
