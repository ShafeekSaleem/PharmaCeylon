import { randomUUID } from "crypto";
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
import type {
  CounterAlertType,
  DailyWorkItem,
  WorkCategory,
} from "@pharmaceylon/shared";
import { approvedWaitingKinds } from "../dashboard/daily-work-kinds";
import { DailyWorkService } from "../dashboard/daily-work.service";
import { PrismaService } from "../prisma/prisma.service";
import { POS_ROLLOUT_SELECT, resolvePosRollout } from "../tenant/pos-rollout";
import {
  counterAlertRecipients,
  counterAlertRule,
} from "./counter-alert-recipients";
import { PERMISSION_KEYS } from "../security/permission-catalog";
import { PermissionsService } from "../security/permissions.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ListNotificationsDto } from "./dto/list-notifications.dto";
import { UpdateNotificationPreferencesDto } from "./dto/update-notification-preferences.dto";

const OPERATIONAL_SOURCE = "operational_scan";
const MAX_ACTION_ITEMS = 25;

export type AdminNotificationInput = {
  severity?: NotificationSeverity;
  title: string;
  message?: string;
  actionLabel?: string;
  actionHref?: string;
  entityType?: string;
  entityId?: string;
  requiresAction?: boolean;
};

type Preferences = NotificationPreference;

/** "Fallback ending" (W7 counter alert `fallback_changed`) is raised this long before the end. */
const FALLBACK_ENDING_NOTICE_MS = 2 * 3_600_000;

/** Daily-work categories that notify, and the preference that switches each off. */
const WORK_NOTIFICATION: Record<
  WorkCategory,
  { category: NotificationCategory; enabled: keyof Preferences }
