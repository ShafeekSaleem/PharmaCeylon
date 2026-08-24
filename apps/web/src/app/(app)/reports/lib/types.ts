export type Scope = "branch" | "tenant";

export type SalesSummary = {
  days: number;
  count: number;
  grandTotal: string;
  branchId: string | null;
  scope: "branch" | "tenant";
};

export type MarginRow = {
  productId: string;
  sku: string;
  name: string;
  /** Null when the product has no brand set. */
  brandName: string | null;
  revenue: string;
  cost: string;
  margin: string;
  unitsSold: number;
  stockOnHand: number;
  category: string;
  /** Primary COMMERCIAL category id, or null if unmapped — lets callers group products by
   *  category reliably (e.g. a same-category COGS-ratio benchmark) instead of matching on the
   *  display name, which a tenant can rename. */
  categoryId: string | null;
};

export type ProfitabilityTarget = { targetGrossMarginPercent: number | null };

export type StockValueItem = {
  productId: string;
  qtyOnHand: number;
  /** At cost (Σ batch.costPrice × qty). */
  value: string;
  /** At retail/MRP (Σ batch.sellingPrice × qty) — the Valuation Basis toggle switches between
   *  this and `value` client-side, no re-fetch needed. */
  retailValue: string;
  /** Leaf COMMERCIAL category, or null when the product has no COMMERCIAL mapping at all. */
  categoryId: string | null;
  categoryName: string;
  /** Top-level COMMERCIAL department the category rolls up to — every panel on this page groups
   *  at this level. Null (name "Unclassified") for an unmapped product, still counted in totals. */
  departmentId: string | null;
  departmentName: string;
  avgDailySales: number;
  /** Null (not Infinity/0) when there's no sales history to divide by — render as "—". */
  daysOfCover: number | null;
  reorderLevel: number;
  isLowStock: boolean;
  /** Capital-at-risk / slow-moving: has real sales velocity but days of cover exceeds the
   *  established threshold — deliberately excludes zero-velocity stock (that's Dead Stock's). */
  isAtRisk: boolean;
  product: { id: string; sku?: string; name?: string };
};

/** 30-days-ago snapshot (KPI deltas), per product — same department rollup as `StockValueItem`. */
export type StockValueSnapshotItem = {
  productId: string;
  value: number;
  retailValue: number;
  qtyOnHand: number;
  departmentId: string | null;
  departmentName: string;
};

export type StockValueTrendDept = { departmentId: string; departmentName: string; value: number; retailValue: number };
export type StockValueTrendPoint = { key: string; label: string; totalValue: number; totalRetailValue: number; departments: StockValueTrendDept[] };

/** One department's trailing-30-day sales revenue, keyed identically to `StockValueItem.departmentId`
 *  (null → "Unclassified") — powers the Inventory Share vs Sales Share dumbbell chart. */
export type InventorySalesByDepartment = { departmentId: string | null; departmentName: string; revenue: number };

export type InventorySummaryResponse = {
  items: StockValueItem[];
  previousItems: StockValueSnapshotItem[];
  /** 4 real ledger-reconstructed points: 30/20/10 days ago, then now — powers the Category Value
   *  Breakdown table's inline sparkline. */
  trend: StockValueTrendPoint[];
  /** Distinct in-scope products with a batch at this branch/tenant — the denominator for Stock
   *  Availability %, since `items`/`previousItems` silently omit any product with zero qty. */
  skuUniverseCount: number;
  salesByDepartment: InventorySalesByDepartment[];
};

export type StockHealthZone = "deadSlow" | "reorderRisk" | "overstocked" | "monitor" | "healthy";

export type StockHealthItem = {
  productId: string;
  qtyOnHand: number;
  value: string;
  departmentId: string | null;
  departmentName: string;
  avgDailySales: number;
  daysOfCover: number | null;
  daysSinceLastSale: number | null;
  reorderLevel: number;
  isLowStock: boolean;
  zone: StockHealthZone;
  product: { id: string; sku?: string; name?: string };
};

export type StockHealthSnapshotItem = { productId: string; value: number; qtyOnHand: number; zone: StockHealthZone; departmentId: string | null; departmentName: string };

export type StockHealthResponse = {
  items: StockHealthItem[];
  previousItems: StockHealthSnapshotItem[];
  skuUniverseCount: number;
};

