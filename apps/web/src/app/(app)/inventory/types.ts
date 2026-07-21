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

export type StockRow = {
  productId: string;
  qtyOnHand: number;
  stockStatus: StockStatus;
  reorderGap: number;
  batchCount: number;
  nearExpiryBatchCount: number;
  lastMovementAt: string | null;
  lastMovementType: string | null;
  product: InventoryProduct;
};

export type BatchRow = {
  id: string;
  batchNo: string;
  expiryDate: string;
  receivedAt: string;
  costPrice: string;
  sellingPrice: string;
  productId: string;
  qtyOnHand: number;
  daysToExpiry: number;
  expired: boolean;
  nearExpiry: boolean;
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
  stockValue: string;
  lowStock: number;
  outOfStock: number;
  nearExpiry: number;
  nearExpiryProducts: number;
  expired: number;
  healthy: number;
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

export type MovementCategory =
  | "all"
  | "adjustments"
  | "sales"
  | "purchases"
  | "transfers"
  | "returns";

export type MovementRow = {
  id: string;
  occurredAt: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
  reason?: string | null;
  batchNo: string | null;
  qtyDelta: number;
  balanceBefore: number | null;
  balanceAfter: number | null;
  actorName: string | null;
  product: { id: string; sku: string; name: string };
};

export type MovementList = {
  items: MovementRow[];
  total: number;
  skip: number;
  take: number;
  summary: {
    unitsIn: number;
    unitsOut: number;
    netDelta: number;
  };
};

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
export const ADJUST_OUT_ROLES = new Set(["owner", "manager"]);
