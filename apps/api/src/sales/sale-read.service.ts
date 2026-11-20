import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  GoodsReturnStatus,
  GoodsReturnType,
  PaymentMethod,
  Prisma,
  RoleName,
  SaleStatus,
} from "@prisma/client";
import { deriveSaleChannel, type FallbackWindow, type SaleChannel } from "@pharmaceylon/shared";
import {
  addDays,
  businessToday,
  dateKeyToUtc,
  safeTimeZone,
  startOfBusinessDay,
} from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { PermissionsService } from "../security/permissions.service";
import { POS_ROLLOUT_SELECT } from "../tenant/pos-rollout";
import { invoiceNoWhere } from "./invoice-no-search.util";
import { channelWhere, fallbackWindowsFromAudit } from "./sale-fallback-windows.util";

const NO_SUCH_TILL = "00000000-0000-4000-8000-000000000000";
const FALLBACK_AUDIT_EVENTS = [
  "branch.pos_fallback_started",
  "branch.pos_fallback_extended",
  "branch.pos_fallback_ended",
] as const;

const SALE_PRODUCT_SELECT = { id: true, name: true, sku: true, unit: true } satisfies Prisma.ProductSelect;
const SALE_BATCH_SELECT = { id: true, batchNo: true, expiryDate: true } satisfies Prisma.BatchSelect;

/**
 * Everything a receipt / POS success state needs, in one shape. Checkout, void, refund, invoice
 * lookup and `GET /sales[/:id]` all send it to till users, who don't hold `costs.view` — so the
 * batch is named fields only, never a whole row with its cost.
 */
export const SALE_INCLUDE = {
  items: {
    include: { product: { select: SALE_PRODUCT_SELECT }, batch: { select: SALE_BATCH_SELECT } },
  },
  payments: true,
  customer: { select: { id: true, fullName: true, phone: true } },
  prescription: {
    select: { id: true, rxNumber: true, patientName: true, doctorName: true },
  },
  seller: { select: { id: true, fullName: true } },
  dispenser: { select: { id: true, fullName: true } },
  discountApprover: { select: { id: true, fullName: true } },
} satisfies Prisma.SaleInclude;

/**
 * Which branches a read covers. The till reads its own branch; the back office reads the
 * branches the caller may view sales at, which can be several.
 */
export type SaleBranchScope = string | readonly string[];

function branchWhere(scope: SaleBranchScope): Prisma.SaleWhereInput {
  return typeof scope === "string" ? { branchId: scope } : { branchId: { in: [...scope] } };
}

/** A sale as one row: the till's recent-sales card and the back office's Sales list. */
const BRANCH_ROLLOUT_SELECT = {
  id: true,
  name: true,
  ...POS_ROLLOUT_SELECT,
} as const;

const SALE_SUMMARY_SELECT = {
  id: true,
  invoiceNo: true,
  status: true,
  soldAt: true,
  grandTotal: true,
  terminalId: true,
  tillId: true,
  shiftId: true,
  offlineCommandId: true,
  branch: { select: BRANCH_ROLLOUT_SELECT },
  shift: { select: { id: true, shiftNumber: true, openedAt: true, closedAt: true } },
  customer: { select: { id: true, fullName: true, phone: true } },
  seller: { select: { id: true, fullName: true } },
  items: {
    select: {
      qty: true,
      productId: true,
      product: { select: { name: true } },
    },
  },
  payments: { select: { method: true, amount: true } },
} satisfies Prisma.SaleSelect;

type SaleSummaryRow = Prisma.SaleGetPayload<{ select: typeof SALE_SUMMARY_SELECT }>;

type RegisterRow = { id: string; tillId: string; label: string };

type AttributionContext = {
  registersByTill: Map<string, RegisterRow>;
  terminalsById: Map<string, { id: string; label: string }>;
  fallbackByBranch: Map<string, FallbackWindow[]>;
};

function saleAttribution(
  sale: Pick<
    SaleSummaryRow,
    "terminalId" | "tillId" | "shiftId" | "offlineCommandId" | "soldAt" | "branch" | "shift"
  >,
  ctx: AttributionContext,
) {
  const register = sale.tillId ? (ctx.registersByTill.get(sale.tillId) ?? null) : null;
  const channel = deriveSaleChannel(sale, sale.branch, ctx.fallbackByBranch.get(sale.branch.id) ?? []);
  const terminal = sale.terminalId ? (ctx.terminalsById.get(sale.terminalId) ?? null) : null;
  return {
    channel,
    terminal,
    register: register ? { id: register.id, tillId: register.tillId, label: register.label } : null,
    shift: sale.shift
      ? {
          id: sale.shift.id,
          shiftNumber: sale.shift.shiftNumber,
          openedAt: sale.shift.openedAt.toISOString(),
          closedAt: sale.shift.closedAt?.toISOString() ?? null,
        }
      : null,
  };
}