/** Branch-to-branch expiry mitigation suggestion — only ever present when the report is scoped to
 *  one specific branch (an "All branches" view has no single "this branch" to move stock away
 *  from) and the tenant has another branch that currently sells this product. */
export type ExpiryTransferOpportunity = { toBranchId: string; toBranchName: string; toBranchAvgDailySales: number; suggestedUnits: number };

export type NearExpiryItem = {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  qtyOnHand: number;
  costPrice: string;
  valueAtRisk: string;
  /** Server-computed relative to this item's own snapshot date — `items` uses "today", while
   *  `previousItems` uses `withinDays` ago, so always read this instead of re-deriving it. */
  daysLeft: number;
  /** Primary COMMERCIAL category, rolled up to its parent department; null when unmapped. */
  categoryId: string | null;
  categoryName: string;
  supplierId: string | null;
  supplierName: string;
  product: { id: string; sku: string; name: string };
  transferOpportunity: ExpiryTransferOpportunity | null;
};

export type NearExpiryResponse = {
  withinDays: number;
  /** Every batch expiring within a 180-day (or `withinDays`, whichever is wider) horizon —
   *  wider than the KPI window on purpose so the time-bucket chart and calendar heatmap don't
   *  need a second fetch. Callers filter to `daysLeft <= withinDays` for the KPI/table view. */
  items: NearExpiryItem[];
  /** The same snapshot reconstructed from ledger quantities as of `withinDays` ago, for KPI
   *  period-over-period deltas — already scoped to the withinDays window, not the full horizon. */
  previousItems: NearExpiryItem[];
};

/** Severity-matrix quadrant — value axis splits at the dead-stock population's own median value,
 *  days axis at 2× the selected inactivity threshold. */
export type DeadStockQuadrant = "recoverFast" | "investigate" | "monitor" | "liquidate";

/** Centralized, deterministic per-item suggestion — computed server-side (see the API's
 *  `ReportsService.deadStock`), never re-derived here. */
export type DeadStockAction = "transfer" | "return_supplier" | "liquidate" | "review_assortment" | "markdown" | "bundle" | "monitor";

export type DeadStockItem = {
  productId: string;
  qtyOnHand: number;
  /** At cost — the tied-up capital figure every KPI/panel is built from. */
  value: string;
  /** Null when the product has never had a qualifying sale at all. */
  daysSinceLastSale: number | null;
  categoryId: string | null;
  categoryName: string;
  /** Top-level COMMERCIAL department this rolls up to — every panel groups at this level (this
   *  report spans every department, not just Medicines). */
  departmentId: string | null;
  departmentName: string;
  /** Residual demand over a window wider than the selected threshold — distinguishes "some
   *  demand recently, just excess stock" from "genuinely zero demand ever". */
  avgDailySales: number;
  daysOfCover: number | null;
  hasKnownSupplier: boolean;
  supplierName: string | null;
  /** True only when a specific branch is in view and another branch shows real recent velocity. */
  crossBranchDemand: boolean;
  quadrant: DeadStockQuadrant;
  suggestedAction: DeadStockAction;
  /** `value × ` an action-specific recovery factor, rounded to cents — see the API's
   *  `DEAD_STOCK_RECOVERY_FACTOR` for the documented assumption behind each action. */
  recoveryValue: number;
  product: { id: string; sku?: string; name?: string };
};

/** 30-days-ago snapshot (KPI deltas) — an independent reclassification as of that date, not
 *  today's items revalued, so a product that only went idle in the last 30 days correctly
 *  doesn't appear here. */
export type DeadStockSnapshotItem = {
  productId: string;
  value: number;
  qtyOnHand: number;
  departmentId: string | null;
  departmentName: string;
};

export type DeadStockTrendDept = { departmentId: string; departmentName: string; value: number };
export type DeadStockTrendPoint = { key: string; label: string; totalValue: number; departments: DeadStockTrendDept[] };

export type DeadStockResponse = {
  /** The inactivity threshold actually applied. */
  daysWithoutSale: number;
  items: DeadStockItem[];
  previousItems: DeadStockSnapshotItem[];
  trend: DeadStockTrendPoint[];
};

// ── Stock Movement ─────────────────────────────────────────────────────────────────────────

