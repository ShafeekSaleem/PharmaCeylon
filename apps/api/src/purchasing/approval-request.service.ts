import { Injectable, NotFoundException } from "@nestjs/common";
import { NotificationCategory, NotificationSeverity } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestApprovalDto } from "./dto/request-approval.dto";

/** How long a repeat request for the same order and reason is treated as the same request. */
const REPEAT_WINDOW_MS = 10 * 60_000;

const WHAT: Record<RequestApprovalDto["kind"], string> = {
  over_delivery: "more arrived than was ordered",
  price_variance: "it is billed above the price the order agreed",
};

/**
 * Asking someone who can approve to look at a delivery the receiver may not book in themselves.
 *
 * Over-delivery beyond the tolerance and a price above the agreed one both need
 * `purchasing.approve`. A storekeeper who hits either used to be stuck with a prompt offering
 * an "accept" they were not allowed to give; this sends the decision to the people who can make
 * it, at this branch, as a notification that opens the order. Nothing is booked in — the
 * approver receives the delivery themselves once they have looked.
 */
@Injectable()
export class PurchaseApprovalRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async request(
    tenantId: string,
    branchId: string,
    userId: string,
    purchaseOrderId: string,
    dto: RequestApprovalDto,
  ): Promise<{ notified: number; alreadyAsked: boolean }> {
    const po = await this.prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, tenantId, branchId },
      select: { id: true, poNumber: true, supplier: { select: { name: true } } },
    });
    if (!po) throw new NotFoundException("Purchase order not found");

    // A second click, or a retry after a dropped connection, should not ping every manager
    // again for the same question.
    const recent = await this.prisma.auditEvent.findFirst({
      where: {
        tenantId,
        actorUserId: userId,
        eventName: "purchase_order.approval_requested",
        entityId: po.id,
        createdAt: { gte: new Date(Date.now() - REPEAT_WINDOW_MS) },
      },
      select: { payload: true },
      orderBy: { createdAt: "desc" },
    });
    if (recent && (recent.payload as { kind?: string } | null)?.kind === dto.kind) {
      return { notified: 0, alreadyAsked: true };
    }

    const requester = await this.prisma.appUser.findFirst({
      where: { id: userId },
      select: { fullName: true, email: true },
    });
    const who = requester?.fullName || requester?.email || "A colleague";

    const notified = await this.notifications.notifyByPermission(
      tenantId,
      "purchasing.approve",
      NotificationCategory.purchasing,
      {
        severity: NotificationSeverity.warning,
        title: `${po.poNumber} is waiting for your approval`,
        message: `${who} is receiving a delivery from ${po.supplier.name}, and ${WHAT[dto.kind]}. ${dto.detail.trim()}`,
        actionLabel: "Open the order",
        actionHref: `/purchasing?po=${po.id}`,
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
      eventName: "purchase_order.approval_requested",
      entityName: "purchase_order",
      entityId: po.id,
      payload: { kind: dto.kind, detail: dto.detail.trim(), notified },
    });

    return { notified, alreadyAsked: false };
  }
}
