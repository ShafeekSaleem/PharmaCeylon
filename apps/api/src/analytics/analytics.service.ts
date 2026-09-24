import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  PaymentMethod,
  PoStatus,
  Prisma,
  RoleName,
  SaleStatus,
  SupplierInvoiceStatus,
} from "@prisma/client";
import { resolveStockStatus } from "../products/stock-qty.util";
import { PrismaService } from "../prisma/prisma.service";
import { StockReadService } from "../inventory/stock/stock-read.service";
import { businessToday, safeTimeZone } from "../common/business-date.util";
import { UpsertBranchMonthlyTargetDto } from "./dto/upsert-branch-monthly-target.dto";

function monthKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function startOfMonth(yearMonth: string): Date {
  const [y, m] = yearMonth.split("-").map(Number);
  return new Date(y!, m! - 1, 1, 0, 0, 0, 0);
}

function endOfMonth(yearMonth: string): Date {
  const start = startOfMonth(yearMonth);
  return new Date(start.getFullYear(), start.getMonth() + 1, 1, 0, 0, 0, 0);
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour < 12) return `${hour} AM`;
  if (hour === 12) return "12 PM";
  return `${hour - 12} PM`;
}

/** Monday 00:00 of the week containing `d` (Monday-based, matches mixWindow). */
function mondayOf(d: Date): Date {
  const start = new Date(d);
  const day = start.getDay(); // 0 Sun … 6 Sat
  const diff = day === 0 ? 6 : day - 1;
  start.setDate(start.getDate() - diff);
  return start;
}

/** 0=Mon … 6=Sun */
function mondayIndex(d: Date): number {
  const day = d.getDay();
  return day === 0 ? 6 : day - 1;
}

function argMax(values: Array<number | null>): number | null {
  let best: number | null = null;
  let bestVal = -Infinity;
  values.forEach((v, i) => {
    if (v != null && v > bestVal) {
      bestVal = v;
      best = i;
    }
  });
  return best;
}