export type MovementTypeFilterKey =
  | "purchase_receipts"
  | "sales_outbound"
  | "transfers_in"
  | "transfers_out"
  | "returns_in"
  | "returns_out"
  | "adjustments"
  | "stocktake_adjustments";

export type MovementGranularity = "daily" | "weekly" | "monthly";
export type MovementReorderStatus = "healthy" | "reorder" | "watch" | "overstocking";

export type StockMovementKpis = {
  inboundUnits: number;
  prevInboundUnits: number;
  outboundUnits: number;
  prevOutboundUnits: number;
  /** At cost — see the API's `ReportsService.stockMovement` doc comment for why this never mixes
   *  cost and retail/sale-price bases. */
  netMovementValue: number;
  prevNetMovementValue: number;
  reorderAlerts: number;
  prevReorderAlerts: number;
  inventoryTurnover: number | null;
  prevInventoryTurnover: number | null;
  sellThroughRate: number | null;
  prevSellThroughRate: number | null;
  avgDaysCover: number | null;
  prevAvgDaysCover: number | null;
  stockoutEvents: number;
  prevStockoutEvents: number;
};

export type StockFlowBridgeStep = { key: string; label: string; kind: "total" | "addition" | "deduction"; value: number };
export type StockMovementCompositionRow = { key: string; label: string; direction: "in" | "out"; units: number };

export type StockMovementTrendPoint = {
  key: string;
  label: string;
  date: string;
  inboundUnits: number;
  outboundUnits: number;
  netUnits: number;
};

export type StockMovementCategoryRow = {
  departmentId: string | null;
  departmentName: string;
  inboundUnits: number;
  outboundUnits: number;
  netUnits: number;
};

export type StockMovementCategoryBreakdownRow = StockMovementCategoryRow & {
  avgDaysCover: number | null;
  /** Net units per trend bucket, same order/keys as `trend` — reconciles exactly against it. */
  trend: number[];
};

export type StockMovementInsight = {
  key: "fastMovingCategory" | "replenishmentWatch" | "highTransfersAdjustments" | "shrinkageVariance";
  title: string;
  description: string;
  changePct: number | null;
  countLabel: string;
};

export type StockMovementTopMoverItem = {
  productId: string;
  departmentId: string | null;
  departmentName: string;
  unitsOut: number;
  unitsIn: number;
  netChange: number;
  avgDailyUnitsOut: number;
  qtyOnHand: number;
  reorderLevel: number;
  reorderStatus: MovementReorderStatus;
  product: { id: string; sku?: string; name?: string };
};

export type StockMovementResponse = {
  days: number;
  granularity: MovementGranularity;
  kpis: StockMovementKpis;
  /** "All branches" only — see the API's doc comment for why transfers are excluded from `kpis`. */
  internalTransferUnits: number;
  trend: StockMovementTrendPoint[];
  avgInboundPerDay: number;
  avgOutboundPerDay: number;
  avgNetPerDay: number;
  bestNetDay: { label: string; date: string; netUnits: number } | null;
  categoryMovement: StockMovementCategoryRow[];
  highestMovementCategories: Array<{ departmentId: string | null; departmentName: string; totalUnits: number }>;
  insights: StockMovementInsight[];
  topMovers: StockMovementTopMoverItem[];
  categoryBreakdown: StockMovementCategoryBreakdownRow[];
  stockFlowBridge: StockFlowBridgeStep[];
  movementComposition: StockMovementCompositionRow[];
};

export type BranchTrendPoint = { label: string; date: string; value: number };

export type BranchTrendResponse = {
  trendDays: number;
  days: string[];
  branches: Array<{
    branchId: string;
    code: string;
    name: string;
    points: BranchTrendPoint[];
    total: number;
    previousTotal: number;
  }>;
  generatedAt: string;
};

export type ExpiryTier = "critical" | "watch" | "notice";

export type AgeBucketKey = "0-30" | "31-60" | "61-90" | "91-180" | "180+";
export type StockAgeingAction = "promote" | "discount" | "transfer" | "review" | "monitor";

