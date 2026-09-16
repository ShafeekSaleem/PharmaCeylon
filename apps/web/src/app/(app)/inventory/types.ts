export type StockStatus = "out" | "low" | "ok";

export type InventoryProduct = {
  id: string;
  sku: string;
  name: string;
  barcode: string | null;
  genericName: string | null;
  brandName: string | null;
  reorderLevel: number;
  isControlled: boolean;
  isActive: boolean;
  unit: string | null;
  imageUrl: string | null;
  dosageForm: string | null;
  strength: string | null;
  categories: { id: string; name: string }[];
  tags: { id: string; name: string }[];
};

/**
 * One product's stock at the selected branch.
 *
 * - `qtyOnHand`: every unit physically at the branch.
 * - `quarantinedQty`: held back from sale and transfer.
 * - `reservedQty`: promised to an approved transfer that hasn't shipped.
 * - `availableQty`: can be sold or transferred now — in date, confirmed expiry, not held or promised.
 *
 * `stockStatus` is worked out from available, not on hand.
 */
export type StockRow = {
  productId: string;
  qtyOnHand: number;
  availableQty: number;
  quarantinedQty: number;
  reservedQty: number;
  /** Sellable units still sitting in expired batches. */
  expiredQty: number;
  stockStatus: StockStatus;
  reorderGap: number;
  batchCount: number;
  nearExpiryBatchCount: number;
  expiredBatchCount: number;
  expiryReviewBatchCount: number;
  lastMovementAt: string | null;
  lastMovementType: string | null;
  product: InventoryProduct;
};

export type StockListResponse = {
  items: StockRow[];
  total: number;
  skip: number;
  take: number;
};

export type BatchRow = {
  id: string;
  batchNo: string;
  expiryDate: string;
  receivedAt: string;
  /** Null when the viewer lacks `inventory.view_cost` — the API leaves it out. */
  costPrice: string | null;
  sellingPrice: string;
  productId: string;
  qtyOnHand: number;
  quarantinedQty: number;
  reservedQty: number;
  availableQty: number;
  daysToExpiry: number;
  expired: boolean;
  nearExpiry: boolean;
  /** Every unit on the batch is held. */
  isQuarantined: boolean;
  quarantinedAt: string | null;
  quarantineReason: string | null;
  /** Imported without a real expiry date — carries a placeholder until someone confirms it. */
  needsExpiryReview: boolean;
  supplier: { id: string; name: string } | null;
  product: {
    id: string;
    sku: string;
    name: string;
    reorderLevel: number;
    isControlled: boolean;
    unit: string | null;
    imageUrl: string | null;
  };
};

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

export type InventoryPeriodStats = {
  key: SummaryPeriod;
  label: string;
  from: string;
  to: string;
  received: number;
  issued: number;
  adjustments: number;
  net: number;
};

export type InventorySummary = {
  skuCount: number;
  totalUnits: number;
  availableUnits: number;
  /** Null without `inventory.view_cost`. */
  stockValue: string | null;
  lowStock: number;
  outOfStock: number;
  /** Batches expiring inside the warning window. */
  nearExpiry: number;
  nearExpiryProducts: number;
  /** Batches past expiry that still have sellable units. */
  expired: number;
  expiredUnits: number;
  quarantinedUnits: number;
  quarantinedProducts: number;
  reservedUnits: number;
  openReservations: number;
  /** Batches whose imported expiry date still needs confirming. */
  expiryReview: number;
  incomingTransfers: number;
  healthy: number;
  expiryWarningDays: number;
  period: InventoryPeriodStats;
  /** @deprecated Prefer `period`. */
  month: {
    received: number;
    issued: number;
    adjustments: number;
    net: number;
  };
};

/** In-page table view filters (not top-level nav). */
export type StockView = "all" | "ok" | "low" | "out" | "expiring";

export type StockStatusFilter = "all" | "ok" | "low" | "out";
export type ExpiryFilter = "all" | "near" | "expired" | "ok";

export type StockAttention =
  | "expired"
  | "near_expiry"
  | "quarantined"
  | "reserved"
  | "expiry_review";

export type MovementCategory =
  | "all"
  | "adjustments"
  | "sales"
  | "purchases"
  | "transfers"
  | "returns"
  | "stocktakes"
  | "opening"
  | "quarantine";

export type MovementRow = {
  id: string;
  occurredAt: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
  reasonCode?: string | null;
  batchId: string | null;
  batchNo: string | null;
  /** Change to on hand; zero for quarantine moves. */
  qtyDelta: number;
  /** Units moved into (+) or out of (−) quarantine. */
  quarantineDelta: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  actorId: string | null;
  actorName: string | null;
  product: { id: string; sku: string; name: string };
};

export type MovementList = {
  items: MovementRow[];
  total: number;
  skip: number;
  take: number;
  /** True when the list is one product's or batch's whole timeline, so balances are shown. */
  balanceAvailable: boolean;
  summary: {
    unitsIn: number;
    unitsOut: number;
    netDelta: number;
  };
};

export type ProductStockDetail = {
  product: {
    id: string;
    sku: string;
    name: string;
    genericName: string | null;
    brandName: string | null;
    strength: string | null;
    dosageForm: string | null;
    unit: string | null;
    imageUrl: string | null;
    reorderLevel: number;
    isControlled: boolean;
    isActive: boolean;
    rangeStatus: "RANGED" | "REFERENCE";
  };
  stockStatus: StockStatus;
  totals: {
    onHand: number;
    available: number;
    quarantined: number;
    reserved: number;
    expired: number;
    incoming: number;
    onOrder: number;
  };
  batches: BatchRow[];
  reservations: Array<{
    qty: number;
    batchNo: string | null;
    sourceType: string;
    sourceId: string;
    label: string;
    createdAt: string;
  }>;
  incoming: Array<{
    transferId: string;
    transferNumber: string;
    fromBranch: { id: string; name: string };
    qty: number;
    expectedOn: string | null;
  }>;
  onOrder: Array<{
    purchaseOrderId: string;
    poNumber: string;
    supplier: { id: string; name: string };
    qty: number;
    expectedOn: string | null;
  }>;
  otherBranches: Array<{
    branchId: string;
    name: string;
    code: string;
    onHand: number;
    available: number;
  }>;
  recentMovements: MovementRow[];
};

export type QuarantineReasonCode = "expired" | "damaged" | "recall" | "inspection" | "other";
