import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import type { CommandProvenance } from "../terminals/command-provenance";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import { ApproveHeldDto, PostHeldDto } from "../security/dto/approve-held.dto";
import { heldAdjustmentMaterial, heldReview } from "../security/held-approval-material";
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
import { AccessService, type ActorAccess } from "../security/access.service";
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
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
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
      where: { tenantId, branchId, status: { in: [HeldAdjustmentStatus.awaiting_approval, HeldAdjustmentStatus.approved] } },
      include: HELD_INCLUDE,
      orderBy: { requestedAt: "desc" },
    });
    return rows.map((row) => this.map(row, canViewCost));
  }

  async accept(user: RequestUser, branchId: string, id: string, input: ApproveHeldDto) {
    let changed = false;
    const actor = await this.prisma.$transaction(async tx => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      if (!["awaiting_approval", "approved"].includes(row.status)) throw new ConflictException("This write-off has already been decided");
      const actor = await this.access.resolveLive(user, branchId, tx);
      const evidence = await this.approvals.issue(tx, user, branchId, "held_adjustment.post", id,
        { ...input, reason: "Approve the held write-off", expiresAt: null });
      if (row.status === "approved" && row.executionApprovalId === evidence.approvalId) return actor;
      await tx.heldAdjustment.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
        status: "approved", executionApprovalId: evidence.approvalId, decidedBy: user.userId, decidedAt: new Date(),
      } });
      await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
        eventName: "inventory.write_off_approved", entityName: "held_adjustment", entityId: id,
        payload: { approvalId: evidence.approvalId, requestedByUserId: row.requestedBy, stockPosted: false } }, tx);
      await this.resolveRequests(user.tenantId, id, tx);
      changed = true;
      return actor;
    });
    const row = await this.load(user.tenantId, branchId, id);
    if (changed) await this.notifications.notifyUser(user.tenantId, row.requestedBy, NotificationCategory.inventory, {
      severity: NotificationSeverity.info, title: "Write-off approved", message: "The write-off is approved. Stock remains unchanged until it is posted.",
      actionLabel: "Open request", actionHref: `/inventory?heldAdjustment=${id}`, entityType: "held_adjustment", entityId: id,
    }, { branchId });
    return this.map(row, actor.has("costs.view"));
  }

  async post(user: RequestUser, branchId: string, id: string, input: PostHeldDto) {
    const { actor, changed } = await this.prisma.$transaction(tx => this.postInTransaction(tx, user, branchId, id, input));
    if (changed) await this.notifyPosted(user.tenantId, branchId, id);
    return this.map(await this.load(user.tenantId, branchId, id), actor.has("costs.view"));
  }

  /** Posting core shared by the browser route and the signed terminal executor, in the caller's
   * READ COMMITTED transaction. `command` is verified provenance copied into the success audit.
   */
  async postInTransaction(tx: Prisma.TransactionClient, user: RequestUser, branchId: string, id: string,
    input: PostHeldDto, command?: CommandProvenance) {
    const row = await this.lock(tx, user.tenantId, branchId, id);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has("inventory.write_off")) throw new ForbiddenException("Your role cannot post write-offs");
    if (row.executionApprovalId !== input.approvalId) throw new ConflictException("Approval changed; refresh and review before posting");
    if (row.status === "accepted" && row.referenceId)
      return { actor, changed: false, approvalId: row.executionApprovalId, referenceId: row.referenceId };
    if (row.status !== "approved" || !row.executionApprovalId) throw new ConflictException("Approve this write-off before posting");
    const authorize = () => this.approvals.requireForExecution(tx, user, branchId, "held_adjustment.post", id, row.executionApprovalId!);
    const evidence = await authorize();
    const payload = row.payload as unknown as StockAdjustmentDto;
    if (payload.productId !== row.productId || payload.batchId !== row.batchId || payload.qty !== row.qty
      || (payload.kind ?? "correction") !== row.kind || ["found", "opening"].includes(row.kind)
      || payload.newBatch || payload.movementType !== "adjustment_out") throw new BadRequestException("Invalid saved write-off");
    const posted = await this.inventory.adjustment(user.tenantId, branchId, actor, payload, { tx, authorize });
    await tx.heldAdjustment.update({ where: { id, tenantId: user.tenantId, branchId }, data: {
      status: "accepted", referenceId: posted.referenceId, executedBy: user.userId, executedAt: new Date(),
    } });
    await this.audit.log({ tenantId: user.tenantId, branchId, actorUserId: user.userId,
      eventName: "inventory.write_off_posted", entityName: "held_adjustment", entityId: id,
      payload: { approvalId: evidence.approvalId, referenceId: posted.referenceId,
        requestedByUserId: row.requestedBy, approvedByUserId: evidence.approvedByUserId, executedByUserId: user.userId,
        ...(command ? { command } : {}) } }, tx);
    return { actor, changed: true, approvalId: evidence.approvalId, referenceId: posted.referenceId };
  }

  /** After commit only: the requester learns stock actually moved. */
  async notifyPosted(tenantId: string, branchId: string, id: string) {
    const row = await this.load(tenantId, branchId, id);
    await this.notifications.notifyUser(tenantId, row.requestedBy, NotificationCategory.inventory, {
      severity: NotificationSeverity.info, title: "Write-off posted", message: "The approved write-off has been posted to inventory.",
      actionLabel: "Open request", actionHref: `/inventory?heldAdjustment=${id}`, entityType: "held_adjustment", entityId: id,
    }, { branchId });
  }

  private async lock(tx: Prisma.TransactionClient, tenantId: string, branchId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM held_adjustment WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    return this.load(tenantId, branchId, id, tx);
  }

  async reject(tenantId: string, branchId: string, access: ActorAccess, id: string, reason: string) {
    const held = await this.load(tenantId, branchId, id);
    if (![HeldAdjustmentStatus.awaiting_approval, HeldAdjustmentStatus.approved].includes(held.status as "awaiting_approval" | "approved")) {
      throw new ConflictException("This write-off has already been decided — refresh to see it");
    }
    const note = reason.trim();
    if (!note) throw new BadRequestException("Say why it's rejected");
    const claimed = await this.prisma.heldAdjustment.updateMany({
      where: { id, tenantId, branchId, status: { in: [HeldAdjustmentStatus.awaiting_approval, HeldAdjustmentStatus.approved] } },
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

  private async resolveRequests(tenantId: string, id: string, tx: Prisma.TransactionClient = this.prisma) {
    await tx.notification.updateMany({
      where: { tenantId, entityType: "held_adjustment", entityId: id, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  private async load(tenantId: string, branchId: string, id: string, tx: Prisma.TransactionClient = this.prisma): Promise<HeldRow> {
    const row = await tx.heldAdjustment.findFirst({
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
      referenceId: row.referenceId, executionApprovalId: row.executionApprovalId,
      executedBy: row.executedBy, executedAt: row.executedAt?.toISOString() ?? null,
      approvalReview: heldReview("held_adjustment", row.approvalVersion, heldAdjustmentMaterial(row)),
      kind: row.kind,
      kindLabel: ADJUSTMENT_KIND_LABELS[row.kind as AdjustmentKind] ?? row.kind,
      qty: row.qty,
      requestReason: (row.payload as unknown as StockAdjustmentDto).reason ?? null,
      fromQuarantine: (row.payload as unknown as StockAdjustmentDto).fromQuarantine === true,
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