export type StockAgeingItem = {
  batchId: string;
  batchNo: string;
  productId: string;
  receivedAt: string;
  ageDays: number;
  ageBucket: AgeBucketKey;
  qtyOnHand: number;
  costPrice: string;
  value: string;
  /** Leaf COMMERCIAL sub-category under Medicines (e.g. "Pain & Fever") — every item here is
   *  already scoped to the Medicines department, so the department itself isn't a useful field. */
  categoryId: string | null;
  categoryName: string;
  supplierId: string | null;
  supplierName: string;
  avgDailySales: number;
  /** Null (not Infinity/0) when there's no sales history to divide by — render as "—". */
  daysOfCover: number | null;
  recommendation: { key: StockAgeingAction; label: string };
  product: { id: string; sku?: string; name?: string };
};

/** Historical snapshot shape (previous-period KPI deltas, monthly trend) — no recommendation or
 *  velocity fields, since those are only meaningful for the current, actionable view. */
export type StockAgeingSnapshotItem = { ageDays: number; ageBucket: AgeBucketKey; value: number; categoryId: string | null };

export type StockAgeingTrendBucket = { key: AgeBucketKey; label: string; value: number; pct: number };
export type StockAgeingTrendPoint = { key: string; label: string; totalValue: number; buckets: StockAgeingTrendBucket[] };

export type StockAgeingResponse = {
  items: StockAgeingItem[];
  previousItems: StockAgeingSnapshotItem[];
  trend: StockAgeingTrendPoint[];
};

export type TransferFlowRow = { fromBranchId: string; fromBranchName: string; toBranchId: string; toBranchName: string; transferCount: number; units: number; value: number };

export type TransferOpportunity = {
  productId: string;
  product: { id: string; sku?: string; name?: string };
  fromBranchId: string;
  fromBranchName: string;
  fromDaysCover: number;
  toBranchId: string;
  toBranchName: string;
  toDaysCover: number | null;
  suggestedUnits: number;
  estimatedValue: number;
};

export type TransferActivityRow = {
  id: string;
  transferNumber: string;
  fromBranchId: string;
  fromBranchName: string;
  toBranchId: string;
  toBranchName: string;
  status: string;
  itemCount: number;
  units: number;
  value: number;
  createdAt: string;
  completedAt: string | null;
};

export type TransfersInsight = { key: string; title: string; description: string; countLabel: string };

export type TransfersKpis = {
  transferCount: number;
  prevTransferCount: number;
  valueMoved: number;
  prevValueMoved: number;
  avgCompletionHours: number | null;
  prevAvgCompletionHours: number | null;
  successRatePct: number | null;
  prevSuccessRatePct: number | null;
};

export type TransfersReportResponse = {
  days: number;
  isMultiBranch: boolean;
  kpis: TransfersKpis;
  branchFlow: TransferFlowRow[];
  opportunities: TransferOpportunity[];
  activity: TransferActivityRow[];
  insights: TransfersInsight[];
};

export type StocktakesKpis = {
  accuracyPct: number | null;
  prevAccuracyPct: number | null;
  varianceValue: number;
  prevVarianceValue: number;
  shrinkageValue: number;
  prevShrinkageValue: number;
  completedCount: number;
  plannedCount: number;
};

export type StocktakeAccuracyTrendPoint = { key: string; label: string; accuracyPct: number | null };

export type StocktakeVarianceRow = { key: string; label: string; varianceValue: number; variancePct: number; linesCounted: number };

export type StocktakeDiscrepancyRow = {
  lineId: string;
  productId: string;
  product: { id: string; sku?: string; name?: string };
  branchId: string;
  branchName: string;
  expectedQty: number;
  countedQty: number;
  varianceQty: number;
  varianceValue: number;
  stocktakeNumber: string;
  stocktakeDate: string;
  isRepeatDiscrepancy: boolean;
  status: string;
};

export type StocktakesInsight = { key: string; title: string; description: string; countLabel: string };

export type StocktakesReportResponse = {
  days: number;
  isMultiBranch: boolean;
  kpis: StocktakesKpis;
  accuracyTrend: StocktakeAccuracyTrendPoint[];
  varianceByBranch: StocktakeVarianceRow[];
  varianceByCategory: StocktakeVarianceRow[];
  insights: StocktakesInsight[];
  discrepancies: StocktakeDiscrepancyRow[];
};

export type PurchaseOrderRow = {
  id: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  branchId: string;
  branchName: string;
  createdAt: string;
  orderedValue: number;
  receivedValue: number;
  fillPct: number | null;
  status: string;
};

