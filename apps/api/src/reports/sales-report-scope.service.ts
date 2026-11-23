import { Injectable } from "@nestjs/common";
import { Prisma, SaleStockPosting } from "@prisma/client";
import {
  deriveSaleChannel,
  type OfflineSaleSyncState,
  type SaleChannel,
} from "@pharmaceylon/shared";
import {
  addDays,
  businessDateKey,
  businessToday,
  safeTimeZone,
  startOfBusinessDay,
} from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import { channelWhere, fallbackWindowsFromAudit } from "../sales/sale-fallback-windows.util";
import { offlineSyncStateWhere } from "../sales/offline-sync-state.util";
import { POS_ROLLOUT_SELECT } from "../tenant/pos-rollout";
import {
  journalStatusQuery,
  journalSyncViews,
  type JournalStatusRow,
} from "../terminals/journal/counter-journal-status";
import {
  effectiveSaleInstant,
  offlineCommandOccurredAt,
  type SaleInstantRow,
} from "./sales-report-effective-time";
import {
  salesReportFiltersActive,
  type SalesReportFilters,
  type SalesReportGroupBy,
} from "./sales-report-query";

const NO_SUCH_TILL = "00000000-0000-4000-8000-000000000000";
const MS_PER_DAY = 86_400_000;

const FALLBACK_AUDIT_EVENTS = [
  "branch.pos_fallback_started",
  "branch.pos_fallback_extended",
  "branch.pos_fallback_ended",
] as const;

const BRANCH_ROLLOUT_SELECT = { id: true, ...POS_ROLLOUT_SELECT } as const;

export const SALES_REPORT_SALE_SELECT = {
  id: true,
  soldAt: true,
  grandTotal: true,
  discountTotal: true,
  status: true,
  terminalId: true,
  tillId: true,
  shiftId: true,
  offlineCommandId: true,
  stockPosting: true,
  branchId: true,
  branch: { select: BRANCH_ROLLOUT_SELECT },
  shift: {
    select: {
      id: true,
      shiftNumber: true,
      openedAt: true,
      closedAt: true,
      registerId: true,
      counter: { select: { label: true } },
    },
  },
} satisfies Prisma.SaleSelect;

export type SalesReportSaleRow = Prisma.SaleGetPayload<{ select: typeof SALES_REPORT_SALE_SELECT }>;

export type SalesReportWindow = Readonly<{
  days: number;
  timeZone: string;
  since: Date;
  before: Date;
  paddedSince: Date;
  paddedBefore: Date;
}>;

/** Freshness the UI can show beside a sales report figure — derived from existing sync/stock state only. */
export type SalesReportFreshness = Readonly<{
  /** When this response was built (ISO-8601). */
  generatedAt: string;
  /** Latest accepted offline-journal sync instant among counters in scope, or null when none. */
  latestSyncedAt: string | null;
  /** Offline-replayed sales in the report window whose stock is not fully settled (pending posting or open case). */
  pendingOfflineCount: number;
}>;

export type SalesReportBreakdownRow = Readonly<{
  key: string;
  label: string;
  channel?: SaleChannel;
  terminal?: { id: string; label: string } | null;
  register?: { id: string; tillId: string; label: string } | null;
    shift?: {
    id: string;
    shiftNumber: string;
    registerId: string;
    registerLabel: string;
    openedAt: string;
    closedAt: string | null;
  } | null;
  count: number;
  grandTotal: string;
}>;

@Injectable()
export class SalesReportScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveTimeZone(tenantId: string, branchId: string | null): Promise<string> {
    if (branchId) {
      const branch = await this.prisma.branch.findFirst({
        where: { tenantId, id: branchId },
        select: { timezone: true, tenant: { select: { timezone: true } } },
      });
      return safeTimeZone(branch?.timezone ?? branch?.tenant.timezone);
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return safeTimeZone(tenant?.timezone);
  }

