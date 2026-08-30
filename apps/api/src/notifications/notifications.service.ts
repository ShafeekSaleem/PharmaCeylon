import { Injectable, NotFoundException } from "@nestjs/common";
import {
  NotificationCategory,
  NotificationPreference,
  NotificationSeverity,
  PoStatus,
  Prisma,
  RoleName,
  StocktakeStatus,
  TransferStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PERMISSION_KEYS } from "../security/permission-catalog";
import { PermissionsService } from "../security/permissions.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ListNotificationsDto } from "./dto/list-notifications.dto";
import { UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";

const OPERATIONAL_SOURCE = "operational_scan";
const MAX_ACTION_ITEMS = 25;

type Preferences = NotificationPreference;

type DesiredNotification = {
  dedupeKey: string;
  branchId: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  title: string;
  message?: string;
  actionLabel: string;
  actionHref: string;
  entityType?: string;
  entityId?: string;
  requiresAction: boolean;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class NotificationsService {
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async list(
    user: RequestUser,
    branchId: string | undefined,
    query: ListNotificationsDto,
  ) {
    await this.refreshOperationalNotifications(user, branchId);
    const where = this.buildWhere(user.tenantId, user.userId, branchId, query);
    const baseWhere = this.buildWhere(user.tenantId, user.userId, branchId, {
      ...query,
      status: "all",
    });
    const take = query.take ?? 30;
    const skip = query.skip ?? 0;

    const [items, filteredTotal, total, unread, actionRequired] =
      await Promise.all([
        this.prisma.notification.findMany({
          where,
          orderBy: [{ requiresAction: "desc" }, { createdAt: "desc" }],
          skip,
          take,
          include: { branch: { select: { id: true, name: true, code: true } } },
        }),
        this.prisma.notification.count({ where }),
        this.prisma.notification.count({
          where: baseWhere,
        }),
        this.prisma.notification.count({
          where: { ...baseWhere, readAt: null },
        }),
        this.prisma.notification.count({
          where: { ...baseWhere, requiresAction: true },
        }),
      ]);

    return { items, filteredTotal, total, unread, actionRequired, skip, take };
  }

  async unreadCount(user: RequestUser, branchId?: string) {
    await this.refreshOperationalNotifications(user, branchId);
    const unread = await this.prisma.notification.count({
      where: {
        tenantId: user.tenantId,
        recipientUserId: user.userId,
        archivedAt: null,
        resolvedAt: null,
        readAt: null,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
    });
    return { unread };
  }

  async getPreferences(tenantId: string, userId: string) {
    return this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { tenantId, userId },
      update: {},
    });
  }

  async updatePreferences(
    tenantId: string,
    userId: string,
    dto: UpdateNotificationPreferencesDto,
  ) {
    const preferences = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { tenantId, userId, ...dto },
      update: dto,
    });
    this.clearRefreshThrottle(userId);
    return preferences;
  }

  async markRead(tenantId: string, userId: string, id: string) {
    const current = await this.findOwned(tenantId, userId, id);
    if (current.readAt) return current;
    return this.prisma.notification.update({
      where: { id, tenantId, recipientUserId: userId },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(tenantId: string, userId: string, branchId?: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        tenantId,
        recipientUserId: userId,
        archivedAt: null,
        resolvedAt: null,
        readAt: null,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      },
      data: { readAt: new Date() },
    });
    return { updated: result.count };
  }

  async archive(tenantId: string, userId: string, id: string) {
    await this.findOwned(tenantId, userId, id);
    return this.prisma.notification.update({
      where: { id, tenantId, recipientUserId: userId },
      data: { archivedAt: new Date(), readAt: new Date() },
    });
  }

  private async findOwned(tenantId: string, userId: string, id: string) {
    const row = await this.prisma.notification.findFirst({
      where: { id, tenantId, recipientUserId: userId },
    });
    if (!row) throw new NotFoundException("Notification not found");
    return row;
  }

  private buildWhere(
    tenantId: string,
    userId: string,
    branchId: string | undefined,
    query: ListNotificationsDto,
  ): Prisma.NotificationWhereInput {
    const q = query.q?.trim();
    return {
      tenantId,
      recipientUserId: userId,
      archivedAt: null,
      resolvedAt: null,
      ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
      ...(query.status === "unread" ? { readAt: null } : {}),
      ...(query.status === "action_required" ? { requiresAction: true } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(q
        ? {
            AND: [
              {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { message: { contains: q, mode: "insensitive" } },
                ],
              },
            ],
          }
        : {}),
    };
  }

  private clearRefreshThrottle(userId: string) {
    for (const key of this.lastRefreshAt.keys()) {
      if (key.startsWith(`${userId}:`)) this.lastRefreshAt.delete(key);
    }
  }

  /**
   * Keeps durable operational alerts in sync without requiring a separate scheduler in v1.
   * Header/page polling invokes this at most once per user+branch every 20 seconds. Dedupe
   * keys update an existing condition; conditions that disappear are resolved automatically.
   */
  private async refreshOperationalNotifications(
    user: RequestUser,
    branchId?: string,
  ) {
    if (!branchId) return;
    const throttleKey = `${user.userId}:${branchId}`;
    const now = Date.now();
    if (now - (this.lastRefreshAt.get(throttleKey) ?? 0) < 20_000) return;
    this.lastRefreshAt.set(throttleKey, now);

    const [granted, preferences] = await Promise.all([
      this.grantedPermissions(user, branchId),
      this.getPreferences(user.tenantId, user.userId),
    ]);
    const desired = await this.collectOperationalNotifications(
      user.tenantId,
      branchId,
      granted,
      preferences,
    );
    const desiredKeys = new Set(desired.map((item) => item.dedupeKey));
    const existing = await this.prisma.notification.findMany({
      where: {
        tenantId: user.tenantId,
        recipientUserId: user.userId,
        branchId,
        source: OPERATIONAL_SOURCE,
        archivedAt: null,
      },
      select: { id: true, dedupeKey: true, resolvedAt: true },
    });

    await this.prisma.$transaction([
      ...desired.map((item) => {
        const prior = existing.find((row) => row.dedupeKey === item.dedupeKey);
        const data = {
          branchId: item.branchId,
          category: item.category,
          severity: item.severity,
          title: item.title,
          message: item.message ?? null,
          actionLabel: item.actionLabel,
          actionHref: item.actionHref,
          entityType: item.entityType ?? null,
          entityId: item.entityId ?? null,
          requiresAction: item.requiresAction,
          metadata: item.metadata ?? Prisma.JsonNull,
          source: OPERATIONAL_SOURCE,
          resolvedAt: null,
          ...(prior?.resolvedAt
            ? { readAt: null, archivedAt: null, createdAt: new Date() }
            : {}),
        };
        return this.prisma.notification.upsert({
          where: {
            tenantId_recipientUserId_dedupeKey: {
              tenantId: user.tenantId,
              recipientUserId: user.userId,
              dedupeKey: item.dedupeKey,
            },
          },
          create: {
            tenantId: user.tenantId,
            recipientUserId: user.userId,
            dedupeKey: item.dedupeKey,
            ...data,
          },
          update: data,
        });
      }),
      ...existing
        .filter(
          (row) => !desiredKeys.has(row.dedupeKey) && row.resolvedAt == null,
        )
        .map((row) =>
          this.prisma.notification.update({
            where: {
              id: row.id,
              tenantId: user.tenantId,
              recipientUserId: user.userId,
            },
            data: { resolvedAt: new Date() },
          }),
        ),
    ]);
  }

  private async grantedPermissions(user: RequestUser, branchId: string) {
    const candidates = user.branchRoles.filter(
      (entry) => entry.branchId === branchId,
    );
    if (candidates.some((entry) => entry.role === RoleName.owner)) {
      return new Set(PERMISSION_KEYS);
    }
    return this.permissions.resolveGrantedKeys(candidates);
  }

  private async collectOperationalNotifications(
    tenantId: string,
    branchId: string,
    granted: Set<string>,
    preferences: Preferences,
  ): Promise<DesiredNotification[]> {
    const jobs: Array<Promise<DesiredNotification[]>> = [];
    if (granted.has("inventory.view")) {
      if (preferences.inventoryEnabled)
        jobs.push(this.lowStockNotifications(tenantId, branchId));
      if (preferences.expiryEnabled)
        jobs.push(this.expiryNotifications(tenantId, branchId));
    }
    if (preferences.purchasingEnabled && granted.has("purchasing.view")) {
      jobs.push(
        this.purchaseOrderNotifications(
          tenantId,
          branchId,
          granted.has("purchasing.approve"),
        ),
      );
    }
    if (preferences.transfersEnabled && granted.has("transfers.view")) {
      jobs.push(
        this.transferNotifications(
          tenantId,
          branchId,
          granted.has("transfers.approve"),
        ),
      );
    }
    if (preferences.stocktakesEnabled && granted.has("stocktakes.use")) {
      jobs.push(
        this.stocktakeNotifications(
          tenantId,
          branchId,
          granted.has("stocktakes.review"),
        ),
      );
    }
    return (await Promise.all(jobs)).flat();
  }

  private async lowStockNotifications(tenantId: string, branchId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { lowStockThresholdUnits: true },
    });
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, branchId },
      _sum: { qtyDelta: true },
    });
    if (!grouped.length) return [];
    const products = await this.prisma.product.findMany({
      where: {
        tenantId,
        isActive: true,
        id: { in: grouped.map((row) => row.productId) },
      },
      select: { id: true, reorderLevel: true },
    });
    const qty = new Map(
      grouped.map((row) => [row.productId, row._sum.qtyDelta ?? 0]),
    );
    const fallback = settings?.lowStockThresholdUnits ?? 20;
    const affected = products.filter((product) => {
      const threshold =
        product.reorderLevel > 0 ? product.reorderLevel : fallback;
      return (qty.get(product.id) ?? 0) <= threshold;
    });
    if (!affected.length) return [];
    const outCount = affected.filter(
      (product) => (qty.get(product.id) ?? 0) <= 0,
    ).length;
    return [
      {
        dedupeKey: `operational:${branchId}:inventory:low-stock`,
        branchId,
        category: NotificationCategory.inventory,
        severity:
          outCount > 0
            ? NotificationSeverity.critical
            : NotificationSeverity.warning,
        title: `${affected.length} product${affected.length === 1 ? " is" : "s are"} low on stock`,
        message:
          outCount > 0
            ? `${outCount} ${outCount === 1 ? "product is" : "products are"} currently out of stock.`
            : "Review reorder levels and create purchase orders where needed.",
        actionLabel: "Review stock",
        actionHref: "/inventory?view=low",
        entityType: "inventory_alert",
        requiresAction: true,
        metadata: { affectedCount: affected.length, outCount },
      },
    ];
  }

  private async expiryNotifications(tenantId: string, branchId: string) {
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { expiryWarningDays: true },
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const horizon = new Date(today);
    horizon.setDate(horizon.getDate() + (settings?.expiryWarningDays ?? 30));
    const batches = await this.prisma.batch.findMany({
      where: { tenantId, branchId, expiryDate: { lte: horizon } },
      select: { id: true, expiryDate: true },
    });
    if (!batches.length) return [];
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["batchId"],
      where: {
        tenantId,
        branchId,
        batchId: { in: batches.map((batch) => batch.id) },
      },
      _sum: { qtyDelta: true },
    });
    const qty = new Map(
      grouped.map((row) => [row.batchId, row._sum.qtyDelta ?? 0]),
    );
    const affected = batches.filter((batch) => (qty.get(batch.id) ?? 0) > 0);
    if (!affected.length) return [];
    const expiredCount = affected.filter(
      (batch) => batch.expiryDate < today,
    ).length;
    return [
      {
        dedupeKey: `operational:${branchId}:expiry:warning`,
        branchId,
        category: NotificationCategory.expiry,
        severity:
          expiredCount > 0
            ? NotificationSeverity.critical
            : NotificationSeverity.warning,
        title: `${affected.length} stocked batch${affected.length === 1 ? "" : "es"} need expiry review`,
        message:
          expiredCount > 0
            ? `${expiredCount} expired ${expiredCount === 1 ? "batch still has" : "batches still have"} on-hand stock.`
            : `These batches expire within ${settings?.expiryWarningDays ?? 30} days.`,
        actionLabel: "Review batches",
        actionHref: `/inventory/batches?nearExpiryDays=${settings?.expiryWarningDays ?? 30}`,
        entityType: "expiry_alert",
        requiresAction: true,
        metadata: { affectedCount: affected.length, expiredCount },
      },
    ];
  }

  private async purchaseOrderNotifications(
    tenantId: string,
    branchId: string,
    canApprove: boolean,
  ) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        tenantId,
        branchId,
        OR: [
          ...(canApprove ? [{ status: PoStatus.pending_approval }] : []),
          {
            status: { in: [PoStatus.issued, PoStatus.partially_received] },
            expectedOn: { lt: today },
          },
        ],
      },
      include: { supplier: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: MAX_ACTION_ITEMS,
    });
    return rows.map<DesiredNotification>((row) => {
      const pending = row.status === PoStatus.pending_approval;
      return {
        dedupeKey: `operational:${branchId}:purchasing:${row.id}:${row.status}`,
        branchId,
        category: NotificationCategory.purchasing,
        severity: pending
          ? NotificationSeverity.warning
          : NotificationSeverity.critical,
        title: pending
          ? `${row.poNumber} requires approval`
          : `${row.poNumber} is overdue`,
        message: `${row.supplier.name}${row.expectedOn ? ` · Expected ${row.expectedOn.toISOString().slice(0, 10)}` : ""}`,
        actionLabel: pending ? "Review order" : "Open order",
        actionHref: `/purchasing?po=${row.id}`,
        entityType: "purchase_order",
        entityId: row.id,
        requiresAction: true,
      };
    });
  }

  private async transferNotifications(
    tenantId: string,
    branchId: string,
    canApprove: boolean,
  ) {
    const rows = await this.prisma.transfer.findMany({
      where: {
        tenantId,
        OR: [
          ...(canApprove
            ? [{ fromBranchId: branchId, status: TransferStatus.requested }]
            : []),
          {
            toBranchId: branchId,
            status: {
              in: [
                TransferStatus.in_transit,
                TransferStatus.partially_received,
              ],
            },
          },
        ],
      },
      include: {
        fromBranch: { select: { name: true } },
        toBranch: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ACTION_ITEMS,
    });
    return rows.map<DesiredNotification>((row) => {
      const pending = row.status === TransferStatus.requested;
      return {
        dedupeKey: `operational:${branchId}:transfers:${row.id}:${row.status}`,
        branchId,
        category: NotificationCategory.transfers,
        severity: pending
          ? NotificationSeverity.warning
          : NotificationSeverity.info,
        title: pending
          ? `${row.transferNumber} requires approval`
          : `${row.transferNumber} is ready to receive`,
        message: `${row.fromBranch.name} → ${row.toBranch.name}`,
        actionLabel: pending ? "Review transfer" : "Receive transfer",
        actionHref: `/transfers?transfer=${row.id}`,
        entityType: "transfer",
        entityId: row.id,
        requiresAction: true,
      };
    });
  }

  private async stocktakeNotifications(
    tenantId: string,
    branchId: string,
    canReview: boolean,
  ) {
    if (!canReview) return [];
    const rows = await this.prisma.stocktake.findMany({
      where: {
        tenantId,
        branchId,
        status: { in: [StocktakeStatus.submitted, StocktakeStatus.approved] },
      },
      orderBy: { updatedAt: "desc" },
      take: MAX_ACTION_ITEMS,
    });
    return rows.map<DesiredNotification>((row) => ({
      dedupeKey: `operational:${branchId}:stocktakes:${row.id}:${row.status}`,
      branchId,
      category: NotificationCategory.stocktakes,
      severity: NotificationSeverity.warning,
      title:
        row.status === StocktakeStatus.submitted
          ? `${row.stocktakeNumber} is awaiting review`
          : `${row.stocktakeNumber} is ready to post`,
      message: row.title ?? row.areaLabel ?? "Stocktake action is required.",
      actionLabel:
        row.status === StocktakeStatus.submitted
          ? "Review count"
          : "Post stocktake",
      actionHref: `/stocktakes/${row.id}`,
      entityType: "stocktake",
      entityId: row.id,
      requiresAction: true,
    }));
  }
}
