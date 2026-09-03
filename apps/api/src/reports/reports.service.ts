import { Injectable } from "@nestjs/common";
import { GoodsReturnStatus, GoodsReturnType, PoStatus, Prisma, StockMovementType } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CategoryTaxonomyService } from "../catalog/category-taxonomy.service";
import { UNCLASSIFIED_MEDICINES_CANONICAL_KEY } from "../catalog/commercial-category-template";
import { resolveStockStatus, stockQtyByProductId } from "../products/stock-qty.util";

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

export type BranchMarginTrendPoint = {
  date: string;
  branchId: string;
  name: string;
  revenue: string;
  cost: string;
};

export type BranchSalesRow = {
  branchId: string;
  code: string;
  name: string;
  city: string | null;
  revenue: string;
  transactions: number;
  unitsSold: number;
};

export type BranchSalesTrendPoint = {
  date: string;
  branchId: string;
  name: string;
  revenue: string;
};

const SHIFT_RANGES: Array<{ key: "morning" | "afternoon" | "evening"; label: string; hours: (h: number) => boolean }> = [
  { key: "morning", label: "Morning", hours: (h) => h >= 6 && h < 12 },
  { key: "afternoon", label: "Afternoon", hours: (h) => h >= 12 && h < 18 },
  { key: "evening", label: "Evening", hours: (h) => h >= 18 || h < 6 },
];

// ── Stock Ageing ───────────────────────────────────────────────────────────────────────────

export type AgeBucketKey = "0-30" | "31-60" | "61-90" | "91-180" | "180+";

const AGE_BUCKETS: Array<{ key: AgeBucketKey; label: string; min: number; max: number }> = [
  { key: "0-30", label: "0-30 Days", min: 0, max: 30 },
  { key: "31-60", label: "31-60 Days", min: 31, max: 60 },
  { key: "61-90", label: "61-90 Days", min: 61, max: 90 },
  { key: "91-180", label: "91-180 Days", min: 91, max: 180 },
  { key: "180+", label: "180+ Days", min: 181, max: Infinity },
];

function ageBucketOf(ageDays: number): AgeBucketKey {
  for (const b of AGE_BUCKETS) if (ageDays >= b.min && ageDays <= b.max) return b.key;
  return "180+";
}

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
  /** `qtyOnHand / avgDailySales`, rounded; null when there's no sales history to divide by
   *  (shown as "—" on the frontend rather than a fabricated/infinite number). */
  daysOfCover: number | null;
  recommendation: { key: StockAgeingAction; label: string };
  product: { id: string; sku?: string; name?: string };
};

/** Lighter-weight shape for a historical snapshot (previous-period KPI deltas, monthly trend
 *  points) — no recommendation/velocity, since those are only meaningful "as of now". */
export type StockAgeingSnapshotItem = { ageDays: number; ageBucket: AgeBucketKey; value: number; categoryId: string | null };

export type StockAgeingTrendBucket = { key: AgeBucketKey; label: string; value: number; pct: number };
export type StockAgeingTrendPoint = { key: string; label: string; totalValue: number; buckets: StockAgeingTrendBucket[] };

export type StockAgeingAction = "promote" | "discount" | "transfer" | "review" | "monitor";

const STOCK_AGEING_ACTION_LABEL: Record<StockAgeingAction, string> = {
  promote: "Promote",
  discount: "Discount",
  transfer: "Transfer",
  review: "Review",
  monitor: "Monitor",
};

// Velocity/margin thresholds the recommendation below is built from — documented here since the
// rule itself has no single "correct" answer, just a defensible, inspectable one.
const AGEING_VELOCITY_WINDOW_DAYS = 90;
const AGEING_LOW_VELOCITY_PER_DAY = 0.15; // ~<5 units sold per month
const AGEING_VERY_LOW_VELOCITY_PER_DAY = AGEING_LOW_VELOCITY_PER_DAY / 2;
const AGEING_HEALTHY_MARGIN_PCT = 25;
const AGEING_STRONGER_DEMAND_MULTIPLE = 2;

/**
 * Rule-based (not ML) suggestion, evaluated most-severe-first:
 *  1. Very old (>180d) and barely selling anywhere → Review (candidate for write-off/liquidation).
 *  2. Another branch sells this meaningfully faster (>=2x) than here → Transfer.
 *  3. Low velocity here (but not severe enough for #1) → Discount, to convert it to cash.
 *  4. Healthy margin and at least *some* velocity → Promote (a markdown would give up margin
 *     this SKU doesn't need to sell through).
 *  5. Otherwise just → Monitor. Stock 90 days old or younger is never flagged — Stock Ageing's
 *     "what to do about it" scope starts where Near Expiry's and Dead Stock's don't already cover it.
 */
function recommendStockAgeingAction(
  ageDays: number,
  marginPct: number,
  avgDailySales: number,
  otherBranchAvgDailySales: number,
): { key: StockAgeingAction; label: string } {
  const key: StockAgeingAction = (() => {
    if (ageDays <= 90) return "monitor";
    if (ageDays > 180 && avgDailySales <= AGEING_VERY_LOW_VELOCITY_PER_DAY) return "review";
    if (otherBranchAvgDailySales > AGEING_LOW_VELOCITY_PER_DAY && otherBranchAvgDailySales >= avgDailySales * AGEING_STRONGER_DEMAND_MULTIPLE) {
      return "transfer";
    }
    if (avgDailySales <= AGEING_LOW_VELOCITY_PER_DAY) return "discount";
    if (marginPct >= AGEING_HEALTHY_MARGIN_PCT) return "promote";
    return "monitor";
  })();
  return { key, label: STOCK_AGEING_ACTION_LABEL[key] };
}

/** Trend points: 5 past month-end snapshots followed by "now" (the current, partial month) —
 *  matches how a manager actually reads "how has this changed lately", not calendar-aligned
 *  reporting periods. Handles year rollover for free since `Date` normalizes month overflow. */
function buildAgeingMonthDefs(now: Date, horizonMonths: number): Array<{ key: string; label: string; asOf: Date }> {
  const defs: Array<{ key: string; label: string; asOf: Date }> = [];
  for (let i = horizonMonths - 1; i >= 1; i--) {
    const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);
    defs.push({
      key: `${monthEnd.getFullYear()}-${monthEnd.getMonth()}`,
      label: monthEnd.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
      asOf: monthEnd,
    });
  }
  defs.push({
    key: `${now.getFullYear()}-${now.getMonth()}-now`,
    label: now.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    asOf: now,
  });
  return defs;
}

// ── Stock Value ────────────────────────────────────────────────────────────────────────────

/** A product is at-risk here only if it HAS recent sales (so zero-velocity items stay Dead
 *  Stock's territory, not duplicated here) but at that rate would take longer than this many
 *  days to sell through current stock — a "slow, not dead" overstock signal. */
const CAPITAL_AT_RISK_COVER_DAYS = 180;

/** Trend points for the Category Value Breakdown sparkline: 30/20/10 days ago plus "now" — real
 *  ledger reconstruction (`batchQtyAsOf`), not fabricated, and cheap (2 extra queries beyond what
 *  `previousItems`/`items` already need, since day-30 and day-0 are reused from those). */
const STOCK_VALUE_TREND_OFFSETS_DAYS = [30, 20, 10, 0];

export type StockValueItem = {
  productId: string;
  qtyOnHand: number;
  /** At cost (Σ batch.costPrice × qty). */
  value: string;
  /** At retail/MRP (Σ batch.sellingPrice × qty) — the second of the two valuation bases the
   *  schema can honestly support (there's no separate average-cost/FIFO cost layer; each batch
   *  just keeps its own receipt cost forever). The frontend's Valuation Basis toggle picks
   *  between this and `value` without a re-fetch. */
  retailValue: string;
  /** Leaf COMMERCIAL category, or null when the product has no COMMERCIAL mapping at all. */
  categoryId: string | null;
  categoryName: string;
  /** Top-level COMMERCIAL department this category rolls up to (or the category itself if it has
   *  no parent) — every panel on this page (treemap, concentration chart, breakdown table) groups
   *  at this level. Null (with name "Unclassified") for a product with no COMMERCIAL mapping —
   *  still counted in every total, never silently dropped. */
  departmentId: string | null;
  departmentName: string;
  avgDailySales: number;
  /** `qtyOnHand / avgDailySales`, rounded; null when there's no sales history to divide by
   *  (render as "—", never Infinity). */
  daysOfCover: number | null;
  reorderLevel: number;
  isLowStock: boolean;
  /** See `CAPITAL_AT_RISK_COVER_DAYS` — precomputed here (not left for the frontend to re-derive)
   *  so the one rule has exactly one implementation. */
  isAtRisk: boolean;
  product: { id: string; sku?: string; name?: string };
};

/** Historical snapshot shape (30-days-ago KPI deltas) — per product, not per batch, since this
 *  report aggregates at the product level throughout. */
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
 *  (null → "Unclassified") so the frontend can join it against its own department-value rollup by
 *  id without a second taxonomy lookup — powers the Inventory Share vs Sales Share dumbbell chart. */
export type InventorySalesByDepartment = { departmentId: string | null; departmentName: string; revenue: number };

export type InventorySummaryResponse = {
  items: StockValueItem[];
  previousItems: StockValueSnapshotItem[];
  trend: StockValueTrendPoint[];
  /** Distinct products with a batch in scope (category/supplier filters applied, branch/tenant
   *  scoped) — the denominator for Stock Availability %, since `items`/`previousItems` only ever
   *  list products that had qty > 0 at that snapshot and silently omit out-of-stock ones. */
  skuUniverseCount: number;
  salesByDepartment: InventorySalesByDepartment[];
};

/** Dead Stock's severity-matrix quadrant (see `ReportsService.deadStock`'s `quadrantOf`) — the
 *  value axis splits at the currently-dead population's own median value, the days axis at
 *  2× the selected inactivity threshold (the same split `recommendDeadStockAction` on the
 *  frontend used to draw between "transfer" and "markdown" before this rewrite centralized it
 *  here). */
export type DeadStockQuadrant = "recoverFast" | "investigate" | "monitor" | "liquidate";

/** Centralized, deterministic per-item suggestion — see `ReportsService.deadStock`'s
 *  `suggestedActionFor` for the exact priority-ordered rule. */
export type DeadStockAction = "transfer" | "return_supplier" | "liquidate" | "review_assortment" | "markdown" | "bundle" | "monitor";

/** Estimated recoverable share of an item's tied-up cost value, by suggested action — explicit,
 *  centralized assumptions (never scattered across the frontend) per the brief:
 *  - `transfer`: recoverable near-fully — it's still the tenant's own capital, just relocated.
 *  - `return_supplier`: assumes the supplier accepts at 85% of original cost — no confirmed
 *    supplier return-policy data exists in this codebase yet (see `supplierByBatchIds`'s own
 *    doc comment), so this is a documented estimate, not a guarantee.
 *  - `bundle`/`markdown`: partial recovery via a discounted or paired sale.
 *  - `review_assortment`: never sold at all — eventual clearance is likely but slower.
 *  - `liquidate`: conservative clearance-sale recovery.
 *  - `monitor`: no recovery booked yet — nothing's been decided for this item.
 */
const DEAD_STOCK_RECOVERY_FACTOR: Record<DeadStockAction, number> = {
  transfer: 1,
  return_supplier: 0.85,
  bundle: 0.6,
  markdown: 0.5,
  review_assortment: 0.4,
  liquidate: 0.25,
  monitor: 0,
};

/** A dead-stock item is a candidate for a supplier return only above a minimum value — same
 *  floor Near Expiry's own `recommendExpiryAction` return-candidate rule already uses, so the
 *  two reports don't silently diverge on "is this worth the paperwork". */
const DEAD_STOCK_MIN_SUPPLIER_RETURN_VALUE = 500;

/** Trend points for the Category Breakdown sparkline — same 30/20/10/0-day offsets and "same
 *  basket, re-valued" convention as Stock Value's own trend (see its doc comment). */
const DEAD_STOCK_TREND_OFFSETS_DAYS = [30, 20, 10, 0];

export type DeadStockItem = {
  productId: string;
  qtyOnHand: number;
  /** At cost — the tied-up capital figure every KPI/panel on this page is built from. */
  value: string;
  /** Null when the product has never had a qualifying sale at all. */
  daysSinceLastSale: number | null;
  /** Leaf COMMERCIAL category, or null when the product has no COMMERCIAL mapping. */
  categoryId: string | null;
  categoryName: string;
  /** Top-level COMMERCIAL department this rolls up to — every panel groups at this level, same
   *  as Stock Value (this report spans every department, not just Medicines). */
  departmentId: string | null;
  departmentName: string;
  /** Residual demand over a window wider than the selected inactivity threshold (see
   *  `residualVelocityByProduct`) — distinguishes "had some demand recently, just excess stock"
   *  from "genuinely zero demand ever", which the dead-stock threshold window alone can't. */
  avgDailySales: number;
  daysOfCover: number | null;
  hasKnownSupplier: boolean;
  supplierName: string | null;
  /** True when another branch shows real recent velocity for this product — only ever computed
   *  when a specific branch is in view (see `deadStock`'s doc comment). */
  crossBranchDemand: boolean;
  quadrant: DeadStockQuadrant;
  suggestedAction: DeadStockAction;
  /** `value × DEAD_STOCK_RECOVERY_FACTOR[suggestedAction]`, rounded to cents. */
  recoveryValue: number;
  product: { id: string; sku?: string; name?: string };
};

/** Historical snapshot shape (30-days-ago KPI deltas) — the result of independently re-running
 *  `classifyDeadStock` as of that date, not "today's items revalued", so a product that only
 *  went idle in the last 30 days correctly doesn't appear here. */
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
  /** The inactivity threshold actually applied (echoes the caller's selection back). */
  daysWithoutSale: number;
  items: DeadStockItem[];
  previousItems: DeadStockSnapshotItem[];
  trend: DeadStockTrendPoint[];
};

// ── Stock Health ───────────────────────────────────────────────────────────────────────────

/** Most-severe-first, deterministic — a product lands in exactly one zone. Dead/Slow is checked
 *  before Reorder Risk: a product nobody is buying isn't usefully a reorder candidate just
 *  because its stock also happens to be low. */
export type StockHealthZone = "deadSlow" | "reorderRisk" | "overstocked" | "monitor" | "healthy";

/** Same "no qualifying sale in N days" definition Dead Stock uses by default. Not user-selectable
 *  here — this merged report has no threshold picker, unlike the old standalone Dead Stock tab. */
const STOCK_HEALTH_DEAD_THRESHOLD_DAYS = 90;
/** Same 180-day bar Stock Value's own overstock/at-risk signal already uses. */
const STOCK_HEALTH_OVERSTOCK_COVER_DAYS = CAPITAL_AT_RISK_COVER_DAYS;
/** Same "<~5 units/month" bar Stock Ageing's recommendation logic already uses for "barely moving". */
const STOCK_HEALTH_LOW_VELOCITY_PER_DAY = AGEING_LOW_VELOCITY_PER_DAY;