> = {
  purchasing: { category: NotificationCategory.purchasing, enabled: "purchasingEnabled" },
  returns: { category: NotificationCategory.purchasing, enabled: "purchasingEnabled" },
  transfers: { category: NotificationCategory.transfers, enabled: "transfersEnabled" },
  stocktakes: { category: NotificationCategory.stocktakes, enabled: "stocktakesEnabled" },
  inventory: { category: NotificationCategory.inventory, enabled: "inventoryEnabled" },
  counter: { category: NotificationCategory.sales, enabled: "salesEnabled" },
};

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
    private readonly work: DailyWorkService,
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
          // Newest first. Pinning everything that needs action to the top buried a fresh
          // answer ("your delivery was accepted") under older requests still waiting.
          orderBy: { createdAt: "desc" },
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
      where: { tenantId_userId: { tenantId, userId } },
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
      where: { tenantId_userId: { tenantId, userId } },
      create: { tenantId, userId, ...dto },
      update: dto,
    });
    this.clearRefreshThrottle(userId);
    return preferences;
  }

  /**
   * Event-sourced notification (source stays the schema default, "domain_event" — distinct from
   * the threshold-based `operational_scan` alerts below) for every tenant user who currently
   * holds `requiredPermission` on at least one branch — owners always qualify regardless of the
   * permission, same bypass as everywhere else in this codebase. Used for admin/access events
   * (staff and role changes, branch and tenant settings changes) that owner/manager should hear
   * about but that have no "current state" to poll, unlike inventory/expiry/purchasing/etc.
   * Skips anyone who has turned the category off in their own preferences (a missing preference
   * row means default-enabled, matching `NotificationPreference`'s column defaults). A no-op if
   * there are no eligible recipients — callers don't need to check first.
   */
  async notifyByPermission(
    tenantId: string,
    requiredPermission: string,
    category: NotificationCategory,
    input: AdminNotificationInput,
    excludeUserId?: string,
    /** Only people who hold the permission *at this branch* — for a request about one branch's
     *  stock, not a tenant-wide event. Owners still qualify wherever they are. */
    opts: { branchId?: string } = {},
  ): Promise<number> {
    const recipientIds = await this.resolveRecipientsByPermission(
      tenantId,
      requiredPermission,
      excludeUserId,
      opts.branchId,
    );
    return this.deliver(tenantId, recipientIds, category, input, opts.branchId);
  }

  /**
   * A W7 counter alert (#81) to the roles its tenant setting names, for one branch. Switched-off
   * types reach nobody. Only `EMITTED_COUNTER_ALERT_TYPES` have a source today; the telemetry
   * types are delivered the same way once P2/P5 call this.
   */
  async notifyCounterAlert(
    tenantId: string,
    branchId: string,
    type: CounterAlertType,
    input: AdminNotificationInput,
    excludeUserId?: string,
  ): Promise<number> {
    const [settings, assignments] = await Promise.all([
      this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { counterAlertPolicy: true },
      }),
      this.prisma.userBranchRole.findMany({
        where: { tenantId, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
        select: { userId: true, branchId: true, role: true, roleRef: { select: { key: true } } },
      }),
    ]);
    const recipients = counterAlertRecipients(
      counterAlertRule(settings?.counterAlertPolicy, type),
      assignments.map((entry) => ({
        userId: entry.userId,
        branchId: entry.branchId,
        role: entry.role,
        roleKey: entry.roleRef?.key ?? null,
      })),
      branchId,
    );
    return this.deliver(
      tenantId,
      recipients,
      NotificationCategory.system,
      { ...input, entityType: input.entityType ?? `counter_alert.${type}` },
      branchId,
    );
  }

  private async deliver(
    tenantId: string,
    recipientIds: string[],
    category: NotificationCategory,
    input: AdminNotificationInput,
    branchId?: string,
  ): Promise<number> {
    if (!recipientIds.length) return 0;

    const preferenceRows = await this.prisma.notificationPreference.findMany({
      where: { tenantId, userId: { in: recipientIds } },
      select: { userId: true, complianceEnabled: true, systemEnabled: true },
    });
    const isEnabled = (userId: string) => {
      const row = preferenceRows.find((preference) => preference.userId === userId);
      if (!row) return true;
      if (category === NotificationCategory.compliance) return row.complianceEnabled;
      if (category === NotificationCategory.system) return row.systemEnabled;
      return true;
    };
    const recipients = recipientIds.filter(isEnabled);
    if (!recipients.length) return 0;

    await this.prisma.notification.createMany({
      data: recipients.map((recipientUserId) => ({
        tenantId,
        recipientUserId,
        branchId: branchId ?? null,
        category,
        severity: input.severity ?? NotificationSeverity.info,
        title: input.title,
        message: input.message ?? null,
        actionLabel: input.actionLabel ?? null,
        actionHref: input.actionHref ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        dedupeKey: randomUUID(),
        requiresAction: input.requiresAction ?? false,
      })),
    });
    return recipients.length;
  }

  /**
   * One notification to one person — the answer to something they asked for, such as the
   * decision on a delivery they sent for approval. Honours the same per-category preferences.
   */
  async notifyUser(
    tenantId: string,
    recipientUserId: string,
    category: NotificationCategory,
    input: AdminNotificationInput,
    opts: { branchId?: string } = {},
  ): Promise<void> {
    const preference = await this.prisma.notificationPreference.findFirst({
      where: { tenantId, userId: recipientUserId },
      select: { complianceEnabled: true, systemEnabled: true },
    });
    if (preference) {
      if (category === NotificationCategory.compliance && !preference.complianceEnabled) return;
      if (category === NotificationCategory.system && !preference.systemEnabled) return;
    }
    await this.prisma.notification.create({
      data: {
        tenantId,
        recipientUserId,
        branchId: opts.branchId ?? null,
        category,
        severity: input.severity ?? NotificationSeverity.info,
        title: input.title,
        message: input.message ?? null,
        actionLabel: input.actionLabel ?? null,
        actionHref: input.actionHref ?? null,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        dedupeKey: randomUUID(),
        requiresAction: input.requiresAction ?? false,
      },
    });
  }

  private async resolveRecipientsByPermission(
    tenantId: string,
    requiredPermission: string,
    excludeUserId?: string,
    branchId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.userBranchRole.findMany({
      where: { tenantId, ...(excludeUserId ? { userId: { not: excludeUserId } } : {}) },
      select: { userId: true, branchId: true, role: true, roleId: true },
    });
    const byUser = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(row);
      byUser.set(row.userId, list);
    }
    const recipients: string[] = [];
    for (const [userId, entries] of byUser) {
      if (entries.some((entry) => entry.role === RoleName.owner)) {
        recipients.push(userId);
        continue;
      }
      const scoped = branchId ? entries.filter((entry) => entry.branchId === branchId) : entries;
      if (!scoped.length) continue;
      const granted = await this.permissions.resolveGrantedKeys(scoped);
      if (granted.has(requiredPermission)) recipients.push(userId);
    }
    return recipients;
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
      user,
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
    user: RequestUser,
    branchId: string,
    granted: Set<string>,
    preferences: Preferences,
  ): Promise<DesiredNotification[]> {
    const tenantId = user.tenantId;
    const branch = await this.prisma.branch.findFirst({
      where: { tenantId, id: branchId },
      select: { name: true, ...POS_ROLLOUT_SELECT },
    });
    if (!branch) return [];
    const rollout = resolvePosRollout(branch);
    const jobs: Array<Promise<DesiredNotification[]>> = [
      this.workNotifications(user, branchId, branch.name, preferences),
    ];
    if (rollout.fallback && preferences.systemEnabled)
      jobs.push(
        this.fallbackEndingNotifications(
          user,
          branchId,
          branch.name,
          rollout.fallback.endsAt,
        ),
      );
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
          rollout.state !== "not_live",
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
        title: pending ? `Approve order ${row.poNumber}` : `${row.poNumber} is overdue`,
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
          ? `Approve transfer ${row.transferNumber}`
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
    counterLive: boolean,
  ) {
    if (!canReview) return [];
    const rows = await this.prisma.stocktake.findMany({
      where: {
        tenantId,
        branchId,
        // At a live branch an approved stocktake is posted at the counter: `workNotifications`.
        status: {
          in: counterLive
            ? [StocktakeStatus.submitted]
            : [StocktakeStatus.submitted, StocktakeStatus.approved],
        },
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

  /**
   * Read from the daily-work model, so permissions, branch scope and every registered "approved,
   * waiting at the counter" kind match the dashboard: approved documents waiting at a live
   * branch's counter, and supplier returns waiting for approval (the one approval wait without
   * a notification of its own). Requests the viewer may not approve themselves are left out.
   */
  private async workNotifications(
    user: RequestUser,
    branchId: string,
    branchName: string,
    preferences: Preferences,
  ): Promise<DesiredNotification[]> {
    const work = await this.work.get(
      user,
      branchId,
      { filter: "all", page: 1 },
      {
        pageSize: MAX_ACTION_ITEMS,
        kinds: [...approvedWaitingKinds(), "goods_return.approve"],
      },
    );
    return work.items
      .filter((item) =>
        item.kind === "goods_return.approve"
          ? item.approval && !item.blocked
          : item.where === "counter",
      )
      .filter((item) => preferences[WORK_NOTIFICATION[item.category].enabled])
      .map((item) => workNotification(item, branchId, branchName));
  }

  /** W7 `fallback_changed`: "ending" is a time rather than an event, so the scan raises it. */
  private async fallbackEndingNotifications(
    user: RequestUser,
    branchId: string,
    branchName: string,
    endsAt: string,
  ): Promise<DesiredNotification[]> {
    if (new Date(endsAt).getTime() - Date.now() > FALLBACK_ENDING_NOTICE_MS)
      return [];
    const roleIds = user.branchRoles.flatMap((entry) =>
      entry.roleId ? [entry.roleId] : [],
    );
    const [settings, roles] = await Promise.all([
      this.prisma.tenantSettings.findUnique({
        where: { tenantId: user.tenantId },
        select: { counterAlertPolicy: true },
      }),
      this.prisma.role.findMany({
        where: { tenantId: user.tenantId, id: { in: roleIds } },
        select: { id: true, key: true },
      }),
    ]);
    const recipients = counterAlertRecipients(
      counterAlertRule(settings?.counterAlertPolicy, "fallback_changed"),
      user.branchRoles.map((entry) => ({
        userId: user.userId,
        branchId: entry.branchId,
        role: entry.role,
        roleKey: roles.find((role) => role.id === entry.roleId)?.key ?? null,
      })),
      branchId,
    );
    if (!recipients.includes(user.userId)) return [];
    return [
      {
        dedupeKey: `operational:${branchId}:counter-alert:fallback-ending:${endsAt}`,
        branchId,
        category: NotificationCategory.system,
        severity: NotificationSeverity.warning,
        title: `Web POS fallback at "${branchName}" ends soon`,
        message: `It ends at ${endsAt}. Checkout then returns to PharmaCeylon POS only.`,
        actionLabel: "Open branch settings",
        actionHref: "/settings/branches",
        entityType: "counter_alert.fallback_changed",
        entityId: branchId,
        requiresAction: false,
      },
    ];
  }
}

/** Deep link to the document; its page shows the counter handoff. */
function workNotification(
  item: DailyWorkItem,
  branchId: string,
  branchName: string,
): DesiredNotification {
  const counter = item.where === "counter";
  return {
    dedupeKey: `operational:${branchId}:work:${item.id}:${item.kind}`,
    branchId,
    category: WORK_NOTIFICATION[item.category].category,
    severity: counter ? NotificationSeverity.info : NotificationSeverity.warning,
    title: counter
      ? `Approved — waiting at the counter · ${item.reference}`
      : `${item.title} ${item.reference}`,
    message: counter
      ? `${item.title} in PharmaCeylon POS at ${branchName}. ${item.detail}`
      : item.detail,
    actionLabel: counter ? "View details" : item.action,
    actionHref: item.href,
    entityType: item.kind.slice(0, item.kind.indexOf(".")),
    entityId: item.id.slice(item.id.indexOf(":") + 1),
    requiresAction: true,
    metadata: { kind: item.kind, where: item.where },
  };
}
