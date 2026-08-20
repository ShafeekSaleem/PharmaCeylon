import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { stockQtyByProductId } from "../products/stock-qty.util";

export type CategoryReportGroupBy = "commercial" | "dosageForm" | "schedule" | "registrationType";

export type CategoryReportRow = {
  categoryId: string;
  name: string;
  revenue: string;
  cost: string;
  margin: string;
  unitsSold: number;
  isUnclassified: boolean;
  /** Only populated for `groupBy=commercial` — the leaf categories rolled up under this
   *  parent department, used to power the breakdown-on-hover chart. */
  children?: CategoryReportRow[];
};

const SHIFT_RANGES: Array<{ key: "morning" | "afternoon" | "evening"; label: string; hours: (h: number) => boolean }> = [
  { key: "morning", label: "Morning", hours: (h) => h >= 6 && h < 12 },
  { key: "afternoon", label: "Afternoon", hours: (h) => h >= 12 && h < 18 },
  { key: "evening", label: "Evening", hours: (h) => h >= 18 || h < 6 },
];

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoryTaxonomy: CategoryTaxonomyService,
  ) {}

  async salesSummary(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const rows = await this.prisma.sale.findMany({
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        soldAt: { gte: since },
      },
      select: { grandTotal: true, soldAt: true, invoiceNo: true },
    });

    const total = rows.reduce((acc, r) => acc.add(r.grandTotal), new Prisma.Decimal(0));
    return {
      days,
      count: rows.length,
      grandTotal: total.toString(),
      branchId,
      scope: branchId ? "branch" : "tenant",
    };
  }

  async marginByProduct(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const items = await this.prisma.saleItem.findMany({
      where: {
        tenantId,
        sale: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          soldAt: { gte: since },
        },
      },
      include: {
        product: { select: { id: true, sku: true, name: true } },
        batch: { select: { costPrice: true } },
        sale: { select: { id: true, soldAt: true } },
      },
    });

    const byProduct = new Map<
      string,
      { productId: string; sku: string; name: string; revenue: Prisma.Decimal; cost: Prisma.Decimal; unitsSold: number }
    >();

    for (const it of items) {
      const key = it.productId;
      const revenue = it.lineTotal;
      const cost = it.batch.costPrice.mul(it.qty);
      const cur = byProduct.get(key) ?? {
        productId: it.productId,
        sku: it.product.sku,
        name: it.product.name,
        revenue: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
        unitsSold: 0,
      };
      cur.revenue = cur.revenue.add(revenue);
      cur.cost = cur.cost.add(cost);
      cur.unitsSold += it.qty;
      byProduct.set(key, cur);
    }

    const productIds = [...byProduct.keys()];
    const [stockMap, categoryByProduct] = await Promise.all([
      this.stockQtyByProductIds(tenantId, branchId, productIds),
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, productIds),
    ]);

    return [...byProduct.values()].map((v) => {
      const category = categoryByProduct.get(v.productId);
      return {
        productId: v.productId,
        sku: v.sku,
        name: v.name,
        revenue: v.revenue.toString(),
        cost: v.cost.toString(),
        margin: v.revenue.sub(v.cost).toString(),
        unitsSold: v.unitsSold,
        stockOnHand: stockMap.get(v.productId) ?? 0,
        category: category?.name ?? "Uncategorized",
        // Null (not "uncategorized") when unmapped — mirrors salesByCategory's convention but
        // keeps this field a real category id/null rather than a synthetic sentinel string, since
        // callers here group by id for benchmark calcs rather than needing a stable bucket key.
        categoryId: category?.id ?? null,
      };
    });
  }

  /** Tenant-wide sum when `branchId` is null (the util requires a branch), branch-scoped otherwise. */
  private async stockQtyByProductIds(
    tenantId: string,
    branchId: string | null,
    productIds: string[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    if (branchId) return stockQtyByProductId(this.prisma, tenantId, branchId, productIds);
    const grouped = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: { tenantId, productId: { in: productIds } },
      _sum: { qtyDelta: true },
    });
    return new Map(grouped.map((g) => [g.productId, g._sum.qtyDelta ?? 0]));
  }

  /** Per-product on-hand value at cost — same batch-level costing technique as deadStock(). */
  async stockValue(tenantId: string, branchId: string | null) {
    const stockByBatch = await this.prisma.stockLedger.groupBy({
      by: ["productId", "batchId"],
      where: { tenantId, ...(branchId ? { branchId } : {}), batchId: { not: null } },
      _sum: { qtyDelta: true },
    });

    const positiveBatchIds = stockByBatch
      .filter((row) => (row._sum.qtyDelta ?? 0) > 0)
      .map((row) => row.batchId!);
    const costBatches = positiveBatchIds.length
      ? await this.prisma.batch.findMany({
          where: { tenantId, id: { in: positiveBatchIds } },
          select: { id: true, costPrice: true },
        })
      : [];
    const costByBatch = new Map(costBatches.map((b) => [b.id, b.costPrice]));

    const byProduct = new Map<string, { productId: string; qtyOnHand: number; value: Prisma.Decimal }>();
    for (const row of stockByBatch) {
      const qty = row._sum.qtyDelta ?? 0;
      if (qty <= 0) continue;
      const cost = costByBatch.get(row.batchId!) ?? new Prisma.Decimal(0);
      const cur = byProduct.get(row.productId) ?? {
        productId: row.productId,
        qtyOnHand: 0,
        value: new Prisma.Decimal(0),
      };
      cur.qtyOnHand += qty;
      cur.value = cur.value.add(cost.mul(qty));
      byProduct.set(row.productId, cur);
    }

    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: [...byProduct.keys()] } },
      select: { id: true, sku: true, name: true },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));

    const items = [...byProduct.values()]
      .map((v) => ({
        productId: v.productId,
        qtyOnHand: v.qtyOnHand,
        value: v.value.toString(),
        product: pmap.get(v.productId) ?? { id: v.productId },
      }))
      .sort((a, b) => Number(b.value) - Number(a.value));

    const totalValue = items.reduce((sum, it) => sum + Number(it.value), 0);
    return { branchId, scope: branchId ? "branch" : "tenant", totalValue, items };
  }

  async nearExpiry(tenantId: string, branchId: string, withinDays = 90) {
    const limit = new Date();
    limit.setDate(limit.getDate() + withinDays);

    const batches = await this.prisma.batch.findMany({
      where: { tenantId, branchId, expiryDate: { lte: limit } },
      orderBy: { expiryDate: "asc" },
      include: { product: { select: { id: true, sku: true, name: true } } },
    });

    const out = [];
    for (const b of batches) {
      const agg = await this.prisma.stockLedger.aggregate({
        where: { tenantId, branchId, batchId: b.id },
        _sum: { qtyDelta: true },
      });
      const qty = agg._sum.qtyDelta ?? 0;
      if (qty > 0) {
        out.push({
          batchId: b.id,
          batchNo: b.batchNo,
          expiryDate: b.expiryDate,
          qtyOnHand: qty,
          costPrice: b.costPrice.toString(),
          valueAtRisk: b.costPrice.mul(qty).toString(),
          product: b.product,
        });
      }
    }
    return { withinDays, items: out };
  }

  async deadStock(tenantId: string, branchId: string | null, daysWithoutSale = 90) {
    const since = new Date();
    since.setDate(since.getDate() - daysWithoutSale);

    const soldProductIds = new Set(
      (
        await this.prisma.saleItem.findMany({
          where: {
            tenantId,
            sale: {
              tenantId,
              ...(branchId ? { branchId } : {}),
              soldAt: { gte: since },
            },
          },
          select: { productId: true },
        })
      ).map((x) => x.productId),
    );

    // Grouped by batch (not just product) so each batch's own cost price can be
    // priced into the tied-up-value total — a plain product-level qty sum has no
    // cost to attach, since cost lives on the batch.
    const stockByBatch = await this.prisma.stockLedger.groupBy({
      by: ["productId", "batchId"],
      where: { tenantId, ...(branchId ? { branchId } : {}), batchId: { not: null } },
      _sum: { qtyDelta: true },
    });

    const positiveBatchIds = stockByBatch
      .filter((row) => (row._sum.qtyDelta ?? 0) > 0)
      .map((row) => row.batchId!);
    const costBatches = positiveBatchIds.length
      ? await this.prisma.batch.findMany({
          where: { tenantId, id: { in: positiveBatchIds } },
          select: { id: true, costPrice: true },
        })
      : [];
    const costByBatch = new Map(costBatches.map((b) => [b.id, b.costPrice]));

    const dead = new Map<string, { productId: string; qtyOnHand: number; value: Prisma.Decimal }>();
    for (const row of stockByBatch) {
      const qty = row._sum.qtyDelta ?? 0;
      if (qty <= 0 || soldProductIds.has(row.productId)) continue;
      const cost = costByBatch.get(row.batchId!) ?? new Prisma.Decimal(0);
      const cur = dead.get(row.productId) ?? {
        productId: row.productId,
        qtyOnHand: 0,
        value: new Prisma.Decimal(0),
      };
      cur.qtyOnHand += qty;
      cur.value = cur.value.add(cost.mul(qty));
      dead.set(row.productId, cur);
    }

    const products = await this.prisma.product.findMany({
      where: { tenantId, id: { in: [...dead.keys()] } },
      select: { id: true, sku: true, name: true },
    });
    const pmap = new Map(products.map((p) => [p.id, p]));

    // SaleItem.createdAt is written alongside its parent Sale, so it doubles as a
    // cheap "last sold" timestamp without joining through Sale for an aggregate.
    const lastSold = dead.size
      ? await this.prisma.saleItem.groupBy({
          by: ["productId"],
          where: {
            tenantId,
            productId: { in: [...dead.keys()] },
            sale: { tenantId, ...(branchId ? { branchId } : {}) },
          },
          _max: { createdAt: true },
        })
      : [];
    const lastSoldMap = new Map(lastSold.map((r) => [r.productId, r._max.createdAt]));

    return {
      daysWithoutSale,
      items: [...dead.values()].map((d) => ({
        productId: d.productId,
        qtyOnHand: d.qtyOnHand,
        value: d.value.toString(),
        lastSoldAt: lastSoldMap.get(d.productId)?.toISOString() ?? null,
        product: pmap.get(d.productId) ?? { id: d.productId },
      })),
    };
  }

  /**
   * Revenue/cost/margin/units grouped by one of four independent classification lenses:
   *
   *  - "commercial" (default): the product's primary COMMERCIAL (merchandising) category —
   *    this is what "Category Sales" / "Margin by Category" / other category profitability
   *    reports mean by "Category". Only the primary map is used, so a product with secondary
   *    commercial associations is never double counted.
   *  - "dosageForm" / "registrationType": the product's NMRA-import-derived classification —
   *    a separate analytical lens ("Dosage Form Performance" / "Registration Type Analysis"),
   *    not a merchandising category.
   *  - "schedule": the product's NMRA schedule (a plain `Product` field, no category join).
   *
   * Products without a mapping for the selected dimension are bucketed as "Uncategorized" (commercial/
   * dosageForm) or "Unspecified" (registrationType) rather than dropped, so totals still reconcile.
   */
  async salesByCategory(
    tenantId: string,
    branchId: string | null,
    days = 30,
    groupBy: CategoryReportGroupBy = "commercial",
  ): Promise<{ days: number; groupedBy: CategoryReportGroupBy; categories: CategoryReportRow[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    if (groupBy === "schedule") {
      const items = await this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } },
        },
        include: {
          batch: { select: { costPrice: true } },
          product: { select: { schedule: true } },
        },
      });

      const byGroup = new Map<
        string,
        {
          categoryId: string;
          name: string;
          revenue: Prisma.Decimal;
          cost: Prisma.Decimal;
          unitsSold: number;
          isUnclassified: boolean;
        }
      >();
      for (const it of items) {
        const name = it.product.schedule?.trim() || "Unscheduled";
        const cur = byGroup.get(name) ?? {
          categoryId: name,
          name,
          revenue: new Prisma.Decimal(0),
          cost: new Prisma.Decimal(0),
          unitsSold: 0,
          isUnclassified: name === "Unscheduled",
        };
        cur.revenue = cur.revenue.add(it.lineTotal);
        cur.cost = cur.cost.add(it.batch.costPrice.mul(it.qty));
        cur.unitsSold += it.qty;
        byGroup.set(name, cur);
      }

      return {
        days,
        groupedBy: "schedule" as const,
        categories: [...byGroup.values()]
          .map((v) => ({
            categoryId: v.categoryId,
            name: v.name,
            revenue: v.revenue.toString(),
            cost: v.cost.toString(),
            margin: v.revenue.sub(v.cost).toString(),
            unitsSold: v.unitsSold,
            isUnclassified: v.isUnclassified,
          }))
          .sort((a, b) => Number(b.revenue) - Number(a.revenue)),
      };
    }

    const items = await this.prisma.saleItem.findMany({
      where: {
        tenantId,
        sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } },
      },
      select: { productId: true, qty: true, lineTotal: true, batch: { select: { costPrice: true } } },
    });
    const productIds = [...new Set(items.map((it) => it.productId))];

    type Agg = {
      categoryId: string;
      name: string;
      revenue: Prisma.Decimal;
      cost: Prisma.Decimal;
      unitsSold: number;
      isUnclassified: boolean;
    };
    const toRow = (v: Agg) => ({
      categoryId: v.categoryId,
      name: v.name,
      revenue: v.revenue.toString(),
      cost: v.cost.toString(),
      margin: v.revenue.sub(v.cost).toString(),
      unitsSold: v.unitsSold,
      isUnclassified: v.isUnclassified,
    });

    if (groupBy === "commercial") {
      // "Category" for merchandising means the department (e.g. Medicines, Personal Care),
      // not the leaf sub-category a product happens to be tagged with (e.g. Pain & Fever) —
      // so commercial rows roll up to their parent department, carrying each department's
      // own leaf children along for the interactive breakdown-on-hover chart.
      const categoryByProduct = await this.categoryTaxonomy.primaryCommercialCategoryByProductIds(
        tenantId,
        productIds,
      );

      const byParent = new Map<string, Agg & { children: Map<string, Agg> }>();
      for (const it of items) {
        const category = categoryByProduct.get(it.productId);
        const childId = category?.id ?? "uncategorized";
        const childName = category?.name ?? "Uncategorized";
        // The real "Unclassified Medicines" safety-net category is only detectable by its
        // stable canonicalKey (a tenant may rename the display name), not by string matching.
        const isChildUnclassified =
          childId === "uncategorized" || category?.canonicalKey === UNCLASSIFIED_MEDICINES_CANONICAL_KEY;
        // Root-level categories (no parent) roll up to themselves — a product can be tagged
        // directly on a department rather than one of its children.
        const parentId = category?.parentCategoryId ?? childId;
        const parentName = category?.parentCategoryId ? (category.parent?.name ?? "Uncategorized") : childName;

        const parent = byParent.get(parentId) ?? {
          categoryId: parentId,
          name: parentName,
          revenue: new Prisma.Decimal(0),
          cost: new Prisma.Decimal(0),
          unitsSold: 0,
          isUnclassified: parentId === "uncategorized",
          children: new Map<string, Agg>(),
        };
        parent.revenue = parent.revenue.add(it.lineTotal);
        parent.cost = parent.cost.add(it.batch.costPrice.mul(it.qty));
        parent.unitsSold += it.qty;
        byParent.set(parentId, parent);

        const child = parent.children.get(childId) ?? {
          categoryId: childId,
          name: childName,
          revenue: new Prisma.Decimal(0),
          cost: new Prisma.Decimal(0),
          unitsSold: 0,
          isUnclassified: isChildUnclassified,
        };
        child.revenue = child.revenue.add(it.lineTotal);
        child.cost = child.cost.add(it.batch.costPrice.mul(it.qty));
        child.unitsSold += it.qty;
        parent.children.set(childId, child);
      }

      return {
        days,
        groupedBy: "commercial" as const,
        categories: [...byParent.values()]
          .map((p) => ({
            ...toRow(p),
            children: [...p.children.values()].map(toRow).sort((a, b) => Number(b.revenue) - Number(a.revenue)),
          }))
          .sort((a, b) => Number(b.revenue) - Number(a.revenue)),
      };
    }

    const categoryByProduct = await this.categoryTaxonomy.regulatoryCategoryByProductIds(
      tenantId,
      productIds,
      groupBy === "dosageForm" ? "DOSAGE_FORM" : "REGISTRATION_TYPE",
    );
    const fallbackName = groupBy === "registrationType" ? "Unspecified" : "Uncategorized";

    const byCategory = new Map<string, Agg>();
    for (const it of items) {
      const category = categoryByProduct.get(it.productId);
      const catId = category?.id ?? "uncategorized";
      const name = category?.name ?? fallbackName;
      const isUnclassified = catId === "uncategorized";
      const cur = byCategory.get(catId) ?? {
        categoryId: catId,
        name,
        revenue: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
        unitsSold: 0,
        isUnclassified,
      };
      cur.revenue = cur.revenue.add(it.lineTotal);
      cur.cost = cur.cost.add(it.batch.costPrice.mul(it.qty));
      cur.unitsSold += it.qty;
      byCategory.set(catId, cur);
    }

    return {
      days,
      groupedBy: groupBy,
      categories: [...byCategory.values()].map(toRow).sort((a, b) => Number(b.revenue) - Number(a.revenue)),
    };
  }

  /** Per-cashier (Sale.soldBy) leaderboard, plus the same sales bucketed into 3 shifts by hour-of-day. */
  async salesByCashier(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const sales = await this.prisma.sale.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } },
      select: { soldBy: true, grandTotal: true, discountTotal: true, status: true, soldAt: true },
    });

    type Agg = { revenue: Prisma.Decimal; transactions: number; discountTotal: Prisma.Decimal; corrections: number };
    const emptyAgg = (): Agg => ({ revenue: new Prisma.Decimal(0), transactions: 0, discountTotal: new Prisma.Decimal(0), corrections: 0 });
    function accumulate(agg: Agg, sale: (typeof sales)[number]) {
      if (sale.status === "posted" || sale.status === "partially_refunded") {
        agg.revenue = agg.revenue.add(sale.grandTotal);
        agg.transactions += 1;
      }
      if (sale.status === "voided" || sale.status === "refunded" || sale.status === "partially_refunded") {
        agg.corrections += 1;
      }
      agg.discountTotal = agg.discountTotal.add(sale.discountTotal);
    }

    const byUser = new Map<string, Agg>();
    const byShift = new Map(SHIFT_RANGES.map((s) => [s.key, emptyAgg()]));
    const cashiersByShift = new Map(SHIFT_RANGES.map((s) => [s.key, new Set<string>()]));

    for (const sale of sales) {
      const userAgg = byUser.get(sale.soldBy) ?? emptyAgg();
      accumulate(userAgg, sale);
      byUser.set(sale.soldBy, userAgg);

      const hour = new Date(sale.soldAt).getHours();
      const shiftKey = SHIFT_RANGES.find((r) => r.hours(hour))!.key;
      accumulate(byShift.get(shiftKey)!, sale);
      cashiersByShift.get(shiftKey)!.add(sale.soldBy);
    }

    const users = await this.prisma.appUser.findMany({
      where: { tenantId, id: { in: [...byUser.keys()] } },
      select: { id: true, fullName: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));

    const serialize = (a: Agg) => ({
      revenue: a.revenue.toString(),
      transactions: a.transactions,
      avgBasket: a.transactions > 0 ? a.revenue.div(a.transactions).toString() : "0",
      discountTotal: a.discountTotal.toString(),
      discountRatePct: a.revenue.gt(0) ? a.discountTotal.div(a.revenue).mul(100).toString() : "0",
      corrections: a.corrections,
    });

    return {
      days,
      cashiers: [...byUser.entries()]
        .map(([userId, agg]) => ({ userId, name: nameById.get(userId) ?? "Unknown", ...serialize(agg) }))
        .sort((a, b) => Number(b.revenue) - Number(a.revenue)),
      shifts: SHIFT_RANGES.map((s) => ({
        key: s.key,
        label: s.label,
        activeCashiers: cashiersByShift.get(s.key)!.size,
        ...serialize(byShift.get(s.key)!),
      })),
    };
  }

  /** Revenue + transaction count per tender type, plus a daily series for a trend chart. */
  async salesByPaymentMethod(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const payments = await this.prisma.salePayment.findMany({
      where: { tenantId, sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } } },
      select: { method: true, amount: true, saleId: true, sale: { select: { status: true, soldAt: true } } },
    });

    type Agg = { revenue: Prisma.Decimal; saleIds: Set<string>; refunded: Prisma.Decimal };
    const byMethod = new Map<string, Agg>();
    const byDay = new Map<string, Map<string, Prisma.Decimal>>();

    for (const p of payments) {
      const cur = byMethod.get(p.method) ?? { revenue: new Prisma.Decimal(0), saleIds: new Set<string>(), refunded: new Prisma.Decimal(0) };
      cur.revenue = cur.revenue.add(p.amount);
      cur.saleIds.add(p.saleId);
      if (p.sale.status === "refunded" || p.sale.status === "partially_refunded") {
        cur.refunded = cur.refunded.add(p.amount);
      }
      byMethod.set(p.method, cur);

      const dayKey = p.sale.soldAt.toISOString().slice(0, 10);
      const dayMap = byDay.get(dayKey) ?? new Map<string, Prisma.Decimal>();
      dayMap.set(p.method, (dayMap.get(p.method) ?? new Prisma.Decimal(0)).add(p.amount));
      byDay.set(dayKey, dayMap);
    }

    const methodKeys = [...byMethod.keys()];
    const dayKeys = [...byDay.keys()].sort();

    return {
      days,
      methods: methodKeys
        .map((method) => {
          const agg = byMethod.get(method)!;
          return {
            method,
            revenue: agg.revenue.toString(),
            transactions: agg.saleIds.size,
            avgTicket: agg.saleIds.size > 0 ? agg.revenue.div(agg.saleIds.size).toString() : "0",
            refundedAtThisMethod: agg.refunded.toString(),
          };
        })
        .sort((a, b) => Number(b.revenue) - Number(a.revenue)),
      trend: dayKeys.map((date) => {
        const dayMap = byDay.get(date)!;
        const point: Record<string, string> = { date };
        for (const method of methodKeys) point[method] = (dayMap.get(method) ?? new Prisma.Decimal(0)).toString();
        return point;
      }),
    };
  }

  /** Customer returns (grouped by free-text reason and by product) + per-product discount leakage. */
  async returnsAndDiscounts(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [returns, discountItems] = await Promise.all([
      this.prisma.goodsReturn.findMany({
        where: { tenantId, type: "customer", ...(branchId ? { branchId } : {}), createdAt: { gte: since } },
        select: {
          id: true,
          reason: true,
          amount: true,
          createdAt: true,
          saleId: true,
          items: { select: { productId: true, qty: true, unitPrice: true, product: { select: { sku: true, name: true } } } },
        },
      }),
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          discountAmount: { gt: 0 },
          sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } },
        },
        select: { productId: true, discountAmount: true, product: { select: { sku: true, name: true } }, sale: { select: { soldAt: true } } },
      }),
    ]);

    const totalReturnValue = returns.reduce((s, r) => s + Number(r.amount), 0);
    const totalDiscount = discountItems.reduce((s, i) => s + Number(i.discountAmount), 0);
    const returnedItemCount = returns.reduce((s, r) => s + r.items.reduce((s2, it) => s2 + it.qty, 0), 0);

    const byReason = new Map<string, { reason: string; value: number; count: number }>();
    for (const r of returns) {
      const reason = r.reason?.trim() || "Unspecified";
      const cur = byReason.get(reason) ?? { reason, value: 0, count: 0 };
      cur.value += Number(r.amount);
      cur.count += 1;
      byReason.set(reason, cur);
    }

    const byDiscountProduct = new Map<string, { productId: string; sku: string; name: string; amount: number }>();
    for (const it of discountItems) {
      const cur = byDiscountProduct.get(it.productId) ?? { productId: it.productId, sku: it.product.sku, name: it.product.name, amount: 0 };
      cur.amount += Number(it.discountAmount);
      byDiscountProduct.set(it.productId, cur);
    }

    const byReturnedProduct = new Map<string, { productId: string; sku: string; name: string; value: number; qty: number }>();
    for (const r of returns) {
      for (const it of r.items) {
        const cur = byReturnedProduct.get(it.productId) ?? { productId: it.productId, sku: it.product.sku, name: it.product.name, value: 0, qty: 0 };
        cur.value += Number(it.unitPrice) * it.qty;
        cur.qty += it.qty;
        byReturnedProduct.set(it.productId, cur);
      }
    }
    const returnedProductIds = [...byReturnedProduct.keys()];
    const soldQtyByProduct = returnedProductIds.length
      ? await this.prisma.saleItem.groupBy({
          by: ["productId"],
          where: { tenantId, productId: { in: returnedProductIds }, sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since } } },
          _sum: { qty: true },
        })
      : [];
    const soldQtyMap = new Map(soldQtyByProduct.map((g) => [g.productId, g._sum.qty ?? 0]));

    const returnTrendByDay = new Map<string, number>();
    for (const r of returns) {
      const key = r.createdAt.toISOString().slice(0, 10);
      returnTrendByDay.set(key, (returnTrendByDay.get(key) ?? 0) + Number(r.amount));
    }
    const discountTrendByDay = new Map<string, number>();
    for (const it of discountItems) {
      const key = it.sale.soldAt.toISOString().slice(0, 10);
      discountTrendByDay.set(key, (discountTrendByDay.get(key) ?? 0) + Number(it.discountAmount));
    }
    const allDays = [...new Set([...returnTrendByDay.keys(), ...discountTrendByDay.keys()])].sort();

    return {
      days,
      totalReturnValue,
      returnedItemCount,
      totalDiscount,
      netSalesImpact: -(totalReturnValue + totalDiscount),
      topReasons: [...byReason.values()].sort((a, b) => b.value - a.value),
      topDiscountLeakage: [...byDiscountProduct.values()].sort((a, b) => b.amount - a.amount).slice(0, 10),
      topReturnedProducts: [...byReturnedProduct.values()]
        .map((p) => {
          const soldQty = soldQtyMap.get(p.productId) ?? 0;
          return { ...p, soldQty, returnRatePct: soldQty > 0 ? (p.qty / soldQty) * 100 : null };
        })
        .sort((a, b) => b.value - a.value)
        .slice(0, 50),
      trend: allDays.map((date) => ({
        date,
        returnValue: returnTrendByDay.get(date) ?? 0,
        discountAmount: discountTrendByDay.get(date) ?? 0,
      })),
    };
  }

  /** Revenue summed into a weekday × hour grid, for a daypart heatmap. */
  async salesByHour(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const sales = await this.prisma.sale.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
      select: { soldAt: true, grandTotal: true },
    });

    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    const counts: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const s of sales) {
      const d = new Date(s.soldAt);
      grid[d.getDay()]![d.getHours()] += Number(s.grandTotal);
      counts[d.getDay()]![d.getHours()] += 1;
    }

    return { days, weekdayLabels: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], grid, counts };
  }

  /** One row per calendar day in range — gross sales (pre-discount), discounts, returns (bucketed by
   * the return's own date, same as `returnsAndDiscounts()`), and the net of the three. Every day in
   * the window gets a row even with no activity, so the table always shows a full `days`-row range. */
  async salesDaily(tenantId: string, branchId: string | null, days = 30) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));

    const [sales, returns] = await Promise.all([
      this.prisma.sale.findMany({
        where: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          soldAt: { gte: rangeStart },
          status: { in: ["posted", "partially_refunded"] },
        },
        select: { soldAt: true, subtotal: true, discountTotal: true },
      }),
      this.prisma.goodsReturn.findMany({
        where: { tenantId, type: "customer", ...(branchId ? { branchId } : {}), createdAt: { gte: rangeStart } },
        select: { createdAt: true, amount: true },
      }),
    ]);

    const dayKeys: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(todayStart);
      d.setDate(d.getDate() - i);
      dayKeys.push(d.toISOString().slice(0, 10));
    }

    const byDay = new Map<string, { transactions: number; grossSales: Prisma.Decimal; discounts: Prisma.Decimal; returns: Prisma.Decimal }>();
    for (const key of dayKeys) byDay.set(key, { transactions: 0, grossSales: new Prisma.Decimal(0), discounts: new Prisma.Decimal(0), returns: new Prisma.Decimal(0) });

    for (const s of sales) {
      const key = s.soldAt.toISOString().slice(0, 10);
      const cur = byDay.get(key);
      if (!cur) continue;
      cur.transactions += 1;
      cur.grossSales = cur.grossSales.add(s.subtotal);
      cur.discounts = cur.discounts.add(s.discountTotal);
    }
    for (const r of returns) {
      const key = r.createdAt.toISOString().slice(0, 10);
      const cur = byDay.get(key);
      if (!cur) continue;
      cur.returns = cur.returns.add(r.amount);
    }

    return {
      days,
      rows: dayKeys.map((date) => {
        const d = byDay.get(date)!;
        return {
          date,
          transactions: d.transactions,
          grossSales: d.grossSales.toString(),
          discounts: d.discounts.toString(),
          returns: d.returns.toString(),
          netSales: d.grossSales.sub(d.discounts).sub(d.returns).toString(),
        };
      }),
    };
  }
}