export type PoLifecycleStage = { status: string; label: string; count: number; value: number };
export type PurchaseTrendPoint = { key: string; label: string; orderedValue: number; receivedValue: number };
export type PurchasingInsight = { key: string; title: string; description: string; countLabel: string };

export type PurchaseSummaryKpis = {
  purchaseSpend: number;
  prevPurchaseSpend: number;
  posRaised: number;
  prevPosRaised: number;
  receivedValue: number;
  prevReceivedValue: number;
  openCommitments: number;
};

export type PurchaseSummaryResponse = {
  days: number;
  kpis: PurchaseSummaryKpis;
  trend: PurchaseTrendPoint[];
  lifecycle: PoLifecycleStage[];
  insights: PurchasingInsight[];
  orders: PurchaseOrderRow[];
};

export type SupplierSpendRow = {
  supplierId: string;
  supplierName: string;
  status: string;
  spend: number;
  sharePct: number;
  cumulativePct: number;
  poCount: number;
  avgPoValue: number;
  categoriesSupplied: number;
};

export type CategorySupplierDependencyRow = {
  categoryId: string | null;
  categoryName: string;
  totalSpend: number;
  cells: Array<{ supplierId: string; supplierName: string; spend: number; dependencyPct: number }>;
};

export type SupplierSpendKpis = {
  totalSpend: number;
  prevTotalSpend: number;
  activeSuppliers: number;
  prevActiveSuppliers: number;
  topSupplierSharePct: number | null;
  avgPoValue: number | null;
};

export type SupplierSpendResponse = {
  days: number;
  kpis: SupplierSpendKpis;
  ranking: SupplierSpendRow[];
  dependencyMatrix: CategorySupplierDependencyRow[];
  dependencySuppliers: Array<{ supplierId: string; supplierName: string }>;
  insights: PurchasingInsight[];
};

export type SupplierPerformanceGrade = "preferred" | "good" | "monitor" | "review";

export type SupplierScoreRow = {
  supplierId: string;
  supplierName: string;
  spend: number;
  onTimePct: number | null;
  fillRatePct: number | null;
  avgLeadTimeDays: number | null;
  priceVariancePct: number | null;
  returnsValue: number;
  score: number;
  grade: SupplierPerformanceGrade;
};

export type SupplierPerformanceKpis = {
  onTimePct: number | null;
  prevOnTimePct: number | null;
  fillRatePct: number | null;
  prevFillRatePct: number | null;
  avgLeadTimeDays: number | null;
  prevAvgLeadTimeDays: number | null;
  priceVariancePct: number | null;
  prevPriceVariancePct: number | null;
};

export type SupplierPerformanceResponse = {
  days: number;
  kpis: SupplierPerformanceKpis;
  scorecard: SupplierScoreRow[];
  insights: PurchasingInsight[];
};

export type ExportPayload = { filename: string; headers: string[]; rows: Array<Array<string | number>> };
export type OnExportData = (payload: ExportPayload | null) => void;

/** Flat COMMERCIAL category row from `/products/categories` — used to build the hierarchical
 *  Category filter tree on the Product Sales "All Products" table. */
export type CommercialCategoryRow = {
  id: string;
  name: string;
  parentCategoryId: string | null;
  canonicalKey: string | null;
  productCount: number;
};

export type CategoryChildRow = {
  categoryId: string;
  name: string;
  revenue: string;
  cost: string;
  margin: string;
  unitsSold: number;
  isUnclassified: boolean;
};

export type CategoryRow = CategoryChildRow & {
  /** True for the synthetic "uncategorized"/"Unspecified"/"Unscheduled" fallback bucket. For
   *  `groupBy=commercial` this is only true for the "no category assigned at all" bucket —
   *  the real "Unclassified Medicines" safety-net category shows up as an unclassified entry
   *  inside `children` instead, since it still belongs to a real parent department. */
  isUnclassified: boolean;
  /** Only present for `groupBy=commercial` — the leaf commercial categories rolled up under
   *  this parent department (e.g. "Pain & Fever" under "Medicines"), used to power the
   *  breakdown-on-hover chart on the Category Sales donut. */
  children?: CategoryChildRow[];
};

