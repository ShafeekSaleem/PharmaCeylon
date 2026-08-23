import { apiJson } from "@/lib/auth-client";
import type {
  BranchMarginResponse,
  BranchMarginRow,
  BranchMarginTrendResponse,
  BranchPerformanceResponse,
  BranchTrendResponse,
  BranchTrendPoint,
  CategoryChildRow,
  CategoryGroupBy,
  CategoryRow,
  CommercialCategoryRow,
  DeadStockResponse,
  MarginRow,
  MarginTrendByCategoryResponse,
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
  StockAgeingResponse,
  StockHealthResponse,
  InventorySummaryResponse,
  MovementGranularity,
  MovementTypeFilterKey,
  StockMovementResponse,
  TransfersReportResponse,
  StocktakesReportResponse,
  PurchaseSummaryResponse,
  SupplierSpendResponse,
  SupplierPerformanceResponse,
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

export function fetchNearExpiry(
  withinDays: number,
  scope: Scope,
  isOwner: boolean,
  categoryId?: string | null,
  supplierId?: string | null,
) {
  const qs =
    `/reports/near-expiry?withinDays=${withinDays}${scopeQs(scope, isOwner)}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "");
  return apiJson<NearExpiryResponse>(qs);
}

/** Lightweight active-supplier list for the Near Expiry page's Supplier filter dropdown. */
export function fetchSuppliersForFilter() {
  return apiJson<Array<{ id: string; name: string; isActive?: boolean }>>("/suppliers?status=active");
}

export function fetchDeadStock(days: number, scope: Scope, isOwner: boolean, categoryId?: string | null, supplierId?: string | null) {
  const qs =
    `/reports/dead-stock?days=${days}${scopeQs(scope, isOwner)}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "");
  return apiJson<DeadStockResponse>(qs);
}

export function fetchStockMovement(
  days: number,
  scope: Scope,
  isOwner: boolean,
  categoryId?: string | null,
  supplierId?: string | null,
  movementType?: MovementTypeFilterKey | null,
  granularity?: MovementGranularity | null,
) {
  const qs =
    `/reports/stock-movement?days=${days}${scopeQs(scope, isOwner)}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "") +
    (movementType ? `&movementType=${movementType}` : "") +
    (granularity ? `&granularity=${granularity}` : "");
  return apiJson<StockMovementResponse>(qs);
}

export function fetchTransfersReport(days: number) {
  return apiJson<TransfersReportResponse>(`/reports/transfers?days=${days}`);
}

export function fetchStocktakesReport(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<StocktakesReportResponse>(`/reports/stocktakes?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchPurchaseSummary(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<PurchaseSummaryResponse>(`/reports/purchase-summary?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchSupplierSpend(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SupplierSpendResponse>(`/reports/supplier-spend?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchSupplierPerformance(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<SupplierPerformanceResponse>(`/reports/supplier-performance?days=${days}${scopeQs(scope, isOwner)}`);
}

export function fetchInventorySummary(scope: Scope, isOwner: boolean, categoryId?: string | null, supplierId?: string | null) {
  const qs =
    `/reports/inventory-summary?${scopeQs(scope, isOwner).replace(/^&/, "")}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "");
  return apiJson<InventorySummaryResponse>(qs);
}

export function fetchStockHealth(scope: Scope, isOwner: boolean, categoryId?: string | null, supplierId?: string | null) {
  const qs =
    `/reports/stock-health?${scopeQs(scope, isOwner).replace(/^&/, "")}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "");
  return apiJson<StockHealthResponse>(qs);
}

export function fetchStockAgeing(scope: Scope, isOwner: boolean, categoryId?: string | null, supplierId?: string | null) {
  const qs =
    `/reports/stock-ageing?${scopeQs(scope, isOwner).replace(/^&/, "")}` +
    (categoryId ? `&categoryId=${categoryId}` : "") +
    (supplierId ? `&supplierId=${supplierId}` : "");
  return apiJson<StockAgeingResponse>(qs);
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
  // in the previous window still count instead of being silently dropped. `previousRows` reuses the
  // same full-`combined`-set derivation to give callers a real previous-period product list (e.g. for
  // recomputing a top-N concentration or a margin-band share as of the prior period), not just the
  // subset also active today that `previousByProduct` covers.
  const currentByProduct = new Map(current.map((r) => [r.productId, r]));
  let previousActiveSkuCount = 0;
  const previousRows: Array<MarginRow & { revenueN: number; costN: number; marginN: number; marginPct: number }> = [];
  for (const row of combined) {
    const curRow = currentByProduct.get(row.productId);
    const curRevenue = curRow ? Number(curRow.revenue) : 0;
    const revenueN = Number(row.revenue) - curRevenue;
    if (revenueN > 0) {
      previousActiveSkuCount++;
      const costN = (curRow ? Number(row.cost) - Number(curRow.cost) : Number(row.cost));
      const marginN = revenueN - costN;
      previousRows.push({
        ...row,
        revenue: String(revenueN),
        cost: String(costN),
        margin: String(marginN),
        unitsSold: row.unitsSold - (curRow?.unitsSold ?? 0),
        revenueN,
        costN,
        marginN,
        marginPct: (marginN / revenueN) * 100,
      });
    }
  }

  return { current, currentTotals, previousTotals, previousByProduct, previousActiveSkuCount, previousRows };
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

/** Daily revenue/cost per top-level COMMERCIAL department — powers Margin by Category's trend
 *  line chart. Real per-day data (not a comparison fetch), so a single call is enough. */
export function fetchMarginTrendByCategory(days: number, scope: Scope, isOwner: boolean) {
  return apiJson<MarginTrendByCategoryResponse>(`/reports/margin-trend-by-category?days=${days}${scopeQs(scope, isOwner)}`);
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

/** Every active branch's revenue/COGS/gross profit for the window — no `scope`/branch param,
 *  this always covers the whole tenant (see `BranchMarginRow`'s doc comment). */
export function fetchBranchMargin(days: number) {
  return apiJson<BranchMarginResponse>(`/reports/branch-margin?days=${days}`);
}

export function fetchBranchMarginTrend(days: number) {
  return apiJson<BranchMarginTrendResponse>(`/reports/branch-margin-trend?days=${days}`);
}

function sumBranchTotals(rows: BranchMarginRow[]): MarginTotals {
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

/** Same double-fetch-and-diff technique as `fetchCategoryComparison` — one `days*2` call split
 *  into current/previous halves, rather than a second server-side "previous period" convention. */
export async function fetchBranchMarginComparison(days: number) {
  const [current, combined] = await Promise.all([fetchBranchMargin(days), fetchBranchMargin(days * 2)]);
  const previousByBranch = subtractByKey(current.branches, combined.branches, (r) => r.branchId, [
    "revenue",
    "cost",
    "margin",
    "unitsSold",
  ]);
  const currentTotals = sumBranchTotals(current.branches);
  const combinedTotals = sumBranchTotals(combined.branches);
  const previousTotals: MarginTotals = {
    revenue: combinedTotals.revenue - currentTotals.revenue,
    cost: combinedTotals.cost - currentTotals.cost,
    margin: combinedTotals.margin - currentTotals.margin,
    unitsSold: combinedTotals.unitsSold - currentTotals.unitsSold,
  };
  return { current: current.branches, previousByBranch, currentTotals, previousTotals };
}
