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
  value: string;
  product: { id: string; sku?: string; name?: string };
};

export type StockValueResponse = {
  branchId: string | null;
  scope: "branch" | "tenant";
  totalValue: number;
  items: StockValueItem[];
};

export type NearExpiryItem = {
  batchId: string;
  batchNo: string;
  expiryDate: string;
  qtyOnHand: number;
  costPrice: string;
  valueAtRisk: string;
  product: { id: string; sku: string; name: string };
};

export type NearExpiryResponse = { withinDays: number; items: NearExpiryItem[] };

export type DeadStockItem = {
  productId: string;
  qtyOnHand: number;
  value: string;
  lastSoldAt: string | null;
  product: { id: string; sku?: string; name?: string };
};

export type DeadStockResponse = { daysWithoutSale: number; items: DeadStockItem[] };

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
export type ReturnedProductRow = { productId: string; sku: string; name: string; value: number; qty: number; soldQty: number; returnRatePct: number | null };

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

export type BranchPerformanceRow = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  todaySales: number;
  todayTxnCount: number;
  monthSales: number;
  monthTxnCount: number;
  targetAmount: number | null;
  achievementPct: number | null;
  vsPrevMonthPct: number | null;
  manager: { id: string; fullName: string; email: string } | null;
  targetId: string | null;
};

export type BranchPerformanceResponse = {
  yearMonth: string;
  generatedAt: string;
  branches: BranchPerformanceRow[];
  totals: { todaySales: number; monthSales: number; targetAmount: number };
};
