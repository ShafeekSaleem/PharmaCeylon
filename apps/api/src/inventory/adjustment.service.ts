import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  HeldAdjustmentStatus,
  NotificationCategory,
  NotificationSeverity,
  Prisma,
  StockMovementType,
} from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { businessToday, safeTimeZone } from "../common/business-date.util";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import {
  ADJUSTMENT_KIND_LABELS,
  ADJUSTMENT_KINDS,
  type AdjustmentKind,
  StockAdjustmentDto,
} from "./dto/stock-adjustment.dto";
import { InventoryService } from "./inventory.service";

const HELD_INCLUDE = {
  product: { select: { id: true, sku: true, name: true } },
  batch: { select: { id: true, batchNo: true, expiryDate: true } },
  requester: { select: { id: true, fullName: true } },
  decider: { select: { id: true, fullName: true } },
} satisfies Prisma.HeldAdjustmentInclude;

type HeldRow = Prisma.HeldAdjustmentGetPayload<{ include: typeof HELD_INCLUDE }>;

/**
 * Stock adjustments, with a second pair of eyes on write-offs.
 *
 * Adding stock posts straight away for anyone who may manage inventory. A write-off posts straight
 * away only for someone who may write off stock — and, when it is worth at least the tenant's
 * write-off threshold, only if their role may also approve its own requests. Anyone else's
 * write-off (a clerk recording breakage, a manager held to a second approver) is kept exactly as
 * entered until someone who may write off stock accepts it. Nothing moves until then.
 */
@Injectable()
export class AdjustmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  async adjust(tenantId: string, branchId: string, access: ActorAccess, dto: StockAdjustmentDto) {
    const increase =
      dto.kind && dto.kind !== "correction"
        ? dto.kind === "found" || dto.kind === "opening"
        : dto.movementType === "adjustment_in";
    if (increase) {
      return { held: false as const, ...(await this.inventory.adjustment(tenantId, branchId, access, dto)) };
    }