/**
 * "commercial" (default) is the merchandising/business Category — what Category Sales, Margin
 * by Category, and every other category profitability report mean by "Category". The other
 * three are import-derived classification lenses (separate analytical views, not merchandising
 * categories): Dosage Form Performance, Schedule Performance, Registration Type Analysis.
 */
export type CategoryGroupBy = "commercial" | "dosageForm" | "schedule" | "registrationType";

export type SalesByCategoryResponse = { days: number; groupedBy: CategoryGroupBy; categories: CategoryRow[] };

/** One (date, top-level COMMERCIAL department) bucket from `/reports/margin-trend-by-category` —
 *  powers Margin by Category's per-department trend line chart. */
export type CategoryTrendPoint = { date: string; categoryId: string; name: string; revenue: string; cost: string };
export type MarginTrendByCategoryResponse = { days: number; points: CategoryTrendPoint[] };

export type SalesDailyRow = { date: string; transactions: number; grossSales: string; discounts: string; returns: string; netSales: string };
export type SalesDailyResponse = { days: number; rows: SalesDailyRow[] };

export type CashierAgg = {
  revenue: string;
  transactions: number;
  avgBasket: string;
  discountTotal: string;
  discountRatePct: string;
  corrections: number;
};

export type CashierRow = CashierAgg & { userId: string; name: string };
export type ShiftRow = CashierAgg & { key: "morning" | "afternoon" | "evening"; label: string; activeCashiers: number };

export type SalesByCashierResponse = { days: number; cashiers: CashierRow[]; shifts: ShiftRow[] };

export type PaymentMethodRow = {
  method: string;
  revenue: string;
  transactions: number;
  avgTicket: string;
  refundedAtThisMethod: string;
};

export type PaymentTrendPoint = { date: string } & Record<string, string>;

export type SalesByPaymentMethodResponse = { days: number; methods: PaymentMethodRow[]; trend: PaymentTrendPoint[] };

export type ReturnReasonRow = { reason: string; value: number; count: number };
export type DiscountLeakageRow = { productId: string; sku: string; name: string; amount: number };
/** One return reason's slice of a single product's total returns — `qty`/`value` here are already
 *  included in the parent row's own `qty`/`value` (a sum across every reason), not additive on top. */
export type ReturnedProductReasonRow = { reason: string; value: number; qty: number };

export type ReturnedProductRow = {
  productId: string;
  sku: string;
  name: string;
  value: number;
  qty: number;
  soldQty: number;
  returnRatePct: number | null;
  /** Sorted descending by value — `reasons[0]` is this product's dominant return reason. */
  reasons: ReturnedProductReasonRow[];
};

export type ReturnsDiscountsResponse = {
  days: number;
  totalReturnValue: number;
  returnedItemCount: number;
  totalDiscount: number;
  netSalesImpact: number;
  topReasons: ReturnReasonRow[];
  topDiscountLeakage: DiscountLeakageRow[];
  topReturnedProducts: ReturnedProductRow[];
  trend: Array<{ date: string; returnValue: number; discountAmount: number }>;
};

export type SalesByHourResponse = {
  days: number;
  weekdayLabels: string[];
  grid: number[][];
  counts: number[][];
};

/** Revenue/COGS/gross profit per branch — the Profitability-owned counterpart to `BranchSalesRow`
 *  (which is demand-only, no cost/margin dimension). Always covers every active branch, unlike
 *  every other Profitability fetch (no `scope`/branch filter applies). */
export type BranchMarginRow = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  revenue: string;
  cost: string;
  margin: string;
  unitsSold: number;
};

export type BranchMarginResponse = { days: number; branches: BranchMarginRow[] };

export type BranchMarginTrendPoint = { date: string; branchId: string; name: string; revenue: string; cost: string };
export type BranchMarginTrendResponse = { days: number; points: BranchMarginTrendPoint[] };

/** Revenue/transaction/units-sold per branch — the Sales-owned counterpart to `BranchMarginRow`
 *  (demand only, no cost/margin dimension). Always covers every active branch, same convention. */
export type BranchSalesRow = { branchId: string; code: string; name: string; city: string | null; revenue: string; transactions: number; unitsSold: number };
export type BranchSalesResponse = { days: number; branches: BranchSalesRow[] };

export type BranchSalesTrendPoint = { date: string; branchId: string; name: string; revenue: string };
export type BranchSalesTrendResponse = { days: number; points: BranchSalesTrendPoint[] };