export type StockHealthItem = {
  productId: string;
  qtyOnHand: number;
  /** At cost — same basis as Stock Value/Dead Stock. */
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

/** 30-days-ago snapshot for KPI deltas — zone reclassifies today's velocity/reorder-level/last-sale
 *  lens against the historical quantity ("today's classification, yesterday's stock level"), the
 *  same approximation Stock Value's Capital-at-Risk trend and Inventory Summary's Days-of-Cover
 *  trend already use, rather than a second full historical re-derivation. */
export type StockHealthSnapshotItem = { productId: string; value: number; qtyOnHand: number; zone: StockHealthZone; departmentId: string | null; departmentName: string };

export type StockHealthResponse = {
  items: StockHealthItem[];
  previousItems: StockHealthSnapshotItem[];
  /** Distinct in-scope products with a batch at this branch/tenant — the denominator for Stock
   *  Availability %, since `items` only lists products with qty > 0 right now. */
  skuUniverseCount: number;
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

/** Every real `StockMovementType` classified into a physical direction. `transfer_reserve_out` /
 *  `transfer_reserve_release` and `quarantine_hold` / `quarantine_release` are deliberately
 *  excluded (mapped to `undefined`) — they're hold/bookkeeping entries that net to zero for any
 *  transfer/quarantine that completes normally (see `transfers.service.ts`'s `postReserveOut` /
 *  `postReserveRelease`), not real stock leaving or entering the tenant. Mirrors the existing
 *  `received`/`issued` classification `InventoryService`'s branch summary already uses, extended
 *  with `stocktake_in`/`stocktake_out` (that summary omits them; this report needs them as their
 *  own explicit Movement Type so stocktake variance can drive the shrinkage insight below). */
const MOVEMENT_DIRECTION: Partial<Record<StockMovementType, "in" | "out">> = {
  purchase_in: "in",
  transfer_in: "in",
  customer_return_in: "in",
  sale_void_in: "in",
  sale_refund_in: "in",
  adjustment_in: "in",
  stocktake_in: "in",
  sale_out: "out",
  transfer_out: "out",
  supplier_return_out: "out",
  adjustment_out: "out",
  stocktake_out: "out",
};

/** Movement Type filter groupings shown in the UI — every real (non-reserve/quarantine) enum
 *  member appears in exactly one bucket, so "All movement types" always reconciles with the sum
 *  of every individual filter's own total. `sales_outbound` covers only the sale itself;
 *  `returns_in` covers every way stock comes back from a customer — a genuine return, or a
 *  voided/refunded sale reversing itself — since all three are customer-driven inbound events
 *  distinct from a fresh purchase receipt. */
const MOVEMENT_FILTER_TYPES: Record<MovementTypeFilterKey, StockMovementType[]> = {
  purchase_receipts: [StockMovementType.purchase_in],
  sales_outbound: [StockMovementType.sale_out],
  transfers_in: [StockMovementType.transfer_in],
  transfers_out: [StockMovementType.transfer_out],
  returns_in: [
    StockMovementType.customer_return_in,
    StockMovementType.sale_void_in,
    StockMovementType.sale_refund_in,
  ],
  returns_out: [StockMovementType.supplier_return_out],
  adjustments: [StockMovementType.adjustment_in, StockMovementType.adjustment_out],
  stocktake_adjustments: [StockMovementType.stocktake_in, StockMovementType.stocktake_out],
};
const ALL_MOVEMENT_TYPES = Object.keys(MOVEMENT_DIRECTION) as StockMovementType[];
const TRANSFER_TYPES: StockMovementType[] = [StockMovementType.transfer_in, StockMovementType.transfer_out];
const TRANSFER_OR_ADJUSTMENT_TYPES = new Set<StockMovementType>([
  StockMovementType.transfer_in,
  StockMovementType.transfer_out,
  StockMovementType.adjustment_in,
  StockMovementType.adjustment_out,
  StockMovementType.stocktake_in,
  StockMovementType.stocktake_out,
]);

/** Row-level "Overstocking" flag — same 180-day cover threshold Stock Value/Dead Stock already
 *  use for the identical concept, so the three reports don't silently diverge on what "overstocked" means. */
const MOVEMENT_OVERSTOCK_COVER_DAYS = 180;
/** Row-level "Watch" flag — an earlier, softer warning than a reorder-point breach: depleting
 *  stock with less than three weeks of runway at this period's velocity. */
const MOVEMENT_WATCH_COVER_DAYS = 21;
/** Movement Insight #2's own (stricter) cover threshold — "genuinely urgent", not just "worth a look". */
const MOVEMENT_REPLENISHMENT_INSIGHT_COVER_DAYS = 7;
/** Movement Insight #3 only surfaces when transfers+adjustments+stocktake make up a material share
 *  of total movement — below this it's normal operational noise, not worth a dashboard callout. */
const MOVEMENT_TRANSFER_ADJUSTMENT_SHARE_THRESHOLD_PCT = 15;
/** Movement Insight #4's variance materiality floor — matches the brief's own "> 2%" example. */
const MOVEMENT_SHRINKAGE_VARIANCE_PCT_THRESHOLD = 2;

export type StockMovementKpis = {
  inboundUnits: number;
  prevInboundUnits: number;
  outboundUnits: number;
  prevOutboundUnits: number;
  /** At cost — Σ(batch.costPrice × qty) for inbound rows minus the same for outbound rows. Never
   *  mixes cost with retail/sale price (a valid inbound/outbound comparison needs one consistent
   *  valuation basis, and cost is the only one every movement type — not just sales — can price). */
  netMovementValue: number;
  prevNetMovementValue: number;
  reorderAlerts: number;
  prevReorderAlerts: number;
  /** Sales units this period ÷ average units on hand (opening+closing ÷ 2), annualized to 365 days
   *  so a 30-day and a 90-day window read as comparable rates. Null when there was no stock to
   *  turn over at all. */
  inventoryTurnover: number | null;
  prevInventoryTurnover: number | null;
  /** Classic retail formula: sale_out units ÷ (opening units + this period's inbound units) × 100
   *  — "of what was available to sell, how much sold". */
  sellThroughRate: number | null;
  prevSellThroughRate: number | null;
  /** Closing units on hand ÷ this period's average daily sell-out rate. */
  avgDaysCover: number | null;
  prevAvgDaysCover: number | null;
  /** Count of times an in-scope carried product's running ledger balance crossed from positive to
   *  zero-or-below during the period — not a snapshot count like Reorder Alerts, a genuine
   *  in-period transition count reconstructed from the same ledger rows already fetched. */
  stockoutEvents: number;
  prevStockoutEvents: number;
};

/** One step of the Stock Flow Bridge (Opening Stock → … → Closing Stock), in units. `total` resets
 *  the running baseline (Opening/Closing), `addition`/`deduction` float a bar up/down from it —
 *  see `WaterfallChart`'s own doc comment for the rendering contract. */
export type StockFlowBridgeStep = { key: string; label: string; kind: "total" | "addition" | "deduction"; value: number };

/** One inbound or outbound movement sub-type's unit total this period, for the Movement
 *  Composition breakdown — omitted entirely (not shown as a zero row) when it didn't occur. */
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
  /** Net units per trend bucket, same order/keys as the main `trend` — lets the table's sparkline
   *  reconcile exactly against the headline chart instead of being independently re-derived. */
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
  /** Tenant-wide ("All branches") only: total transfer-out units this period — internal
   *  branch-to-branch relocation, deliberately excluded from `kpis`/`trend`/`categoryMovement`'s
   *  external inbound/outbound totals under that scope (see `stockMovement`'s doc comment) so one
   *  transfer never inflates tenant-wide flow as both an inbound and an outbound unit. Always 0
   *  under a specific branch scope, where transfers count normally. */
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

// ── Transfers ──────────────────────────────────────────────────────────────────────────────

/** A source branch counts as "overstocked" for transfer-opportunity purposes past this many days
 *  of cover; a target branch counts as "needs it" under this many (or already below its own
 *  reorder point, checked separately). Deliberately looser than Stock Health's own 180-day
 *  overstock bar — a branch doesn't need to be *that* extreme to be worth relocating stock from
 *  when another branch is genuinely running low. */
const TRANSFER_SOURCE_MIN_COVER_DAYS = 90;
const TRANSFER_TARGET_MAX_COVER_DAYS = 14;
/** Same 3-week "enough to matter without overcorrecting" horizon Near Expiry's own transfer
 *  suggestion uses. */
const TRANSFER_SUGGESTED_COVER_DAYS = 21;

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
  /** At cost, receivedQty only (what actually physically moved) — see `transfersReport`'s doc
   *  comment for why requested-but-not-yet-received qty isn't counted here. */
  valueMoved: number;
  prevValueMoved: number;
  avgCompletionHours: number | null;
  prevAvgCompletionHours: number | null;
  /** % of transfers reaching a terminal state (received/rejected/cancelled) in the period that
   *  landed on `received` — still-in-flight transfers aren't counted against or for it. */
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

// ── Stocktakes ─────────────────────────────────────────────────────────────────────────────

/** How many of a product/branch pair's most recent stocktakes need a negative variance before it
 *  counts as a "repeated discrepancy" worth calling out, rather than one-off counting noise. */
const STOCKTAKE_REPEAT_DISCREPANCY_MIN_COUNT = 2;
/** Repeat-discrepancy detection looks back further than the report's own `days` window — a
 *  pattern spanning three stocktakes over four months is exactly the kind of thing a 30-day
 *  window would otherwise hide half of. */
const STOCKTAKE_REPEAT_LOOKBACK_DAYS = 180;

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
  /** Populated for a multi-branch tenant; empty (use `varianceByCategory` instead) for a
   *  single-branch one — see `stocktakesReport`'s doc comment. */
  varianceByBranch: StocktakeVarianceRow[];
  varianceByCategory: StocktakeVarianceRow[];
  insights: StocktakesInsight[];
  discrepancies: StocktakeDiscrepancyRow[];
};

// ── Purchasing: Purchase Summary ──────────────────────────────────────────────────────────────

/** Every value below is at pre-tax, pre-discount unit cost (`orderedQty × unitCost`) — the same
 *  "cost basis, nothing blended in" convention every other report in this file already uses (see
 *  Stock Movement's `netMovementValue` doc comment). Shipping charges, discounts and tax aren't
 *  folded in, so this is "committed unit cost", not the supplier's actual invoice total. */
const PO_TERMINAL_STATUSES: PoStatus[] = [PoStatus.received, PoStatus.short_closed, PoStatus.cancelled];
/** A supplier counts as "repeatedly under-fulfilling" once this many of its POs in the period
 *  landed on partially_received/short_closed. */
const PURCHASE_REPEAT_PARTIAL_MIN_COUNT = 2;
/** Same 180-day overstock bar Stock Value/Stock Health/Dead Stock all already use for "this is
 *  too much stock", applied here to flag an open PO for a product the branch is already swimming in. */
const PURCHASE_OVERSTOCK_COVER_DAYS = 180;

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
  /** Current outstanding committed value across every non-terminal PO, tenant/branch-wide — a
   *  point-in-time snapshot, not scoped to `days` (an open PO from 4 months ago is still an open
   *  commitment today), so there's no "previous period" to compare it against. */
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

// ── Purchasing: Supplier Spend ────────────────────────────────────────────────────────────────

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

// ── Purchasing: Supplier Performance ──────────────────────────────────────────────────────────

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
  /** 0-100 composite — see `computeSupplierScore`'s doc comment for the exact, disclosed formula.
   *  Never presented as anything other than a transparent weighted blend of the metrics on this
   *  same row; there is no external rating/survey data behind it. */
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
        status: { in: ["posted", "partially_refunded"] },
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

  /** Completed customer returns in the window, shaped for every Profitability method to net out
   *  of its own revenue/cost accumulation — the same way each already adds `SaleItem` rows, just
   *  subtracting instead. Windowed by the return's own `createdAt` (not the original sale's date),
   *  matching `returnsAndDiscounts`/`salesDaily`'s existing convention so these netted figures
   *  don't visibly disagree with those reports for the same range. Only `status: completed` returns
   *  are netted — earlier workflow states (draft/pending_approval/...) never moved stock or cash
   *  (see `returns.service.ts`'s `completeReturn`), so netting them would subtract a return that
   *  hasn't actually happened yet. Revenue reversal uses `unitPrice * qty` (the refunded sale
   *  price — `GoodsReturnItem` doesn't retain the original line's tax/discount split); cost
   *  reversal uses the same batch's `costPrice` the original sale was costed at, when known. */
  private async netCustomerReturnItems(tenantId: string, branchId: string | null, since: Date) {
    return this.prisma.goodsReturnItem.findMany({
      where: {
        tenantId,
        goodsReturn: {
          type: GoodsReturnType.customer,
          status: GoodsReturnStatus.completed,
          ...(branchId ? { branchId } : {}),
          createdAt: { gte: since },
        },
      },
      select: {
        productId: true,
        qty: true,
        unitPrice: true,
        batchId: true,
        batch: { select: { costPrice: true } },
        product: { select: { sku: true, name: true, brandName: true, schedule: true } },
        goodsReturn: { select: { createdAt: true, branchId: true } },
      },
    });
  }

  async marginByProduct(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [items, returnItems] = await Promise.all([
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: {
            tenantId,
            ...(branchId ? { branchId } : {}),
            soldAt: { gte: since },
            status: { in: ["posted", "partially_refunded"] },
          },
        },
        include: {
          product: { select: { id: true, sku: true, name: true, brandName: true } },
          batch: { select: { costPrice: true } },
          sale: { select: { id: true, soldAt: true } },
        },
      }),
      this.netCustomerReturnItems(tenantId, branchId, since),
    ]);

    const byProduct = new Map<
      string,
      { productId: string; sku: string; name: string; brandName: string | null; revenue: Prisma.Decimal; cost: Prisma.Decimal; unitsSold: number }
    >();

    for (const it of items) {
      const key = it.productId;
      const revenue = it.lineTotal;
      const cost = it.batch.costPrice.mul(it.qty);
      const cur = byProduct.get(key) ?? {
        productId: it.productId,
        sku: it.product.sku,
        name: it.product.name,
        brandName: it.product.brandName ?? null,
        revenue: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
        unitsSold: 0,
      };
      cur.revenue = cur.revenue.add(revenue);
      cur.cost = cur.cost.add(cost);
      cur.unitsSold += it.qty;
      byProduct.set(key, cur);
    }

    // Net out completed returns — by the return's own date, same convention `salesDaily` already
    // uses for its net-sales column, so a return doesn't disappear just because the original sale
    // happened outside this window (e.g. bought 45 days ago, returned 5 days ago inside a 30-day
    // range). A product with no in-window sale still gets an entry here so the period's net
    // revenue/cost genuinely reflects every completed return that happened in it.
    for (const ret of returnItems) {
      const cur = byProduct.get(ret.productId) ?? {
        productId: ret.productId,
        sku: ret.product.sku,
        name: ret.product.name,
        brandName: ret.product.brandName ?? null,
        revenue: new Prisma.Decimal(0),
        cost: new Prisma.Decimal(0),
        unitsSold: 0,
      };
      cur.revenue = cur.revenue.sub(ret.unitPrice.mul(ret.qty));
      if (ret.batchId && ret.batch) cur.cost = cur.cost.sub(ret.batch.costPrice.mul(ret.qty));
      cur.unitsSold -= ret.qty;
      byProduct.set(ret.productId, cur);
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
        brandName: v.brandName,
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

  /**
   * On-hand inventory value at both cost (`Batch.costPrice`) and retail (`Batch.sellingPrice`) —
   * the two valuation bases the schema can honestly support (there's no average-cost/FIFO layer;
   * every batch just keeps its own receipt cost). Product-level, not batch-level: this report is
   * about capital allocation by category/product, not batch freshness (that's Stock Ageing's).
   *
   * `categoryId` filters by top-level COMMERCIAL department (every panel here groups at that
   * level — see `StockValueItem.departmentId`), not the leaf sub-category Near Expiry/Stock
   * Ageing filter by, since this report spans every department, not just Medicines.
   *
   * `previousItems`/`trend` reconstruct historical quantities from the stock ledger (the same
   * `batchQtyAsOf` technique `nearExpiry`/`stockAgeing` use) — real data, not fabricated: batch
   * costs are fixed at receipt time, so "value N days ago" is exact, not estimated.
   */
  async inventorySummary(tenantId: string, branchId: string | null, categoryId?: string, supplierId?: string): Promise<InventorySummaryResponse> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const empty: InventorySummaryResponse = { items: [], previousItems: [], trend: [], skuUniverseCount: 0, salesByDepartment: [] };

    const allBatches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      select: { id: true, productId: true, costPrice: true, sellingPrice: true },
    });
    if (allBatches.length === 0) return empty;

    const allProductIds = [...new Set(allBatches.map((b) => b.productId))];
    const [categoryByProduct, supplierByBatch] = await Promise.all([
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, allProductIds),
      this.supplierByBatchIds(tenantId, allBatches.map((b) => b.id)),
    ]);

    const departmentOf = (productId: string): { id: string | null; name: string } => {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    };
    const categoryOf = (productId: string) => categoryByProduct.get(productId) ?? null;

    const batches = allBatches.filter((b) => {
      if (categoryId && departmentOf(b.productId).id !== categoryId) return false;
      if (supplierId && supplierByBatch.get(b.id)?.id !== supplierId) return false;
      return true;
    });
    if (batches.length === 0) return empty;

    const batchIds = batches.map((b) => b.id);
    const productIds = [...new Set(batches.map((b) => b.productId))];
    const prevAsOf = new Date(now);
    prevAsOf.setDate(prevAsOf.getDate() - 30);
    const trendAsOfDates = STOCK_VALUE_TREND_OFFSETS_DAYS.map((d) => {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      return dt;
    });

    const [currentQty, prevQty, qty20, qty10, products, avgDailySales] = await Promise.all([
      this.batchQtyAsOf(tenantId, branchId, batchIds),
      this.batchQtyAsOf(tenantId, branchId, batchIds, prevAsOf),
      this.batchQtyAsOf(tenantId, branchId, batchIds, trendAsOfDates[1]),
      this.batchQtyAsOf(tenantId, branchId, batchIds, trendAsOfDates[2]),
      this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, sku: true, name: true, reorderLevel: true } }),
      this.avgDailySalesByProduct(tenantId, branchId, productIds, now),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const qtyMapsByOffset = new Map<number, Map<string, number>>([
      [30, prevQty],
      [20, qty20],
      [10, qty10],
      [0, currentQty],
    ]);

    function aggregateByProduct(qtyMap: Map<string, number>): Map<string, { qty: number; value: Prisma.Decimal; retailValue: Prisma.Decimal }> {
      const map = new Map<string, { qty: number; value: Prisma.Decimal; retailValue: Prisma.Decimal }>();
      for (const b of batches) {
        const qty = qtyMap.get(b.id) ?? 0;
        if (qty <= 0) continue;
        const cur = map.get(b.productId) ?? { qty: 0, value: new Prisma.Decimal(0), retailValue: new Prisma.Decimal(0) };
        cur.qty += qty;
        cur.value = cur.value.add(b.costPrice.mul(qty));
        cur.retailValue = cur.retailValue.add(b.sellingPrice.mul(qty));
        map.set(b.productId, cur);
      }
      return map;
    }

    const currentByProduct = aggregateByProduct(currentQty);
    const items: StockValueItem[] = [...currentByProduct.entries()]
      .map(([productId, agg]) => {
        const cat = categoryOf(productId);
        const dept = departmentOf(productId);
        const product = productById.get(productId);
        const velocity = avgDailySales.get(productId) ?? 0;
        const daysOfCover = velocity > 0 ? Math.round(agg.qty / velocity) : null;
        const reorderLevel = product?.reorderLevel ?? 0;
        return {
          productId,
          qtyOnHand: agg.qty,
          value: agg.value.toString(),
          retailValue: agg.retailValue.toString(),
          categoryId: cat?.id ?? null,
          categoryName: cat?.name ?? "Unclassified",
          departmentId: dept.id,
          departmentName: dept.name,
          avgDailySales: velocity,
          daysOfCover,
          reorderLevel,
          isLowStock: resolveStockStatus(agg.qty, reorderLevel) === "low",
          isAtRisk: velocity > 0 && daysOfCover != null && daysOfCover > CAPITAL_AT_RISK_COVER_DAYS,
          product: product ?? { id: productId },
        };
      })
      .sort((a, b) => Number(b.value) - Number(a.value));

    const prevByProduct = aggregateByProduct(prevQty);
    const previousItems: StockValueSnapshotItem[] = [...prevByProduct.entries()].map(([productId, agg]) => {
      const dept = departmentOf(productId);
      return { productId, value: Number(agg.value), retailValue: Number(agg.retailValue), qtyOnHand: agg.qty, departmentId: dept.id, departmentName: dept.name };
    });

    const deptNameById = new Map<string, string>();
    for (const pid of productIds) {
      const d = departmentOf(pid);
      deptNameById.set(d.id ?? "unclassified", d.name);
    }

    function deptAggregateAt(qtyMap: Map<string, number>): Map<string, { value: Prisma.Decimal; retailValue: Prisma.Decimal }> {
      const map = new Map<string, { value: Prisma.Decimal; retailValue: Prisma.Decimal }>();
      for (const b of batches) {
        const qty = qtyMap.get(b.id) ?? 0;
        if (qty <= 0) continue;
        const key = departmentOf(b.productId).id ?? "unclassified";
        const cur = map.get(key) ?? { value: new Prisma.Decimal(0), retailValue: new Prisma.Decimal(0) };
        cur.value = cur.value.add(b.costPrice.mul(qty));
        cur.retailValue = cur.retailValue.add(b.sellingPrice.mul(qty));
        map.set(key, cur);
      }
      return map;
    }

    const trend: StockValueTrendPoint[] = STOCK_VALUE_TREND_OFFSETS_DAYS.map((offsetDays, i) => {
      const deptAgg = deptAggregateAt(qtyMapsByOffset.get(offsetDays)!);
      const departments: StockValueTrendDept[] = [...deptAgg.entries()].map(([id, v]) => ({
        departmentId: id,
        departmentName: deptNameById.get(id) ?? "Unclassified",
        value: Number(v.value),
        retailValue: Number(v.retailValue),
      }));
      return {
        key: offsetDays === 0 ? "now" : `${offsetDays}d-ago`,
        label: offsetDays === 0 ? "Now" : `${offsetDays}d ago`,
        totalValue: departments.reduce((s, d) => s + d.value, 0),
        totalRetailValue: departments.reduce((s, d) => s + d.retailValue, 0),
        departments,
      };
    });

    // Sales-side of the Inventory Share vs Sales Share comparison — scoped to the exact same
    // (category/supplier-filtered) product universe as the stock side so the two shares are
    // computed over identical baskets, and rolled up through the same `departmentOf()` closure
    // so department ids/names line up with `items[].departmentId` with no re-mapping needed.
    const salesSince = new Date(now);
    salesSince.setDate(salesSince.getDate() - 30);
    const saleLines = await this.prisma.saleItem.findMany({
      where: {
        tenantId,
        productId: { in: productIds },
        sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: salesSince }, status: { in: ["posted", "partially_refunded"] } },
      },
      select: { productId: true, lineTotal: true },
    });
    const revenueByDept = new Map<string, Prisma.Decimal>();
    for (const line of saleLines) {
      const key = departmentOf(line.productId).id ?? "unclassified";
      revenueByDept.set(key, (revenueByDept.get(key) ?? new Prisma.Decimal(0)).add(line.lineTotal));
    }
    const salesByDepartment: InventorySalesByDepartment[] = [...revenueByDept.entries()].map(([id, revenue]) => ({
      departmentId: id === "unclassified" ? null : id,
      departmentName: deptNameById.get(id) ?? "Unclassified",
      revenue: Number(revenue),
    }));

    return { items, previousItems, trend, skuUniverseCount: productIds.length, salesByDepartment };
  }

  /** Current stock quantity per batch, or its historical quantity "as of" a past date when
   *  `asOf` is given (summing only ledger entries that had already occurred by then) — a single
   *  `groupBy`, not one query per batch. */
  private async batchQtyAsOf(
    tenantId: string,
    branchId: string | null,
    batchIds: string[],
    asOf?: Date,
  ): Promise<Map<string, number>> {
    if (batchIds.length === 0) return new Map();
    const rows = await this.prisma.stockLedger.groupBy({
      by: ["batchId"],
      where: {
        tenantId,
        ...(branchId ? { branchId } : {}),
        batchId: { in: batchIds },
        ...(asOf ? { occurredAt: { lte: asOf } } : {}),
      },
      _sum: { qtyDelta: true },
    });
    return new Map(rows.map((r) => [r.batchId!, r._sum.qtyDelta ?? 0]));
  }

  /** A batch has no direct supplier column — trace it through the receipt line that created it
   *  (Batch ← GoodsReceiptItem → GoodsReceipt → PurchaseOrder → Supplier), batched, no N+1. */
  /**
   * `Batch.supplierId` (set directly at receive/adjustment time) is the authoritative source —
   * the `GoodsReceiptItem → GoodsReceipt → PurchaseOrder → Supplier` chain is only a fallback for
   * batches created before that column existed, or via any other path that never populated it.
   * Without the fallback, older/manually-adjusted batches would silently lose supplier lineage
   * they already had through the PO chain.
   */
  private async supplierByBatchIds(tenantId: string, batchIds: string[]): Promise<Map<string, { id: string; name: string }>> {
    if (batchIds.length === 0) return new Map();
    const [batchesWithSupplier, receiptItems] = await Promise.all([
      this.prisma.batch.findMany({
        where: { tenantId, id: { in: batchIds }, supplierId: { not: null } },
        select: { id: true, supplier: { select: { id: true, name: true } } },
      }),
      this.prisma.goodsReceiptItem.findMany({
        where: { tenantId, batchId: { in: batchIds } },
        select: {
          batchId: true,
          goodsReceipt: { select: { purchaseOrder: { select: { supplier: { select: { id: true, name: true } } } } } },
        },
      }),
    ]);
    const map = new Map<string, { id: string; name: string }>();
    for (const ri of receiptItems) {
      const supplier = ri.goodsReceipt?.purchaseOrder?.supplier;
      if (ri.batchId && supplier) map.set(ri.batchId, supplier);
    }
    for (const b of batchesWithSupplier) {
      if (b.supplier) map.set(b.id, b.supplier);
    }
    return map;
  }

  /**
   * Near-expiry batches, COMMERCIAL-category and supplier enriched. Fetches a fixed 180-day
   * horizon (or `withinDays` if wider) regardless of the caller's window — `items` lets the
   * frontend re-slice for the KPI/table window while still having enough range for the 4-bucket
   * chart and the 6-month calendar heatmap without a second round trip.
   *
   * Scoped to the MEDICINES department only — expiry risk management is overwhelmingly a
   * medicines concern (shelf-life-sensitive, regulated stock), so every other department is
   * excluded rather than diluting the page with e.g. personal-care or baby-care items. `category`
   * here means the LEAF sub-category under Medicines (Pain & Fever, Anti-infectives, ...), not
   * the department itself, so the page's charts break down by that finer dimension.
   *
   * `previousItems` reconstructs the *same* near-expiry snapshot exactly `withinDays` ago (stock
   * quantities as they stood then, via the ledger) — a real historical comparison for a metric
   * that's otherwise a point-in-time snapshot, not a period total that can be double-fetched and
   * subtracted the way revenue/margin reports are.
   */
  async nearExpiry(
    tenantId: string,
    branchId: string | null,
    withinDays = 90,
    categoryId?: string,
    supplierId?: string,
  ) {
    const HORIZON_DAYS = Math.max(withinDays, 180);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const horizonLimit = new Date(now);
    horizonLimit.setDate(horizonLimit.getDate() + HORIZON_DAYS);
    const prevAsOf = new Date(now);
    prevAsOf.setDate(prevAsOf.getDate() - withinDays);

    const batches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}), expiryDate: { lte: horizonLimit } },
      orderBy: { expiryDate: "asc" },
      include: { product: { select: { id: true, sku: true, name: true } } },
    });
    if (batches.length === 0) return { withinDays, items: [], previousItems: [] };

    const batchIds = batches.map((b) => b.id);
    const productIds = [...new Set(batches.map((b) => b.productId))];

    const [currentQty, prevQty, categoryByProduct, supplierByBatch, canonicalIds] = await Promise.all([
      this.batchQtyAsOf(tenantId, branchId, batchIds),
      this.batchQtyAsOf(tenantId, branchId, batchIds, prevAsOf),
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, productIds),
      this.supplierByBatchIds(tenantId, batchIds),
      this.categoryTaxonomy.commercialCanonicalIds(tenantId),
    ]);
    const medicinesDeptId = canonicalIds.get("MEDICINES") ?? null;

    const toItem = (b: (typeof batches)[number], qty: number, asOf: Date) => {
      if (qty <= 0) return null;
      const category = categoryByProduct.get(b.productId);
      const departmentId = category?.parentCategoryId ?? category?.id ?? null;
      // Scope to Medicines only — excludes both other departments and truly uncategorized stock,
      // since we can't confirm the latter belongs here either.
      if (!medicinesDeptId || departmentId !== medicinesDeptId) return null;
      const supplier = supplierByBatch.get(b.id);
      return {
        batchId: b.id,
        batchNo: b.batchNo,
        expiryDate: b.expiryDate.toISOString(),
        qtyOnHand: qty,
        costPrice: b.costPrice.toString(),
        valueAtRisk: b.costPrice.mul(qty).toString(),
        daysLeft: Math.round((b.expiryDate.getTime() - asOf.getTime()) / 86_400_000),
        // Leaf sub-category (not rolled up to the department — the department is fixed at
        // Medicines for this whole endpoint, so it wouldn't be a useful grouping dimension here).
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? "Uncategorized",
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? "Unknown supplier",
        product: b.product,
      };
    };

    let items = batches.map((b) => toItem(b, currentQty.get(b.id) ?? 0, now)).filter((it): it is NonNullable<typeof it> => it !== null);
    // The previous snapshot only covers the same withinDays window (expiring by "today", as
    // measured withinDays ago) — not the full 180-day horizon, since it's only used for KPI
    // deltas, never the chart/heatmap.
    let previousItems = batches
      .map((b) => toItem(b, prevQty.get(b.id) ?? 0, prevAsOf))
      .filter((it): it is NonNullable<typeof it> => it !== null && new Date(it.expiryDate) <= now);

    if (categoryId) {
      items = items.filter((it) => it.categoryId === categoryId);
      previousItems = previousItems.filter((it) => it.categoryId === categoryId);
    }
    if (supplierId) {
      items = items.filter((it) => it.supplierId === supplierId);
      previousItems = previousItems.filter((it) => it.supplierId === supplierId);
    }

    // Branch-to-branch expiry mitigation — only meaningful when viewing one specific branch (an
    // "All branches" view has no single "this branch" to move stock away from) and only when the
    // tenant actually has another branch to move it to. Each near-expiry product is matched to
    // whichever OTHER branch currently sells it fastest; Prisma's `groupBy` can't group by a
    // related model's field (`Sale.branchId` isn't a column on `SaleItem`), so this loops per
    // other branch instead — bounded by the tenant's (always small, single-digit) branch count.
    const itemsWithTransfer = await (async () => {
      if (!branchId || items.length === 0) return items.map((it) => ({ ...it, transferOpportunity: null }));
      const otherBranches = await this.prisma.branch.findMany({ where: { tenantId, id: { not: branchId } }, select: { id: true, name: true } });
      if (otherBranches.length === 0) return items.map((it) => ({ ...it, transferOpportunity: null }));

      const expiringProductIds = [...new Set(items.map((it) => it.product.id))];
      const velocityByBranch = await Promise.all(
        otherBranches.map(async (b) => ({ branch: b, velocity: await this.avgDailySalesByProduct(tenantId, b.id, expiringProductIds, now) })),
      );

      return items.map((it) => {
        let best: { branch: { id: string; name: string }; velocity: number } | null = null;
        for (const { branch, velocity } of velocityByBranch) {
          const v = velocity.get(it.product.id) ?? 0;
          // Below this a branch is "barely selling" (same bar Stock Ageing's own recommendation
          // uses) — technically nonzero demand isn't a convincing transfer case on its own.
          if (v >= AGEING_LOW_VELOCITY_PER_DAY && (!best || v > best.velocity)) best = { branch, velocity: v };
        }
        if (!best) return { ...it, transferOpportunity: null };
        // Enough to cover ~3 weeks of the receiving branch's own demand, capped at what's actually
        // on hand here — plausible enough to sell through there before expiry without assuming
        // this branch can spare (or that branch could sell) more than that.
        const suggestedUnits = Math.min(it.qtyOnHand, Math.max(1, Math.round(best.velocity * 21)));
        return {
          ...it,
          transferOpportunity: { toBranchId: best.branch.id, toBranchName: best.branch.name, toBranchAvgDailySales: best.velocity, suggestedUnits },
        };
      });
    })();

    return { withinDays, items: itemsWithTransfer, previousItems };
  }

  /**
   * Runs the dead-stock classification as of a given date (`asOf`) — "positive quantity as of
   * that date, with no qualifying sale in the `thresholdDays` immediately before it". Used both
   * for `items` (asOf = now) and `previousItems` (asOf = 30 days ago) so the KPI trend compares
   * two genuinely independent classifications, not "the same SKUs, revalued" — a product that
   * only went idle in the last 30 days correctly drops out of the 30-days-ago snapshot.
   *
   * A qualifying sale excludes voided sales entirely and, for a fully refunded sale, the demand
   * it represented never really happened — only `posted`/`partially_refunded` count, the same
   * filter `avgDailySalesByProduct` already uses elsewhere in this file.
   */
  private async classifyDeadStock(
    tenantId: string,
    branchId: string | null,
    batches: Array<{ id: string; productId: string; costPrice: Prisma.Decimal }>,
    thresholdDays: number,
    asOf: Date,
  ): Promise<Map<string, { qty: number; value: Prisma.Decimal; daysSinceLastSale: number | null }>> {
    const qtyMap = await this.batchQtyAsOf(
      tenantId,
      branchId,
      batches.map((b) => b.id),
      asOf,
    );
    const byProduct = new Map<string, { qty: number; value: Prisma.Decimal }>();
    for (const b of batches) {
      const qty = qtyMap.get(b.id) ?? 0;
      if (qty <= 0) continue;
      const cur = byProduct.get(b.productId) ?? { qty: 0, value: new Prisma.Decimal(0) };
      cur.qty += qty;
      cur.value = cur.value.add(b.costPrice.mul(qty));
      byProduct.set(b.productId, cur);
    }
    if (byProduct.size === 0) return new Map();

    const productIds = [...byProduct.keys()];
    const lastSold = await this.prisma.saleItem.groupBy({
      by: ["productId"],
      where: {
        tenantId,
        productId: { in: productIds },
        sale: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          status: { in: ["posted", "partially_refunded"] },
          soldAt: { lte: asOf },
        },
      },
      _max: { createdAt: true },
    });
    const lastSoldMap = new Map(lastSold.map((r) => [r.productId, r._max.createdAt]));

    const dead = new Map<string, { qty: number; value: Prisma.Decimal; daysSinceLastSale: number | null }>();
    for (const [productId, agg] of byProduct) {
      const lastSoldAt = lastSoldMap.get(productId) ?? null;
      const daysSinceLastSale = lastSoldAt ? Math.round((asOf.getTime() - lastSoldAt.getTime()) / 86_400_000) : null;
      if (daysSinceLastSale != null && daysSinceLastSale <= thresholdDays) continue; // still selling recently enough — not dead
      dead.set(productId, { qty: agg.qty, value: agg.value, daysSinceLastSale });
    }
    return dead;
  }

  /** Same shape as `avgDailySalesByProduct` but with a caller-supplied window instead of the
   *  fixed `AGEING_VELOCITY_WINDOW_DAYS` — Dead Stock needs a window wider than its own
   *  (user-selectable) inactivity threshold, or "velocity" would trivially read 0 for every item
   *  by definition (a dead item has no sale inside its own threshold window already). */
  private async residualVelocityByProduct(
    tenantId: string,
    branchId: string | null,
    productIds: string[],
    now: Date,
    windowDays: number,
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const since = new Date(now);
    since.setDate(since.getDate() - windowDays);
    const rows = await this.prisma.saleItem.groupBy({
      by: ["productId"],
      where: {
        tenantId,
        productId: { in: productIds },
        sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
      },
      _sum: { qty: true },
    });
    return new Map(rows.map((r) => [r.productId, (r._sum.qty ?? 0) / windowDays]));
  }

  /**
   * Inventory-capital-recovery view — "how much capital is trapped in stock that isn't selling,
   * where is it concentrated, and what should we do about it?" Distinct from Stock Ageing
   * (batch age, sells or not) and Near Expiry (expiry proximity): Dead Stock is purely a demand
   * signal — no qualifying sale in `thresholdDays` (see `classifyDeadStock`) — and spans every
   * COMMERCIAL department, not just Medicines.
   *
   * Severity quadrant / suggested action / recovery-value methodology is centralized here (see
   * `DEAD_STOCK_RECOVERY_FACTOR` and `quadrantOf`/`suggestedActionFor` below) so the frontend
   * never re-derives it — same principle as Stock Value's `CAPITAL_AT_RISK_COVER_DAYS`.
   *
   * `categoryId` filters by top-level COMMERCIAL department (this report spans every department,
   * like Stock Value — not the Medicines-only leaf-category filter Near Expiry/Stock Ageing use).
   */
  async deadStock(
    tenantId: string,
    branchId: string | null,
    thresholdDays = 90,
    categoryId?: string,
    supplierId?: string,
  ): Promise<DeadStockResponse> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const empty: DeadStockResponse = { daysWithoutSale: thresholdDays, items: [], previousItems: [], trend: [] };

    const allBatches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      select: { id: true, productId: true, costPrice: true },
    });
    if (allBatches.length === 0) return empty;

    const allProductIds = [...new Set(allBatches.map((b) => b.productId))];
    const [categoryByProduct, supplierByBatch] = await Promise.all([
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, allProductIds),
      this.supplierByBatchIds(tenantId, allBatches.map((b) => b.id)),
    ]);

    const departmentOf = (productId: string): { id: string | null; name: string } => {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    };
    const categoryOf = (productId: string) => categoryByProduct.get(productId) ?? null;

    const batches = allBatches.filter((b) => {
      if (categoryId && departmentOf(b.productId).id !== categoryId) return false;
      if (supplierId && supplierByBatch.get(b.id)?.id !== supplierId) return false;
      return true;
    });
    if (batches.length === 0) return empty;

    // First batch found per product stands in for "the" supplier — a product's batches can span
    // multiple suppliers, same simplification Stock Value's own supplier filter already makes.
    const supplierByProduct = new Map<string, { id: string; name: string }>();
    for (const b of batches) {
      if (supplierByProduct.has(b.productId)) continue;
      const s = supplierByBatch.get(b.id);
      if (s) supplierByProduct.set(b.productId, s);
    }

    const productIds = [...new Set(batches.map((b) => b.productId))];
    const prevAsOf = new Date(now);
    prevAsOf.setDate(prevAsOf.getDate() - 30);
    // Always meaningfully wider than the selected threshold, so residual velocity never
    // trivially reads 0 for every item just because the item is dead by definition.
    const velocityWindowDays = thresholdDays + 90;

    const [currentDead, prevDead, products] = await Promise.all([
      this.classifyDeadStock(tenantId, branchId, batches, thresholdDays, now),
      this.classifyDeadStock(tenantId, branchId, batches, thresholdDays, prevAsOf),
      this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, sku: true, name: true } }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));

    if (currentDead.size === 0) return { daysWithoutSale: thresholdDays, items: [], previousItems: [], trend: [] };

    const deadProductIds = [...currentDead.keys()];
    const [residualVelocity, crossBranchVelocity] = await Promise.all([
      this.residualVelocityByProduct(tenantId, branchId, deadProductIds, now, velocityWindowDays),
      // Cross-branch demand only means something when a specific branch is in view — under
      // "All branches" scope, dead stock is already evaluated against tenant-wide demand.
      branchId ? this.avgDailySalesByProduct(tenantId, null, deadProductIds, now, branchId) : Promise.resolve(new Map<string, number>()),
    ]);

    // Severity matrix's value-axis split — median of the currently-dead population itself (not
    // all stock), so the split always divides these specific items roughly in half regardless of
    // the tenant's overall value scale.
    const sortedValues = [...currentDead.values()].map((d) => Number(d.value)).sort((a, b) => a - b);
    const mid = Math.floor(sortedValues.length / 2);
    const medianValue = sortedValues.length === 0 ? 0 : sortedValues.length % 2 === 0 ? (sortedValues[mid - 1]! + sortedValues[mid]!) / 2 : sortedValues[mid]!;

    function quadrantOf(value: number, daysSinceLastSale: number | null): DeadStockQuadrant {
      const highValue = value >= medianValue;
      const longInactivity = daysSinceLastSale == null || daysSinceLastSale >= thresholdDays * 2;
      if (highValue && !longInactivity) return "recoverFast";
      if (highValue && longInactivity) return "investigate";
      if (!highValue && !longInactivity) return "monitor";
      return "liquidate";
    }

    // Priority-ordered, deterministic — first match wins. Transfer/return-to-supplier are
    // evaluated first since they route stock back into *some* productive use; everything else
    // falls back to the quadrant it landed in (see class doc for the full rationale).
    function suggestedActionFor(
      quadrant: DeadStockQuadrant,
      daysSinceLastSale: number | null,
      hasKnownSupplier: boolean,
      value: number,
      crossBranchDemand: boolean,
    ): DeadStockAction {
      if (crossBranchDemand) return "transfer";
      if (hasKnownSupplier && value >= DEAD_STOCK_MIN_SUPPLIER_RETURN_VALUE) return "return_supplier";
      if (quadrant === "liquidate") return "liquidate";
      if (daysSinceLastSale == null) return "review_assortment";
      if (quadrant === "investigate") return "markdown";
      if (quadrant === "recoverFast") return "bundle";
      return "monitor";
    }

    const items: DeadStockItem[] = [...currentDead.entries()]
      .map(([productId, agg]) => {
        const dept = departmentOf(productId);
        const cat = categoryOf(productId);
        const product = productById.get(productId);
        const supplier = supplierByProduct.get(productId) ?? null;
        const value = Number(agg.value);
        const velocity = residualVelocity.get(productId) ?? 0;
        const daysOfCover = velocity > 0 ? Math.round(agg.qty / velocity) : null;
        const crossBranchDemand = (crossBranchVelocity.get(productId) ?? 0) > 0;
        const quadrant = quadrantOf(value, agg.daysSinceLastSale);
        const suggestedAction = suggestedActionFor(quadrant, agg.daysSinceLastSale, !!supplier, value, crossBranchDemand);
        return {
          productId,
          qtyOnHand: agg.qty,
          value: agg.value.toString(),
          daysSinceLastSale: agg.daysSinceLastSale,
          categoryId: cat?.id ?? null,
          categoryName: cat?.name ?? "Unclassified",
          departmentId: dept.id,
          departmentName: dept.name,
          avgDailySales: velocity,
          daysOfCover,
          hasKnownSupplier: !!supplier,
          supplierName: supplier?.name ?? null,
          crossBranchDemand,
          quadrant,
          suggestedAction,
          recoveryValue: Math.round(value * DEAD_STOCK_RECOVERY_FACTOR[suggestedAction] * 100) / 100,
          product: product ?? { id: productId },
        };
      })
      .sort((a, b) => Number(b.value) - Number(a.value));

    const previousItems: DeadStockSnapshotItem[] = [...prevDead.entries()].map(([productId, agg]) => {
      const dept = departmentOf(productId);
      return { productId, value: Number(agg.value), qtyOnHand: agg.qty, departmentId: dept.id, departmentName: dept.name };
    });

    // Trend: the *same* currently-dead batches, revalued at each historical qty snapshot — same
    // "same basket, re-valued" convention Stock Value's sparkline already uses, not a re-run of
    // the classification at each point (which `previousItems` already does properly for the KPI).
    const deadProductIdSet = new Set(deadProductIds);
    const deadBatches = batches.filter((b) => deadProductIdSet.has(b.productId));
    const deadBatchIds = deadBatches.map((b) => b.id);
    const deptNameById = new Map<string, string>();
    for (const pid of deadProductIds) {
      const d = departmentOf(pid);
      deptNameById.set(d.id ?? "unclassified", d.name);
    }

    const trendAsOfDates = DEAD_STOCK_TREND_OFFSETS_DAYS.map((d) => {
      const dt = new Date(now);
      dt.setDate(dt.getDate() - d);
      return dt;
    });
    const trendQtyMaps = await Promise.all(trendAsOfDates.map((d) => this.batchQtyAsOf(tenantId, branchId, deadBatchIds, d)));

    function deptValueAt(qtyMap: Map<string, number>): Map<string, Prisma.Decimal> {
      const map = new Map<string, Prisma.Decimal>();
      for (const b of deadBatches) {
        const qty = qtyMap.get(b.id) ?? 0;
        if (qty <= 0) continue;
        const key = departmentOf(b.productId).id ?? "unclassified";
        map.set(key, (map.get(key) ?? new Prisma.Decimal(0)).add(b.costPrice.mul(qty)));
      }
      return map;
    }

    const trend: DeadStockTrendPoint[] = DEAD_STOCK_TREND_OFFSETS_DAYS.map((offsetDays, i) => {
      const deptAgg = deptValueAt(trendQtyMaps[i]!);
      const departments: DeadStockTrendDept[] = [...deptAgg.entries()].map(([id, v]) => ({
        departmentId: id,
        departmentName: deptNameById.get(id) ?? "Unclassified",
        value: Number(v),
      }));
      return {
        key: offsetDays === 0 ? "now" : `${offsetDays}d-ago`,
        label: offsetDays === 0 ? "Now" : `${offsetDays}d ago`,
        totalValue: departments.reduce((s, d) => s + d.value, 0),
        departments,
      };
    });

    return { daysWithoutSale: thresholdDays, items, previousItems, trend };
  }

  /**
   * Which inventory is healthy, understocked, overstocked, or dead — classifies every in-stock
   * product into exactly one `StockHealthZone` (see priority note on the type) and powers the
   * Inventory Health Matrix bubble chart plus the four Stock Health KPIs. Spans every COMMERCIAL
   * department, like Stock Value/Dead Stock (not the Medicines-only scope Stock Ageing/Near
   * Expiry use) — this report's whole point is a tenant-wide health view.
   */
  async stockHealth(tenantId: string, branchId: string | null, categoryId?: string, supplierId?: string): Promise<StockHealthResponse> {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const empty: StockHealthResponse = { items: [], previousItems: [], skuUniverseCount: 0 };

    const allBatches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      select: { id: true, productId: true, costPrice: true },
    });
    if (allBatches.length === 0) return empty;

    const allProductIds = [...new Set(allBatches.map((b) => b.productId))];
    const [categoryByProduct, supplierByBatch] = await Promise.all([
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, allProductIds),
      this.supplierByBatchIds(tenantId, allBatches.map((b) => b.id)),
    ]);

    const departmentOf = (productId: string): { id: string | null; name: string } => {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    };

    const batches = allBatches.filter((b) => {
      if (categoryId && departmentOf(b.productId).id !== categoryId) return false;
      if (supplierId && supplierByBatch.get(b.id)?.id !== supplierId) return false;
      return true;
    });
    if (batches.length === 0) return empty;

    const batchIds = batches.map((b) => b.id);
    const productIds = [...new Set(batches.map((b) => b.productId))];
    const prevAsOf = new Date(now);
    prevAsOf.setDate(prevAsOf.getDate() - 30);

    const [currentQty, prevQty, products, velocity, lastSold] = await Promise.all([
      this.batchQtyAsOf(tenantId, branchId, batchIds),
      this.batchQtyAsOf(tenantId, branchId, batchIds, prevAsOf),
      this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, sku: true, name: true, reorderLevel: true } }),
      this.avgDailySalesByProduct(tenantId, branchId, productIds, now),
      this.prisma.saleItem.groupBy({
        by: ["productId"],
        where: {
          tenantId,
          productId: { in: productIds },
          sale: { tenantId, ...(branchId ? { branchId } : {}), status: { in: ["posted", "partially_refunded"] } },
        },
        _max: { createdAt: true },
      }),
    ]);
    const productById = new Map(products.map((p) => [p.id, p]));
    const lastSoldMap = new Map(lastSold.map((r) => [r.productId, r._max.createdAt]));

    function aggregateByProduct(qtyMap: Map<string, number>): Map<string, { qty: number; value: Prisma.Decimal }> {
      const map = new Map<string, { qty: number; value: Prisma.Decimal }>();
      for (const b of batches) {
        const qty = qtyMap.get(b.id) ?? 0;
        if (qty <= 0) continue;
        const cur = map.get(b.productId) ?? { qty: 0, value: new Prisma.Decimal(0) };
        cur.qty += qty;
        cur.value = cur.value.add(b.costPrice.mul(qty));
        map.set(b.productId, cur);
      }
      return map;
    }

    function daysSinceLastSaleOf(productId: string): number | null {
      const lastSoldAt = lastSoldMap.get(productId) ?? null;
      return lastSoldAt ? Math.round((now.getTime() - lastSoldAt.getTime()) / 86_400_000) : null;
    }

    function classifyZone(qtyOnHand: number, velocityPerDay: number, daysOfCover: number | null, daysSinceLastSale: number | null, isLowStock: boolean): StockHealthZone {
      const isDead = qtyOnHand > 0 && (daysSinceLastSale == null || daysSinceLastSale > STOCK_HEALTH_DEAD_THRESHOLD_DAYS);
      if (isDead) return "deadSlow";
      if (isLowStock) return "reorderRisk";
      if (velocityPerDay > 0 && daysOfCover != null && daysOfCover > STOCK_HEALTH_OVERSTOCK_COVER_DAYS) return "overstocked";
      if (velocityPerDay > 0 && velocityPerDay < STOCK_HEALTH_LOW_VELOCITY_PER_DAY) return "monitor";
      return "healthy";
    }

    const currentByProduct = aggregateByProduct(currentQty);
    const items: StockHealthItem[] = [...currentByProduct.entries()].map(([productId, agg]) => {
      const dept = departmentOf(productId);
      const product = productById.get(productId);
      const velocityPerDay = velocity.get(productId) ?? 0;
      const daysOfCover = velocityPerDay > 0 ? Math.round(agg.qty / velocityPerDay) : null;
      const daysSinceLastSale = daysSinceLastSaleOf(productId);
      const reorderLevel = product?.reorderLevel ?? 0;
      const isLowStock = resolveStockStatus(agg.qty, reorderLevel) === "low";
      return {
        productId,
        qtyOnHand: agg.qty,
        value: agg.value.toString(),
        departmentId: dept.id,
        departmentName: dept.name,
        avgDailySales: velocityPerDay,
        daysOfCover,
        daysSinceLastSale,
        reorderLevel,
        isLowStock,
        zone: classifyZone(agg.qty, velocityPerDay, daysOfCover, daysSinceLastSale, isLowStock),
        product: product ?? { id: productId },
      };
    });

    const prevByProduct = aggregateByProduct(prevQty);
    const previousItems: StockHealthSnapshotItem[] = [...prevByProduct.entries()].map(([productId, agg]) => {
      const dept = departmentOf(productId);
      const product = productById.get(productId);
      const velocityPerDay = velocity.get(productId) ?? 0;
      const daysOfCover = velocityPerDay > 0 ? Math.round(agg.qty / velocityPerDay) : null;
      const daysSinceLastSale = daysSinceLastSaleOf(productId);
      const reorderLevel = product?.reorderLevel ?? 0;
      const isLowStock = resolveStockStatus(agg.qty, reorderLevel) === "low";
      return {
        productId,
        value: Number(agg.value),
        qtyOnHand: agg.qty,
        zone: classifyZone(agg.qty, velocityPerDay, daysOfCover, daysSinceLastSale, isLowStock),
        departmentId: dept.id,
        departmentName: dept.name,
      };
    });

    return { items, previousItems, skuUniverseCount: productIds.length };
  }

  /** Average units sold per day per product over a trailing window — one `groupBy`, not per
   *  product. `excludeBranchId` (instead of `branchId`) computes "every branch except this one"'s
   *  velocity in a single call, for the ageing recommendation's cross-branch demand check. */
  private async avgDailySalesByProduct(
    tenantId: string,
    branchId: string | null,
    productIds: string[],
    now: Date,
    excludeBranchId?: string,
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const since = new Date(now);
    since.setDate(since.getDate() - AGEING_VELOCITY_WINDOW_DAYS);
    const rows = await this.prisma.saleItem.groupBy({
      by: ["productId"],
      where: {
        tenantId,
        productId: { in: productIds },
        sale: {
          tenantId,
          ...(excludeBranchId ? { branchId: { not: excludeBranchId } } : branchId ? { branchId } : {}),
          soldAt: { gte: since },
          status: { in: ["posted", "partially_refunded"] },
        },
      },
      _sum: { qty: true },
    });
    return new Map(rows.map((r) => [r.productId, (r._sum.qty ?? 0) / AGEING_VELOCITY_WINDOW_DAYS]));
  }

  /**
   * Inventory age (time since `Batch.receivedAt`, not expiry date — that's Near Expiry's concern,
   * and this never excludes a product just because it hasn't sold recently — that's Dead Stock's).
   * Batch-level, not product-level: a product can have both a fresh and a stale batch of stock at
   * once, so age composition is computed per batch and only rolled up at display time.
   *
   * Scoped to the MEDICINES department only, same as `nearExpiry` and for the same reason —
   * ageing/freshness is overwhelmingly a medicines concern (shelf-life-sensitive, capital-heavy,
   * regulated stock), so every other department is excluded rather than diluting the page. As with
   * `nearExpiry`, `category` here means the LEAF sub-category under Medicines (Pain & Fever,
   * Anti-infectives, ...), not the department itself.
   *
   * `categoryId`/`supplierId` filters are applied to the batch list up front (not after the fact)
   * so `items`, `previousItems`, and `trend` all reflect exactly the same filtered population —
   * required for the KPI/chart/table reconciliation this report depends on.
   *
   * `trend` reconstructs the last `TREND_MONTHS` months' age composition from the ledger (the same
   * "quantity as of a past date" technique `nearExpiry`'s `batchQtyAsOf` already uses) — a batch's
   * age *at that past date* is computed from its fixed `receivedAt`, and only batches that already
   * existed by then (and had positive quantity then) count toward that month's total.
   */
  async stockAgeing(tenantId: string, branchId: string | null, categoryId?: string, supplierId?: string) {
    const TREND_MONTHS = 6;
    const PREV_PERIOD_DAYS = 30;
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const prevAsOf = new Date(now);
    prevAsOf.setDate(prevAsOf.getDate() - PREV_PERIOD_DAYS);

    const empty = { items: [] as StockAgeingItem[], previousItems: [] as StockAgeingSnapshotItem[], trend: [] as StockAgeingTrendPoint[] };

    const allBatches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}) },
      select: { id: true, batchNo: true, productId: true, costPrice: true, sellingPrice: true, receivedAt: true },
    });
    if (allBatches.length === 0) return empty;

    const allProductIds = [...new Set(allBatches.map((b) => b.productId))];
    const [categoryByProduct, supplierByBatch, canonicalIds] = await Promise.all([
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, allProductIds),
      this.supplierByBatchIds(tenantId, allBatches.map((b) => b.id)),
      this.categoryTaxonomy.commercialCanonicalIds(tenantId),
    ]);
    const medicinesDeptId = canonicalIds.get("MEDICINES") ?? null;

    // Leaf sub-category (not rolled up — Medicines is the only department in scope, so the
    // department itself wouldn't be a useful grouping dimension here, same as nearExpiry).
    const leafCategoryOf = (productId: string) => categoryByProduct.get(productId) ?? null;
    const isInMedicines = (productId: string): boolean => {
      const cat = leafCategoryOf(productId);
      const departmentId = cat?.parentCategoryId ?? cat?.id ?? null;
      return !!medicinesDeptId && departmentId === medicinesDeptId;
    };

    const batches = allBatches.filter((b) => {
      if (!isInMedicines(b.productId)) return false;
      if (categoryId && leafCategoryOf(b.productId)?.id !== categoryId) return false;
      if (supplierId && supplierByBatch.get(b.id)?.id !== supplierId) return false;
      return true;
    });
    if (batches.length === 0) return empty;

    const batchIds = batches.map((b) => b.id);
    const productIds = [...new Set(batches.map((b) => b.productId))];
    const monthDefs = buildAgeingMonthDefs(now, TREND_MONTHS);

    const [currentQty, prevQty, velocityByProduct, otherBranchVelocityByProduct, products] = await Promise.all([
      this.batchQtyAsOf(tenantId, branchId, batchIds),
      this.batchQtyAsOf(tenantId, branchId, batchIds, prevAsOf),
      this.avgDailySalesByProduct(tenantId, branchId, productIds, now),
      branchId ? this.avgDailySalesByProduct(tenantId, null, productIds, now, branchId) : Promise.resolve(new Map<string, number>()),
      this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, sku: true, name: true } }),
    ]);
    const trendQtyMaps = await Promise.all(monthDefs.map((m) => this.batchQtyAsOf(tenantId, branchId, batchIds, m.asOf)));
    const productById = new Map(products.map((p) => [p.id, p]));

    type BatchRow = (typeof batches)[number];
    const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

    function buildItem(b: BatchRow, qty: number, asOf: Date): StockAgeingItem | null {
      if (qty <= 0) return null;
      const ageDays = daysBetween(b.receivedAt, asOf);
      const value = b.costPrice.mul(qty);
      const leaf = leafCategoryOf(b.productId);
      const supplier = supplierByBatch.get(b.id);
      const avgDailySales = velocityByProduct.get(b.productId) ?? 0;
      const otherBranchAvgDailySales = otherBranchVelocityByProduct.get(b.productId) ?? 0;
      const marginPct = b.sellingPrice.greaterThan(0) ? b.sellingPrice.sub(b.costPrice).div(b.sellingPrice).mul(100).toNumber() : 0;
      return {
        batchId: b.id,
        batchNo: b.batchNo,
        productId: b.productId,
        receivedAt: b.receivedAt.toISOString(),
        ageDays,
        ageBucket: ageBucketOf(ageDays),
        qtyOnHand: qty,
        costPrice: b.costPrice.toString(),
        value: value.toString(),
        categoryId: leaf?.id ?? null,
        categoryName: leaf?.name ?? "Unclassified",
        supplierId: supplier?.id ?? null,
        supplierName: supplier?.name ?? "Unknown supplier",
        avgDailySales,
        daysOfCover: avgDailySales > 0 ? Math.round(qty / avgDailySales) : null,
        recommendation: recommendStockAgeingAction(ageDays, marginPct, avgDailySales, otherBranchAvgDailySales),
        product: productById.get(b.productId) ?? { id: b.productId },
      };
    }

    function snapshotItem(b: BatchRow, qty: number, asOf: Date): StockAgeingSnapshotItem | null {
      if (qty <= 0) return null;
      const ageDays = daysBetween(b.receivedAt, asOf);
      return {
        ageDays,
        ageBucket: ageBucketOf(ageDays),
        value: Number(b.costPrice.mul(qty)),
        categoryId: leafCategoryOf(b.productId)?.id ?? null,
      };
    }

    const items = batches.map((b) => buildItem(b, currentQty.get(b.id) ?? 0, now)).filter((it): it is StockAgeingItem => it !== null);
    const previousItems = batches
      .filter((b) => b.receivedAt <= prevAsOf)
      .map((b) => snapshotItem(b, prevQty.get(b.id) ?? 0, prevAsOf))
      .filter((it): it is StockAgeingSnapshotItem => it !== null);

    const trend: StockAgeingTrendPoint[] = monthDefs.map((m, i) => {
      const qtyMap = trendQtyMaps[i]!;
      const monthItems = batches
        .filter((b) => b.receivedAt <= m.asOf)
        .map((b) => snapshotItem(b, qtyMap.get(b.id) ?? 0, m.asOf))
        .filter((it): it is StockAgeingSnapshotItem => it !== null);
      const totalValue = monthItems.reduce((s, it) => s + it.value, 0);
      const buckets = AGE_BUCKETS.map((def) => {
        const value = monthItems.filter((it) => it.ageBucket === def.key).reduce((s, it) => s + it.value, 0);
        return { key: def.key, label: def.label, value, pct: totalValue > 0 ? (value / totalValue) * 100 : 0 };
      });
      return { key: m.key, label: m.label, totalValue, buckets };
    });

    return { items, previousItems, trend };
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
      const [items, returnItems] = await Promise.all([
        this.prisma.saleItem.findMany({
          where: {
            tenantId,
            sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
          },
          include: {
            batch: { select: { costPrice: true } },
            product: { select: { schedule: true } },
          },
        }),
        this.netCustomerReturnItems(tenantId, branchId, since),
      ]);

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
      for (const ret of returnItems) {
        const name = ret.product.schedule?.trim() || "Unscheduled";
        const cur = byGroup.get(name) ?? {
          categoryId: name,
          name,
          revenue: new Prisma.Decimal(0),
          cost: new Prisma.Decimal(0),
          unitsSold: 0,
          isUnclassified: name === "Unscheduled",
        };
        cur.revenue = cur.revenue.sub(ret.unitPrice.mul(ret.qty));
        if (ret.batchId && ret.batch) cur.cost = cur.cost.sub(ret.batch.costPrice.mul(ret.qty));
        cur.unitsSold -= ret.qty;
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

    const [items, returnItems] = await Promise.all([
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: { productId: true, qty: true, lineTotal: true, batch: { select: { costPrice: true } } },
      }),
      this.netCustomerReturnItems(tenantId, branchId, since),
    ]);
    // Includes returned products even when their sale falls outside this window (see
    // `netCustomerReturnItems`'s doc comment) so their category still resolves instead of
    // silently falling back to "Uncategorized".
    const productIds = [...new Set([...items.map((it) => it.productId), ...returnItems.map((it) => it.productId)])];

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
      // Shared by both the sale-item loop (positive deltas) and the return-item netting loop
      // (negative deltas) below — the parent/child rollup logic is identical either way, just the
      // sign differs, so this keeps that non-trivial resolution logic from being duplicated.
      const applyToCommercial = (productId: string, revenueDelta: Prisma.Decimal, costDelta: Prisma.Decimal, unitsDelta: number) => {
        const category = categoryByProduct.get(productId);
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
        parent.revenue = parent.revenue.add(revenueDelta);
        parent.cost = parent.cost.add(costDelta);
        parent.unitsSold += unitsDelta;
        byParent.set(parentId, parent);

        const child = parent.children.get(childId) ?? {
          categoryId: childId,
          name: childName,
          revenue: new Prisma.Decimal(0),
          cost: new Prisma.Decimal(0),
          unitsSold: 0,
          isUnclassified: isChildUnclassified,
        };
        child.revenue = child.revenue.add(revenueDelta);
        child.cost = child.cost.add(costDelta);
        child.unitsSold += unitsDelta;
        parent.children.set(childId, child);
      };

      for (const it of items) {
        applyToCommercial(it.productId, it.lineTotal, it.batch.costPrice.mul(it.qty), it.qty);
      }
      for (const ret of returnItems) {
        const cost = ret.batchId && ret.batch ? ret.batch.costPrice.mul(ret.qty) : new Prisma.Decimal(0);
        applyToCommercial(ret.productId, ret.unitPrice.mul(ret.qty).neg(), cost.neg(), -ret.qty);
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
    const applyToCategory = (productId: string, revenueDelta: Prisma.Decimal, costDelta: Prisma.Decimal, unitsDelta: number) => {
      const category = categoryByProduct.get(productId);
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
      cur.revenue = cur.revenue.add(revenueDelta);
      cur.cost = cur.cost.add(costDelta);
      cur.unitsSold += unitsDelta;
      byCategory.set(catId, cur);
    };
    for (const it of items) {
      applyToCategory(it.productId, it.lineTotal, it.batch.costPrice.mul(it.qty), it.qty);
    }
    for (const ret of returnItems) {
      const cost = ret.batchId && ret.batch ? ret.batch.costPrice.mul(ret.qty) : new Prisma.Decimal(0);
      applyToCategory(ret.productId, ret.unitPrice.mul(ret.qty).neg(), cost.neg(), -ret.qty);
    }

    return {
      days,
      groupedBy: groupBy,
      categories: [...byCategory.values()].map(toRow).sort((a, b) => Number(b.revenue) - Number(a.revenue)),
    };
  }

  /** Daily revenue/cost per top-level COMMERCIAL department, for Margin by Category's trend
   *  chart — same product→department rollup as `salesByCategory`'s `groupBy=commercial`
   *  branch, just keyed by (date, departmentId) instead of collapsing the date dimension away. */
  async marginTrendByCategory(tenantId: string, branchId: string | null, days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [items, returnItems] = await Promise.all([
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: {
          productId: true,
          qty: true,
          lineTotal: true,
          batch: { select: { costPrice: true } },
          sale: { select: { soldAt: true } },
        },
      }),
      this.netCustomerReturnItems(tenantId, branchId, since),
    ]);
    const productIds = [...new Set([...items.map((it) => it.productId), ...returnItems.map((it) => it.productId)])];
    const categoryByProduct = await this.categoryTaxonomy.primaryCommercialCategoryByProductIds(
      tenantId,
      productIds,
    );

    type Agg = { categoryId: string; name: string; revenue: Prisma.Decimal; cost: Prisma.Decimal };
    const byKey = new Map<string, Agg>();
    const applyToTrend = (productId: string, date: string, revenueDelta: Prisma.Decimal, costDelta: Prisma.Decimal) => {
      const category = categoryByProduct.get(productId);
      // Roll up to the parent department, same as salesByCategory's commercial grouping — a
      // trend line per leaf sub-category would be too many series to read at a glance.
      const categoryId = category?.parentCategoryId ?? category?.id ?? "uncategorized";
      const name = category?.parentCategoryId ? (category.parent?.name ?? "Uncategorized") : (category?.name ?? "Uncategorized");
      const key = `${date}|${categoryId}`;
      const cur = byKey.get(key) ?? { categoryId, name, revenue: new Prisma.Decimal(0), cost: new Prisma.Decimal(0) };
      cur.revenue = cur.revenue.add(revenueDelta);
      cur.cost = cur.cost.add(costDelta);
      byKey.set(key, cur);
    };
    for (const it of items) {
      applyToTrend(it.productId, it.sale.soldAt.toISOString().slice(0, 10), it.lineTotal, it.batch.costPrice.mul(it.qty));
    }
    // Netted on the return's own date (not the original sale's), same convention as
    // `netCustomerReturnItems` — so a day's bucket reflects the actual net cash/COGS impact.
    for (const ret of returnItems) {
      const cost = ret.batchId && ret.batch ? ret.batch.costPrice.mul(ret.qty) : new Prisma.Decimal(0);
      applyToTrend(ret.productId, ret.goodsReturn.createdAt.toISOString().slice(0, 10), ret.unitPrice.mul(ret.qty).neg(), cost.neg());
    }

    const points = [...byKey.entries()].map(([key, v]) => ({
      date: key.split("|")[0]!,
      categoryId: v.categoryId,
      name: v.name,
      revenue: v.revenue.toString(),
      cost: v.cost.toString(),
    }));

    return { days, points };
  }

  /** Every branch the tenant has, always — this report's whole point is comparing branches, so
   *  unlike every other Profitability method it never collapses to "one branch or the tenant
   *  total"; a branch with zero activity in the window still appears as a 0-row instead of
   *  vanishing (same "start from the branch list" pattern as `analytics.service.ts`'s
   *  `branchPerformance`, which this mirrors — except that method is revenue-only/calendar-month;
   *  this one needs the COGS join and returns-netting only the Profitability methods have, so it
   *  lives here instead, on the same rolling `days` window as Gross Profit/Margin by Product). */
  async branchMargin(tenantId: string, days = 30): Promise<{ days: number; branches: BranchMarginRow[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [branches, items, returnItems] = await Promise.all([
      this.prisma.branch.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true, city: true },
      }),
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: { qty: true, lineTotal: true, batch: { select: { costPrice: true } }, sale: { select: { branchId: true } } },
      }),
      // branchId omitted (null) — nets returns across every branch at once, bucketed below by
      // each return's own `goodsReturn.branchId` rather than being pre-filtered to one.
      this.netCustomerReturnItems(tenantId, null, since),
    ]);

    type Agg = { revenue: Prisma.Decimal; cost: Prisma.Decimal; unitsSold: number };
    const byBranch = new Map<string, Agg>();
    const applyToBranch = (branchId: string, revenueDelta: Prisma.Decimal, costDelta: Prisma.Decimal, unitsDelta: number) => {
      const cur = byBranch.get(branchId) ?? { revenue: new Prisma.Decimal(0), cost: new Prisma.Decimal(0), unitsSold: 0 };
      cur.revenue = cur.revenue.add(revenueDelta);
      cur.cost = cur.cost.add(costDelta);
      cur.unitsSold += unitsDelta;
      byBranch.set(branchId, cur);
    };
    for (const it of items) {
      applyToBranch(it.sale.branchId, it.lineTotal, it.batch.costPrice.mul(it.qty), it.qty);
    }
    for (const ret of returnItems) {
      const cost = ret.batchId && ret.batch ? ret.batch.costPrice.mul(ret.qty) : new Prisma.Decimal(0);
      applyToBranch(ret.goodsReturn.branchId, ret.unitPrice.mul(ret.qty).neg(), cost.neg(), -ret.qty);
    }

    return {
      days,
      branches: branches.map((b) => {
        const agg = byBranch.get(b.id) ?? { revenue: new Prisma.Decimal(0), cost: new Prisma.Decimal(0), unitsSold: 0 };
        return {
          branchId: b.id,
          code: b.code,
          name: b.name,
          city: b.city,
          revenue: agg.revenue.toString(),
          cost: agg.cost.toString(),
          margin: agg.revenue.sub(agg.cost).toString(),
          unitsSold: agg.unitsSold,
        };
      }),
    };
  }

  /** Daily revenue/cost per branch, for Branch Profitability's margin-over-time heatmap — same
   *  shape and rollup convention as `marginTrendByCategory`, just keyed by (date, branchId)
   *  instead of (date, departmentId). Day-granular; the frontend buckets into weeks itself, the
   *  same way Margin by Category's own trend chart already does client-side. */
  async branchMarginTrend(tenantId: string, days = 30): Promise<{ days: number; points: BranchMarginTrendPoint[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [branches, items, returnItems] = await Promise.all([
      this.prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: {
          qty: true,
          lineTotal: true,
          batch: { select: { costPrice: true } },
          sale: { select: { branchId: true, soldAt: true } },
        },
      }),
      this.netCustomerReturnItems(tenantId, null, since),
    ]);
    const nameByBranch = new Map(branches.map((b) => [b.id, b.name]));

    type Agg = { branchId: string; name: string; revenue: Prisma.Decimal; cost: Prisma.Decimal };
    const byKey = new Map<string, Agg>();
    const applyToTrend = (branchId: string, date: string, revenueDelta: Prisma.Decimal, costDelta: Prisma.Decimal) => {
      const name = nameByBranch.get(branchId) ?? "Unknown Branch";
      const key = `${date}|${branchId}`;
      const cur = byKey.get(key) ?? { branchId, name, revenue: new Prisma.Decimal(0), cost: new Prisma.Decimal(0) };
      cur.revenue = cur.revenue.add(revenueDelta);
      cur.cost = cur.cost.add(costDelta);
      byKey.set(key, cur);
    };
    for (const it of items) {
      applyToTrend(it.sale.branchId, it.sale.soldAt.toISOString().slice(0, 10), it.lineTotal, it.batch.costPrice.mul(it.qty));
    }
    // Netted on the return's own date (not the original sale's) — same convention as every other
    // Profitability method's returns netting.
    for (const ret of returnItems) {
      const cost = ret.batchId && ret.batch ? ret.batch.costPrice.mul(ret.qty) : new Prisma.Decimal(0);
      applyToTrend(ret.goodsReturn.branchId, ret.goodsReturn.createdAt.toISOString().slice(0, 10), ret.unitPrice.mul(ret.qty).neg(), cost.neg());
    }

    const points = [...byKey.entries()].map(([key, v]) => ({
      date: key.split("|")[0]!,
      branchId: v.branchId,
      name: v.name,
      revenue: v.revenue.toString(),
      cost: v.cost.toString(),
    }));

    return { days, points };
  }

  /** Every branch, revenue/units summed the same way `branchMargin` does (status-filtered SaleItems,
   *  netted against completed customer returns) but without the COGS join — this is Branch Sales'
   *  demand story, not Branch Profitability's margin one, and it's what fixes Branch Sales' period
   *  selector actually doing something (the page used to be powered by `analytics.service.ts`'s
   *  calendar-month-only `branchPerformance`). Transaction counts come from a separate `Sale.groupBy`
   *  (an item-level aggregate would double-count a multi-line sale) and are never returns-netted,
   *  matching every other report's convention that a return doesn't undo a transaction happening. */
  async branchSales(tenantId: string, days = 30): Promise<{ days: number; branches: BranchSalesRow[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [branches, items, returnItems, saleCounts] = await Promise.all([
      this.prisma.branch.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, code: true, name: true, city: true },
      }),
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: { qty: true, lineTotal: true, sale: { select: { branchId: true } } },
      }),
      this.netCustomerReturnItems(tenantId, null, since),
      this.prisma.sale.groupBy({
        by: ["branchId"],
        where: { tenantId, soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        _count: { _all: true },
      }),
    ]);

    type Agg = { revenue: Prisma.Decimal; unitsSold: number };
    const byBranch = new Map<string, Agg>();
    const applyToBranch = (branchId: string, revenueDelta: Prisma.Decimal, unitsDelta: number) => {
      const cur = byBranch.get(branchId) ?? { revenue: new Prisma.Decimal(0), unitsSold: 0 };
      cur.revenue = cur.revenue.add(revenueDelta);
      cur.unitsSold += unitsDelta;
      byBranch.set(branchId, cur);
    };
    for (const it of items) {
      applyToBranch(it.sale.branchId, it.lineTotal, it.qty);
    }
    for (const ret of returnItems) {
      applyToBranch(ret.goodsReturn.branchId, ret.unitPrice.mul(ret.qty).neg(), -ret.qty);
    }
    const transactionsByBranch = new Map(saleCounts.map((g) => [g.branchId, g._count._all]));

    return {
      days,
      branches: branches.map((b) => {
        const agg = byBranch.get(b.id) ?? { revenue: new Prisma.Decimal(0), unitsSold: 0 };
        return {
          branchId: b.id,
          code: b.code,
          name: b.name,
          city: b.city,
          revenue: agg.revenue.toString(),
          transactions: transactionsByBranch.get(b.id) ?? 0,
          unitsSold: agg.unitsSold,
        };
      }),
    };
  }

  /** Daily revenue per branch, for Branch Sales' trend chart — same shape/rollup convention as
   *  `branchMarginTrend`, just revenue-only (no cost dimension, this page has no margin story). */
  async branchSalesTrend(tenantId: string, days = 30): Promise<{ days: number; points: BranchSalesTrendPoint[] }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [branches, items, returnItems] = await Promise.all([
      this.prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } }),
      this.prisma.saleItem.findMany({
        where: {
          tenantId,
          sale: { tenantId, soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
        },
        select: { lineTotal: true, sale: { select: { branchId: true, soldAt: true } } },
      }),
      this.netCustomerReturnItems(tenantId, null, since),
    ]);
    const nameByBranch = new Map(branches.map((b) => [b.id, b.name]));

    type Agg = { branchId: string; name: string; revenue: Prisma.Decimal };
    const byKey = new Map<string, Agg>();
    const applyToTrend = (branchId: string, date: string, revenueDelta: Prisma.Decimal) => {
      const name = nameByBranch.get(branchId) ?? "Unknown Branch";
      const key = `${date}|${branchId}`;
      const cur = byKey.get(key) ?? { branchId, name, revenue: new Prisma.Decimal(0) };
      cur.revenue = cur.revenue.add(revenueDelta);
      byKey.set(key, cur);
    };
    for (const it of items) {
      applyToTrend(it.sale.branchId, it.sale.soldAt.toISOString().slice(0, 10), it.lineTotal);
    }
    for (const ret of returnItems) {
      applyToTrend(ret.goodsReturn.branchId, ret.goodsReturn.createdAt.toISOString().slice(0, 10), ret.unitPrice.mul(ret.qty).neg());
    }

    const points = [...byKey.entries()].map(([key, v]) => ({
      date: key.split("|")[0]!,
      branchId: v.branchId,
      name: v.name,
      revenue: v.revenue.toString(),
    }));

    return { days, points };
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
        // Same status gate as revenue — a voided sale's discount shouldn't inflate discountRatePct
        // (revenue's denominator) while never itself contributing to revenue.
        agg.discountTotal = agg.discountTotal.add(sale.discountTotal);
      }
      if (sale.status === "voided" || sale.status === "refunded" || sale.status === "partially_refunded") {
        agg.corrections += 1;
      }
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
      where: {
        tenantId,
        sale: { tenantId, ...(branchId ? { branchId } : {}), soldAt: { gte: since }, status: { in: ["posted", "partially_refunded"] } },
      },
      select: { method: true, amount: true, saleId: true, sale: { select: { status: true, soldAt: true } } },
    });

    type Agg = { revenue: Prisma.Decimal; saleIds: Set<string>; refunded: Prisma.Decimal };
    const byMethod = new Map<string, Agg>();
    const byDay = new Map<string, Map<string, Prisma.Decimal>>();

    for (const p of payments) {
      const cur = byMethod.get(p.method) ?? { revenue: new Prisma.Decimal(0), saleIds: new Set<string>(), refunded: new Prisma.Decimal(0) };
      cur.revenue = cur.revenue.add(p.amount);
      cur.saleIds.add(p.saleId);
      // "refunded" (fully refunded) sales are now excluded by the query's own status filter above —
      // only partially_refunded sales can still appear here, so this can never match "refunded".
      if (p.sale.status === "partially_refunded") {
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
        // completed only — matches netCustomerReturnItems' convention: a draft/pending_approval/
        // rejected/cancelled return never actually moved stock or cash, so counting it here would
        // overstate returns vs. every other report that nets returns out of revenue.
        where: { tenantId, type: "customer", status: GoodsReturnStatus.completed, ...(branchId ? { branchId } : {}), createdAt: { gte: since } },
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

    // Still keyed by product alone (so `qty`/`returnRatePct` below stay the product's real,
    // unsplit return rate — splitting the row itself by reason would understate the rate for any
    // product returned under more than one reason) — but each row now also carries its own
    // per-reason breakdown, so the frontend's "click a reason bar" filter can narrow the returned-
    // products table to just that reason's products and show a real Reason column, without
    // corrupting the rate every other part of this page already relies on.
    const byReturnedProduct = new Map<
      string,
      { productId: string; sku: string; name: string; value: number; qty: number; reasonBreakdown: Map<string, { value: number; qty: number }> }
    >();
    for (const r of returns) {
      const reason = r.reason?.trim() || "Unspecified";
      for (const it of r.items) {
        const cur = byReturnedProduct.get(it.productId) ?? { productId: it.productId, sku: it.product.sku, name: it.product.name, value: 0, qty: 0, reasonBreakdown: new Map() };
        const itemValue = Number(it.unitPrice) * it.qty;
        cur.value += itemValue;
        cur.qty += it.qty;
        const rb = cur.reasonBreakdown.get(reason) ?? { value: 0, qty: 0 };
        rb.value += itemValue;
        rb.qty += it.qty;
        cur.reasonBreakdown.set(reason, rb);
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
          const reasons = [...p.reasonBreakdown.entries()]
            .map(([reason, v]) => ({ reason, value: v.value, qty: v.qty }))
            .sort((a, b) => b.value - a.value);
          return {
            productId: p.productId,
            sku: p.sku,
            name: p.name,
            value: p.value,
            qty: p.qty,
            soldQty,
            returnRatePct: soldQty > 0 ? (p.qty / soldQty) * 100 : null,
            reasons,
          };
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

  /** One row per calendar day in range — gross sales (tax-inclusive, same `grandTotal` basis
   * `marginByProduct`/Profitability use, so this table's `netSales` reconciles with the rest of
   * the reports module instead of quietly running on a different, tax-exclusive total), discounts
   * (informational only now — already folded into `grossSales` via `grandTotal`, no longer
   * subtracted a second time), returns (completed only, netted the same way `netCustomerReturnItems`
   * nets everywhere else, bucketed by the return's own date). Every day in the window gets a row
   * even with no activity, so the table always shows a full `days`-row range. */
  async salesDaily(tenantId: string, branchId: string | null, days = 30) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rangeStart = new Date(todayStart);
    rangeStart.setDate(rangeStart.getDate() - (days - 1));

    const [sales, returnItems] = await Promise.all([
      this.prisma.sale.findMany({
        where: {
          tenantId,
          ...(branchId ? { branchId } : {}),
          soldAt: { gte: rangeStart },
          status: { in: ["posted", "partially_refunded"] },
        },
        select: { soldAt: true, grandTotal: true, discountTotal: true },
      }),
      this.netCustomerReturnItems(tenantId, branchId, rangeStart),
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
      cur.grossSales = cur.grossSales.add(s.grandTotal);
      cur.discounts = cur.discounts.add(s.discountTotal);
    }
    for (const ret of returnItems) {
      const key = ret.goodsReturn.createdAt.toISOString().slice(0, 10);
      const cur = byDay.get(key);
      if (!cur) continue;
      cur.returns = cur.returns.add(ret.unitPrice.mul(ret.qty));
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
          // grossSales is grandTotal-based, so discounts are already netted in — subtracting them
          // again here would double-count. Returns are the only thing left to back out.
          netSales: d.grossSales.sub(d.returns).toString(),
        };
      }),
    };
  }

  /** Product-level on-hand quantity — current, or "as of" a past date when `asOf` is given
   *  (summing only ledger entries that had already occurred by then). Branch-scoped when
   *  `branchId` is set, tenant-wide sum otherwise — the same two modes `stockQtyByProductIds`
   *  already offers, unified with `batchQtyAsOf`'s historical-reconstruction technique since Stock
   *  Movement needs both at once (current stock for today's Reorder Alerts/Top Movers, and
   *  N-days-ago stock for the Reorder Alerts KPI's period comparison). */
  private async productQtyAsOf(
    tenantId: string,
    branchId: string | null,
    productIds: string[],
    asOf?: Date,
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const rows = await this.prisma.stockLedger.groupBy({
      by: ["productId"],
      where: {
        tenantId,
        productId: { in: productIds },
        ...(branchId ? { branchId } : {}),
        ...(asOf ? { occurredAt: { lte: asOf } } : {}),
      },
      _sum: { qtyDelta: true },
    });
    return new Map(rows.map((r) => [r.productId, r._sum.qtyDelta ?? 0]));
  }

  /**
   * Inventory-flow dashboard — "how is stock flowing in and out, which products/categories churn
   * fastest, where is flow becoming imbalanced, and what needs replenishment or investigation?"
   * Every figure here comes straight from `StockLedger` (the tenant's one source of truth for a
   * quantity change) classified by `MOVEMENT_DIRECTION`, not re-derived from Sales/Purchasing/
   * Transfers directly — so a new movement type only ever needs one classification update, here.
   *
   * Distinct from Stock Value (capital allocation), Stock Ageing (batch age), Dead Stock
   * (non-moving inventory) and Near Expiry (expiry exposure) — this owns pure inbound/outbound
   * flow and velocity, and never reproduces those reports' own tables.
   *
   * **All-branches transfer netting**: a transfer is one `transfer_out` at the source branch and
   * one `transfer_in` at the destination — real inbound/outbound for either branch alone, but pure
   * relocation of the tenant's own stock, not external flow, when viewed tenant-wide. So under
   * "All branches" with the default "All movement types" filter, both are excluded from
   * `kpis`/`trend`/`categoryMovement` (`internalTransferUnits` reports the excluded volume
   * separately) — but an explicit `movementType: "transfers_in"/"transfers_out"` filter still shows
   * that data directly, since the caller asked for it by name. Under a specific branch, transfers
   * count normally in both directions.
   */
  async stockMovement(
    tenantId: string,
    branchId: string | null,
    days = 30,
    categoryId?: string,
    supplierId?: string,
    movementType?: MovementTypeFilterKey,
    granularityOverride?: MovementGranularity,
  ): Promise<StockMovementResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);

    const empty: StockMovementResponse = {
      days,
      granularity: granularityOverride ?? (days <= 45 ? "daily" : days <= 180 ? "weekly" : "monthly"),
      kpis: {
        inboundUnits: 0,
        prevInboundUnits: 0,
        outboundUnits: 0,
        prevOutboundUnits: 0,
        netMovementValue: 0,
        prevNetMovementValue: 0,
        reorderAlerts: 0,
        prevReorderAlerts: 0,
        inventoryTurnover: null,
        prevInventoryTurnover: null,
        sellThroughRate: null,
        prevSellThroughRate: null,
        avgDaysCover: null,
        prevAvgDaysCover: null,
        stockoutEvents: 0,
        prevStockoutEvents: 0,
      },
      internalTransferUnits: 0,
      trend: [],
      avgInboundPerDay: 0,
      avgOutboundPerDay: 0,
      avgNetPerDay: 0,
      bestNetDay: null,
      categoryMovement: [],
      highestMovementCategories: [],
      insights: [],
      topMovers: [],
      categoryBreakdown: [],
      stockFlowBridge: [],
      movementComposition: [],
    };

    const allowedTypes = movementType ? MOVEMENT_FILTER_TYPES[movementType] : ALL_MOVEMENT_TYPES;

    const [currentLedgerRaw, previousLedgerRaw] = await Promise.all([
      this.prisma.stockLedger.findMany({
        where: { tenantId, ...(branchId ? { branchId } : {}), movementType: { in: allowedTypes }, occurredAt: { gte: since, lte: now } },
        select: { productId: true, movementType: true, qtyDelta: true, occurredAt: true, batchId: true },
      }),
      this.prisma.stockLedger.findMany({
        where: { tenantId, ...(branchId ? { branchId } : {}), movementType: { in: allowedTypes }, occurredAt: { gte: prevSince, lte: prevTo } },
        select: { productId: true, movementType: true, qtyDelta: true, occurredAt: true, batchId: true },
      }),
    ]);
    // ── Category/supplier scoping — resolved over every active product plus anything the ledger
    // touched (a since-deactivated product can still have historical movement), so Reorder Alerts
    // (which scans every active product, not just ones that moved) and the ledger-driven panels
    // share one consistent department/supplier lookup. Deliberately NOT an early-return-on-empty
    // shortcut like Dead Stock/Stock Value use for their batch-driven queries — Reorder Alerts is a
    // point-in-time stock snapshot independent of the Movement Type filter, so it must still run
    // even when that filter happens to match zero ledger rows in both periods.
    const ledgerProductIds = [...new Set([...currentLedgerRaw, ...previousLedgerRaw].map((r) => r.productId))];
    const activeProducts = await this.prisma.product.findMany({
      // RANGED only: a reference record the pharmacy never carried is not a stock-out.
      where: { tenantId, isActive: true, rangeStatus: "RANGED" },
      select: { id: true, sku: true, name: true, reorderLevel: true },
    });
    if (activeProducts.length === 0 && ledgerProductIds.length === 0) return empty;
    const resolutionProductIds = [...new Set([...activeProducts.map((p) => p.id), ...ledgerProductIds])];
    const productBatches = await this.prisma.batch.findMany({
      where: { tenantId, productId: { in: resolutionProductIds } },
      select: { id: true, productId: true },
    });
    const [categoryByProduct, supplierByBatch] = await Promise.all([
      this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, resolutionProductIds),
      this.supplierByBatchIds(tenantId, productBatches.map((b) => b.id)),
    ]);
    const supplierByProduct = new Map<string, { id: string; name: string }>();
    for (const b of productBatches) {
      if (supplierByProduct.has(b.productId)) continue;
      const s = supplierByBatch.get(b.id);
      if (s) supplierByProduct.set(b.productId, s);
    }
    const departmentOf = (productId: string): { id: string | null; name: string } => {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    };
    const productAllowed = (productId: string) => {
      if (categoryId && departmentOf(productId).id !== categoryId) return false;
      if (supplierId && supplierByProduct.get(productId)?.id !== supplierId) return false;
      return true;
    };

    const filteredCurrent = currentLedgerRaw.filter((r) => productAllowed(r.productId));
    const filteredPrevious = previousLedgerRaw.filter((r) => productAllowed(r.productId));
    const directionOf = (mt: StockMovementType) => MOVEMENT_DIRECTION[mt];

    const isAllBranchesDefaultView = branchId === null && !movementType;
    const externalCurrent = isAllBranchesDefaultView ? filteredCurrent.filter((r) => !TRANSFER_TYPES.includes(r.movementType)) : filteredCurrent;
    const externalPrevious = isAllBranchesDefaultView ? filteredPrevious.filter((r) => !TRANSFER_TYPES.includes(r.movementType)) : filteredPrevious;
    const internalTransferUnits = isAllBranchesDefaultView
      ? filteredCurrent.filter((r) => r.movementType === StockMovementType.transfer_out).reduce((s, r) => s + Math.abs(r.qtyDelta), 0)
      : 0;

    function sumUnits(rows: typeof externalCurrent, dir: "in" | "out"): number {
      let total = 0;
      for (const r of rows) if (directionOf(r.movementType) === dir) total += Math.abs(r.qtyDelta);
      return total;
    }
    const inboundUnits = sumUnits(externalCurrent, "in");
    const outboundUnits = sumUnits(externalCurrent, "out");
    const prevInboundUnits = sumUnits(externalPrevious, "in");
    const prevOutboundUnits = sumUnits(externalPrevious, "out");

    // ── Net Movement Value (cost basis only — see StockMovementKpis doc comment) ────────────
    const batchIdsForValue = [...new Set([...externalCurrent, ...externalPrevious].map((r) => r.batchId).filter((id): id is string => !!id))];
    const costByBatch = new Map<string, Prisma.Decimal>();
    if (batchIdsForValue.length > 0) {
      const batchRows = await this.prisma.batch.findMany({ where: { tenantId, id: { in: batchIdsForValue } }, select: { id: true, costPrice: true } });
      for (const b of batchRows) costByBatch.set(b.id, b.costPrice);
    }
    function valueOf(rows: typeof externalCurrent, dir: "in" | "out"): Prisma.Decimal {
      let total = new Prisma.Decimal(0);
      for (const r of rows) {
        if (directionOf(r.movementType) !== dir) continue;
        const cost = r.batchId ? costByBatch.get(r.batchId) : undefined;
        if (!cost) continue;
        total = total.add(cost.mul(Math.abs(r.qtyDelta)));
      }
      return total;
    }
    const netMovementValue = Number(valueOf(externalCurrent, "in").sub(valueOf(externalCurrent, "out")));
    const prevNetMovementValue = Number(valueOf(externalPrevious, "in").sub(valueOf(externalPrevious, "out")));

    // ── Reorder Alerts — canonical `resolveStockStatus`/`reorderLevel` rule (Products/Stock
    // Value's own low-stock definition), scanned over every active product in the category/
    // supplier scope, independent of the Movement Type filter (a stock-level snapshot, not a
    // movement total). `prevReorderAlerts` reconstructs stock as of `since` from the same ledger.
    // Restricted to products this branch (or tenant, under All Branches) has actually ever
    // stocked — `activeProducts` is the tenant's WHOLE catalog (which can run into the thousands
    // for an NMRA-derived catalog), and a product this branch never carries at all isn't something
    // it needs to "reorder"; Stock Value/Dead Stock sidestep this same trap by deriving their
    // product universe from `Batch` rows in the first place, so this mirrors that convention. ──
    const carriedBatches = await this.prisma.batch.findMany({
      where: { tenantId, ...(branchId ? { branchId } : {}), productId: { in: activeProducts.map((p) => p.id) } },
      select: { productId: true },
      distinct: ["productId"],
    });
    const carriedProductIds = new Set(carriedBatches.map((b) => b.productId));
    const scopedActiveProducts = activeProducts.filter((p) => productAllowed(p.id) && carriedProductIds.has(p.id));
    const scopedProductIds = scopedActiveProducts.map((p) => p.id);
    const combinedQtyProductIds = [...new Set([...scopedProductIds, ...ledgerProductIds])];
    const [qtyNowMap, qtyPrevMap] = await Promise.all([
      this.productQtyAsOf(tenantId, branchId, combinedQtyProductIds),
      this.productQtyAsOf(tenantId, branchId, scopedProductIds, since),
    ]);
    const reorderLevelById = new Map(activeProducts.map((p) => [p.id, p.reorderLevel]));
    function countReorderAlerts(qtyMap: Map<string, number>): number {
      let count = 0;
      for (const pid of scopedProductIds) {
        const qty = qtyMap.get(pid) ?? 0;
        const level = reorderLevelById.get(pid) ?? 0;
        if (resolveStockStatus(qty, level) !== "ok") count += 1;
      }
      return count;
    }
    const reorderAlerts = countReorderAlerts(qtyNowMap);
    const prevReorderAlerts = countReorderAlerts(qtyPrevMap);

    // ── Trend (auto granularity: <=45d daily, <=180d weekly, else monthly — keeps the chart from
    // ever rendering more than ~45 bars) ──────────────────────────────────────────────────────
    const granularity: MovementGranularity = granularityOverride ?? (days <= 45 ? "daily" : days <= 180 ? "weekly" : "monthly");
    function bucketKeyOf(date: Date): { key: string; bucketStart: Date } {
      const d = new Date(date);
      d.setHours(0, 0, 0, 0);
      if (granularity === "daily") return { key: d.toISOString().slice(0, 10), bucketStart: d };
      if (granularity === "weekly") {
        const dow = (d.getDay() + 6) % 7; // days since Monday
        const monday = new Date(d);
        monday.setDate(d.getDate() - dow);
        return { key: monday.toISOString().slice(0, 10), bucketStart: monday };
      }
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      return { key: monthStart.toISOString().slice(0, 7), bucketStart: monthStart };
    }
    function formatBucketLabel(d: Date): string {
      return d.toLocaleDateString("en-US", { month: "short", day: granularity === "monthly" ? undefined : "numeric" });
    }
    const bucketOrder: Array<{ key: string; label: string; date: string }> = [];
    const seenBuckets = new Set<string>();
    for (let d = new Date(since); d <= now; d.setDate(d.getDate() + 1)) {
      const { key, bucketStart } = bucketKeyOf(d);
      if (!seenBuckets.has(key)) {
        seenBuckets.add(key);
        bucketOrder.push({ key, label: formatBucketLabel(bucketStart), date: bucketStart.toISOString() });
      }
    }
    const bucketTotals = new Map(bucketOrder.map((b) => [b.key, { inboundUnits: 0, outboundUnits: 0 }]));
    const bucketByDept = new Map(bucketOrder.map((b) => [b.key, new Map<string, number>()]));
    const deptAgg = new Map<string, { id: string | null; name: string; inboundUnits: number; outboundUnits: number }>();
    const prevDeptAgg = new Map<string, { id: string | null; name: string; inboundUnits: number; outboundUnits: number }>();
    const byProduct = new Map<string, { unitsOut: number; unitsIn: number }>();

    for (const r of externalCurrent) {
      const dir = directionOf(r.movementType);
      if (!dir) continue;
      const qty = Math.abs(r.qtyDelta);
      const bucket = bucketTotals.get(bucketKeyOf(r.occurredAt).key);
      if (bucket) (dir === "in" ? (bucket.inboundUnits += qty) : (bucket.outboundUnits += qty));

      const dept = departmentOf(r.productId);
      const deptKey = dept.id ?? "unclassified";
      const deptBucket = bucketByDept.get(bucketKeyOf(r.occurredAt).key);
      if (deptBucket) deptBucket.set(deptKey, (deptBucket.get(deptKey) ?? 0) + (dir === "in" ? qty : -qty));

      const dCur = deptAgg.get(deptKey) ?? { id: dept.id, name: dept.name, inboundUnits: 0, outboundUnits: 0 };
      dir === "in" ? (dCur.inboundUnits += qty) : (dCur.outboundUnits += qty);
      deptAgg.set(deptKey, dCur);

      const pCur = byProduct.get(r.productId) ?? { unitsOut: 0, unitsIn: 0 };
      dir === "in" ? (pCur.unitsIn += qty) : (pCur.unitsOut += qty);
      byProduct.set(r.productId, pCur);
    }
    for (const r of externalPrevious) {
      const dir = directionOf(r.movementType);
      if (!dir) continue;
      const qty = Math.abs(r.qtyDelta);
      const dept = departmentOf(r.productId);
      const deptKey = dept.id ?? "unclassified";
      const pCur = prevDeptAgg.get(deptKey) ?? { id: dept.id, name: dept.name, inboundUnits: 0, outboundUnits: 0 };
      dir === "in" ? (pCur.inboundUnits += qty) : (pCur.outboundUnits += qty);
      prevDeptAgg.set(deptKey, pCur);
    }

    const trend: StockMovementTrendPoint[] = bucketOrder.map((b) => {
      const v = bucketTotals.get(b.key)!;
      return { key: b.key, label: b.label, date: b.date, inboundUnits: v.inboundUnits, outboundUnits: v.outboundUnits, netUnits: v.inboundUnits - v.outboundUnits };
    });
    const avgInboundPerDay = inboundUnits / days;
    const avgOutboundPerDay = outboundUnits / days;
    const avgNetPerDay = (inboundUnits - outboundUnits) / days;

    // Best/most-significant net day is always computed at DAILY resolution (independent of the
    // chosen chart granularity) — a single standout day would otherwise be invisible once a long
    // range rolls it into a weekly/monthly bucket.
    const dailyNet = new Map<string, number>();
    for (const r of externalCurrent) {
      const dir = directionOf(r.movementType);
      if (!dir) continue;
      const dayKey = r.occurredAt.toISOString().slice(0, 10);
      const delta = dir === "in" ? Math.abs(r.qtyDelta) : -Math.abs(r.qtyDelta);
      dailyNet.set(dayKey, (dailyNet.get(dayKey) ?? 0) + delta);
    }
    let bestNetDay: StockMovementResponse["bestNetDay"] = null;
    for (const [dateKey, netUnits] of dailyNet.entries()) {
      if (!bestNetDay || Math.abs(netUnits) > Math.abs(bestNetDay.netUnits)) {
        bestNetDay = { date: dateKey, label: formatBucketLabel(new Date(`${dateKey}T00:00:00`)), netUnits };
      }
    }

    // ── Movement by Commercial Category + Category Breakdown ────────────────────────────────
    const categoryMovement: StockMovementCategoryRow[] = [...deptAgg.values()]
      .map((d) => ({ departmentId: d.id, departmentName: d.name, inboundUnits: d.inboundUnits, outboundUnits: d.outboundUnits, netUnits: d.inboundUnits - d.outboundUnits }))
      .sort((a, b) => b.inboundUnits + b.outboundUnits - (a.inboundUnits + a.outboundUnits));
    const highestMovementCategories = categoryMovement.slice(0, 3).map((d) => ({ departmentId: d.departmentId, departmentName: d.departmentName, totalUnits: d.inboundUnits + d.outboundUnits }));

    const deptQtyOnHand = new Map<string, number>();
    for (const [pid, qty] of qtyNowMap.entries()) {
      const deptKey = departmentOf(pid).id ?? "unclassified";
      deptQtyOnHand.set(deptKey, (deptQtyOnHand.get(deptKey) ?? 0) + Math.max(0, qty));
    }
    const categoryBreakdown: StockMovementCategoryBreakdownRow[] = categoryMovement.map((d) => {
      const deptKey = d.departmentId ?? "unclassified";
      const qtyOnHand = deptQtyOnHand.get(deptKey) ?? 0;
      const velocity = d.outboundUnits / days;
      const avgDaysCover = velocity > 0 ? Math.round(qtyOnHand / velocity) : null;
      const trendSeries = bucketOrder.map((b) => bucketByDept.get(b.key)?.get(deptKey) ?? 0);
      return { ...d, avgDaysCover, trend: trendSeries };
    });

    // ── Stock Flow Bridge, Movement Composition, and the turnover/sell-through/cover/stockout
    // KPIs — all reuse `qtyPrevMap`/`qtyNowMap` (already fetched for Reorder Alerts) and
    // `externalCurrent`/`externalPrevious` (already fetched for the headline KPIs/trend), so none
    // of this needs a new query beyond one more `productQtyAsOf` call for the previous period's
    // own opening snapshot. Restricted to `scopedProductIds` (the same "actually carried" universe
    // Reorder Alerts uses) so Opening/Closing units and the bucketed deltas share one consistent
    // product set — a stray ledger row from a product outside that set would otherwise silently
    // break the bridge's arithmetic. ──────────────────────────────────────────────────────────
    function countStockoutTransitions(rows: typeof externalCurrent, openingQtyMap: Map<string, number>, productIds: string[]): number {
      const byProduct = new Map<string, typeof rows>();
      for (const r of rows) {
        if (!byProduct.has(r.productId)) byProduct.set(r.productId, []);
        byProduct.get(r.productId)!.push(r);
      }
      let events = 0;
      for (const pid of productIds) {
        const productRows = byProduct.get(pid);
        if (!productRows || productRows.length === 0) continue;
        const sorted = [...productRows].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
        let running = openingQtyMap.get(pid) ?? 0;
        let wasInStock = running > 0;
        for (const r of sorted) {
          running += r.qtyDelta;
          const isInStock = running > 0;
          if (wasInStock && !isInStock) events++;
          wasInStock = isInStock;
        }
      }
      return events;
    }

    const scopedSet = new Set(scopedProductIds);
    const bridgeRows = externalCurrent.filter((r) => scopedSet.has(r.productId));
    const prevBridgeRows = externalPrevious.filter((r) => scopedSet.has(r.productId));
    function unitsOfTypes(rows: typeof externalCurrent, types: StockMovementType[]): number {
      let total = 0;
      for (const r of rows) if (types.includes(r.movementType)) total += Math.abs(r.qtyDelta);
      return total;
    }

    const qtyPrevPrevMap = await this.productQtyAsOf(tenantId, branchId, scopedProductIds, prevSince);
    const sumQty = (map: Map<string, number>) => scopedProductIds.reduce((s, pid) => s + Math.max(0, map.get(pid) ?? 0), 0);
    const openingUnits = sumQty(qtyPrevMap);
    const closingUnits = sumQty(qtyNowMap);
    const prevOpeningUnits = sumQty(qtyPrevPrevMap);
    const prevClosingUnits = openingUnits; // qty "as of `since`" is also qty "as of the previous period's end"

    const purchasesIn = unitsOfTypes(bridgeRows, [StockMovementType.purchase_in]);
    const returnsIn = unitsOfTypes(bridgeRows, [StockMovementType.customer_return_in, StockMovementType.sale_void_in, StockMovementType.sale_refund_in]);
    const transfersIn = unitsOfTypes(bridgeRows, [StockMovementType.transfer_in]);
    const adjIn = unitsOfTypes(bridgeRows, [StockMovementType.adjustment_in, StockMovementType.stocktake_in]);
    const salesOut = unitsOfTypes(bridgeRows, [StockMovementType.sale_out]);
    const transfersOut = unitsOfTypes(bridgeRows, [StockMovementType.transfer_out]);
    const supplierReturnsOut = unitsOfTypes(bridgeRows, [StockMovementType.supplier_return_out]);
    const adjOut = unitsOfTypes(bridgeRows, [StockMovementType.adjustment_out, StockMovementType.stocktake_out]);
    const adjustmentsNet = adjIn - adjOut;

    const accountedClose = openingUnits + purchasesIn + returnsIn + transfersIn - salesOut - transfersOut - supplierReturnsOut + adjustmentsNet;
    // Expected to be ~0 in the overwhelming majority of cases — see the doc comment above for the
    // one known source of a genuine (small) residual: an in-flight reserve/quarantine hold that
    // straddles the window boundary, which `batchQtyAsOf`-style ground truth sees but the bucketed
    // deltas above (reserve/quarantine types are always excluded from `ALL_MOVEMENT_TYPES`) don't.
    const unallocated = closingUnits - accountedClose;

    const stockFlowBridge: StockFlowBridgeStep[] = [
      { key: "opening", label: "Opening Stock", kind: "total", value: openingUnits },
      ...(purchasesIn > 0 ? [{ key: "purchases", label: "Purchases", kind: "addition" as const, value: purchasesIn }] : []),
      ...(returnsIn > 0 ? [{ key: "returnsIn", label: "Returns In", kind: "addition" as const, value: returnsIn }] : []),
      ...(transfersIn > 0 ? [{ key: "transfersIn", label: "Transfers In", kind: "addition" as const, value: transfersIn }] : []),
      ...(salesOut > 0 ? [{ key: "sales", label: "Sales", kind: "deduction" as const, value: salesOut }] : []),
      ...(transfersOut > 0 ? [{ key: "transfersOut", label: "Transfers Out", kind: "deduction" as const, value: transfersOut }] : []),
      ...(supplierReturnsOut > 0 ? [{ key: "supplierReturns", label: "Supplier Returns", kind: "deduction" as const, value: supplierReturnsOut }] : []),
      ...(adjustmentsNet !== 0 ? [{ key: "adjustments", label: "Adjustments", kind: (adjustmentsNet >= 0 ? "addition" : "deduction") as "addition" | "deduction", value: Math.abs(adjustmentsNet) }] : []),
      ...(Math.abs(unallocated) >= 1 ? [{ key: "unallocated", label: "Unallocated", kind: (unallocated >= 0 ? "addition" : "deduction") as "addition" | "deduction", value: Math.abs(unallocated) }] : []),
      { key: "closing", label: "Closing Stock", kind: "total", value: closingUnits },
    ];

    const movementComposition: StockMovementCompositionRow[] = (
      [
        { key: "purchases", label: "Purchases", direction: "in" as const, units: purchasesIn },
        { key: "transfersIn", label: "Transfers In", direction: "in" as const, units: transfersIn },
        { key: "returnsIn", label: "Customer Returns", direction: "in" as const, units: returnsIn },
        { key: "adjustmentsIn", label: "Adjustments", direction: "in" as const, units: adjIn },
        { key: "sales", label: "Sales", direction: "out" as const, units: salesOut },
        { key: "transfersOut", label: "Transfers Out", direction: "out" as const, units: transfersOut },
        { key: "supplierReturns", label: "Supplier Returns", direction: "out" as const, units: supplierReturnsOut },
        { key: "adjustmentsOut", label: "Adjustments", direction: "out" as const, units: adjOut },
      ] satisfies StockMovementCompositionRow[]
    ).filter((r) => r.units > 0);

    const sellThroughDenominator = openingUnits + purchasesIn + returnsIn + transfersIn + adjIn;
    const sellThroughRate = sellThroughDenominator > 0 ? (salesOut / sellThroughDenominator) * 100 : null;
    const avgUnitsOnHand = (openingUnits + closingUnits) / 2;
    const periodTurnover = avgUnitsOnHand > 0 ? salesOut / avgUnitsOnHand : null;
    const inventoryTurnover = periodTurnover != null ? periodTurnover * (365 / days) : null;
    const avgDaysCover = salesOut > 0 ? closingUnits / (salesOut / days) : null;
    const stockoutEvents = countStockoutTransitions(bridgeRows, qtyPrevMap, scopedProductIds);

    const prevPurchasesIn = unitsOfTypes(prevBridgeRows, [StockMovementType.purchase_in]);
    const prevReturnsIn = unitsOfTypes(prevBridgeRows, [StockMovementType.customer_return_in, StockMovementType.sale_void_in, StockMovementType.sale_refund_in]);
    const prevTransfersIn = unitsOfTypes(prevBridgeRows, [StockMovementType.transfer_in]);
    const prevAdjIn = unitsOfTypes(prevBridgeRows, [StockMovementType.adjustment_in, StockMovementType.stocktake_in]);
    const prevSalesOut = unitsOfTypes(prevBridgeRows, [StockMovementType.sale_out]);
    const prevSellThroughDenominator = prevOpeningUnits + prevPurchasesIn + prevReturnsIn + prevTransfersIn + prevAdjIn;
    const prevSellThroughRate = prevSellThroughDenominator > 0 ? (prevSalesOut / prevSellThroughDenominator) * 100 : null;
    const prevAvgUnitsOnHand = (prevOpeningUnits + prevClosingUnits) / 2;
    const prevPeriodTurnover = prevAvgUnitsOnHand > 0 ? prevSalesOut / prevAvgUnitsOnHand : null;
    const prevInventoryTurnover = prevPeriodTurnover != null ? prevPeriodTurnover * (365 / days) : null;
    const prevAvgDaysCover = prevSalesOut > 0 ? prevClosingUnits / (prevSalesOut / days) : null;
    const prevStockoutEvents = countStockoutTransitions(prevBridgeRows, qtyPrevPrevMap, scopedProductIds);

    // ── Top Movers — ranked by total movement (units out + in) by default; "By Net Change" (the
    // reference's own label) doesn't reconcile against its own shown rows as a strict sort, so
    // "most active product" is the honest default here, with Net Change/Outbound/Value available
    // as frontend-side re-sorts of this same array (no re-fetch needed). ──────────────────────
    const productById = new Map(activeProducts.map((p) => [p.id, p]));
    const topMovers: StockMovementTopMoverItem[] = [...byProduct.entries()]
      .map(([productId, agg]) => {
        const product = productById.get(productId);
        const dept = departmentOf(productId);
        const qtyOnHand = Math.max(0, qtyNowMap.get(productId) ?? 0);
        const reorderLevel = product?.reorderLevel ?? 0;
        const netChange = agg.unitsIn - agg.unitsOut;
        const avgDailyUnitsOut = agg.unitsOut / days;
        const daysOfCover = avgDailyUnitsOut > 0 ? qtyOnHand / avgDailyUnitsOut : null;
        const status = resolveStockStatus(qtyOnHand, reorderLevel);
        const reorderStatus: MovementReorderStatus =
          status !== "ok"
            ? "reorder"
            : daysOfCover != null && daysOfCover > MOVEMENT_OVERSTOCK_COVER_DAYS
              ? "overstocking"
              : netChange < 0 && daysOfCover != null && daysOfCover < MOVEMENT_WATCH_COVER_DAYS
                ? "watch"
                : "healthy";
        return {
          productId,
          departmentId: dept.id,
          departmentName: dept.name,
          unitsOut: agg.unitsOut,
          unitsIn: agg.unitsIn,
          netChange,
          avgDailyUnitsOut,
          qtyOnHand,
          reorderLevel,
          reorderStatus,
          product: product ? { id: product.id, sku: product.sku, name: product.name } : { id: productId },
        };
      })
      .sort((a, b) => b.unitsOut + b.unitsIn - (a.unitsOut + a.unitsIn));

    // ── Movement Insights — four deterministic, real-data signals (see each block's comment for
    // exactly what it measures and why); a block is omitted entirely rather than shown empty/zero
    // when its own materiality threshold isn't met. ─────────────────────────────────────────────
    const insights: StockMovementInsight[] = [];

    const topDept = categoryMovement[0];
    if (topDept) {
      const deptKey = topDept.departmentId ?? "unclassified";
      const prevTotal = prevDeptAgg.get(deptKey);
      const prevMovement = prevTotal ? prevTotal.inboundUnits + prevTotal.outboundUnits : 0;
      const curMovement = topDept.inboundUnits + topDept.outboundUnits;
      const changePct = prevMovement > 0 ? ((curMovement - prevMovement) / prevMovement) * 100 : null;
      insights.push({
        key: "fastMovingCategory",
        title: "Fast-moving category",
        description: `${topDept.departmentName} moved ${curMovement.toLocaleString("en-IN")} units${changePct != null ? `, ${Math.abs(changePct).toFixed(1)}% ${changePct >= 0 ? "above" : "below"} the previous period.` : "."}`,
        changePct,
        countLabel: `${curMovement.toLocaleString("en-IN")} units`,
      });
    }

    let replenishmentCount = 0;
    for (const [pid, agg] of byProduct.entries()) {
      if (agg.unitsOut <= 0) continue;
      const qty = Math.max(0, qtyNowMap.get(pid) ?? 0);
      const velocity = agg.unitsOut / days;
      const cover = velocity > 0 ? qty / velocity : null;
      if (cover != null && cover < MOVEMENT_REPLENISHMENT_INSIGHT_COVER_DAYS) replenishmentCount += 1;
    }
    if (replenishmentCount > 0) {
      insights.push({
        key: "replenishmentWatch",
        title: "Replenishment watch",
        description: `${replenishmentCount} SKU${replenishmentCount === 1 ? "" : "s"} now ${replenishmentCount === 1 ? "has" : "have"} < ${MOVEMENT_REPLENISHMENT_INSIGHT_COVER_DAYS} days of cover after recent outbound movement.`,
        changePct: null,
        countLabel: `${replenishmentCount} SKU${replenishmentCount === 1 ? "" : "s"}`,
      });
    }

    function transferAdjustShare(rows: typeof filteredCurrent): number {
      let matched = 0;
      let total = 0;
      for (const r of rows) {
        if (!directionOf(r.movementType)) continue;
        const qty = Math.abs(r.qtyDelta);
        total += qty;
        if (TRANSFER_OR_ADJUSTMENT_TYPES.has(r.movementType)) matched += qty;
      }
      return total > 0 ? (matched / total) * 100 : 0;
    }
    const transferAdjustSharePct = transferAdjustShare(filteredCurrent);
    if (transferAdjustSharePct >= MOVEMENT_TRANSFER_ADJUSTMENT_SHARE_THRESHOLD_PCT) {
      const prevSharePct = transferAdjustShare(filteredPrevious);
      const changePct = prevSharePct > 0 ? transferAdjustSharePct - prevSharePct : null;
      insights.push({
        key: "highTransfersAdjustments",
        title: "High transfers / adjustments",
        description: `Transfers, adjustments and stocktakes account for ${transferAdjustSharePct.toFixed(1)}% of movement.`,
        changePct,
        countLabel: `${transferAdjustSharePct.toFixed(1)}%`,
      });
    }

    const stocktakeOutByProduct = new Map<string, number>();
    for (const r of filteredCurrent) {
      if (r.movementType !== StockMovementType.stocktake_out) continue;
      stocktakeOutByProduct.set(r.productId, (stocktakeOutByProduct.get(r.productId) ?? 0) + Math.abs(r.qtyDelta));
    }
    let shrinkageCount = 0;
    for (const [pid, variance] of stocktakeOutByProduct.entries()) {
      const qty = Math.max(0, qtyNowMap.get(pid) ?? 0);
      // Approximates "expected quantity at count time" as current qty + what the count removed —
      // exact only when no further movement happened since; documented as a simplification since
      // this report doesn't join back to the originating StocktakeLine for the true expected value.
      const expected = qty + variance;
      const variancePct = expected > 0 ? (variance / expected) * 100 : 0;
      if (variancePct > MOVEMENT_SHRINKAGE_VARIANCE_PCT_THRESHOLD) shrinkageCount += 1;
    }
    if (shrinkageCount > 0) {
      insights.push({
        key: "shrinkageVariance",
        title: "Shrinkage / variance signal",
        description: `${shrinkageCount} SKU${shrinkageCount === 1 ? "" : "s"} show negative stocktake variance greater than ${MOVEMENT_SHRINKAGE_VARIANCE_PCT_THRESHOLD}%.`,
        changePct: null,
        countLabel: `${shrinkageCount} SKU${shrinkageCount === 1 ? "" : "s"}`,
      });
    }

    return {
      days,
      granularity,
      kpis: {
        inboundUnits,
        prevInboundUnits,
        outboundUnits,
        prevOutboundUnits,
        netMovementValue,
        prevNetMovementValue,
        reorderAlerts,
        prevReorderAlerts,
        inventoryTurnover,
        prevInventoryTurnover,
        sellThroughRate,
        prevSellThroughRate,
        avgDaysCover,
        prevAvgDaysCover,
        stockoutEvents,
        prevStockoutEvents,
      },
      internalTransferUnits,
      trend,
      avgInboundPerDay,
      avgOutboundPerDay,
      avgNetPerDay,
      bestNetDay,
      categoryMovement,
      highestMovementCategories,
      insights,
      topMovers,
      categoryBreakdown,
      stockFlowBridge,
      movementComposition,
    };
  }

  /**
   * How effectively are branches using transfers to balance inventory? Inherently tenant-wide (a
   * transfer only means something in a multi-branch context) — returns the empty shape outright
   * for a single-branch tenant rather than a page of zeros. `days` scopes which transfer records
   * count (by `createdAt`); the Transfer Opportunities panel is independent of that window since
   * it reflects *current* stock/velocity, not period activity.
   */
  async transfersReport(tenantId: string, days = 30): Promise<TransfersReportResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);

    const branches = await this.prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } });
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const isMultiBranch = branches.length > 1;

    const empty: TransfersReportResponse = {
      days,
      isMultiBranch,
      kpis: { transferCount: 0, prevTransferCount: 0, valueMoved: 0, prevValueMoved: 0, avgCompletionHours: null, prevAvgCompletionHours: null, successRatePct: null, prevSuccessRatePct: null },
      branchFlow: [],
      opportunities: [],
      activity: [],
      insights: [],
    };
    if (!isMultiBranch) return empty;

    const transferSelect = {
      id: true,
      transferNumber: true,
      fromBranchId: true,
      toBranchId: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      items: { select: { productId: true, qty: true, receivedQty: true, batchId: true } },
    } as const;
    const [currentTransfers, previousTransfers] = await Promise.all([
      this.prisma.transfer.findMany({ where: { tenantId, createdAt: { gte: since, lte: now } }, select: transferSelect }),
      this.prisma.transfer.findMany({ where: { tenantId, createdAt: { gte: prevSince, lte: prevTo } }, select: transferSelect }),
    ]);

    const batchIds = [
      ...new Set([...currentTransfers, ...previousTransfers].flatMap((t) => t.items.map((i) => i.batchId).filter((id): id is string => !!id))),
    ];
    const batchRows = batchIds.length > 0 ? await this.prisma.batch.findMany({ where: { tenantId, id: { in: batchIds } }, select: { id: true, costPrice: true } }) : [];
    const costByBatch = new Map(batchRows.map((b) => [b.id, b.costPrice]));

    function valueMovedOf(transfers: typeof currentTransfers): number {
      let total = new Prisma.Decimal(0);
      for (const t of transfers) {
        for (const item of t.items) {
          if (!item.batchId) continue;
          const cost = costByBatch.get(item.batchId);
          if (!cost) continue;
          total = total.add(cost.mul(item.receivedQty));
        }
      }
      return Number(total);
    }
    function avgCompletionHoursOf(transfers: typeof currentTransfers): number | null {
      const received = transfers.filter((t) => t.status === "received");
      if (received.length === 0) return null;
      const totalHours = received.reduce((s, t) => s + (t.updatedAt.getTime() - t.createdAt.getTime()) / 3_600_000, 0);
      return totalHours / received.length;
    }
    function successRatePctOf(transfers: typeof currentTransfers): number | null {
      const terminal = transfers.filter((t) => t.status === "received" || t.status === "rejected" || t.status === "cancelled");
      if (terminal.length === 0) return null;
      return (terminal.filter((t) => t.status === "received").length / terminal.length) * 100;
    }

    const kpis: TransfersKpis = {
      transferCount: currentTransfers.length,
      prevTransferCount: previousTransfers.length,
      valueMoved: valueMovedOf(currentTransfers),
      prevValueMoved: valueMovedOf(previousTransfers),
      avgCompletionHours: avgCompletionHoursOf(currentTransfers),
      prevAvgCompletionHours: avgCompletionHoursOf(previousTransfers),
      successRatePct: successRatePctOf(currentTransfers),
      prevSuccessRatePct: successRatePctOf(previousTransfers),
    };

    // ── Branch Transfer Flow ────────────────────────────────────────────────────────────────
    const flowMap = new Map<string, { fromBranchId: string; toBranchId: string; transferCount: number; units: number; value: number }>();
    for (const t of currentTransfers) {
      const key = `${t.fromBranchId}::${t.toBranchId}`;
      const cur = flowMap.get(key) ?? { fromBranchId: t.fromBranchId, toBranchId: t.toBranchId, transferCount: 0, units: 0, value: 0 };
      cur.transferCount += 1;
      for (const item of t.items) {
        cur.units += item.receivedQty;
        if (item.batchId) {
          const cost = costByBatch.get(item.batchId);
          if (cost) cur.value += Number(cost.mul(item.receivedQty));
        }
      }
      flowMap.set(key, cur);
    }
    const branchFlow: TransferFlowRow[] = [...flowMap.values()]
      .map((f) => ({ ...f, fromBranchName: branchNameById.get(f.fromBranchId) ?? "Unknown", toBranchName: branchNameById.get(f.toBranchId) ?? "Unknown" }))
      .sort((a, b) => b.units - a.units);

    // ── Transfer Activity ───────────────────────────────────────────────────────────────────
    const activity: TransferActivityRow[] = currentTransfers
      .map((t) => {
        const units = t.items.reduce((s, i) => s + i.receivedQty, 0);
        const value = t.items.reduce((s, i) => {
          if (!i.batchId) return s;
          const cost = costByBatch.get(i.batchId);
          return cost ? s + Number(cost.mul(i.receivedQty)) : s;
        }, 0);
        return {
          id: t.id,
          transferNumber: t.transferNumber,
          fromBranchId: t.fromBranchId,
          fromBranchName: branchNameById.get(t.fromBranchId) ?? "Unknown",
          toBranchId: t.toBranchId,
          toBranchName: branchNameById.get(t.toBranchId) ?? "Unknown",
          status: t.status,
          itemCount: t.items.length,
          units,
          value,
          createdAt: t.createdAt.toISOString(),
          completedAt: t.status === "received" ? t.updatedAt.toISOString() : null,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // ── Insights ────────────────────────────────────────────────────────────────────────────
    const insights: TransfersInsight[] = [];
    const loopMap = new Map<string, number>();
    for (const t of currentTransfers) {
      for (const item of t.items) {
        const key = `${t.fromBranchId}::${t.toBranchId}::${item.productId}`;
        loopMap.set(key, (loopMap.get(key) ?? 0) + 1);
      }
    }
    const repeatLoops = [...loopMap.values()].filter((c) => c >= 2).length;
    if (repeatLoops > 0) {
      insights.push({
        key: "repeatLoops",
        title: "Repeat transfer loops",
        description: `${repeatLoops} product/branch-pair${repeatLoops === 1 ? "" : "s"} were transferred more than once this period — a sign of a recurring imbalance rather than a one-off.`,
        countLabel: `${repeatLoops} loop${repeatLoops === 1 ? "" : "s"}`,
      });
    }
    const busiestLane = branchFlow[0];
    if (busiestLane) {
      insights.push({
        key: "busiestLane",
        title: "Busiest transfer lane",
        description: `${busiestLane.fromBranchName} → ${busiestLane.toBranchName} accounts for ${busiestLane.transferCount} transfer${busiestLane.transferCount === 1 ? "" : "s"} this period.`,
        countLabel: `${busiestLane.units.toLocaleString("en-IN")} units`,
      });
    }
    if (kpis.successRatePct != null && kpis.successRatePct < 90) {
      const failed = currentTransfers.filter((t) => t.status === "rejected" || t.status === "cancelled").length;
      insights.push({
        key: "lowSuccessRate",
        title: "Rejected / cancelled transfers",
        description: `${failed} transfer${failed === 1 ? "" : "s"} were rejected or cancelled this period (${(100 - kpis.successRatePct).toFixed(0)}% of concluded transfers).`,
        countLabel: `${failed} transfer${failed === 1 ? "" : "s"}`,
      });
    }

    // ── Transfer Opportunities — live cross-branch days-of-cover comparison, independent of
    // `days`'s transfer-activity window ────────────────────────────────────────────────────
    const allBatches = await this.prisma.batch.findMany({ where: { tenantId }, select: { id: true, productId: true, branchId: true, costPrice: true } });
    const opportunityProductIds = [...new Set(allBatches.map((b) => b.productId))];
    const opportunities: TransferOpportunity[] = [];
    if (opportunityProductIds.length > 0) {
      const products = await this.prisma.product.findMany({ where: { tenantId, id: { in: opportunityProductIds } }, select: { id: true, sku: true, name: true, reorderLevel: true } });
      const productById = new Map(products.map((p) => [p.id, p]));
      const costByProductBranch = new Map<string, Prisma.Decimal>();
      for (const b of allBatches) {
        const key = `${b.productId}::${b.branchId}`;
        if (!costByProductBranch.has(key)) costByProductBranch.set(key, b.costPrice);
      }

      const perBranch = await Promise.all(
        branches.map(async (b) => ({
          branch: b,
          qtyMap: await this.productQtyAsOf(tenantId, b.id, opportunityProductIds),
          velocityMap: await this.avgDailySalesByProduct(tenantId, b.id, opportunityProductIds, now),
        })),
      );

      for (const productId of opportunityProductIds) {
        const product = productById.get(productId);
        const reorderLevel = product?.reorderLevel ?? 0;
        let source: { branch: { id: string; name: string }; daysOfCover: number; qty: number } | null = null;
        let target: { branch: { id: string; name: string }; daysOfCover: number | null; velocity: number } | null = null;
        for (const { branch, qtyMap, velocityMap } of perBranch) {
          const qty = Math.max(0, qtyMap.get(productId) ?? 0);
          const velocity = velocityMap.get(productId) ?? 0;
          const daysOfCover = velocity > 0 ? qty / velocity : null;
          if (qty > 0 && daysOfCover != null && daysOfCover >= TRANSFER_SOURCE_MIN_COVER_DAYS && (!source || daysOfCover > source.daysOfCover)) {
            source = { branch, daysOfCover, qty };
          }
          const isUrgent = (daysOfCover != null && daysOfCover <= TRANSFER_TARGET_MAX_COVER_DAYS) || resolveStockStatus(qty, reorderLevel) !== "ok";
          if (isUrgent && (!target || (daysOfCover ?? -1) < (target.daysOfCover ?? Infinity))) {
            target = { branch, daysOfCover, velocity };
          }
        }
        if (!source || !target || source.branch.id === target.branch.id) continue;
        const suggestedUnits = Math.min(source.qty, Math.max(1, Math.round(target.velocity * TRANSFER_SUGGESTED_COVER_DAYS)));
        if (suggestedUnits <= 0) continue;
        const cost = costByProductBranch.get(`${productId}::${source.branch.id}`);
        opportunities.push({
          productId,
          product: product ? { id: product.id, sku: product.sku, name: product.name } : { id: productId },
          fromBranchId: source.branch.id,
          fromBranchName: source.branch.name,
          fromDaysCover: Math.round(source.daysOfCover),
          toBranchId: target.branch.id,
          toBranchName: target.branch.name,
          toDaysCover: target.daysOfCover == null ? null : Math.round(target.daysOfCover),
          suggestedUnits,
          estimatedValue: cost ? Number(cost.mul(suggestedUnits)) : 0,
        });
      }
      opportunities.sort((a, b) => b.estimatedValue - a.estimatedValue);
    }

    return { days, isMultiBranch, kpis, branchFlow, opportunities: opportunities.slice(0, 10), activity, insights };
  }

  /**
   * How accurate is our recorded inventory, and where are discrepancies concentrated? Branch-
   * scoped like almost every other report (`branchId` null means "All branches") — unlike
   * Transfers, a single branch's own stocktake accuracy is already meaningful on its own, so this
   * doesn't force a tenant-wide view. `days` scopes which stocktake was *created* within, for the
   * headline KPIs/trend/breakdowns; the repeated-discrepancy insight looks back further
   * (`STOCKTAKE_REPEAT_LOOKBACK_DAYS`) since a real recurring pattern spans multiple stocktake
   * sessions, not just the ones inside a short reporting window. The Variance by Branch panel
   * only makes sense under "All branches" with more than one branch to compare — otherwise the
   * page falls back to Variance by Category (see `isMultiBranch`, despite the tenant possibly
   * having several branches — under a specific-branch scope there's only ever one to show).
   */
  async stocktakesReport(tenantId: string, branchId: string | null, days = 30): Promise<StocktakesReportResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);
    const lookbackSince = new Date(now);
    lookbackSince.setDate(lookbackSince.getDate() - STOCKTAKE_REPEAT_LOOKBACK_DAYS);

    const branches = await this.prisma.branch.findMany({ where: { tenantId, isActive: true }, select: { id: true, name: true } });
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    const isMultiBranch = branchId === null && branches.length > 1;

    const empty: StocktakesReportResponse = {
      days,
      isMultiBranch,
      kpis: { accuracyPct: null, prevAccuracyPct: null, varianceValue: 0, prevVarianceValue: 0, shrinkageValue: 0, prevShrinkageValue: 0, completedCount: 0, plannedCount: 0 },
      accuracyTrend: [],
      varianceByBranch: [],
      varianceByCategory: [],
      insights: [],
      discrepancies: [],
    };

    const lineSelect = {
      id: true,
      productId: true,
      batchId: true,
      systemQty: true,
      countedQty: true,
      varianceQty: true,
      status: true,
      countedAt: true,
      stocktake: { select: { id: true, stocktakeNumber: true, branchId: true, createdAt: true } },
    } as const;

    const [currentStocktakes, previousStocktakes, currentLines, previousLines, lookbackNegativeLines] = await Promise.all([
      this.prisma.stocktake.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: since, lte: now } }, select: { id: true, status: true } }),
      this.prisma.stocktake.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: prevSince, lte: prevTo } }, select: { id: true, status: true } }),
      this.prisma.stocktakeLine.findMany({
        where: { tenantId, countedQty: { not: null }, stocktake: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: since, lte: now } } },
        select: lineSelect,
      }),
      this.prisma.stocktakeLine.findMany({
        where: { tenantId, countedQty: { not: null }, stocktake: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: prevSince, lte: prevTo } } },
        select: lineSelect,
      }),
      this.prisma.stocktakeLine.findMany({
        where: { tenantId, varianceQty: { lt: 0 }, stocktake: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: lookbackSince, lte: now } } },
        select: { productId: true, stocktake: { select: { id: true, branchId: true } } },
      }),
    ]);

    if (currentStocktakes.length === 0 && currentLines.length === 0) return empty;

    const batchIds = [...new Set([...currentLines, ...previousLines].map((l) => l.batchId))];
    const batchRows = batchIds.length > 0 ? await this.prisma.batch.findMany({ where: { tenantId, id: { in: batchIds } }, select: { id: true, costPrice: true } }) : [];
    const costByBatch = new Map(batchRows.map((b) => [b.id, b.costPrice]));

    const productIds = [...new Set(currentLines.map((l) => l.productId))];
    const categoryByProduct = await this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, productIds);
    const departmentOf = (productId: string): { id: string | null; name: string } => {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    };
    const products = productIds.length > 0 ? await this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, sku: true, name: true } }) : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    function valueOfLine(l: (typeof currentLines)[number]): number {
      const cost = costByBatch.get(l.batchId);
      return cost ? Number(cost.mul(Math.abs(l.varianceQty ?? 0))) : 0;
    }
    function kpisOf(lines: typeof currentLines) {
      const accuracyPct = lines.length > 0 ? (lines.filter((l) => (l.varianceQty ?? 0) === 0).length / lines.length) * 100 : null;
      const varianceValue = lines.reduce((s, l) => s + valueOfLine(l), 0);
      const shrinkageValue = lines.filter((l) => (l.varianceQty ?? 0) < 0).reduce((s, l) => s + valueOfLine(l), 0);
      return { accuracyPct, varianceValue, shrinkageValue };
    }
    const currentKpis = kpisOf(currentLines);
    const previousKpis = kpisOf(previousLines);

    const kpis: StocktakesKpis = {
      accuracyPct: currentKpis.accuracyPct,
      prevAccuracyPct: previousKpis.accuracyPct,
      varianceValue: currentKpis.varianceValue,
      prevVarianceValue: previousKpis.varianceValue,
      shrinkageValue: currentKpis.shrinkageValue,
      prevShrinkageValue: previousKpis.shrinkageValue,
      completedCount: currentStocktakes.filter((s) => s.status === "completed").length,
      plannedCount: currentStocktakes.length,
    };

    // ── Accuracy Trend — weekly buckets across the selected window ─────────────────────────
    const bucketMs = 7 * 86_400_000;
    const bucketOf = (d: Date) => Math.floor((now.getTime() - d.getTime()) / bucketMs);
    const numBuckets = Math.max(1, Math.ceil(days / 7));
    const bucketLines: (typeof currentLines)[] = Array.from({ length: numBuckets }, () => []);
    for (const l of currentLines) {
      const countedAt = l.countedAt ?? l.stocktake.createdAt;
      const idx = Math.min(numBuckets - 1, Math.max(0, bucketOf(countedAt)));
      bucketLines[numBuckets - 1 - idx]!.push(l);
    }
    const accuracyTrend: StocktakeAccuracyTrendPoint[] = bucketLines.map((lines, i) => {
      const bucketStart = new Date(now.getTime() - (numBuckets - i) * bucketMs);
      return {
        key: bucketStart.toISOString().slice(0, 10),
        label: bucketStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        accuracyPct: lines.length > 0 ? kpisOf(lines).accuracyPct : null,
      };
    });

    // ── Variance by Branch (multi-branch) / by Category (single-branch fallback) ────────────
    function rollup(keyOf: (l: (typeof currentLines)[number]) => string, nameOf: (key: string) => string): StocktakeVarianceRow[] {
      const map = new Map<string, { value: number; count: number }>();
      for (const l of currentLines) {
        const key = keyOf(l);
        const cur = map.get(key) ?? { value: 0, count: 0 };
        cur.value += valueOfLine(l);
        cur.count += 1;
        map.set(key, cur);
      }
      const total = [...map.values()].reduce((s, v) => s + v.value, 0);
      return [...map.entries()]
        .map(([key, v]) => ({ key, label: nameOf(key), varianceValue: v.value, variancePct: total > 0 ? (v.value / total) * 100 : 0, linesCounted: v.count }))
        .sort((a, b) => b.varianceValue - a.varianceValue);
    }
    const varianceByBranch = isMultiBranch ? rollup((l) => l.stocktake.branchId, (key) => branchNameById.get(key) ?? "Unknown") : [];
    const varianceByCategory = rollup(
      (l) => departmentOf(l.productId).id ?? "unclassified",
      (key) => (key === "unclassified" ? "Unclassified" : (departmentOf(currentLines.find((l) => (departmentOf(l.productId).id ?? "unclassified") === key)!.productId).name)),
    );

    // ── Insights ────────────────────────────────────────────────────────────────────────────
    const insights: StocktakesInsight[] = [];
    const repeatMap = new Map<string, Set<string>>();
    for (const l of lookbackNegativeLines) {
      const key = `${l.productId}::${l.stocktake.branchId}`;
      const set = repeatMap.get(key) ?? new Set<string>();
      set.add(l.stocktake.id);
      repeatMap.set(key, set);
    }
    const repeatPairs = [...repeatMap.entries()].filter(([, ids]) => ids.size >= STOCKTAKE_REPEAT_DISCREPANCY_MIN_COUNT);
    if (repeatPairs.length > 0) {
      insights.push({
        key: "repeatedDiscrepancies",
        title: "Repeated discrepancies",
        description: `${repeatPairs.length} product/branch pair${repeatPairs.length === 1 ? "" : "s"} came up short in ${STOCKTAKE_REPEAT_DISCREPANCY_MIN_COUNT}+ stocktakes over the last ${STOCKTAKE_REPEAT_LOOKBACK_DAYS} days — a pattern, not a one-off count error.`,
        countLabel: `${repeatPairs.length} pair${repeatPairs.length === 1 ? "" : "s"}`,
      });
    }
    const topVarianceCategory = varianceByCategory[0];
    if (topVarianceCategory && varianceByCategory.length > 1) {
      insights.push({
        key: "categoryConcentration",
        title: "Variance concentration",
        description: `${topVarianceCategory.label} accounts for ${topVarianceCategory.variancePct.toFixed(0)}% of this period's total variance value.`,
        countLabel: `${topVarianceCategory.variancePct.toFixed(0)}%`,
      });
    }
    if (isMultiBranch && varianceByBranch.length > 0) {
      const worstBranch = varianceByBranch[0]!;
      insights.push({
        key: "worstBranch",
        title: "Branch needing attention",
        description: `${worstBranch.label} accounts for ${worstBranch.variancePct.toFixed(0)}% of total variance value this period.`,
        countLabel: `${worstBranch.variancePct.toFixed(0)}%`,
      });
    }

    // ── Detailed discrepancy table — every line with a nonzero variance, highest value first ──
    const repeatKeySet = new Set(repeatPairs.map(([key]) => key));
    const discrepancies: StocktakeDiscrepancyRow[] = currentLines
      .filter((l) => (l.varianceQty ?? 0) !== 0)
      .map((l) => {
        const product = productById.get(l.productId);
        return {
          lineId: l.id,
          productId: l.productId,
          product: product ? { id: product.id, sku: product.sku, name: product.name } : { id: l.productId },
          branchId: l.stocktake.branchId,
          branchName: branchNameById.get(l.stocktake.branchId) ?? "Unknown",
          expectedQty: l.systemQty,
          countedQty: l.countedQty ?? 0,
          varianceQty: l.varianceQty ?? 0,
          varianceValue: valueOfLine(l),
          stocktakeNumber: l.stocktake.stocktakeNumber,
          stocktakeDate: l.stocktake.createdAt.toISOString(),
          isRepeatDiscrepancy: repeatKeySet.has(`${l.productId}::${l.stocktake.branchId}`),
          status: l.status,
        };
      })
      .sort((a, b) => b.varianceValue - a.varianceValue);

    return { days, isMultiBranch, kpis, accuracyTrend, varianceByBranch, varianceByCategory, insights, discrepancies };
  }

  /**
   * What are we buying, how much are we spending, and are we purchasing efficiently? `days` scopes
   * which PO was *created* within (the "Purchases vs Receipts" trend and "Received Value" KPI both
   * attribute a PO's received value to its own creation bucket, not the receipt's own date — "of
   * what we ordered this period, how much has arrived so far" — a simpler, still-honest framing
   * than reconciling receipts against POs created in an earlier window). `openCommitments` is the
   * one exception: a point-in-time snapshot across every non-terminal PO regardless of `days`,
   * since an open PO from months ago is still money we're on the hook for today.
   */
  async purchaseSummary(tenantId: string, branchId: string | null, days = 30): Promise<PurchaseSummaryResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);

    const poSelect = {
      id: true,
      poNumber: true,
      supplierId: true,
      branchId: true,
      status: true,
      createdAt: true,
      supplier: { select: { id: true, name: true } },
      branch: { select: { id: true, name: true } },
      items: { select: { productId: true, orderedQty: true, unitCost: true } },
      goodsReceipts: { select: { items: { select: { productId: true, receivedQty: true } } } },
    } as const;

    const [currentPOs, previousPOs, openPOs] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: since, lte: now } }, select: poSelect }),
      this.prisma.purchaseOrder.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: prevSince, lte: prevTo } }, select: poSelect }),
      this.prisma.purchaseOrder.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), status: { notIn: PO_TERMINAL_STATUSES } }, select: poSelect }),
    ]);

    function computeRow(po: (typeof currentPOs)[number]) {
      const unitCostByProduct = new Map(po.items.map((i) => [i.productId, Number(i.unitCost)]));
      const orderedQtyByProduct = new Map(po.items.map((i) => [i.productId, i.orderedQty]));
      const receivedQtyByProduct = new Map<string, number>();
      for (const gr of po.goodsReceipts) for (const it of gr.items) receivedQtyByProduct.set(it.productId, (receivedQtyByProduct.get(it.productId) ?? 0) + it.receivedQty);
      let orderedValue = 0;
      let receivedValue = 0;
      let totalOrderedQty = 0;
      let totalReceivedQty = 0;
      for (const [productId, orderedQty] of orderedQtyByProduct) {
        const unitCost = unitCostByProduct.get(productId) ?? 0;
        const receivedQty = Math.min(orderedQty, receivedQtyByProduct.get(productId) ?? 0);
        orderedValue += orderedQty * unitCost;
        receivedValue += receivedQty * unitCost;
        totalOrderedQty += orderedQty;
        totalReceivedQty += receivedQty;
      }
      const fillPct = totalOrderedQty > 0 ? (totalReceivedQty / totalOrderedQty) * 100 : null;
      return { orderedValue, receivedValue, fillPct };
    }

    const currentRows = currentPOs.map((po) => ({ po, ...computeRow(po) }));
    const previousRows = previousPOs.map((po) => ({ po, ...computeRow(po) }));
    const openRows = openPOs.map((po) => ({ po, ...computeRow(po) }));

    const kpis: PurchaseSummaryKpis = {
      purchaseSpend: currentRows.reduce((s, r) => s + r.orderedValue, 0),
      prevPurchaseSpend: previousRows.reduce((s, r) => s + r.orderedValue, 0),
      posRaised: currentPOs.length,
      prevPosRaised: previousPOs.length,
      receivedValue: currentRows.reduce((s, r) => s + r.receivedValue, 0),
      prevReceivedValue: previousRows.reduce((s, r) => s + r.receivedValue, 0),
      openCommitments: openRows.reduce((s, r) => s + Math.max(0, r.orderedValue - r.receivedValue), 0),
    };

    // ── Purchases vs Receipts trend (weekly buckets) ───────────────────────────────────────
    const bucketMs = 7 * 86_400_000;
    const numBuckets = Math.max(1, Math.ceil(days / 7));
    const orderedBuckets = Array.from({ length: numBuckets }, () => 0);
    const receivedBuckets = Array.from({ length: numBuckets }, () => 0);
    for (const r of currentRows) {
      const idx = Math.min(numBuckets - 1, Math.max(0, Math.floor((now.getTime() - r.po.createdAt.getTime()) / bucketMs)));
      const bucketFromEnd = numBuckets - 1 - idx;
      orderedBuckets[bucketFromEnd] += r.orderedValue;
      receivedBuckets[bucketFromEnd] += r.receivedValue;
    }
    const trend: PurchaseTrendPoint[] = Array.from({ length: numBuckets }, (_, i) => {
      const bucketStart = new Date(now.getTime() - (numBuckets - i) * bucketMs);
      return {
        key: bucketStart.toISOString().slice(0, 10),
        label: bucketStart.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        orderedValue: orderedBuckets[i]!,
        receivedValue: receivedBuckets[i]!,
      };
    });

    // ── PO Lifecycle ────────────────────────────────────────────────────────────────────────
    const STATUS_LABEL: Record<string, string> = {
      draft: "Draft",
      pending_approval: "Pending Approval",
      issued: "Issued",
      partially_received: "Partially Received",
      received: "Received",
      short_closed: "Short Closed",
      cancelled: "Cancelled",
    };
    const lifecycleAgg = new Map<string, { count: number; value: number }>();
    for (const r of currentRows) {
      const cur = lifecycleAgg.get(r.po.status) ?? { count: 0, value: 0 };
      cur.count += 1;
      cur.value += r.orderedValue;
      lifecycleAgg.set(r.po.status, cur);
    }
    const lifecycle: PoLifecycleStage[] = Object.keys(STATUS_LABEL).map((status) => ({
      status,
      label: STATUS_LABEL[status]!,
      count: lifecycleAgg.get(status)?.count ?? 0,
      value: lifecycleAgg.get(status)?.value ?? 0,
    }));

    // ── Insights ────────────────────────────────────────────────────────────────────────────
    const insights: PurchasingInsight[] = [];
    const partialCountBySupplier = new Map<string, { name: string; count: number }>();
    for (const r of currentRows) {
      if (r.po.status !== "partially_received" && r.po.status !== "short_closed") continue;
      const cur = partialCountBySupplier.get(r.po.supplierId) ?? { name: r.po.supplier.name, count: 0 };
      cur.count += 1;
      partialCountBySupplier.set(r.po.supplierId, cur);
    }
    const repeatPartialSuppliers = [...partialCountBySupplier.values()].filter((s) => s.count >= PURCHASE_REPEAT_PARTIAL_MIN_COUNT);
    if (repeatPartialSuppliers.length > 0) {
      insights.push({
        key: "repeatedPartialFulfilment",
        title: "Repeated partial fulfilment",
        description: `${repeatPartialSuppliers.map((s) => s.name).join(", ")} each left ${PURCHASE_REPEAT_PARTIAL_MIN_COUNT}+ orders partially filled or short-closed this period.`,
        countLabel: `${repeatPartialSuppliers.length} supplier${repeatPartialSuppliers.length === 1 ? "" : "s"}`,
      });
    }

    const openBranchIds = [...new Set(openPOs.map((po) => po.branchId))];
    const openProductIds = [...new Set(openPOs.flatMap((po) => po.items.map((i) => i.productId)))];
    if (openBranchIds.length > 0 && openProductIds.length > 0) {
      const overstockByBranch = await Promise.all(
        openBranchIds.map(async (bId) => ({
          branchId: bId,
          qtyMap: await this.productQtyAsOf(tenantId, bId, openProductIds),
          velocityMap: await this.avgDailySalesByProduct(tenantId, bId, openProductIds, now),
        })),
      );
      const overstockMapByBranch = new Map(overstockByBranch.map((o) => [o.branchId, o]));
      let overstockCount = 0;
      let overstockValue = 0;
      for (const po of openPOs) {
        const bd = overstockMapByBranch.get(po.branchId);
        if (!bd) continue;
        for (const item of po.items) {
          const qty = Math.max(0, bd.qtyMap.get(item.productId) ?? 0);
          const velocity = bd.velocityMap.get(item.productId) ?? 0;
          const daysOfCover = velocity > 0 ? qty / velocity : null;
          if (daysOfCover != null && daysOfCover > PURCHASE_OVERSTOCK_COVER_DAYS) {
            overstockCount += 1;
            overstockValue += item.orderedQty * Number(item.unitCost);
          }
        }
      }
      if (overstockCount > 0) {
        insights.push({
          key: "overstockPurchaseRisk",
          title: "Overstock purchase risk",
          description: `${overstockCount} open PO line${overstockCount === 1 ? "" : "s"} order more of a product the receiving branch already has over ${PURCHASE_OVERSTOCK_COVER_DAYS} days of cover for.`,
          countLabel: `${overstockCount} line${overstockCount === 1 ? "" : "s"}`,
        });
      }
    }

    const orders: PurchaseOrderRow[] = currentRows
      .map((r) => ({
        id: r.po.id,
        poNumber: r.po.poNumber,
        supplierId: r.po.supplierId,
        supplierName: r.po.supplier.name,
        branchId: r.po.branchId,
        branchName: r.po.branch.name,
        createdAt: r.po.createdAt.toISOString(),
        orderedValue: r.orderedValue,
        receivedValue: r.receivedValue,
        fillPct: r.fillPct,
        status: r.po.status,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return { days, kpis, trend, lifecycle, insights, orders };
  }

  /**
   * Where is procurement spend concentrated? Same cost-basis valuation as `purchaseSummary`
   * (`orderedQty × unitCost`, pre-tax/discount). The dependency matrix caps at the top 6
   * categories × top 6 suppliers by spend — wider than that stops being readable as a grid, and
   * every category/supplier not in the top 6 still counts fully in the KPIs/ranking, just not in
   * the matrix itself.
   */
  async supplierSpend(tenantId: string, branchId: string | null, days = 30): Promise<SupplierSpendResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);

    const poSelect = { id: true, supplierId: true, createdAt: true, items: { select: { productId: true, orderedQty: true, unitCost: true } } } as const;

    const [currentPOs, previousPOs, suppliers] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: since, lte: now } }, select: poSelect }),
      this.prisma.purchaseOrder.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), createdAt: { gte: prevSince, lte: prevTo } }, select: poSelect }),
      this.prisma.supplier.findMany({ where: { tenantId }, select: { id: true, name: true, status: true } }),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));

    function poValue(po: { items: Array<{ orderedQty: number; unitCost: Prisma.Decimal }> }): number {
      return po.items.reduce((s, i) => s + i.orderedQty * Number(i.unitCost), 0);
    }

    const productIds = [...new Set(currentPOs.flatMap((po) => po.items.map((i) => i.productId)))];
    const categoryByProduct = await this.categoryTaxonomy.primaryCommercialCategoryByProductIds(tenantId, productIds);
    function departmentOf(productId: string): { id: string | null; name: string } {
      const cat = categoryByProduct.get(productId);
      if (!cat) return { id: null, name: "Unclassified" };
      return cat.parent ? { id: cat.parent.id, name: cat.parent.name } : { id: cat.id, name: cat.name };
    }

    const bySupplier = new Map<string, { spend: number; poCount: number; categories: Set<string> }>();
    const byCategorySupplier = new Map<string, Map<string, number>>();
    const categoryTotals = new Map<string, number>();
    const deptNameByKey = new Map<string, string>();
    for (const po of currentPOs) {
      const cur = bySupplier.get(po.supplierId) ?? { spend: 0, poCount: 0, categories: new Set<string>() };
      cur.spend += poValue(po);
      cur.poCount += 1;
      for (const item of po.items) {
        const dept = departmentOf(item.productId);
        const deptKey = dept.id ?? "unclassified";
        deptNameByKey.set(deptKey, dept.name);
        cur.categories.add(deptKey);
        const lineValue = item.orderedQty * Number(item.unitCost);
        categoryTotals.set(deptKey, (categoryTotals.get(deptKey) ?? 0) + lineValue);
        const supplierMap = byCategorySupplier.get(deptKey) ?? new Map<string, number>();
        supplierMap.set(po.supplierId, (supplierMap.get(po.supplierId) ?? 0) + lineValue);
        byCategorySupplier.set(deptKey, supplierMap);
      }
      bySupplier.set(po.supplierId, cur);
    }

    const totalSpend = [...bySupplier.values()].reduce((s, v) => s + v.spend, 0);
    const rankingUnsorted = [...bySupplier.entries()]
      .map(([supplierId, agg]) => ({
        supplierId,
        supplierName: supplierById.get(supplierId)?.name ?? "Unknown",
        status: supplierById.get(supplierId)?.status ?? "active",
        spend: agg.spend,
        sharePct: totalSpend > 0 ? (agg.spend / totalSpend) * 100 : 0,
        poCount: agg.poCount,
        avgPoValue: agg.poCount > 0 ? agg.spend / agg.poCount : 0,
        categoriesSupplied: agg.categories.size,
      }))
      .sort((a, b) => b.spend - a.spend);
    let cumulative = 0;
    const ranking: SupplierSpendRow[] = rankingUnsorted.map((r) => {
      cumulative += r.sharePct;
      return { ...r, cumulativePct: cumulative };
    });

    const prevBySupplier = new Set(previousPOs.map((po) => po.supplierId));
    const kpis: SupplierSpendKpis = {
      totalSpend,
      prevTotalSpend: previousPOs.reduce((s, po) => s + poValue(po), 0),
      activeSuppliers: bySupplier.size,
      prevActiveSuppliers: prevBySupplier.size,
      topSupplierSharePct: ranking[0]?.sharePct ?? null,
      avgPoValue: currentPOs.length > 0 ? totalSpend / currentPOs.length : null,
    };

    // ── Category × Supplier dependency matrix (top 6 × top 6) ──────────────────────────────
    const topCategoryKeys = [...categoryTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([key]) => key);
    const topSupplierIds = ranking.slice(0, 6).map((r) => r.supplierId);
    const dependencyMatrix: CategorySupplierDependencyRow[] = topCategoryKeys.map((catKey) => {
      const supplierMap = byCategorySupplier.get(catKey) ?? new Map<string, number>();
      const totalForCat = categoryTotals.get(catKey) ?? 0;
      return {
        categoryId: catKey === "unclassified" ? null : catKey,
        categoryName: deptNameByKey.get(catKey) ?? "Unclassified",
        totalSpend: totalForCat,
        cells: topSupplierIds.map((supId) => {
          const spend = supplierMap.get(supId) ?? 0;
          return { supplierId: supId, supplierName: supplierById.get(supId)?.name ?? "Unknown", spend, dependencyPct: totalForCat > 0 ? (spend / totalForCat) * 100 : 0 };
        }),
      };
    });
    const dependencySuppliers = topSupplierIds.map((supId) => ({ supplierId: supId, supplierName: supplierById.get(supId)?.name ?? "Unknown" }));

    // ── Insights ────────────────────────────────────────────────────────────────────────────
    const insights: PurchasingInsight[] = [];
    if (ranking.length >= 2) {
      const top3 = ranking.slice(0, 3);
      const top3Share = top3.reduce((s, r) => s + r.sharePct, 0);
      insights.push({
        key: "supplierConcentration",
        title: "Supplier concentration",
        description: `Top ${top3.length} supplier${top3.length === 1 ? "" : "s"} (${top3.map((r) => r.supplierName).join(", ")}) account${top3.length === 1 ? "s" : ""} for ${top3Share.toFixed(0)}% of purchasing spend.`,
        countLabel: `${top3Share.toFixed(0)}%`,
      });
    }
    let worstDependency: { categoryName: string; supplierName: string; pct: number } | null = null;
    for (const row of dependencyMatrix) {
      for (const cell of row.cells) {
        if (cell.dependencyPct >= 50 && (!worstDependency || cell.dependencyPct > worstDependency.pct)) {
          worstDependency = { categoryName: row.categoryName, supplierName: cell.supplierName, pct: cell.dependencyPct };
        }
      }
    }
    if (worstDependency) {
      insights.push({
        key: "categoryDependency",
        title: "Category dependency risk",
        description: `${worstDependency.pct.toFixed(0)}% of ${worstDependency.categoryName} procurement depends on ${worstDependency.supplierName}.`,
        countLabel: `${worstDependency.pct.toFixed(0)}%`,
      });
    }

    return { days, kpis, ranking, dependencyMatrix, dependencySuppliers, insights };
  }

  /**
   * Which suppliers provide the best overall value and service? Scoped by *delivery* date
   * (`GoodsReceipt.receivedOn`) rather than PO creation date, unlike `purchaseSummary`/
   * `supplierSpend` — "how did a supplier perform on deliveries this period" is naturally about
   * when the delivery happened, not when we placed the order. Every metric here is a real,
   * disclosed derivation from stored fields (see each block's comment) — nothing is fabricated,
   * though with light demo data most suppliers will trivially read as ~100% until they've built up
   * a real history of late/partial/mispriced deliveries.
   */
  async supplierPerformance(tenantId: string, branchId: string | null, days = 30): Promise<SupplierPerformanceResponse> {
    const now = new Date();
    now.setHours(23, 59, 59, 999);
    const since = new Date(now);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    const prevTo = new Date(since.getTime() - 1);

    const receiptSelect = {
      id: true,
      receivedOn: true,
      items: { select: { productId: true, receivedQty: true, batch: { select: { costPrice: true } } } },
      purchaseOrder: {
        select: { id: true, supplierId: true, branchId: true, createdAt: true, expectedOn: true, items: { select: { productId: true, unitCost: true, orderedQty: true } } },
      },
    } as const;

    const [currentReceiptsRaw, previousReceiptsRaw, suppliers, currentReturns] = await Promise.all([
      this.prisma.goodsReceipt.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), receivedOn: { gte: since, lte: now } }, select: receiptSelect }),
      this.prisma.goodsReceipt.findMany({ where: { tenantId, ...(branchId ? { branchId } : {}), receivedOn: { gte: prevSince, lte: prevTo } }, select: receiptSelect }),
      this.prisma.supplier.findMany({ where: { tenantId }, select: { id: true, name: true } }),
      this.prisma.goodsReturn.findMany({ where: { tenantId, type: GoodsReturnType.supplier, ...(branchId ? { branchId } : {}), createdAt: { gte: since, lte: now } }, select: { supplierId: true, amount: true } }),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s]));
    // A receipt's parent PO might belong to a different branch than the receipt's own scoping
    // filter would suggest if branchId is null (tenant-wide) — irrelevant here since GoodsReceipt
    // and PurchaseOrder always share the same branchId in this schema; kept for defensiveness only.
    const currentReceipts = currentReceiptsRaw;
    const previousReceipts = previousReceiptsRaw;

    type ReceiptRow = (typeof currentReceipts)[number];
    type SupplierAgg = {
      spend: number;
      orderedQtyTotal: number;
      receivedQtyTotal: number;
      orderedCostTotal: number;
      actualCostTotal: number;
      leadTimes: number[];
      onTimeFlags: boolean[];
    };

    function aggregateBySupplier(receipts: ReceiptRow[]): Map<string, SupplierAgg> {
      const bySupplier = new Map<string, SupplierAgg>();
      const seenPoProduct = new Set<string>();
      const seenPoForLeadTime = new Set<string>();
      for (const receipt of receipts) {
        const po = receipt.purchaseOrder;
        const cur = bySupplier.get(po.supplierId) ?? { spend: 0, orderedQtyTotal: 0, receivedQtyTotal: 0, orderedCostTotal: 0, actualCostTotal: 0, leadTimes: [], onTimeFlags: [] };
        const unitCostByProduct = new Map(po.items.map((i) => [i.productId, Number(i.unitCost)]));
        const orderedQtyByProduct = new Map(po.items.map((i) => [i.productId, i.orderedQty]));
        for (const item of receipt.items) {
          const poProductKey = `${po.id}::${item.productId}`;
          if (!seenPoProduct.has(poProductKey)) {
            seenPoProduct.add(poProductKey);
            cur.orderedQtyTotal += orderedQtyByProduct.get(item.productId) ?? 0;
          }
          const orderedUnitCost = unitCostByProduct.get(item.productId) ?? 0;
          const actualUnitCost = Number(item.batch.costPrice);
          cur.receivedQtyTotal += item.receivedQty;
          cur.orderedCostTotal += item.receivedQty * orderedUnitCost;
          cur.actualCostTotal += item.receivedQty * actualUnitCost;
          cur.spend += item.receivedQty * orderedUnitCost;
        }
        // Deduped per PO (not per receipt) — a PO delivered across several partial shipments
        // counts once for lead-time/on-time purposes, using whichever of its in-period receipts is
        // encountered first, not necessarily the very first ever received.
        if (!seenPoForLeadTime.has(po.id)) {
          seenPoForLeadTime.add(po.id);
          cur.leadTimes.push((receipt.receivedOn.getTime() - po.createdAt.getTime()) / 86_400_000);
          if (po.expectedOn) cur.onTimeFlags.push(receipt.receivedOn.getTime() <= po.expectedOn.getTime());
        }
        bySupplier.set(po.supplierId, cur);
      }
      return bySupplier;
    }

    const currentAgg = aggregateBySupplier(currentReceipts);
    const previousAgg = aggregateBySupplier(previousReceipts);

    function overallMetrics(bySupplier: Map<string, SupplierAgg>) {
      let receivedQty = 0, orderedQty = 0, leadTimeSum = 0, leadTimeCount = 0, onTimeCount = 0, onTimeEligible = 0, orderedCost = 0, actualCost = 0;
      for (const agg of bySupplier.values()) {
        receivedQty += agg.receivedQtyTotal;
        orderedQty += agg.orderedQtyTotal;
        leadTimeSum += agg.leadTimes.reduce((s, v) => s + v, 0);
        leadTimeCount += agg.leadTimes.length;
        onTimeCount += agg.onTimeFlags.filter(Boolean).length;
        onTimeEligible += agg.onTimeFlags.length;
        orderedCost += agg.orderedCostTotal;
        actualCost += agg.actualCostTotal;
      }
      return {
        onTimePct: onTimeEligible > 0 ? (onTimeCount / onTimeEligible) * 100 : null,
        fillRatePct: orderedQty > 0 ? (receivedQty / orderedQty) * 100 : null,
        avgLeadTimeDays: leadTimeCount > 0 ? leadTimeSum / leadTimeCount : null,
        priceVariancePct: orderedCost > 0 ? ((actualCost - orderedCost) / orderedCost) * 100 : null,
      };
    }
    const currentOverall = overallMetrics(currentAgg);
    const previousOverall = overallMetrics(previousAgg);

    const kpis: SupplierPerformanceKpis = {
      onTimePct: currentOverall.onTimePct,
      prevOnTimePct: previousOverall.onTimePct,
      fillRatePct: currentOverall.fillRatePct,
      prevFillRatePct: previousOverall.fillRatePct,
      avgLeadTimeDays: currentOverall.avgLeadTimeDays,
      prevAvgLeadTimeDays: previousOverall.avgLeadTimeDays,
      priceVariancePct: currentOverall.priceVariancePct,
      prevPriceVariancePct: previousOverall.priceVariancePct,
    };

    const returnsBySupplier = new Map<string, number>();
    for (const r of currentReturns) {
      if (!r.supplierId) continue;
      returnsBySupplier.set(r.supplierId, (returnsBySupplier.get(r.supplierId) ?? 0) + Number(r.amount));
    }

    /**
     * Transparent 0-100 composite: 30% on-time delivery, 30% fill rate, 20% lead time (faster is
     * better, penalized 4pts/day beyond instant), 20% price accuracy (penalized 5pts per 1% of
     * variance in either direction). A supplier missing a metric entirely (no on-time-eligible
     * orders yet, say) gets a neutral 70 for that component rather than being penalized for an
     * absence of data. This is a documented formula, not an external rating — see the type's own
     * doc comment.
     */
    function computeSupplierScore(onTimePct: number | null, fillRatePct: number | null, avgLeadTimeDays: number | null, priceVariancePct: number | null): { score: number; grade: SupplierPerformanceGrade } {
      const onTimeScore = onTimePct ?? 70;
      const fillScore = fillRatePct ?? 70;
      const leadTimeScore = avgLeadTimeDays == null ? 70 : Math.max(0, 100 - avgLeadTimeDays * 4);
      const priceScore = priceVariancePct == null ? 70 : Math.max(0, 100 - Math.abs(priceVariancePct) * 5);
      const score = onTimeScore * 0.3 + fillScore * 0.3 + leadTimeScore * 0.2 + priceScore * 0.2;
      const grade: SupplierPerformanceGrade = score >= 85 ? "preferred" : score >= 70 ? "good" : score >= 50 ? "monitor" : "review";
      return { score: Math.round(score * 10) / 10, grade };
    }

    const scorecard: SupplierScoreRow[] = [...currentAgg.entries()]
      .map(([supplierId, agg]) => {
        const onTimePct = agg.onTimeFlags.length > 0 ? (agg.onTimeFlags.filter(Boolean).length / agg.onTimeFlags.length) * 100 : null;
        const fillRatePct = agg.orderedQtyTotal > 0 ? (agg.receivedQtyTotal / agg.orderedQtyTotal) * 100 : null;
        const avgLeadTimeDays = agg.leadTimes.length > 0 ? agg.leadTimes.reduce((s, v) => s + v, 0) / agg.leadTimes.length : null;
        const priceVariancePct = agg.orderedCostTotal > 0 ? ((agg.actualCostTotal - agg.orderedCostTotal) / agg.orderedCostTotal) * 100 : null;
        const { score, grade } = computeSupplierScore(onTimePct, fillRatePct, avgLeadTimeDays, priceVariancePct);
        return {
          supplierId,
          supplierName: supplierById.get(supplierId)?.name ?? "Unknown",
          spend: agg.spend,
          onTimePct,
          fillRatePct,
          avgLeadTimeDays,
          priceVariancePct,
          returnsValue: returnsBySupplier.get(supplierId) ?? 0,
          score,
          grade,
        };
      })
      .sort((a, b) => b.spend - a.spend);

    // ── Insights ────────────────────────────────────────────────────────────────────────────
    const insights: PurchasingInsight[] = [];
    const worstOnTime = [...scorecard].filter((s) => s.onTimePct != null).sort((a, b) => a.onTimePct! - b.onTimePct!)[0];
    if (worstOnTime && worstOnTime.onTimePct! < 80) {
      insights.push({
        key: "lateDeliveries",
        title: "Late delivery risk",
        description: `${worstOnTime.supplierName} delivered on time only ${worstOnTime.onTimePct!.toFixed(0)}% of the time this period.`,
        countLabel: `${worstOnTime.onTimePct!.toFixed(0)}%`,
      });
    }
    const worstPrice = [...scorecard].filter((s) => s.priceVariancePct != null && s.priceVariancePct > 5).sort((a, b) => b.priceVariancePct! - a.priceVariancePct!)[0];
    if (worstPrice) {
      insights.push({
        key: "priceIncrease",
        title: "Purchase price increase",
        description: `${worstPrice.supplierName}'s delivered cost ran ${worstPrice.priceVariancePct!.toFixed(1)}% above the agreed PO price this period.`,
        countLabel: `+${worstPrice.priceVariancePct!.toFixed(1)}%`,
      });
    }
    const reviewSuppliers = scorecard.filter((s) => s.grade === "review");
    if (reviewSuppliers.length > 0) {
      insights.push({
        key: "needsReview",
        title: "Suppliers needing review",
        description: `${reviewSuppliers.map((s) => s.supplierName).join(", ")} scored below 50 on this period's composite performance score.`,
        countLabel: `${reviewSuppliers.length} supplier${reviewSuppliers.length === 1 ? "" : "s"}`,
      });
    }

    return { days, kpis, scorecard, insights };
  }
}