    const canWriteOff = access.has("inventory.write_off");
    if (!canWriteOff && !access.has("inventory.manage")) {
      throw new ForbiddenException("Your role can't adjust stock");
    }
    if (!dto.batchId) throw new BadRequestException("Choose the batch to write off");
    const batch = await this.prisma.batch.findFirst({
      where: { id: dto.batchId, tenantId, branchId, productId: dto.productId },
      select: { id: true, costPrice: true },
    });
    if (!batch) throw new BadRequestException("Invalid batch");
    const value = batch.costPrice.mul(dto.qty);

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredWriteOffThreshold: true },
    });
    const threshold = settings?.approvalRequiredWriteOffThreshold ?? null;
    const overLimit = threshold != null && value.gte(threshold);
    const needsApproval = !canWriteOff || (overLimit && !access.canSelfApprove);
    if (!needsApproval) {
      return { held: false as const, ...(await this.inventory.adjustment(tenantId, branchId, access, dto)) };
    }

    if (dto.kind === "correction" && !dto.reason?.trim()) {
      throw new BadRequestException("Say what the correction is for");
    }
    const kind: AdjustmentKind = dto.kind ?? "correction";
    const row = await this.prisma.heldAdjustment.create({
      data: {
        tenantId,
        branchId,
        productId: dto.productId,
        batchId: batch.id,
        kind,
        qty: dto.qty,
        value,
        note: dto.reason?.trim() || null,
        payload: { ...dto, movementType: "adjustment_out" } as unknown as Prisma.InputJsonValue,
        requestedBy: access.userId,
      },
      include: HELD_INCLUDE,
    });

    const notified = await this.notifications.notifyByPermission(
      tenantId,
      "inventory.write_off",
      NotificationCategory.inventory,
      {
        severity: NotificationSeverity.warning,
        title: `Approve a write-off · ${row.product.name}`,
        message: `${row.requester.fullName || "A colleague"} · ${ADJUSTMENT_KIND_LABELS[kind]} · ${dto.qty} unit${dto.qty === 1 ? "" : "s"} of batch ${row.batch.batchNo}${row.note ? ` · ${row.note}` : ""}`,
        actionLabel: "Review the write-off",
        actionHref: `/inventory?heldAdjustment=${row.id}`,
        entityType: "held_adjustment",
        entityId: row.id,
        requiresAction: true,
      },
      access.userId,
      { branchId },
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: access.userId,
      eventName: "inventory.write_off_held",
      entityName: "product",
      entityId: dto.productId,
      payload: { heldAdjustmentId: row.id, kind, qty: dto.qty, value: value.toFixed(2), notified },
    });
    return { held: true as const, heldAdjustment: this.map(row, access.has("costs.view")), notified };
  }

  async listHeld(tenantId: string, branchId: string, canViewCost: boolean) {
    const rows = await this.prisma.heldAdjustment.findMany({
      where: { tenantId, branchId, status: HeldAdjustmentStatus.awaiting_approval },
      include: HELD_INCLUDE,
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((row) => this.map(row, canViewCost));
  }

  async accept(tenantId: string, branchId: string, access: ActorAccess, id: string) {
    const held = await this.load(tenantId, branchId, id);
    if (held.status !== HeldAdjustmentStatus.awaiting_approval) {
      throw new ConflictException("This write-off has already been decided — refresh to see it");
    }
    assertMayApprove(access, [held.requestedBy], "write-off");
    const claimed = await this.prisma.heldAdjustment.updateMany({
      where: { id, tenantId, branchId, status: HeldAdjustmentStatus.awaiting_approval },
      data: { status: HeldAdjustmentStatus.accepted, decidedBy: access.userId, decidedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Someone else is deciding this write-off — refresh to see it");
    }
    let posted: { referenceId: string };
    try {
      posted = await this.inventory.adjustment(
        tenantId,
        branchId,
        access,
        held.payload as unknown as StockAdjustmentDto,
      );
    } catch (error) {
      // Not enough stock any more, say: it goes back to waiting with nothing posted.
      await this.prisma.heldAdjustment.updateMany({
        where: { id, tenantId, branchId, status: HeldAdjustmentStatus.accepted, referenceId: null },
        data: { status: HeldAdjustmentStatus.awaiting_approval, decidedBy: null, decidedAt: null },
      });
      throw error;
    }
    await this.prisma.heldAdjustment.update({
      where: { id, tenantId },
      data: { referenceId: posted.referenceId },
    });
    await this.resolveRequests(tenantId, id);
    await this.notifications.notifyUser(
      tenantId,
      held.requestedBy,
      NotificationCategory.inventory,
      {
        severity: NotificationSeverity.info,
        title: `Write-off approved · ${held.product.name}`,
        message: `${held.qty} unit${held.qty === 1 ? "" : "s"} of batch ${held.batch.batchNo} written off.`,
        actionLabel: "Open inventory",
        actionHref: `/inventory/movements`,
        entityType: "product",
        entityId: held.productId,
      },
      { branchId },
    );
    return this.map(await this.load(tenantId, branchId, id), access.has("costs.view"));
  }

  async reject(tenantId: string, branchId: string, access: ActorAccess, id: string, reason: string) {
    const held = await this.load(tenantId, branchId, id);
    if (held.status !== HeldAdjustmentStatus.awaiting_approval) {
      throw new ConflictException("This write-off has already been decided — refresh to see it");
    }
    const note = reason.trim();
    if (!note) throw new BadRequestException("Say why it's rejected");
    const claimed = await this.prisma.heldAdjustment.updateMany({
      where: { id, tenantId, branchId, status: HeldAdjustmentStatus.awaiting_approval },
      data: {
        status: HeldAdjustmentStatus.rejected,
        decidedBy: access.userId,
        decidedAt: new Date(),
        decisionNote: note,
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Someone else is deciding this write-off — refresh to see it");
    }
    await this.resolveRequests(tenantId, id);
    await this.notifications.notifyUser(
      tenantId,
      held.requestedBy,
      NotificationCategory.inventory,
      {
        severity: NotificationSeverity.warning,
        title: `Write-off rejected · ${held.product.name}`,
        message: note,
        entityType: "product",
        entityId: held.productId,
      },
      { branchId },
    );
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: access.userId,
      eventName: "inventory.write_off_rejected",
      entityName: "product",
      entityId: held.productId,
      payload: { heldAdjustmentId: id, reason: note },
    });
    return this.map(await this.load(tenantId, branchId, id), access.has("costs.view"));
  }

  /**
   * What was written off this month, by what happened — units, and value for those who may see
   * cost. Read from the ledger, so it counts what actually posted.
   */
  async writeOffPolicy(tenantId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredWriteOffThreshold: true },
    });
    return { threshold: settings?.approvalRequiredWriteOffThreshold?.toFixed(2) ?? null };
  }

  async writeOffSummary(tenantId: string, branchId: string, canViewCost: boolean) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const today = businessToday(safeTimeZone(tenant?.timezone));
    const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const rows = await this.prisma.stockLedger.findMany({
      where: {
        tenantId,
        branchId,
        movementType: StockMovementType.adjustment_out,
        occurredAt: { gte: monthStart },
      },
      select: { reasonCode: true, qtyDelta: true, batch: { select: { costPrice: true } } },
    });
    const byKind = new Map<string, { units: number; value: Prisma.Decimal }>();
    for (const row of rows) {
      const key = row.reasonCode && (ADJUSTMENT_KINDS as readonly string[]).includes(row.reasonCode)
        ? row.reasonCode
        : "other";
      const entry = byKind.get(key) ?? { units: 0, value: new Prisma.Decimal(0) };
      const units = Math.abs(row.qtyDelta);
      entry.units += units;
      entry.value = entry.value.add((row.batch?.costPrice ?? new Prisma.Decimal(0)).mul(units));
      byKind.set(key, entry);
    }
    return {
      since: monthStart.toISOString().slice(0, 10),
      rows: [...byKind.entries()].map(([kind, entry]) => ({
        kind,
        label: kind === "other" ? "Other" : ADJUSTMENT_KIND_LABELS[kind as AdjustmentKind],
        units: entry.units,
        value: canViewCost ? entry.value.toFixed(2) : null,
      })),
    };
  }

  private async resolveRequests(tenantId: string, id: string) {
    await this.prisma.notification.updateMany({
      where: { tenantId, entityType: "held_adjustment", entityId: id, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  private async load(tenantId: string, branchId: string, id: string): Promise<HeldRow> {
    const row = await this.prisma.heldAdjustment.findFirst({
      where: { id, tenantId, branchId },
      include: HELD_INCLUDE,
    });
    if (!row) throw new NotFoundException("Write-off not found");
    return row;
  }

  private map(row: HeldRow, canViewCost: boolean) {
    return {
      id: row.id,
      status: row.status,
      kind: row.kind,
      kindLabel: ADJUSTMENT_KIND_LABELS[row.kind as AdjustmentKind] ?? row.kind,
      qty: row.qty,
      value: canViewCost ? row.value.toFixed(2) : null,
      note: row.note,
      product: row.product,
      batch: { id: row.batch.id, batchNo: row.batch.batchNo, expiryDate: row.batch.expiryDate.toISOString() },
      requester: row.requester,
      requestedAt: row.requestedAt.toISOString(),
      decider: row.decider,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
    };
  }
}
