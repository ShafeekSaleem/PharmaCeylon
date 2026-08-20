import { apiJson } from "@/lib/auth-client";
import type {
  BranchPerformanceResponse,
  BranchTrendResponse,
  BranchTrendPoint,
  CategoryChildRow,
  CategoryGroupBy,
  CategoryRow,
  CommercialCategoryRow,
  DeadStockResponse,
  MarginRow,
  NearExpiryResponse,
  PaymentMethodRow,
  ProfitabilityTarget,
  ReturnsDiscountsResponse,
  SalesByCashierResponse,
  SalesByCategoryResponse,
  SalesByHourResponse,
  SalesByPaymentMethodResponse,
  SalesDailyResponse,
  SalesSummary,
  Scope,
  StockValueResponse,
} from "./types";

function scopeQs(scope: Scope, isOwner: boolean): string {
  return isOwner && scope === "tenant" ? "&scope=tenant" : "";
}

export function fetchSalesSummary(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SalesSummary>(`/reports/sales-summary?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchMarginByProduct(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<MarginRow[]>(`/reports/margin-by-product?days=${days}${scopeQs(scope, isOwner)}`);
}

/** Tenant-configured gross margin % goal for the Gross Profit page's goal tracker — null until an
 *  owner/manager sets one in Settings → Profitability. */
export function fetchProfitabilityTarget() {
  return apiJson<ProfitabilityTarget>("/tenant/profitability-target");
}

export function updateProfitabilityTarget(targetGrossMarginPercent: number | null) {
  return apiJson<ProfitabilityTarget>("/tenant/profitability-target", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetGrossMarginPercent }),
  });
}

/** Full COMMERCIAL category list (flat, with `parentCategoryId`) — tenant-wide, not date-scoped. */
export function fetchCommercialCategories() {
  return apiJson<CommercialCategoryRow[]>("/products/categories");
}

export function fetchNearExpiry(withinDays: number) {
  return apiJson<NearExpiryResponse>(`/reports/near-expiry?withinDays=${withinDays}`);
}

export function fetchDeadStock(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<DeadStockResponse>(`/reports/dead-stock?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchStockValue(scope: Scope, isOwner: boolean) {
  return apiJson<StockValueResponse>(`/reports/stock-value?${scopeQs(scope, isOwner).replace(/^&/, "")}`);
}

export function fetchBranchSalesTrend(days: number) {
  return apiJson<BranchTrendResponse>(`/analytics/branch-sales-trend?days=${days}`);
}

export function fetchSalesDaily(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SalesDailyResponse>(`/reports/sales-daily?days=${days}${scopeQs(scope, isOwner)}`);
}

/** Aggregates one or all branches from a branch-sales-trend response into a single day-by-day series + totals. */
export function reduceBranchTrend(
  resp: BranchTrendResponse,
  scope: Scope,
  branchId: string | null,
): { points: BranchTrendPoint[]; total: number; previousTotal: number } {
  const branches =
    scope === "branch" && branchId
      ? resp.branches.filter((b) => b.branchId === branchId)
      : resp.branches;

  if (branches.length === 0) {
    return { points: [], total: 0, previousTotal: 0 };
  }

  const len = branches[0]!.points.length;
  const points: BranchTrendPoint[] = Array.from({ length: len }, (_, i) => ({
    label: branches[0]!.points[i]!.label,
    date: branches[0]!.points[i]!.date,
    value: branches.reduce((sum, b) => sum + (b.points[i]?.value ?? 0), 0),
  }));
  const total = branches.reduce((sum, b) => sum + b.total, 0);
  const previousTotal = branches.reduce((sum, b) => sum + b.previousTotal, 0);
  return { points, total, previousTotal };
}

/**
 * Daily revenue for the selected window plus the immediately-preceding equal-length window, so a
 * trend chart can plot both as separate lines. One `days*2` call to `branch-sales-trend` (its own
 * daily series ending today) is split in half locally — the endpoint's built-in `previousTotal` is
 * relative to a *different* window when `days` is doubled, so totals are re-summed from the split.
 */
export async function fetchSalesTrendWithComparison(days: number, scope: Scope, branchId: string | null) {
  const resp = await fetchBranchSalesTrend(days * 2);
  const reduced = reduceBranchTrend(resp, scope, branchId);
  const previousPoints = reduced.points.slice(0, days);
  const currentPoints = reduced.points.slice(days);
  const total = currentPoints.reduce((s, p) => s + p.value, 0);
  const previousTotal = previousPoints.reduce((s, p) => s + p.value, 0);
  return { currentPoints, previousPoints, total, previousTotal };
}

/** Sales revenue + transaction-count comparison against the equal-length prior window, derived from two aggregate calls (the API has no dedicated "previous period" endpoint for /reports/sales-summary). */
export async function fetchSalesComparison(days: number, scope: Scope, isOwner: boolean) {
  const [current, combined] = await Promise.all([
    fetchSalesSummary(days, scope, isOwner),
    fetchSalesSummary(days * 2, scope, isOwner),
  ]);
  const previousCount = combined.count - current.count;
  const previousGrandTotal = Number(combined.grandTotal) - Number(current.grandTotal);
  return { current, previous: { count: previousCount, grandTotal: previousGrandTotal } };
}

export type MarginTotals = { revenue: number; cost: number; margin: number; unitsSold: number };

function sumMargin(rows: MarginRow[]): MarginTotals {
  const revenue = rows.reduce((s, r) => s + Number(r.revenue), 0);
  const cost = rows.reduce((s, r) => s + Number(r.cost), 0);
  const unitsSold = rows.reduce((s, r) => s + r.unitsSold, 0);
  return { revenue, cost, margin: revenue - cost, unitsSold };
}

/** Margin totals + per-product comparison against the equal-length prior window (same double-fetch-and-subtract technique as sales). */
export async function fetchMarginComparison(days: number, scope: Scope, isOwner: boolean) {
  const [current, combined] = await Promise.all([
    fetchMarginByProduct(days, scope, isOwner),
    fetchMarginByProduct(days * 2, scope, isOwner),
  ]);
  const currentTotals = sumMargin(current);
  const combinedTotals = sumMargin(combined);
  const previousTotals: MarginTotals = {
    revenue: combinedTotals.revenue - currentTotals.revenue,
    cost: combinedTotals.cost - currentTotals.cost,
    margin: combinedTotals.margin - currentTotals.margin,
    unitsSold: combinedTotals.unitsSold - currentTotals.unitsSold,
  };

  const combinedByProduct = new Map(combined.map((r) => [r.productId, r]));
  const previousByProduct = new Map<string, MarginTotals & { marginPct: number }>();
  for (const row of current) {
    const both = combinedByProduct.get(row.productId);
    const prevRevenue = (both ? Number(both.revenue) : 0) - Number(row.revenue);
    const prevCost = (both ? Number(both.cost) : 0) - Number(row.cost);
    const prevMargin = prevRevenue - prevCost;
    const prevUnits = (both ? both.unitsSold : 0) - row.unitsSold;
    previousByProduct.set(row.productId, {
      revenue: prevRevenue,
      cost: prevCost,
      margin: prevMargin,
      unitsSold: prevUnits,
      marginPct: prevRevenue > 0 ? (prevMargin / prevRevenue) * 100 : 0,
    });
  }

  // Distinct SKUs active in the previous window — computed from the full `combined` set (not just
  // `previousByProduct`, which only covers products also active *now*) so products that sold only
  // in the previous window still count instead of being silently dropped.
  const currentByProduct = new Map(current.map((r) => [r.productId, r]));
  let previousActiveSkuCount = 0;
  for (const row of combined) {
    const curRevenue = currentByProduct.has(row.productId) ? Number(currentByProduct.get(row.productId)!.revenue) : 0;
    if (Number(row.revenue) - curRevenue > 0) previousActiveSkuCount++;
  }

  return { current, currentTotals, previousTotals, previousByProduct, previousActiveSkuCount };
}

/** Subtracts `current` numeric fields from a `days*2` combined fetch to derive the immediately-preceding
 * window per entity — same double-fetch technique as sales/margin, generalized across the category,
 * cashier and payment-method reports (all "grouped rows with a handful of numeric-string fields"). */
function subtractByKey<TRow extends Record<string, unknown>>(
  current: TRow[],
  combined: TRow[],
  keyOf: (r: TRow) => string,
  fields: Array<keyof TRow & string>,
): Map<string, Record<string, number>> {
  const combinedByKey = new Map(combined.map((r) => [keyOf(r), r]));
  const result = new Map<string, Record<string, number>>();
  for (const row of current) {
    const key = keyOf(row);
    const both = combinedByKey.get(key);
    const prev: Record<string, number> = {};
    for (const field of fields) {
      prev[field] = Number(both?.[field] ?? 0) - Number(row[field] ?? 0);
    }
    result.set(key, prev);
  }
  return result;
}

export function fetchSalesByCategory(days: number, scope: Scope, isOwner: boolean, groupBy: CategoryGroupBy = "commercial") {
  return apiJson<SalesByCategoryResponse>(`/reports/sales-by-category?days=${days}${scopeQs(scope, isOwner)}&groupBy=${groupBy}`);
}

function sumCategoryTotals(rows: CategoryRow[]): MarginTotals {
  return rows.reduce(
    (acc, r) => ({
      revenue: acc.revenue + Number(r.revenue),
      cost: acc.cost + Number(r.cost),
      margin: acc.margin + Number(r.margin),
      unitsSold: acc.unitsSold + Number(r.unitsSold),
    }),
    { revenue: 0, cost: 0, margin: 0, unitsSold: 0 },
  );
}

export async function fetchCategoryComparison(days: number, scope: Scope, isOwner: boolean, groupBy: CategoryGroupBy = "commercial") {
  const [current, combined] = await Promise.all([
    fetchSalesByCategory(days, scope, isOwner, groupBy),
    fetchSalesByCategory(days * 2, scope, isOwner, groupBy),
  ]);
  const previousByCategory = subtractByKey(current.categories, combined.categories, (r) => r.categoryId, [
    "revenue",
    "cost",
    "margin",
    "unitsSold",
  ]);
  // Same diff, one level down — `groupBy=commercial` rows carry a `children` array (the leaf
  // categories rolled up under each parent department); flattening both periods' children before
  // diffing gives the Category Performance table's parent-drill-down view a real growth column
  // too, not just the parent rows.
  const currentChildren: CategoryChildRow[] = current.categories.flatMap((r) => r.children ?? []);
  const combinedChildren: CategoryChildRow[] = combined.categories.flatMap((r) => r.children ?? []);
  const previousByChildCategory = subtractByKey(currentChildren, combinedChildren, (r) => r.categoryId, [
    "revenue",
    "cost",
    "margin",
    "unitsSold",
  ]);
  // Totals use the full `combined` set (not just categories also active in the current
  // period) so a category that dropped to zero this period doesn't get silently excluded
  // from the previous-period total — same fix applied to fetchMarginComparison's SKU count.
  const currentTotals = sumCategoryTotals(current.categories);
  const combinedTotals = sumCategoryTotals(combined.categories);
  const previousTotals: MarginTotals = {
    revenue: combinedTotals.revenue - currentTotals.revenue,
    cost: combinedTotals.cost - currentTotals.cost,
    margin: combinedTotals.margin - currentTotals.margin,
    unitsSold: combinedTotals.unitsSold - currentTotals.unitsSold,
  };
  return { current: current.categories, previousByCategory, previousByChildCategory, currentTotals, previousTotals };
}

export function fetchSalesByCashier(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SalesByCashierResponse>(`/reports/sales-by-cashier?days=${days}${scopeQs(scope, isOwner)}`);
}

/** Aggregate (not per-cashier) revenue/transactions/active-cashier-count comparison — enough for the KPI row.
 * Active-cashier count uses the full `combined` (2×days) roster, not just cashiers also active in the
 * current period, so a cashier who worked last period but not this one isn't silently dropped from the
 * previous-period count (the same undercount fix applied to fetchMarginComparison's SKU count). */
export async function fetchCashierAggregateComparison(days: number, scope: Scope, isOwner: boolean) {
  const [current, combined] = await Promise.all([
    fetchSalesByCashier(days, scope, isOwner),
    fetchSalesByCashier(days * 2, scope, isOwner),
  ]);
  const sum = (rows: RevenueRow[]) => rows.reduce((s, r) => s + Number(r.revenue), 0);
  const currentRevenue = sum(current.cashiers);
  const previousRevenue = sum(combined.cashiers) - currentRevenue;

  const currentTransactions = current.cashiers.reduce((s, c) => s + c.transactions, 0);
  const previousTransactions = combined.cashiers.reduce((s, c) => s + c.transactions, 0) - currentTransactions;

  const currentByUser = new Map(current.cashiers.map((c) => [c.userId, c]));
  let previousActiveCashierCount = 0;
  for (const row of combined.cashiers) {
    const curRevenue = currentByUser.has(row.userId) ? Number(currentByUser.get(row.userId)!.revenue) : 0;
    if (Number(row.revenue) - curRevenue > 0) previousActiveCashierCount++;
  }

  return { current, currentRevenue, previousRevenue, currentTransactions, previousTransactions, previousActiveCashierCount };
}

type RevenueRow = { revenue: string };

export function fetchSalesByPaymentMethod(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SalesByPaymentMethodResponse>(`/reports/sales-by-payment-method?days=${days}${scopeQs(scope, isOwner)}`);
}

export async function fetchPaymentMethodComparison(days: number, scope: Scope, isOwner: boolean) {
  const [current, combined] = await Promise.all([
    fetchSalesByPaymentMethod(days, scope, isOwner),
    fetchSalesByPaymentMethod(days * 2, scope, isOwner),
  ]);
  const previousByMethod = subtractByKey(current.methods, combined.methods, (r: PaymentMethodRow) => r.method, ["revenue", "transactions"]);

  const currentRevenue = current.methods.reduce((s, m) => s + Number(m.revenue), 0);
  const previousRevenue = combined.methods.reduce((s, m) => s + Number(m.revenue), 0) - currentRevenue;
  const currentTransactions = current.methods.reduce((s, m) => s + m.transactions, 0);
  const previousTransactions = combined.methods.reduce((s, m) => s + m.transactions, 0) - currentTransactions;

  return { current, previousByMethod, previousRevenue, previousTransactions };
}

export function fetchReturnsAndDiscounts(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<ReturnsDiscountsResponse>(`/reports/returns-and-discounts?days=${days}${scopeQs(scope, isOwner)}`);
}

export async function fetchReturnsDiscountsComparison(days: number, scope: Scope, isOwner: boolean) {
  const [current, combined] = await Promise.all([
    fetchReturnsAndDiscounts(days, scope, isOwner),
    fetchReturnsAndDiscounts(days * 2, scope, isOwner),
  ]);
  return {
    current,
    previous: {
      totalReturnValue: combined.totalReturnValue - current.totalReturnValue,
      returnedItemCount: combined.returnedItemCount - current.returnedItemCount,
      totalDiscount: combined.totalDiscount - current.totalDiscount,
      netSalesImpact: combined.netSalesImpact - current.netSalesImpact,
    },
  };
}

export function fetchSalesByHour(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SalesByHourResponse>(`/reports/sales-by-hour?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchBranchPerformance(yearMonth?: string) {
  return apiJson<BranchPerformanceResponse>(`/analytics/branch-performance${yearMonth ? `?yearMonth=${yearMonth}` : ""}`);
}