  async reportWindow(tenantId: string, branchId: string | null, days: number): Promise<SalesReportWindow> {
    const timeZone = await this.resolveTimeZone(tenantId, branchId);
    const today = businessToday(timeZone);
    const since = startOfBusinessDay(timeZone, businessDateKey(timeZone, addDays(today, -(days - 1))));
    const before = startOfBusinessDay(
      timeZone,
      businessDateKey(timeZone, addDays(today, 1)),
    );
    return {
      days,
      timeZone,
      since,
      before,
      paddedSince: new Date(since.getTime() - 2 * MS_PER_DAY),
      paddedBefore: new Date(before.getTime() + 2 * MS_PER_DAY),
    };
  }

  private async dimensionWhere(
    tenantId: string,
    branchId: string | null,
    filters: SalesReportFilters,
  ): Promise<Prisma.SaleWhereInput> {
    const branchIds = branchId
      ? [branchId]
      : (
          await this.prisma.branch.findMany({
            where: { tenantId, isActive: true },
            select: { id: true },
          })
        ).map((b) => b.id);

    const [registerTillId, rolloutBranches, fallbackHistory] = await Promise.all([
      filters.registerId
        ? this.prisma.terminalCounter.findFirst({
            where: {
              tenantId,
              branchId: branchId ? branchId : { in: branchIds },
              id: filters.registerId,
            },
            select: { tillId: true },
          })
        : Promise.resolve(null),
      filters.channel
        ? this.prisma.branch.findMany({
            where: { tenantId, id: { in: branchIds } },
            select: BRANCH_ROLLOUT_SELECT,
          })
        : Promise.resolve([]),
      filters.channel
        ? this.prisma.auditEvent.findMany({
            where: {
              tenantId,
              branchId: { in: branchIds },
              eventName: { in: [...FALLBACK_AUDIT_EVENTS] },
            },
            select: { branchId: true, eventName: true, payload: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
    ]);

    const historicalFallbacks = filters.channel
      ? fallbackWindowsFromAudit(fallbackHistory)
      : new Map<string, import("@pharmaceylon/shared").FallbackWindow[]>();

    return {
      ...(filters.terminalId ? { terminalId: filters.terminalId } : {}),
      ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
      ...(filters.registerId
        ? { tillId: registerTillId?.tillId ?? NO_SUCH_TILL }
        : {}),
      ...(filters.channel && rolloutBranches.length
        ? channelWhere(filters.channel, rolloutBranches, historicalFallbacks)
        : filters.channel
          ? channelWhere(filters.channel, [], historicalFallbacks)
          : {}),
      ...(filters.offlineSyncState
        ? offlineSyncStateWhere(filters.offlineSyncState)
        : {}),
    };
  }

  async saleWhereForReports(
    tenantId: string,
    branchId: string | null,
    window: SalesReportWindow,
    filters: SalesReportFilters,
    statuses: Prisma.EnumSaleStatusFilter | null = { in: ["posted", "partially_refunded"] },
  ): Promise<Prisma.SaleWhereInput> {
    const dimension = await this.dimensionWhere(tenantId, branchId, filters);
    return {
      tenantId,
      ...(branchId ? { branchId } : {}),
      soldAt: { gte: window.paddedSince, lt: window.paddedBefore },
      ...(statuses ? { status: statuses } : {}),
      ...dimension,
    };
  }

  async occurredAtByCommandId(
    tenantId: string,
    commandIds: readonly string[],
  ): Promise<Map<string, number>> {
    const ids = [...new Set(commandIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await this.prisma.terminalCommandReceipt.findMany({
      where: { tenantId, commandId: { in: ids } },
      select: { commandId: true, command: true },
    });
    const out = new Map<string, number>();
    for (const row of rows) {
      const ms = offlineCommandOccurredAt(row.command);
      if (ms != null) out.set(row.commandId, ms);
    }
    return out;
  }

  inEffectiveWindow(
    sale: SaleInstantRow,
    window: SalesReportWindow,
    occurredAtByCommandId: ReadonlyMap<string, number>,
  ): boolean {
    const at = effectiveSaleInstant(sale, occurredAtByCommandId);
    return at >= window.since && at < window.before;
  }

  async filterPostedSalesInWindow(
    sales: readonly SalesReportSaleRow[],
    window: SalesReportWindow,
    occurredAtByCommandId: ReadonlyMap<string, number>,
  ): Promise<SalesReportSaleRow[]> {
    return sales.filter(
      (s) =>
        (s.status === "posted" || s.status === "partially_refunded") &&
        this.inEffectiveWindow(s, window, occurredAtByCommandId),
    );
  }

  async loadPostedSales(
    tenantId: string,
    branchId: string | null,
    window: SalesReportWindow,
    filters: SalesReportFilters,
  ): Promise<{ sales: SalesReportSaleRow[]; occurredAtByCommandId: Map<string, number> }> {
    const where = await this.saleWhereForReports(tenantId, branchId, window, filters);
    const rows = await this.prisma.sale.findMany({
      where,
      select: SALES_REPORT_SALE_SELECT,
    });
    const occurredAtByCommandId = await this.occurredAtByCommandId(
      tenantId,
      rows.map((r) => r.offlineCommandId).filter((id): id is string => Boolean(id)),
    );
    const sales = await this.filterPostedSalesInWindow(rows, window, occurredAtByCommandId);
    return { sales, occurredAtByCommandId };
  }

  businessDateKey(
    timeZone: string,
    sale: SaleInstantRow,
    occurredAtByCommandId: ReadonlyMap<string, number>,
  ): string {
    return businessDateKey(timeZone, effectiveSaleInstant(sale, occurredAtByCommandId));
  }

  weekdayIndex(timeZone: string, at: Date): number {
    const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
    const order = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
    return Math.max(0, order.indexOf(short as (typeof order)[number]));
  }

  hourOfDay(timeZone: string, at: Date): number {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hour12: false,
    }).formatToParts(at);
    return Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  }

  async openDiscrepancySaleIds(tenantId: string, saleIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(saleIds)];
    if (!ids.length) return new Set();
    const rows = await this.prisma.offlineStockDiscrepancy.findMany({
      where: { tenantId, saleId: { in: ids }, status: "open" },
      select: { saleId: true },
    });
    return new Set(rows.map((r) => r.saleId));
  }

  deriveOfflineSyncState(
    sale: Pick<SalesReportSaleRow, "offlineCommandId" | "stockPosting">,
    openCases: ReadonlySet<string>,
    saleId: string,
  ): OfflineSaleSyncState | null {
    if (!sale.offlineCommandId) return null;
    if (openCases.has(saleId)) return "held";
    if (sale.stockPosting === SaleStockPosting.pending_reconciliation) return "pending_stock_posting";
    return "accepted";
  }

  async freshness(
    tenantId: string,
    branchId: string | null,
    window: SalesReportWindow,
    filters: SalesReportFilters,
  ): Promise<SalesReportFreshness> {
    const generatedAt = new Date();
    const branches = branchId
      ? await this.prisma.branch.findMany({
          where: { tenantId, id: branchId },
          select: { id: true, timezone: true },
        })
      : await this.prisma.branch.findMany({
          where: { tenantId, isActive: true },
          select: { id: true, timezone: true },
        });

    let latestSyncedAt: Date | null = null;
    for (const branch of branches) {
      const rows = await this.prisma.$queryRaw<JournalStatusRow[]>(
        journalStatusQuery(tenantId, branch.id),
      );
      const views = journalSyncViews(rows);
      for (const view of views) {
        const accepted = view.head?.acceptedAt;
        if (accepted != null) {
          const d = new Date(accepted);
          if (!latestSyncedAt || d > latestSyncedAt) latestSyncedAt = d;
        }
      }
    }

    const pendingWhere = await this.saleWhereForReports(tenantId, branchId, window, filters);
    const pendingCandidates = await this.prisma.sale.findMany({
      where: { ...pendingWhere, offlineCommandId: { not: null } },
      select: { id: true, soldAt: true, offlineCommandId: true, stockPosting: true },
    });
    const occurredAtByCommandId = await this.occurredAtByCommandId(
      tenantId,
      pendingCandidates.map((s) => s.offlineCommandId).filter((id): id is string => Boolean(id)),
    );
    const inWindowIds = pendingCandidates
      .filter((s) => this.inEffectiveWindow(s, window, occurredAtByCommandId))
      .map((s) => s.id);
    const openCases = await this.openDiscrepancySaleIds(tenantId, inWindowIds);
    const pendingOfflineCount = pendingCandidates.filter((s) => {
      if (!inWindowIds.includes(s.id)) return false;
      if (openCases.has(s.id)) return true;
      return s.stockPosting === SaleStockPosting.pending_reconciliation;
    }).length;

    return {
      generatedAt: generatedAt.toISOString(),
      latestSyncedAt: latestSyncedAt?.toISOString() ?? null,
      pendingOfflineCount,
    };
  }

  async breakdown(
    tenantId: string,
    sales: readonly SalesReportSaleRow[],
    groupBy: SalesReportGroupBy,
    occurredAtByCommandId: ReadonlyMap<string, number>,
  ): Promise<SalesReportBreakdownRow[]> {
    const historical = sales.length
      ? await this.fallbackHistoryForBranchIds(
          tenantId,
          [...new Set(sales.map((s) => s.branchId))],
        )
      : new Map();
    const terminalIds = [...new Set(sales.map((s) => s.terminalId).filter((id): id is string => Boolean(id)))];
    const tillIds = [...new Set(sales.map((s) => s.tillId).filter((id): id is string => Boolean(id)))];

    const [terminals, registers] = await Promise.all([
      terminalIds.length
        ? this.prisma.operationalTerminal.findMany({
            where: { tenantId, id: { in: terminalIds } },
            select: { id: true, label: true },
          })
        : Promise.resolve([]),
      tillIds.length
        ? this.prisma.terminalCounter.findMany({
            where: { tenantId, tillId: { in: tillIds } },
            select: { id: true, tillId: true, label: true },
          })
        : Promise.resolve([]),
    ]);
    const terminalById = new Map(terminals.map((t) => [t.id, t]));
    const registerByTill = new Map(registers.map((r) => [r.tillId, r]));

    type Bucket = {
      key: string;
      label: string;
      count: number;
      total: Prisma.Decimal;
      terminal?: { id: string; label: string } | null;
      register?: { id: string; tillId: string; label: string } | null;
      shift?: SalesReportBreakdownRow["shift"];
      channel?: SaleChannel;
    };
    const buckets = new Map<string, Bucket>();

    for (const sale of sales) {
      let key: string;
      let label: string;
      let terminal: Bucket["terminal"];
      let register: Bucket["register"];
      let shift: Bucket["shift"];
      let channel: SaleChannel | undefined;

      if (groupBy === "terminal") {
        key = sale.terminalId ?? "none";
        if (sale.terminalId) {
          const row = terminalById.get(sale.terminalId) ?? {
            id: sale.terminalId,
            label: "Unknown counter",
          };
          terminal = { id: row.id, label: row.label };
          label = row.label;
        } else {
          terminal = null;
          label = "No counter";
        }
        if (sale.tillId) {
          const reg = registerByTill.get(sale.tillId);
          register = reg
            ? { id: reg.id, tillId: reg.tillId, label: reg.label }
            : null;
        }
      } else if (groupBy === "shift") {
        key = sale.shiftId ?? "none";
        if (sale.shift) {
          shift = {
            id: sale.shift.id,
            shiftNumber: sale.shift.shiftNumber,
            registerId: sale.shift.registerId,
            registerLabel: sale.shift.counter.label,
            openedAt: sale.shift.openedAt.toISOString(),
            closedAt: sale.shift.closedAt?.toISOString() ?? null,
          };
          label = `Shift #${sale.shift.shiftNumber}`;
        } else {
          shift = null;
          label = "No shift";
        }
      } else {
        channel = deriveSaleChannel(
          sale,
          sale.branch,
          historical.get(sale.branchId) ?? [],
        );
        key = channel;
        label = channelLabel(channel);
      }

      const cur = buckets.get(key) ?? {
        key,
        label,
        count: 0,
        total: new Prisma.Decimal(0),
        terminal,
        register,
        shift,
        channel,
      };
      cur.count += 1;
      cur.total = cur.total.add(sale.grandTotal);
      buckets.set(key, cur);
    }

    return [...buckets.values()]
      .map((b) => ({
        key: b.key,
        label: b.label,
        ...(b.channel ? { channel: b.channel } : {}),
        ...(groupBy === "terminal" ? { terminal: b.terminal ?? null, register: b.register ?? null } : {}),
        ...(groupBy === "shift" ? { shift: b.shift ?? null } : {}),
        count: b.count,
        grandTotal: b.total.toString(),
      }))
      .sort((a, b) => Number(b.grandTotal) - Number(a.grandTotal));
  }

  /**
   * Completed customer returns in the report window always count when no dimension filters are set.
   * With filters, a return matches when its original sale would match the same filters (any sale
   * status — including fully refunded), or when it has no linked sale and its own `shiftId` matches
   * a `shiftId` filter.
   */
  async filterCustomerReturnsForReport<T extends { saleId: string | null; shiftId: string | null }>(
    tenantId: string,
    branchId: string | null,
    filters: SalesReportFilters,
    returns: readonly T[],
  ): Promise<T[]> {
    if (!salesReportFiltersActive(filters) || !returns.length) return [...returns];

    const saleIds = [...new Set(returns.map((r) => r.saleId).filter((id): id is string => Boolean(id)))];
    const sales =
      saleIds.length > 0
        ? await this.prisma.sale.findMany({
            where: { tenantId, id: { in: saleIds } },
            select: SALES_REPORT_SALE_SELECT,
          })
        : [];
    const saleById = new Map(sales.map((s) => [s.id, s]));
    const branchIds = [...new Set(sales.map((s) => s.branchId))];
    const historical = await this.fallbackHistoryForBranchIds(tenantId, branchIds);
    const openCases = await this.openDiscrepancySaleIds(tenantId, saleIds);

    let registerTillId: string | null = null;
    if (filters.registerId) {
      const register = await this.prisma.terminalCounter.findFirst({
        where: {
          tenantId,
          id: filters.registerId,
          ...(branchId ? { branchId } : {}),
        },
        select: { tillId: true },
      });
      registerTillId = register?.tillId ?? NO_SUCH_TILL;
    }

    return returns.filter((r) =>
      this.returnMatchesReportFilters(r, r.saleId ? saleById.get(r.saleId) : undefined, filters, {
        registerTillId,
        historical,
        openCases,
      }),
    );
  }

  private returnMatchesReportFilters(
    ret: { saleId: string | null; shiftId: string | null },
    sale: SalesReportSaleRow | undefined,
    filters: SalesReportFilters,
    ctx: {
      registerTillId: string | null;
      historical: Map<string, import("@pharmaceylon/shared").FallbackWindow[]>;
      openCases: ReadonlySet<string>;
    },
  ): boolean {
    if (ret.saleId) {
      if (!sale) return false;
      if (filters.terminalId && sale.terminalId !== filters.terminalId) return false;
      if (filters.shiftId && sale.shiftId !== filters.shiftId && ret.shiftId !== filters.shiftId) return false;
      if (filters.registerId && sale.tillId !== ctx.registerTillId) return false;
      if (filters.channel) {
        const channel = deriveSaleChannel(sale, sale.branch, ctx.historical.get(sale.branchId) ?? []);
        if (channel !== filters.channel) return false;
      }
      if (filters.offlineSyncState) {
        const state = this.deriveOfflineSyncState(sale, ctx.openCases, sale.id);
        if (state !== filters.offlineSyncState) return false;
      }
      return true;
    }
    if (filters.shiftId && ret.shiftId === filters.shiftId) return true;
    return false;
  }

  private async fallbackHistoryForBranchIds(
    tenantId: string,
    branchIds: readonly string[],
  ): Promise<Map<string, import("@pharmaceylon/shared").FallbackWindow[]>> {
    if (!branchIds.length) return new Map();
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        tenantId,
        branchId: { in: [...branchIds] },
        eventName: { in: [...FALLBACK_AUDIT_EVENTS] },
      },
      select: { branchId: true, eventName: true, payload: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return fallbackWindowsFromAudit(rows);
  }

}

function channelLabel(channel: SaleChannel): string {
  switch (channel) {
    case "web_legacy":
      return "Web (legacy)";
    case "desktop_online":
      return "Counter (online)";
    case "offline":
      return "Counter (offline sync)";
    case "fallback":
      return "Web (fallback)";
    default:
      return channel;
  }
}