function toSaleSummary(sale: SaleSummaryRow, ctx: AttributionContext) {
  return {
    id: sale.id,
    invoiceNo: sale.invoiceNo,
    status: sale.status,
    soldAt: sale.soldAt.toISOString(),
    grandTotal: sale.grandTotal.toFixed(2),
    branch: { id: sale.branch.id, name: sale.branch.name },
    itemCount: sale.items.reduce((sum, i) => sum + i.qty, 0),
    customerName: sale.customer?.fullName ?? null,
    customerPhone: sale.customer?.phone ?? null,
    sellerName: sale.seller.fullName,
    // How the customer paid — refund rows are negative and don't count.
    paymentMethods: [
      ...new Set(sale.payments.filter((p) => p.amount.gt(0)).map((p) => p.method)),
    ],
    productIds: [...new Set(sale.items.map((i) => i.productId))],
    summary: sale.items
      .slice(0, 3)
      .map((i) => `${i.qty}× ${i.product.name}`)
      .join(", "),
    ...saleAttribution(sale, ctx),
  };
}

/** The detail page reads named fields only, so a cost can't ride along on a whole row. */
const SALE_DETAIL_INCLUDE = {
  branch: { select: BRANCH_ROLLOUT_SELECT },
  shift: { select: { id: true, shiftNumber: true, openedAt: true, closedAt: true } },
  items: {
    include: {
      product: { select: SALE_PRODUCT_SELECT },
      batch: { select: SALE_BATCH_SELECT },
    },
    orderBy: { createdAt: "asc" },
  },
  payments: { orderBy: { createdAt: "asc" } },
  customer: { select: { id: true, fullName: true, phone: true } },
  prescription: {
    select: { id: true, rxNumber: true, patientName: true, doctorName: true },
  },
  seller: { select: { id: true, fullName: true } },
  dispenser: { select: { id: true, fullName: true } },
  goodsReturns: {
    where: { type: GoodsReturnType.customer, status: GoodsReturnStatus.completed },
    select: { id: true, returnNumber: true, amount: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  },
} satisfies Prisma.SaleInclude;

type SaleDetailRow = Prisma.SaleGetPayload<{ include: typeof SALE_DETAIL_INCLUDE }>;

function toSaleDetail(sale: SaleDetailRow, ctx: AttributionContext) {
  return {
    id: sale.id,
    invoiceNo: sale.invoiceNo,
    status: sale.status,
    soldAt: sale.soldAt.toISOString(),
    subtotal: sale.subtotal.toFixed(2),
    discountTotal: sale.discountTotal.toFixed(2),
    taxTotal: sale.taxTotal.toFixed(2),
    grandTotal: sale.grandTotal.toFixed(2),
    amountPaid: sale.amountPaid.toFixed(2),
    changeDue: sale.changeDue.toFixed(2),
    // SaleItem has no sale-time cost snapshot. Current batch costs can change after a
    // receipt/repricing, so they cannot establish historical COGS, even for an owner.
    costTotal: null,
    notes: sale.notes,
    branch: { id: sale.branch.id, name: sale.branch.name },
    ...saleAttribution(sale, ctx),
    customer: sale.customer,
    prescription: sale.prescription,
    seller: sale.seller,
    dispenser: sale.dispenser,
    items: sale.items.map((item) => ({
      id: item.id,
      qty: item.qty,
      unitPrice: item.unitPrice.toFixed(2),
      discountAmount: item.discountAmount.toFixed(2),
      taxAmount: item.taxAmount.toFixed(2),
      lineTotal: item.lineTotal.toFixed(2),
      unitCost: null,
      product: item.product,
      batch: {
        id: item.batch.id,
        batchNo: item.batch.batchNo,
        expiryDate: item.batch.expiryDate.toISOString().slice(0, 10),
      },
    })),
    payments: sale.payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      amount: payment.amount.toFixed(2),
      reference: payment.reference,
      createdAt: payment.createdAt.toISOString(),
    })),
    refunds: sale.goodsReturns.map((row) => ({
      id: row.id,
      returnNumber: row.returnNumber,
      amount: row.amount.toFixed(2),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export type SaleHistoryFilters = {
  page?: number;
  pageSize?: number;
  /** One branch, or `all` for every branch the caller can view. Omitted: the active branch. */
  branchId?: string;
  /** Tenant calendar days, `YYYY-MM-DD`, both inclusive. */
  from?: string;
  to?: string;
  soldBy?: string;
  paymentMethod?: PaymentMethod;
  invoiceNo?: string;
  /** Part of the customer's phone; only digits count. */
  customerPhone?: string;
  /** Sale total bounds, both inclusive. */
  minTotal?: string;
  maxTotal?: string;
  terminalId?: string;
  registerId?: string;
  tillId?: string;
  shiftId?: string;
  channel?: SaleChannel;
};

/**
 * The digits of a phone that identify the line, whatever way it was written: no separators, no
 * Sri Lankan country code (94) and no trunk 0. "+94 71 482 0937" and "071-482 0937" both give
 * "714820937", which is a substring of either stored form's digits.
 */
export function phoneSearchDigits(value: string): string {
  let digits = value.replace(/\D/g, "").replace(/^0+/, "");
  if (digits.startsWith("94") && digits.length >= 11) digits = digits.slice(2);
  return digits.replace(/^0+/, "");
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function isDateKey(value: string): boolean {
  try {
    dateKeyToUtc(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reading sales back: the till's recall, invoice lookup and typeahead, the back office's Sales
 * history and sale detail, and global search all go through here, so a sale reads the same
 * wherever it is looked up. Every query is scoped by tenant and by a branch scope; the
 * back-office reads derive that scope from the branches where the caller holds `sales.view`.
 */
@Injectable()
export class SaleReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  private async tenantZone(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return safeTimeZone(tenant?.timezone);
  }

  /**
   * `soldAt` bounds for a run of the tenant's calendar days, `from` and `to` inclusive. Either
   * end may be left open.
   */
  private soldAtWhere(zone: string, from?: string, to?: string): Prisma.SaleWhereInput {
    if (!from && !to) return {};
    return {
      soldAt: {
        ...(from ? { gte: startOfBusinessDay(zone, from) } : {}),
        ...(to
          ? {
              lt: startOfBusinessDay(
                zone,
                addDays(dateKeyToUtc(to), 1).toISOString().slice(0, 10),
              ),
            }
          : {}),
      },
    };
  }

  /**
   * The branch's latest sales. A range keeps to the tenant's calendar days — `todayOnly` (the
   * till's "today's sales"), the last `days` business days, or one `date` (`YYYY-MM-DD`) — and
   * allows a range's worth of rows rather than the recall lane's 50.
   */
  async recent(
    tenantId: string,
    branchId: string,
    take = 12,
    range: { todayOnly?: boolean; days?: number; date?: string } = {},
  ) {
    const days = range.todayOnly ? 1 : range.days;
    const ranged = Boolean(days || range.date);
    let soldAt: Prisma.SaleWhereInput = {};
    if (ranged) {
      const zone = await this.tenantZone(tenantId);
      if (range.date && /^\d{4}-\d{2}-\d{2}$/.test(range.date)) {
        soldAt = this.soldAtWhere(zone, range.date, range.date);
      } else if (days) {
        const first = addDays(businessToday(zone), -(Math.min(Math.max(days, 1), 31) - 1));
        soldAt = this.soldAtWhere(zone, first.toISOString().slice(0, 10));
      }
    }
    const sales = await this.prisma.sale.findMany({
      where: { tenantId, branchId, ...soldAt },
      orderBy: { soldAt: "desc" },
      take: Math.min(Math.max(take, 1), ranged ? 500 : 50),
      select: SALE_SUMMARY_SELECT,
    });
    const ctx = await this.attributionContext(tenantId, [branchId], sales);
    return sales.map((row) => toSaleSummary(row, ctx));
  }

  /** Invoice lookup for the POS returns lane (exact, contains, then suffix). */
  async findByInvoice(tenantId: string, scope: SaleBranchScope, invoiceNo: string) {
    const term = invoiceNo.trim().replace(/\s+/g, "");
    if (!term) throw new BadRequestException("Enter an invoice number");

    const base = { tenantId, ...branchWhere(scope) };

    const sale =
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { equals: term, mode: "insensitive" } },
        include: SALE_INCLUDE,
      })) ??
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { contains: term, mode: "insensitive" } },
        orderBy: { soldAt: "desc" },
        include: SALE_INCLUDE,
      })) ??
      (await this.prisma.sale.findFirst({
        where: { ...base, invoiceNo: { endsWith: term, mode: "insensitive" } },
        orderBy: { soldAt: "desc" },
        include: SALE_INCLUDE,
      }));

    if (!sale) throw new NotFoundException(`No sale found for invoice ${term}`);
    return sale;
  }

  /**
   * Typeahead for the POS returns lane and global search — match invoice number or customer.
   * Prefers posted sales (refundable) but still surfaces voided/refunded so cashiers
   * can see why a bill cannot be refunded again.
   */
  async searchInvoices(tenantId: string, scope: SaleBranchScope, q: string, take = 12) {
    const term = q.trim();
    if (term.length < 1) return [];

    const limit = Math.min(Math.max(take, 1), 25);

    const rows = await this.prisma.sale.findMany({
      where: {
        tenantId,
        ...branchWhere(scope),
        OR: [
          { invoiceNo: { contains: term, mode: "insensitive" } },
          {
            customer: {
              is: { fullName: { contains: term, mode: "insensitive" } },
            },
          },
          { customer: { is: { phone: { contains: term } } } },
        ],
      },
      orderBy: { soldAt: "desc" },
      take: Math.min(limit * 3, 50),
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        soldAt: true,
        grandTotal: true,
        branch: { select: { id: true, name: true } },
        customer: { select: { fullName: true, phone: true } },
        seller: { select: { fullName: true } },
        payments: { select: { method: true, amount: true } },
        _count: { select: { items: true } },
      },
    });

    const statusRank = (status: SaleStatus) => {
      if (status === SaleStatus.posted) return 0;
      if (status === SaleStatus.partially_refunded) return 1;
      return 2;
    };

    return rows
      .sort((a, b) => {
        const rank = statusRank(a.status) - statusRank(b.status);
        if (rank !== 0) return rank;
        return b.soldAt.getTime() - a.soldAt.getTime();
      })
      .slice(0, limit)
      // The till shows a hit as a sale card: who sold it and how it was paid, refunds left out.
      .map(({ payments, seller, ...row }) => ({
        ...row,
        sellerName: seller.fullName,
        paymentMethods: [...new Set(payments.filter((p) => p.amount.gt(0)).map((p) => p.method))],
      }));
  }

  /**
   * Permission keys the caller holds at each branch they work at, or `null` for an owner, who
   * holds every key at every branch of the tenant (the same shortcut `RolesGuard` takes).
   */
  private async grantsByBranch(user: RequestUser): Promise<Map<string, ReadonlySet<string>> | null> {
    if (user.branchRoles.some((entry) => entry.role === RoleName.owner)) return null;
    const byBranch = new Map<string, RequestUser["branchRoles"]>();
    for (const entry of user.branchRoles) {
      byBranch.set(entry.branchId, [...(byBranch.get(entry.branchId) ?? []), entry]);
    }
    const grants = new Map<string, ReadonlySet<string>>();
    for (const [branchId, entries] of byBranch) {
      grants.set(branchId, await this.permissions.resolveGrantedKeys(entries));
    }
    return grants;
  }

  /**
   * The branches whose sales the caller may read: every active branch for an owner, otherwise
   * those where one of their roles grants `sales.view`. A role elsewhere doesn't widen it.
   */
  async viewableBranches(user: RequestUser) {
    return this.branchesWithSalesView(user, await this.grantsByBranch(user));
  }

  private branchesWithSalesView(
    user: RequestUser,
    grants: Map<string, ReadonlySet<string>> | null,
  ) {
    const ids = grants
      ? [...grants].filter(([, keys]) => keys.has("sales.view")).map(([branchId]) => branchId)
      : null;
    return this.prisma.branch.findMany({
      where: { tenantId: user.tenantId, isActive: true, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
  }

  /** `branchId` from a filter → the branch ids to read. Asking for a branch you can't view is a 403. */
  private async historyScope(
    user: RequestUser,
    activeBranchId: string | undefined,
    requested: string | undefined,
  ): Promise<string[]> {
    const viewable = (await this.viewableBranches(user)).map((branch) => branch.id);
    const target = requested === "all" ? undefined : (requested ?? activeBranchId);
    if (!target) return viewable;
    if (!viewable.includes(target)) {
      throw new ForbiddenException("You can't view sales at that branch");
    }
    return [target];
  }

  /** Back-office Sales list: newest first, paged on the server. */
  async history(user: RequestUser, activeBranchId: string | undefined, filters: SaleHistoryFilters) {
    for (const key of ["from", "to"] as const) {
      const value = filters[key];
      if (value !== undefined && !isDateKey(value)) {
        throw new BadRequestException(`${key} must be a date (YYYY-MM-DD)`);
      }
    }
    if (filters.from && filters.to && filters.from > filters.to) {
      throw new BadRequestException("from must not be after to");
    }
    const minTotal = filters.minTotal ? new Prisma.Decimal(filters.minTotal) : null;
    const maxTotal = filters.maxTotal ? new Prisma.Decimal(filters.maxTotal) : null;
    if (minTotal && maxTotal && minTotal.gt(maxTotal)) {
      throw new BadRequestException("minTotal must not be more than maxTotal");
    }
    const phoneDigits = filters.customerPhone !== undefined ? phoneSearchDigits(filters.customerPhone) : null;
    if (phoneDigits !== null && phoneDigits.length < 4) {
      throw new BadRequestException("Enter at least 4 digits of the phone number");
    }

    const page = Math.max(filters.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const branchIds = await this.historyScope(user, activeBranchId, filters.branchId);
    const invoiceNo = filters.invoiceNo?.trim().replace(/\s+/g, "");
    const counterScoped = Boolean(invoiceNo && (filters.registerId || filters.terminalId));
    const zone = filters.from || filters.to ? await this.tenantZone(user.tenantId) : null;
    const customerIds = phoneDigits ? await this.customersByPhone(user.tenantId, phoneDigits) : null;

    const [rolloutBranches, fallbackHistory, registerTillId] = await Promise.all([
      filters.channel
        ? this.prisma.branch.findMany({
            where: { tenantId: user.tenantId, id: { in: branchIds } },
            select: BRANCH_ROLLOUT_SELECT,
          })
        : Promise.resolve([]),
      filters.channel
        ? this.prisma.auditEvent.findMany({
            where: {
              tenantId: user.tenantId,
              branchId: { in: branchIds },
              eventName: { in: [...FALLBACK_AUDIT_EVENTS] },
            },
            select: { branchId: true, eventName: true, payload: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          })
        : Promise.resolve([]),
      filters.registerId
        ? this.prisma.terminalCounter.findFirst({
            where: { tenantId: user.tenantId, branchId: { in: branchIds }, id: filters.registerId },
            select: { tillId: true },
          })
        : Promise.resolve(null),
    ]);
    const historicalFallbacks = filters.channel ? fallbackWindowsFromAudit(fallbackHistory) : new Map();

    const where: Prisma.SaleWhereInput = {
      tenantId: user.tenantId,
      ...branchWhere(branchIds),
      ...(zone ? this.soldAtWhere(zone, filters.from, filters.to) : {}),
      ...(filters.soldBy ? { soldBy: filters.soldBy } : {}),
      // A refund row is negative; a sale paid by cash and refunded to card wasn't "a card sale".
      ...(filters.paymentMethod
        ? { payments: { some: { method: filters.paymentMethod, amount: { gt: 0 } } } }
        : {}),
      ...(invoiceNo ? invoiceNoWhere(invoiceNo, counterScoped) : {}),
      ...(customerIds ? { customerId: { in: customerIds } } : {}),
      ...(minTotal || maxTotal
        ? { grandTotal: { ...(minTotal ? { gte: minTotal } : {}), ...(maxTotal ? { lte: maxTotal } : {}) } }
        : {}),
      ...(filters.terminalId ? { terminalId: filters.terminalId } : {}),
      ...(filters.shiftId ? { shiftId: filters.shiftId } : {}),
      ...(filters.tillId
        ? { tillId: filters.tillId }
        : filters.registerId
          ? { tillId: registerTillId?.tillId ?? NO_SUCH_TILL }
          : {}),
      ...(filters.channel && rolloutBranches.length
        ? channelWhere(filters.channel, rolloutBranches, historicalFallbacks)
        : filters.channel
          ? channelWhere(filters.channel, [], historicalFallbacks)
          : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.sale.findMany({
        where,
        orderBy: [{ soldAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: SALE_SUMMARY_SELECT,
      }),
      this.prisma.sale.count({ where }),
    ]);
    const ctx = await this.attributionContext(user.tenantId, branchIds, rows);
    return { items: rows.map((row) => toSaleSummary(row, ctx)), total, page, pageSize };
  }

  /**
   * Customers whose phone holds these digits, ignoring how the phone was typed in. Phones are
   * free text ("071 482 0937", "+94714820937"), so the comparison strips non-digits in SQL.
   */
  private async customersByPhone(tenantId: string, digits: string): Promise<string[]> {
    const pattern = `%${digits}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer
      WHERE tenant_id = ${tenantId}::uuid
        AND phone IS NOT NULL
        AND regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${pattern}
      LIMIT 200`;
    return rows.map((row) => row.id);
  }

  /** What the Sales filters offer: the branches the caller can view, and who has sold there. */
  async historyOptions(user: RequestUser) {
    const branches = await this.viewableBranches(user);
    const branchIds = branches.map((branch) => branch.id);
    const [sellers, registers, terminals] = await Promise.all([
      this.prisma.sale.findMany({
        where: { tenantId: user.tenantId, ...branchWhere(branchIds) },
        distinct: ["soldBy"],
        select: { seller: { select: { id: true, fullName: true } } },
      }),
      this.prisma.terminalCounter.findMany({
        where: { tenantId: user.tenantId, branchId: { in: branchIds }, isActive: true },
        select: { id: true, tillId: true, label: true, branchId: true },
        orderBy: [{ branchId: "asc" }, { label: "asc" }],
      }),
      this.prisma.operationalTerminal.findMany({
        where: { tenantId: user.tenantId, branchId: { in: branchIds }, retiredAt: null },
        select: { id: true, label: true, branchId: true },
        orderBy: [{ branchId: "asc" }, { label: "asc" }],
      }),
    ]);
    return {
      branches,
      sellers: sellers
        .map((row) => row.seller)
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      registers: registers.map((row) => ({
        registerId: row.id,
        tillId: row.tillId,
        label: row.label,
        branchId: row.branchId,
      })),
      terminals: terminals.map((row) => ({
        terminalId: row.id,
        label: row.label,
        branchId: row.branchId,
      })),
    };
  }

  /**
   * One sale for the back office, at any branch the caller can view — so a row from "All
   * branches" opens without switching branch. Historical costs are unavailable until sales
   * store a sale-time cost snapshot.
   * A sale outside that scope is a 404, not a 403, so its existence isn't confirmed.
   */
  async detail(user: RequestUser, id: string) {
    const grants = await this.grantsByBranch(user);
    const branchIds = (await this.branchesWithSalesView(user, grants)).map((branch) => branch.id);
    const sale = await this.prisma.sale.findFirst({
      where: { id, tenantId: user.tenantId, ...branchWhere(branchIds) },
      include: SALE_DETAIL_INCLUDE,
    });
    if (!sale) throw new NotFoundException("Sale not found");
    const ctx = await this.attributionContext(user.tenantId, branchIds, [sale]);
    return toSaleDetail(sale, ctx);
  }

  private async attributionContext(
    tenantId: string,
    branchIds: readonly string[],
    sales: ReadonlyArray<{ tillId: string | null; terminalId: string | null; branch: { id: string } }>,
  ): Promise<AttributionContext> {
    const tillIds = [...new Set(sales.map((s) => s.tillId).filter((id): id is string => Boolean(id)))];
    const terminalIds = [...new Set(sales.map((s) => s.terminalId).filter((id): id is string => Boolean(id)))];
    const [registers, terminals, auditRows] = await Promise.all([
      tillIds.length
        ? this.prisma.terminalCounter.findMany({
            where: { tenantId, branchId: { in: [...branchIds] }, tillId: { in: tillIds } },
            select: { id: true, tillId: true, label: true },
          })
        : Promise.resolve([]),
      terminalIds.length
        ? this.prisma.operationalTerminal.findMany({
            where: { tenantId, branchId: { in: [...branchIds] }, id: { in: terminalIds } },
            select: { id: true, label: true },
          })
        : Promise.resolve([]),
      this.prisma.auditEvent.findMany({
        where: {
          tenantId,
          branchId: { in: [...branchIds] },
          eventName: { in: [...FALLBACK_AUDIT_EVENTS] },
        },
        select: { branchId: true, eventName: true, payload: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    return {
      registersByTill: new Map(registers.map((row) => [row.tillId, row])),
      terminalsById: new Map(terminals.map((row) => [row.id, row])),
      fallbackByBranch: fallbackWindowsFromAudit(auditRows),
    };
  }
}