function mixWindow(
  todayStart: Date,
  period: "today" | "this_week" | "this_month",
): { start: Date; end: Date | null } {
  if (period === "today") {
    return { start: todayStart, end: null };
  }
  if (period === "this_week") {
    const start = new Date(todayStart);
    // Monday-based week (ISO-ish)
    const day = start.getDay(); // 0 Sun … 6 Sat
    const diff = day === 0 ? 6 : day - 1;
    start.setDate(start.getDate() - diff);
    return { start, end: null };
  }
  const ym = monthKey(todayStart);
  return { start: startOfMonth(ym), end: endOfMonth(ym) };
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockRead: StockReadService,
  ) {}

  /** Validate optional branch scope; omit → tenant-wide. */
  private async resolveOptionalBranch(
    tenantId: string,
    branchId?: string | null,
  ): Promise<string | undefined> {
    if (!branchId) return undefined;
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException("Branch not found");
    return branch.id;
  }

  /**
   * Rule-based v1: products whose available stock, plus anything already on order, is at or
   * below the reorder level.
   *
   * It used to sum the whole stock ledger, which counted quarantined and expired units as
   * sellable and — worse — ignored open purchase orders, so it recommended reordering stock
   * arriving the next morning. Available and on-order both come in now; Purchasing's own
   * suggestions endpoint groups the same numbers by supplier.
   */
  async reorderRecommendations(tenantId: string, branchId: string) {
    const products = await this.prisma.product.findMany({
      // RANGED only: an imported reference catalog is not stock this branch is missing.
      where: { tenantId, isActive: true, rangeStatus: "RANGED" },
      select: {
        id: true,
        sku: true,
        name: true,
        reorderLevel: true,
      },
    });
    if (products.length === 0) {
      return { branchId, generatedAt: new Date().toISOString(), items: [] };
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    const today = businessToday(safeTimeZone(tenant?.timezone));
    const totals = await this.stockRead.productTotals({
      tenantId,
      branchId,
      today,
      nearExpiryCutoff: today,
      productIds: products.map((p) => p.id),
    });

    const openItems = await this.prisma.purchaseOrderItem.findMany({
      where: {
        tenantId,
        purchaseOrder: {
          branchId,
          status: {
            in: [
              PoStatus.draft,
              PoStatus.pending_approval,
              PoStatus.issued,
              PoStatus.partially_received,
            ],
          },
        },
      },
      select: { productId: true, orderedQty: true, receivedQty: true },
    });
    const onOrder = new Map<string, number>();
    for (const item of openItems) {
      const outstanding = Math.max(item.orderedQty - item.receivedQty, 0);
      if (outstanding > 0) {
        onOrder.set(item.productId, (onOrder.get(item.productId) ?? 0) + outstanding);
      }
    }

    const recs: Array<{
      productId: string;
      sku: string;
      name: string;
      onHand: number;
      available: number;
      onOrderQty: number;
      reorderLevel: number;
      suggestedQty: number;
      confidence: number;
      reason: string;
    }> = [];

    for (const p of products) {
      const stock = totals.get(p.id);
      const available = stock?.available ?? 0;
      const ordered = onOrder.get(p.id) ?? 0;
      const covered = available + ordered;
      if (covered > p.reorderLevel) continue;
      const target = Math.max(p.reorderLevel * 2, p.reorderLevel + 1);
      const suggestedQty = Math.max(target - covered, 0);
      if (suggestedQty <= 0) continue;
      const confidence =
        p.reorderLevel > 0
          ? Math.min(1, (p.reorderLevel - covered) / p.reorderLevel + 0.3)
          : 0.4;
      recs.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        onHand: stock?.onHand ?? 0,
        available,
        onOrderQty: ordered,
        reorderLevel: p.reorderLevel,
        suggestedQty,
        confidence: Number(confidence.toFixed(2)),
        reason: ordered > 0 ? "short_despite_open_order" : "below_or_at_reorder_level",
      });
    }

    return { branchId, generatedAt: new Date().toISOString(), items: recs };
  }

  /** Placeholder aggregate for future mart-backed forecasting. */
  async forecastSummary(tenantId: string, branchId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 28);

    const units = await this.prisma.saleItem.aggregate({
      where: { tenantId, sale: { tenantId, branchId, soldAt: { gte: since } } },
      _sum: { qty: true },
    });

    return {
      branchId,
      windowDays: 28,
      unitsSold: units._sum.qty ?? 0,
      note: "Model-backed forecasts will replace this summary once analytics marts are populated.",
    };
  }

  /**
   * Multi-branch performance for Owner (and Managers seeing assigned branches).
   * Includes monthly targets + achievement + optional manager assignment.
   */
  async branchPerformance(tenantId: string, yearMonth?: string) {
    const ym = yearMonth && /^\d{4}-\d{2}$/.test(yearMonth) ? yearMonth : monthKey();
    const monthStart = startOfMonth(ym);
    const monthEnd = endOfMonth(ym);
    const todayStart = startOfToday();

    const branches = await this.prisma.branch.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, city: true },
    });

    const [monthSales, todaySales, prevMonthSales, targets] = await Promise.all([
      this.prisma.sale.groupBy({
        by: ["branchId"],
        where: {
          tenantId,
          status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
          soldAt: { gte: monthStart, lt: monthEnd },
        },
        _sum: { grandTotal: true },
        _count: { _all: true },
      }),
      this.prisma.sale.groupBy({
        by: ["branchId"],
        where: {
          tenantId,
          status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
          soldAt: { gte: todayStart },
        },
        _sum: { grandTotal: true },
        _count: { _all: true },
      }),
      this.prisma.sale.groupBy({
        by: ["branchId"],
        where: {
          tenantId,
          status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
          soldAt: {
            gte: new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, 1),
            lt: monthStart,
          },
        },
        _sum: { grandTotal: true },
      }),
      this.prisma.branchMonthlyTarget.findMany({
        where: { tenantId, yearMonth: ym },
        include: {
          manager: { select: { id: true, fullName: true, email: true } },
        },
      }),
    ]);

    const monthMap = new Map(
      monthSales.map((r) => [r.branchId, { sales: Number(r._sum.grandTotal ?? 0), count: r._count._all }]),
    );
    const todayMap = new Map(
      todaySales.map((r) => [r.branchId, { sales: Number(r._sum.grandTotal ?? 0), count: r._count._all }]),
    );
    const prevMap = new Map(prevMonthSales.map((r) => [r.branchId, Number(r._sum.grandTotal ?? 0)]));
    const targetMap = new Map(targets.map((t) => [t.branchId, t]));

    const items = branches.map((b) => {
      const month = monthMap.get(b.id) ?? { sales: 0, count: 0 };
      const today = todayMap.get(b.id) ?? { sales: 0, count: 0 };
      const prev = prevMap.get(b.id) ?? 0;
      const target = targetMap.get(b.id);
      const targetAmount = target ? Number(target.targetAmount) : null;
      const achievementPct =
        targetAmount != null && targetAmount > 0
          ? Math.round((month.sales / targetAmount) * 1000) / 10
          : null;
      const vsPrevPct =
        prev > 0 ? Math.round(((month.sales - prev) / prev) * 1000) / 10 : month.sales > 0 ? null : 0;

      return {
        branchId: b.id,
        code: b.code,
        name: b.name,
        city: b.city,
        todaySales: today.sales,
        todayTxnCount: today.count,
        monthSales: month.sales,
        monthTxnCount: month.count,
        targetAmount,
        achievementPct,
        vsPrevMonthPct: vsPrevPct,
        manager: target?.manager
          ? {
              id: target.manager.id,
              fullName: target.manager.fullName,
              email: target.manager.email,
            }
          : null,
        targetId: target?.id ?? null,
      };
    });

    return {
      yearMonth: ym,
      generatedAt: new Date().toISOString(),
      branches: items,
      totals: {
        todaySales: items.reduce((s, b) => s + b.todaySales, 0),
        monthSales: items.reduce((s, b) => s + b.monthSales, 0),
        targetAmount: items.reduce(
          (s, b) => s + (b.targetAmount ?? 0),
          0,
        ),
      },
    };
  }

  /**
   * Sales trend + payment mix.
   * Omit branchId for tenant-wide (Owner overview); pass branchId for Manager/branch scope.
   * @param trendDays 7 | 14 | 30 — daily sales trend points
   * @param mixPeriod today | this_week | this_month — payment mix window
   */
  async salesPulse(
    tenantId: string,
    trendDays = 7,
    mixPeriod: "today" | "this_week" | "this_month" = "this_month",
    branchId?: string | null,
  ) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const days = [7, 14, 30].includes(trendDays) ? trendDays : 7;
    const todayStart = startOfToday();
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));

    const mix = mixWindow(todayStart, mixPeriod);

    const posted: Prisma.SaleWhereInput = {
      tenantId,
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
      status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
    };

    const paymentSaleWhere: Prisma.SaleWhereInput = {
      ...posted,
      soldAt: mix.end
        ? { gte: mix.start, lt: mix.end }
        : { gte: mix.start },
    };

    const [todayAgg, yesterdayAgg, rangeSales, mixPayments, mixSalesAgg] =
      await Promise.all([
        this.prisma.sale.aggregate({
          where: { ...posted, soldAt: { gte: todayStart } },
          _sum: { grandTotal: true },
          _count: { _all: true },
        }),
        this.prisma.sale.aggregate({
          where: {
            ...posted,
            soldAt: { gte: yesterdayStart, lt: todayStart },
          },
          _sum: { grandTotal: true },
        }),
        this.prisma.sale.findMany({
          where: { ...posted, soldAt: { gte: rangeStart } },
          select: { soldAt: true, grandTotal: true },
        }),
        this.prisma.salePayment.findMany({
          where: {
            tenantId,
            sale: paymentSaleWhere,
          },
          select: { method: true, amount: true },
        }),
        // Same soldAt window + statuses as paymentMix, but Σ Sale.grandTotal
        // (revenue KPI parity for donut center; slices stay tender amounts).
        this.prisma.sale.aggregate({
          where: paymentSaleWhere,
          _sum: { grandTotal: true },
        }),
      ]);

    const byDay = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }
    for (const s of rangeSales) {
      const key = new Date(s.soldAt).toISOString().slice(0, 10);
      if (!byDay.has(key)) continue;
      byDay.set(key, (byDay.get(key) ?? 0) + Number(s.grandTotal));
    }

    const dailyEntries = [...byDay.entries()];
    const salesTrend = dailyEntries.map(([iso, value]) => {
      const d = new Date(`${iso}T12:00:00`);
      const label =
        days <= 7
          ? d.toLocaleDateString(undefined, { weekday: "short" })
          : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return { label, date: iso, value };
    });

    const methodTotals = new Map<string, number>();
    for (const p of mixPayments) {
      methodTotals.set(
        p.method,
        (methodTotals.get(p.method) ?? 0) + Number(p.amount),
      );
    }
    const paymentMix = [...methodTotals.entries()]
      .map(([method, value]) => ({ method, value }))
      .sort((a, b) => b.value - a.value);

    const todayTotal = Number(todayAgg._sum.grandTotal ?? 0);
    const yesterdayTotal = Number(yesterdayAgg._sum.grandTotal ?? 0);
    const vsYesterdayPct =
      yesterdayTotal > 0
        ? Math.round(((todayTotal - yesterdayTotal) / yesterdayTotal) * 1000) / 10
        : todayTotal > 0
          ? null
          : 0;

    const paymentMixTotal = Number(mixSalesAgg._sum.grandTotal ?? 0);

    return {
      todaySales: todayTotal,
      todayTxnCount: todayAgg._count._all,
      yesterdaySales: yesterdayTotal,
      vsYesterdayPct,
      trendDays: days,
      salesTrend7d: salesTrend,
      salesTrend,
      paymentMix,
      /** Σ Sale.grandTotal for mix window — use for donut center (not sum of slices). */
      paymentMixTotal,
      paymentMixScope: mixPeriod,
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Weekly revenue vs PO purchases for this or last calendar month. */
  async revenuePurchaseSeries(
    tenantId: string,
    period: "this_month" | "last_month" = "this_month",
    branchId?: string | null,
  ) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const now = new Date();
    let y = now.getFullYear();
    let m = now.getMonth();
    if (period === "last_month") {
      m -= 1;
      if (m < 0) {
        m = 11;
        y -= 1;
      }
    }
    const monthStart = new Date(y, m, 1, 0, 0, 0, 0);
    const monthEnd = new Date(y, m + 1, 1, 0, 0, 0, 0);
    const yearMonth = `${y}-${String(m + 1).padStart(2, "0")}`;

    const posted: Prisma.SaleWhereInput = {
      tenantId,
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
      status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
      soldAt: { gte: monthStart, lt: monthEnd },
    };

    const [sales, pos] = await Promise.all([
      this.prisma.sale.findMany({
        where: posted,
        select: { soldAt: true, grandTotal: true },
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          tenantId,
          ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
          status: { not: PoStatus.cancelled },
          createdAt: { gte: monthStart, lt: monthEnd },
        },
        select: {
          createdAt: true,
          items: { select: { unitCost: true, orderedQty: true } },
        },
      }),
    ]);

    const dayMs = 86400000;
    const totalDays = Math.max(1, Math.round((monthEnd.getTime() - monthStart.getTime()) / dayMs));
    const weeks: Array<{ label: string; a: number; b: number }> = [];

    for (let w = 0; w < 4; w++) {
      const startOffset = Math.floor((totalDays * w) / 4);
      const endOffset = w === 3 ? totalDays : Math.floor((totalDays * (w + 1)) / 4);
      const ws = new Date(monthStart.getTime() + startOffset * dayMs);
      const we = new Date(monthStart.getTime() + endOffset * dayMs);

      const rev = sales
        .filter((s) => {
          const t = new Date(s.soldAt).getTime();
          return t >= ws.getTime() && t < we.getTime();
        })
        .reduce((sum, s) => sum + Number(s.grandTotal), 0);

      const purch = pos
        .filter((po) => {
          const t = new Date(po.createdAt).getTime();
          return t >= ws.getTime() && t < we.getTime();
        })
        .reduce(
          (sum, po) =>
            sum +
            po.items.reduce((ls, it) => ls + Number(it.unitCost) * it.orderedQty, 0),
          0,
        );

      weeks.push({ label: `Week ${w + 1}`, a: rev, b: purch });
    }

    const totalRevenue = weeks.reduce((s, w) => s + w.a, 0);
    const totalPurchases = weeks.reduce((s, w) => s + w.b, 0);

    return {
      period,
      yearMonth,
      weeks,
      totalRevenue,
      totalPurchases,
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  async upsertBranchMonthlyTarget(
    tenantId: string,
    actorUserId: string,
    dto: UpsertBranchMonthlyTargetDto,
  ) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: dto.branchId, tenantId, isActive: true },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException("Branch not found");

    if (dto.managerUserId) {
      const manager = await this.prisma.userBranchRole.findFirst({
        where: {
          tenantId,
          userId: dto.managerUserId,
          branchId: dto.branchId,
          role: RoleName.manager,
        },
      });
      if (!manager) {
        throw new BadRequestException(
          "Assigned user must have manager role on that branch",
        );
      }
    }

    const row = await this.prisma.branchMonthlyTarget.upsert({
      where: {
        tenantId_branchId_yearMonth: {
          tenantId,
          branchId: dto.branchId,
          yearMonth: dto.yearMonth,
        },
      },
      create: {
        tenantId,
        branchId: dto.branchId,
        yearMonth: dto.yearMonth,
        targetAmount: new Prisma.Decimal(dto.targetAmount),
        managerUserId: dto.managerUserId ?? null,
        notes: dto.notes ?? null,
        createdBy: actorUserId,
      },
      update: {
        targetAmount: new Prisma.Decimal(dto.targetAmount),
        managerUserId:
          dto.managerUserId === undefined ? undefined : dto.managerUserId,
        notes: dto.notes === undefined ? undefined : dto.notes,
      },
      include: {
        manager: { select: { id: true, fullName: true, email: true } },
        branch: { select: { id: true, code: true, name: true } },
      },
    });

    return row;
  }

  /** Credit-on-account + supplier AP for cash panel (no full AR settlement yet). */
  async financialSnapshot(tenantId: string, branchId?: string | null) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const saleScope: Prisma.SaleWhereInput = {
      tenantId,
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
      status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
    };

    const [creditAgg, creditCustomers, openInvoices] = await Promise.all([
      this.prisma.salePayment.aggregate({
        where: {
          tenantId,
          method: PaymentMethod.credit,
          sale: saleScope,
        },
        _sum: { amount: true },
      }),
      this.prisma.sale.findMany({
        where: {
          ...saleScope,
          payments: { some: { method: PaymentMethod.credit } },
          customerId: { not: null },
        },
        select: { customerId: true },
        distinct: ["customerId"],
      }),
      this.prisma.supplierInvoice.findMany({
        where: {
          tenantId,
          // Supplier invoices are tenant-level today; when branch-scoped, still return
          // tenant AP (no reliable branch FK on invoices). Branch filter affects AR only.
          status: { in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial] },
        },
        select: {
          id: true,
          totalAmount: true,
          paidAmount: true,
          supplierId: true,
        },
      }),
    ]);

    const receivables = Number(creditAgg._sum.amount ?? 0);
    const payables = openInvoices.reduce(
      (s, inv) => s + Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount)),
      0,
    );
    const supplierIds = new Set(openInvoices.map((i) => i.supplierId));

    return {
      receivablesOutstanding: receivables,
      receivablesCustomerCount: creditCustomers.length,
      receivablesNote:
        "Credit sales on account (settlement ledger not implemented yet).",
      payablesOutstanding: payables,
      payablesSupplierCount: supplierIds.size,
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Inventory + open-PO health for dashboard KPIs.
   * Omit branchId → all branches (Owner); pass branchId for Manager scope.
   */
  async opsSnapshot(tenantId: string, branchId?: string | null) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const branchWhere = scopedBranchId ? { branchId: scopedBranchId } : {};

    const openPoStatuses: PoStatus[] = [
      PoStatus.draft,
      PoStatus.pending_approval,
      PoStatus.issued,
      PoStatus.partially_received,
    ];

    const nearLimit = new Date();
    nearLimit.setDate(nearLimit.getDate() + 30);

    const [products, stockRows, nearBatches, openPos, valueLedger] =
      await Promise.all([
        this.prisma.product.findMany({
          // RANGED only — see above.
          where: { tenantId, isActive: true, rangeStatus: "RANGED" },
          select: { id: true, reorderLevel: true, isControlled: true },
        }),
        this.prisma.stockLedger.groupBy({
          by: scopedBranchId ? ["productId"] : ["productId", "branchId"],
          where: { tenantId, ...branchWhere },
          _sum: { qtyDelta: true },
        }),
        this.prisma.batch.findMany({
          where: {
            tenantId,
            ...branchWhere,
            expiryDate: { lte: nearLimit },
            isQuarantined: false,
          },
          select: {
            id: true,
            productId: true,
            product: { select: { isControlled: true } },
          },
        }),
        this.prisma.purchaseOrder.findMany({
          where: {
            tenantId,
            ...branchWhere,
            status: { in: openPoStatuses },
          },
          select: {
            status: true,
            expectedOn: true,
            items: { select: { unitCost: true, orderedQty: true } },
          },
        }),
        this.prisma.stockLedger.groupBy({
          by: ["batchId"],
          where: {
            tenantId,
            ...branchWhere,
            batchId: { not: null },
          },
          _sum: { qtyDelta: true },
        }),
      ]);

    const productMap = new Map(products.map((p) => [p.id, p]));
    let lowStock = 0;
    let outOfStock = 0;
    const controlledLowIds = new Set<string>();
    const productsWithStockRows = new Set<string>();

    for (const row of stockRows) {
      const product = productMap.get(row.productId);
      if (!product) continue;
      productsWithStockRows.add(row.productId);
      const qty = row._sum.qtyDelta ?? 0;
      const status = resolveStockStatus(qty, product.reorderLevel);
      if (status === "low") lowStock += 1;
      if (status === "out") outOfStock += 1;
      if ((status === "low" || status === "out") && product.isControlled) {
        controlledLowIds.add(row.productId);
      }
    }

    // Branch scope matches inventory/summary: active SKUs with no ledger = out.
    // Tenant scope only counts locations that have ledger history (avoids catalog SKUs
    // never stocked at any branch from inflating Owner low/out tiles).
    if (scopedBranchId) {
      for (const p of products) {
        if (productsWithStockRows.has(p.id)) continue;
        outOfStock += 1;
        if (p.isControlled) controlledLowIds.add(p.id);
      }
    }

    const batchIds = nearBatches.map((b) => b.id);
    const batchQty =
      batchIds.length === 0
        ? []
        : await this.prisma.stockLedger.groupBy({
            by: ["batchId"],
            where: {
              tenantId,
              ...branchWhere,
              batchId: { in: batchIds },
            },
            _sum: { qtyDelta: true },
          });
    const qtyByBatch = new Map(
      batchQty.map((g) => [g.batchId!, g._sum.qtyDelta ?? 0]),
    );

    let nearExpiry = 0;
    const controlledNearExpiryIds = new Set<string>();
    for (const b of nearBatches) {
      const qty = qtyByBatch.get(b.id) ?? 0;
      if (qty <= 0) continue;
      nearExpiry += 1;
      if (b.product.isControlled) controlledNearExpiryIds.add(b.productId);
    }

    const valueBatchIds = valueLedger
      .filter((g) => (g._sum.qtyDelta ?? 0) > 0 && g.batchId)
      .map((g) => g.batchId!);
    let stockValue = 0;
    if (valueBatchIds.length > 0) {
      const costBatches = await this.prisma.batch.findMany({
        where: { tenantId, id: { in: valueBatchIds } },
        select: { id: true, costPrice: true },
      });
      const costMap = new Map(costBatches.map((b) => [b.id, Number(b.costPrice)]));
      for (const g of valueLedger) {
        const qty = g._sum.qtyDelta ?? 0;
        if (qty <= 0 || !g.batchId) continue;
        stockValue += qty * (costMap.get(g.batchId) ?? 0);
      }
    }

    const openPoCount = openPos.length;
    const openPoValue = openPos.reduce(
      (sum, po) =>
        sum +
        po.items.reduce((ls, it) => ls + Number(it.unitCost) * it.orderedQty, 0),
      0,
    );
    const pendingApproval = openPos.filter(
      (po) => po.status === PoStatus.pending_approval,
    ).length;
    const today = startOfToday();
    const overduePos = openPos.filter((po) => {
      if (!po.expectedOn) return false;
      if (
        po.status !== PoStatus.issued &&
        po.status !== PoStatus.partially_received
      ) {
        return false;
      }
      const expected = new Date(po.expectedOn);
      expected.setHours(0, 0, 0, 0);
      return expected < today;
    }).length;

    const controlledAttentionIds = new Set<string>([
      ...controlledLowIds,
      ...controlledNearExpiryIds,
    ]);

    return {
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      lowStock,
      outOfStock,
      nearExpiry,
      stockValue,
      openPoCount,
      openPoValue,
      pendingApproval,
      overduePos,
      controlledLowStock: controlledLowIds.size,
      controlledNearExpiry: controlledNearExpiryIds.size,
      controlledAttentionCount: controlledAttentionIds.size,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Count SKUs that left low/out status since `days` ago (default 7).
   * Reconstructs qty at comparedTo from StockLedger; uses current reorderLevel.
   */
  async inventoryImprovement(
    tenantId: string,
    branchId?: string | null,
    days = 7,
  ) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const windowDays = Number.isFinite(days)
      ? Math.min(90, Math.max(1, Math.round(days)))
      : 7;
    const asOf = new Date();
    const comparedTo = new Date(asOf);
    comparedTo.setDate(comparedTo.getDate() - windowDays);

    const branchWhere = scopedBranchId ? { branchId: scopedBranchId } : {};

    const products = await this.prisma.product.findMany({
      // RANGED only — see above.
      where: { tenantId, isActive: true, rangeStatus: "RANGED" },
      select: { id: true, reorderLevel: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    type QtyRow = { productId: string; branchId?: string; qty: number };
    let currentQtyRows: QtyRow[];
    let recentQtyRows: QtyRow[];

    if (scopedBranchId) {
      const [current, recent] = await Promise.all([
        this.prisma.stockLedger.groupBy({
          by: ["productId"],
          where: { tenantId, branchId: scopedBranchId },
          _sum: { qtyDelta: true },
        }),
        this.prisma.stockLedger.groupBy({
          by: ["productId"],
          where: {
            tenantId,
            branchId: scopedBranchId,
            occurredAt: { gt: comparedTo },
          },
          _sum: { qtyDelta: true },
        }),
      ]);
      currentQtyRows = current.map((r) => ({
        productId: r.productId,
        qty: r._sum.qtyDelta ?? 0,
      }));
      recentQtyRows = recent.map((r) => ({
        productId: r.productId,
        qty: r._sum.qtyDelta ?? 0,
      }));
    } else {
      const [current, recent] = await Promise.all([
        this.prisma.stockLedger.groupBy({
          by: ["productId", "branchId"],
          where: { tenantId },
          _sum: { qtyDelta: true },
        }),
        this.prisma.stockLedger.groupBy({
          by: ["productId", "branchId"],
          where: { tenantId, occurredAt: { gt: comparedTo } },
          _sum: { qtyDelta: true },
        }),
      ]);
      currentQtyRows = current.map((r) => ({
        productId: r.productId,
        branchId: r.branchId,
        qty: r._sum.qtyDelta ?? 0,
      }));
      recentQtyRows = recent.map((r) => ({
        productId: r.productId,
        branchId: r.branchId,
        qty: r._sum.qtyDelta ?? 0,
      }));
    }

    const rowKey = (row: QtyRow) =>
      scopedBranchId ? row.productId : `${row.productId}:${row.branchId}`;

    const recentMap = new Map(recentQtyRows.map((r) => [rowKey(r), r.qty]));

    let improvedCount = 0;
    let worsenedCount = 0;
    let attentionNow = 0;
    let attentionPrev = 0;
    const seen = new Set<string>();

    for (const row of currentQtyRows) {
      const product = productMap.get(row.productId);
      if (!product) continue;
      const key = rowKey(row);
      seen.add(key);
      const qtyNow = row.qty;
      const qtyPrev = qtyNow - (recentMap.get(key) ?? 0);
      const statusNow = resolveStockStatus(qtyNow, product.reorderLevel);
      const statusPrev = resolveStockStatus(qtyPrev, product.reorderLevel);
      const attnNow = statusNow === "low" || statusNow === "out";
      const attnPrev = statusPrev === "low" || statusPrev === "out";
      if (attnNow) attentionNow += 1;
      if (attnPrev) attentionPrev += 1;
      if (attnPrev && !attnNow) improvedCount += 1;
      if (!attnPrev && attnNow) worsenedCount += 1;
    }

    for (const [key, recentDelta] of recentMap) {
      if (seen.has(key)) continue;
      const productId = scopedBranchId ? key : key.split(":")[0]!;
      const product = productMap.get(productId);
      if (!product) continue;
      const qtyNow = 0;
      const qtyPrev = qtyNow - recentDelta;
      const statusNow = resolveStockStatus(qtyNow, product.reorderLevel);
      const statusPrev = resolveStockStatus(qtyPrev, product.reorderLevel);
      const attnNow = statusNow === "low" || statusNow === "out";
      const attnPrev = statusPrev === "low" || statusPrev === "out";
      if (scopedBranchId || attnPrev || attnNow) {
        if (attnNow) attentionNow += 1;
        if (attnPrev) attentionPrev += 1;
        if (attnPrev && !attnNow) improvedCount += 1;
        if (!attnPrev && attnNow) worsenedCount += 1;
      }
    }

    if (scopedBranchId) {
      for (const p of products) {
        if (seen.has(p.id) || recentMap.has(p.id)) continue;
        attentionNow += 1;
        attentionPrev += 1;
      }
    }

    return {
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      days: windowDays,
      asOf: asOf.toISOString(),
      comparedTo: comparedTo.toISOString(),
      improvedCount,
      worsenedCount,
      attentionNow,
      attentionPrev,
      attentionDelta: attentionNow - attentionPrev,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Footfall (bill count) series with a "typical pace" reference line.
   * today  → hourly (7am-9pm) vs. 30-day average for that hour.
   * week   → daily (Mon-Sun, current week) vs. 8-week average for that weekday.
   * month  → daily (1..N, current month) vs. this month's own average-so-far.
   * Future buckets (hours/days not reached yet) get value=null but still carry
   * a reference point, so the "pace" line stays visible ahead of where we are.
   */
  async footfallSeries(
    tenantId: string,
    branchId: string | undefined | null,
    period: "today" | "week" | "month",
  ) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const todayStart = startOfToday();
    const posted: Prisma.SaleWhereInput = {
      tenantId,
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
      status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
    };

    if (period === "today") {
      const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am..9pm
      const refStart = new Date(todayStart);
      refStart.setDate(refStart.getDate() - 30);

      const [todaySales, refSales] = await Promise.all([
        this.prisma.sale.findMany({
          where: { ...posted, soldAt: { gte: todayStart } },
          select: { soldAt: true },
        }),
        this.prisma.sale.findMany({
          where: { ...posted, soldAt: { gte: refStart, lt: todayStart } },
          select: { soldAt: true },
        }),
      ]);

      const byHour = new Map<number, number>(HOURS.map((h) => [h, 0]));
      for (const s of todaySales) {
        const h = new Date(s.soldAt).getHours();
        if (byHour.has(h)) byHour.set(h, byHour.get(h)! + 1);
      }
      const refByHour = new Map<number, number>(HOURS.map((h) => [h, 0]));
      for (const s of refSales) {
        const h = new Date(s.soldAt).getHours();
        if (refByHour.has(h)) refByHour.set(h, refByHour.get(h)! + 1);
      }

      const values = HOURS.map((h) => byHour.get(h) ?? 0);
      const reference = HOURS.map((h) => Math.round(((refByHour.get(h) ?? 0) / 30) * 10) / 10);
      const labels = HOURS.map(hourLabel);
      const peakIndex = argMax(values);

      return {
        period,
        unit: "bills",
        labels,
        values,
        reference,
        referenceLabel: "30-day avg for this hour",
        peakIndex,
        peakLabel: peakIndex != null ? labels[peakIndex] : null,
        totalSoFar: values.reduce((s, v) => s + v, 0),
        scope: scopedBranchId ? "branch" : "tenant",
        branchId: scopedBranchId ?? null,
        generatedAt: new Date().toISOString(),
      };
    }

    if (period === "week") {
      const weekStart = mondayOf(todayStart);
      const refStart = new Date(weekStart);
      refStart.setDate(refStart.getDate() - 56); // 8 weeks back

      const [weekSales, refSales] = await Promise.all([
        this.prisma.sale.findMany({
          where: { ...posted, soldAt: { gte: weekStart } },
          select: { soldAt: true },
        }),
        this.prisma.sale.findMany({
          where: { ...posted, soldAt: { gte: refStart, lt: weekStart } },
          select: { soldAt: true },
        }),
      ]);

      const byDow = new Array(7).fill(0) as number[];
      for (const s of weekSales) byDow[mondayIndex(new Date(s.soldAt))]! += 1;
      const refByDow = new Array(7).fill(0) as number[];
      for (const s of refSales) refByDow[mondayIndex(new Date(s.soldAt))]! += 1;

      const todayIdx = mondayIndex(todayStart);
      const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      const values = byDow.map((v, i) => (i <= todayIdx ? v : null));
      const reference = refByDow.map((v) => Math.round((v / 8) * 10) / 10);
      const peakIndex = argMax(values);

      return {
        period,
        unit: "bills",
        labels,
        values,
        reference,
        referenceLabel: "8-week avg for this weekday",
        peakIndex,
        peakLabel: peakIndex != null ? (peakIndex === todayIdx ? `${labels[peakIndex]} (today)` : labels[peakIndex]) : null,
        totalSoFar: values.reduce<number>((s, v) => s + (v ?? 0), 0),
        scope: scopedBranchId ? "branch" : "tenant",
        branchId: scopedBranchId ?? null,
        generatedAt: new Date().toISOString(),
      };
    }

    // period === "month"
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const monthEnd = new Date(todayStart.getFullYear(), todayStart.getMonth() + 1, 1);
    const daysInMonth = Math.round((monthEnd.getTime() - monthStart.getTime()) / 86400000);
    const todayDom = todayStart.getDate(); // 1-based

    const monthSales = await this.prisma.sale.findMany({
      where: { ...posted, soldAt: { gte: monthStart, lt: monthEnd } },
      select: { soldAt: true },
    });

    const byDom = new Array(daysInMonth + 1).fill(0) as number[];
    for (const s of monthSales) byDom[new Date(s.soldAt).getDate()]! += 1;

    const labels = Array.from({ length: daysInMonth }, (_, i) => String(i + 1));
    const values = labels.map((_, i) => (i + 1 <= todayDom ? byDom[i + 1]! : null));
    const totalSoFar = values.reduce<number>((s, v) => s + (v ?? 0), 0);
    const avgSoFar = todayDom > 0 ? Math.round((totalSoFar / todayDom) * 10) / 10 : 0;
    const reference = labels.map(() => avgSoFar);
    const peakIndex = argMax(values);

    return {
      period,
      unit: "bills",
      labels,
      values,
      reference,
      referenceLabel: "this month's avg so far",
      peakIndex,
      peakLabel: peakIndex != null ? `Day ${labels[peakIndex]}` : null,
      totalSoFar,
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Today's counter footfall split two ways: identity (walk-in vs. registered)
   * and, within registered, behavior (new = Customer record created today vs.
   * repeat = existing customer). Walk-ins have no identity, so they're counted
   * by transaction, not verified unique people — see the dashboard's own note.
   */
  async customerBreakdownToday(tenantId: string, branchId: string | undefined | null) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const todayStart = startOfToday();

    const sales = await this.prisma.sale.findMany({
      where: {
        tenantId,
        ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
        status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
        soldAt: { gte: todayStart },
      },
      select: { customerId: true, customer: { select: { createdAt: true } } },
    });

    let walkIn = 0;
    let newC = 0;
    let repeat = 0;
    for (const s of sales) {
      if (!s.customerId || !s.customer) {
        walkIn += 1;
        continue;
      }
      if (s.customer.createdAt >= todayStart) newC += 1;
      else repeat += 1;
    }

    const registered = newC + repeat;
    return {
      total: walkIn + registered,
      registered,
      walkIn,
      newCustomers: newC,
      repeatCustomers: repeat,
      scope: scopedBranchId ? "branch" : "tenant",
      branchId: scopedBranchId ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Daily sales trend per branch, one series per active branch (Owner: compare branches). */
  async branchSalesTrend(tenantId: string, trendDays = 7) {
    // Reports needs longer windows (90d) and their doubled equivalent for a same-length
    // previous-period comparison (up to 180d) — dashboard's own callers only ever request 7/14/30.
    const days = [7, 14, 30, 60, 90, 180].includes(trendDays) ? trendDays : 7;
    const todayStart = startOfToday();
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));
    // Previous period is the same length, immediately before rangeStart — lets
    // the dashboard show "vs previous N days" without a second round trip.
    const prevRangeStart = new Date(rangeStart);
    prevRangeStart.setDate(prevRangeStart.getDate() - days);

    const [branches, windowSales] = await Promise.all([
      this.prisma.branch.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.sale.findMany({
        where: {
          tenantId,
          status: { in: [SaleStatus.posted, SaleStatus.partially_refunded] },
          soldAt: { gte: prevRangeStart },
        },
        select: { branchId: true, soldAt: true, grandTotal: true },
      }),
    ]);

    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }

    const byBranchDay = new Map<string, Map<string, number>>();
    const prevTotalByBranch = new Map<string, number>();
    for (const b of branches) {
      byBranchDay.set(b.id, new Map(dayKeys.map((k) => [k, 0])));
      prevTotalByBranch.set(b.id, 0);
    }

    for (const s of windowSales) {
      if (s.soldAt >= rangeStart) {
        const dayMap = byBranchDay.get(s.branchId);
        if (!dayMap) continue;
        const key = new Date(s.soldAt).toISOString().slice(0, 10);
        if (!dayMap.has(key)) continue;
        dayMap.set(key, (dayMap.get(key) ?? 0) + Number(s.grandTotal));
      } else if (!prevTotalByBranch.has(s.branchId)) {
        continue;
      } else {
        prevTotalByBranch.set(s.branchId, prevTotalByBranch.get(s.branchId)! + Number(s.grandTotal));
      }
    }

    const series = branches.map((b) => {
      const dayMap = byBranchDay.get(b.id)!;
      const points = dayKeys.map((iso) => {
        const d = new Date(`${iso}T12:00:00`);
        const label =
          days <= 7
            ? d.toLocaleDateString(undefined, { weekday: "short" })
            : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return { label, date: iso, value: dayMap.get(iso) ?? 0 };
      });
      const total = points.reduce((s, p) => s + p.value, 0);
      const previousTotal = prevTotalByBranch.get(b.id) ?? 0;
      return { branchId: b.id, code: b.code, name: b.name, points, total, previousTotal };
    });

    return {
      trendDays: days,
      days: dayKeys,
      branches: series.sort((a, b) => b.total - a.total),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Received (positive qtyDelta) vs issued (negative) stock-ledger movement —
   * Inventory clerk dashboard trend chart. Branch-scoped only (omit branchId →
   * tenant-wide, for Owner/Manager use). Same period vocabulary as
   * footfallSeries: today → hourly, week → Mon-Sun to date, month → day 1..N to date.
   */
  async stockMovementTrend(
    tenantId: string,
    branchId: string | undefined | null,
    period: "today" | "week" | "month" = "week",
  ) {
    const scopedBranchId = await this.resolveOptionalBranch(tenantId, branchId);
    const todayStart = startOfToday();
    const branchWhere: Prisma.StockLedgerWhereInput = {
      tenantId,
      ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
    };
    const ledgerSelect = {
      occurredAt: true,
      qtyDelta: true,
      batch: { select: { costPrice: true } },
    } satisfies Prisma.StockLedgerSelect;
    type LedgerRow = Prisma.StockLedgerGetPayload<{ select: typeof ledgerSelect }>;

    const bucket = () => ({ received: 0, issued: 0, receivedValue: 0, issuedValue: 0 });
    const tally = (
      b: ReturnType<typeof bucket>,
      row: LedgerRow,
      totals: ReturnType<typeof bucket>,
    ) => {
      const value = Math.abs(row.qtyDelta) * Number(row.batch?.costPrice ?? 0);
      if (row.qtyDelta > 0) {
        b.received += row.qtyDelta;
        b.receivedValue += value;
        totals.received += row.qtyDelta;
        totals.receivedValue += value;
      } else if (row.qtyDelta < 0) {
        b.issued += Math.abs(row.qtyDelta);
        b.issuedValue += value;
        totals.issued += Math.abs(row.qtyDelta);
        totals.issuedValue += value;
      }
    };
    const summarize = (totals: ReturnType<typeof bucket>) => ({
      receivedTotal: totals.received,
      issuedTotal: totals.issued,
      netTotal: totals.received - totals.issued,
      receivedValueTotal: totals.receivedValue,
      issuedValueTotal: totals.issuedValue,
      netValueTotal: totals.receivedValue - totals.issuedValue,
      generatedAt: new Date().toISOString(),
    });

    if (period === "today") {
      const HOURS = Array.from({ length: 15 }, (_, i) => i + 7); // 7am..9pm
      const rows = await this.prisma.stockLedger.findMany({
        where: { ...branchWhere, occurredAt: { gte: todayStart } },
        select: ledgerSelect,
      });

      const byHour = new Map<number, ReturnType<typeof bucket>>(HOURS.map((h) => [h, bucket()]));
      const totals = bucket();
      for (const r of rows) {
        const h = new Date(r.occurredAt).getHours();
        const b = byHour.get(h);
        if (b) tally(b, r, totals);
      }

      const points = HOURS.map((h) => ({ label: hourLabel(h), ...byHour.get(h)! }));
      return { period, points, ...summarize(totals) };
    }

    if (period === "week") {
      const weekStart = mondayOf(todayStart);
      const todayIdx = mondayIndex(todayStart);
      const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

      const rows = await this.prisma.stockLedger.findMany({
        where: { ...branchWhere, occurredAt: { gte: weekStart } },
        select: ledgerSelect,
      });

      const byDow = Array.from({ length: 7 }, () => bucket());
      const totals = bucket();
      for (const r of rows) {
        const idx = mondayIndex(new Date(r.occurredAt));
        if (idx <= todayIdx) tally(byDow[idx]!, r, totals);
      }

      const points = labels.map((label, i) => ({ label, ...byDow[i]! }));
      return { period, points, ...summarize(totals) };
    }

    // period === "month"
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const todayDom = todayStart.getDate(); // 1-based

    const rows = await this.prisma.stockLedger.findMany({
      where: { ...branchWhere, occurredAt: { gte: monthStart } },
      select: ledgerSelect,
    });

    const byDom = Array.from({ length: todayDom }, () => bucket());
    const totals = bucket();
    for (const r of rows) {
      const dom = new Date(r.occurredAt).getDate();
      if (dom >= 1 && dom <= todayDom) tally(byDom[dom - 1]!, r, totals);
    }

    const points = byDom.map((b, i) => ({ label: String(i + 1), ...b }));
    return { period, points, ...summarize(totals) };
  }

  /** Top suppliers by outstanding payable, with overdue-PO counts (Owner: supplier risk view). */
  async supplierSpendSummary(tenantId: string, limit = 6) {
    const today = startOfToday();

    const [openInvoices, overduePos] = await Promise.all([
      this.prisma.supplierInvoice.findMany({
        where: {
          tenantId,
          status: { in: [SupplierInvoiceStatus.open, SupplierInvoiceStatus.partial] },
        },
        select: {
          supplierId: true,
          totalAmount: true,
          paidAmount: true,
          supplier: { select: { id: true, name: true, code: true } },
        },
      }),
      this.prisma.purchaseOrder.findMany({
        where: {
          tenantId,
          status: { in: [PoStatus.issued, PoStatus.partially_received] },
          expectedOn: { lt: today },
        },
        select: { supplierId: true },
      }),
    ]);

    const overdueBySupplier = new Map<string, number>();
    for (const po of overduePos) {
      overdueBySupplier.set(po.supplierId, (overdueBySupplier.get(po.supplierId) ?? 0) + 1);
    }

    const bySupplier = new Map<
      string,
      { supplierId: string; name: string; code: string; outstanding: number; invoiceCount: number }
    >();
    for (const inv of openInvoices) {
      if (!inv.supplier) continue;
      const outstanding = Math.max(0, Number(inv.totalAmount) - Number(inv.paidAmount));
      const existing = bySupplier.get(inv.supplierId);
      if (existing) {
        existing.outstanding += outstanding;
        existing.invoiceCount += 1;
      } else {
        bySupplier.set(inv.supplierId, {
          supplierId: inv.supplierId,
          name: inv.supplier.name,
          code: inv.supplier.code,
          outstanding,
          invoiceCount: 1,
        });
      }
    }

    const suppliers = [...bySupplier.values()]
      .map((s) => ({ ...s, overduePoCount: overdueBySupplier.get(s.supplierId) ?? 0 }))
      .sort((a, b) => b.outstanding - a.outstanding);

    return {
      suppliers: suppliers.slice(0, limit),
      totalOutstanding: suppliers.reduce((s, x) => s + x.outstanding, 0),
      totalSuppliers: suppliers.length,
      totalOverduePos: overduePos.length,
      generatedAt: new Date().toISOString(),
    };
  }
}
