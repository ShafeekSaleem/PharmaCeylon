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
const SALE_SUMMARY_SELECT = {
  id: true,
  invoiceNo: true,
  status: true,
  soldAt: true,
  grandTotal: true,
  branch: { select: { id: true, name: true } },
  customer: { select: { id: true, fullName: true } },
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

function toSaleSummary(sale: SaleSummaryRow) {
  return {
    id: sale.id,
    invoiceNo: sale.invoiceNo,
    status: sale.status,
    soldAt: sale.soldAt.toISOString(),
    grandTotal: sale.grandTotal.toFixed(2),
    branch: sale.branch,
    itemCount: sale.items.reduce((sum, i) => sum + i.qty, 0),
    customerName: sale.customer?.fullName ?? null,
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
  };
}

/** The detail page reads named fields only, so a cost can't ride along on a whole row. */
const SALE_DETAIL_INCLUDE = {
  branch: { select: { id: true, name: true } },
  items: {
    include: {
      product: { select: SALE_PRODUCT_SELECT },
      // `toSaleDetail` drops the cost unless the caller holds `costs.view`.
      batch: { select: { ...SALE_BATCH_SELECT, costPrice: true } },
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

function toSaleDetail(sale: SaleDetailRow, opts: { canViewCost: boolean }) {
  const costTotal = sale.items.reduce(
    (sum, item) => sum.add(item.batch.costPrice.mul(item.qty)),
    new Prisma.Decimal(0),
  );
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
    // Without `costs.view` the figure is left out, not zeroed — the page shows a dash.
    costTotal: opts.canViewCost ? costTotal.toFixed(2) : null,
    notes: sale.notes,
    branch: sale.branch,
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
      unitCost: opts.canViewCost ? item.batch.costPrice.toFixed(2) : null,
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
};

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
    return sales.map(toSaleSummary);
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

    const page = Math.max(filters.page ?? 1, 1);
    const pageSize = Math.min(Math.max(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const branchIds = await this.historyScope(user, activeBranchId, filters.branchId);
    const invoiceNo = filters.invoiceNo?.trim().replace(/\s+/g, "");
    const zone = filters.from || filters.to ? await this.tenantZone(user.tenantId) : null;

    const where: Prisma.SaleWhereInput = {
      tenantId: user.tenantId,
      ...branchWhere(branchIds),
      ...(zone ? this.soldAtWhere(zone, filters.from, filters.to) : {}),
      ...(filters.soldBy ? { soldBy: filters.soldBy } : {}),
      // A refund row is negative; a sale paid by cash and refunded to card wasn't "a card sale".
      ...(filters.paymentMethod
        ? { payments: { some: { method: filters.paymentMethod, amount: { gt: 0 } } } }
        : {}),
      ...(invoiceNo ? { invoiceNo: { contains: invoiceNo, mode: "insensitive" } } : {}),
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
    return { items: rows.map(toSaleSummary), total, page, pageSize };
  }

  /** What the Sales filters offer: the branches the caller can view, and who has sold there. */
  async historyOptions(user: RequestUser) {
    const branches = await this.viewableBranches(user);
    const sellers = await this.prisma.sale.findMany({
      where: { tenantId: user.tenantId, ...branchWhere(branches.map((branch) => branch.id)) },
      distinct: ["soldBy"],
      select: { seller: { select: { id: true, fullName: true } } },
    });
    return {
      branches,
      sellers: sellers
        .map((row) => row.seller)
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
    };
  }

  /**
   * One sale for the back office, at any branch the caller can view — so a row from "All
   * branches" opens without switching branch. Costs follow `costs.view` at the sale's own branch.
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
    const canViewCost = grants === null || (grants.get(sale.branchId)?.has("costs.view") ?? false);
    return toSaleDetail(sale, { canViewCost });
  }
}
