export type PoStatus =
  | "draft"
  | "pending_approval"
  | "issued"
  | "partially_received"
  | "received"
  | "short_closed"
  | "cancelled";

export type PoPriority = "low" | "normal" | "high" | "urgent";

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

export type SupplierOption = {
  id: string;
  code: string;
  name: string;
  leadTimeDays: number;
  paymentTermsDays: number;
  isActive: boolean;
};

export type PoProductRef = {
  id: string;
  sku: string;
  name: string;
};

export type PurchaseOrderItem = {
  id: string;
  productId: string;
  orderedQty: number;
  /** Null when the caller may not see costs (`purchasing.view_cost`). */
  unitCost: string | null;
  packCost?: string | null;
  /** Packs as ordered; null when the line was entered in units. */
  orderedPacks?: number | null;
  unitsPerPack?: number;
  /** Good units booked in so far. Free and rejected units are reported separately. */
  receivedQty?: number;
  freeQty?: number;
  rejectedQty?: number;
  outstandingQty?: number;
  outstandingPacks?: number | null;
  discountPercent?: string | number;
  taxPercent?: string | number;
  product: PoProductRef;
  /** What this branch last paid and charged for the product — the receiving form's starting price. */
  lastBatchPrices?: { costPrice: string; sellingPrice: string } | null;
};

export type PoReceiptSummary = {
  items: { productId: string; receivedQty: number }[];
};

export type PurchaseOrderListItem = {
  id: string;
  poNumber: string;
  status: PoStatus;
  priority?: PoPriority;
  expectedOn: string | null;
  notes: string | null;
  supplierReference?: string | null;
  deliveryInstructions?: string | null;
  paymentTermsDays?: number;
  shippingCharges?: string | number;
  createdAt: string;
  supplier: { id: string; code: string; name: string };
  items: PurchaseOrderItem[];
  goodsReceipts?: PoReceiptSummary[];
};

export type GoodsReceiptItem = {
  id: string;
  productId: string;
  batchId: string;
  receivedQty: number;
  freeQty?: number;
  rejectedQty?: number;
  packs?: number | null;
  unitCost?: string | null;
  product: PoProductRef;
  batch: {
    id: string;
    batchNo: string;
    expiryDate: string;
    costPrice: string;
    sellingPrice: string;
  };
};

/** A row on the Deliveries tab. */
export type DeliveryRow = {
  id: string;
  grnNumber: string;
  receivedOn: string;
  createdAt: string;
  purchaseOrder: { id: string; poNumber: string; status: PoStatus };
  supplier: { id: string; code: string; name: string };
  receivedBy: { id: string; fullName: string } | null;
  invoice: { id: string; invoiceNumber: string; status: string } | null;
  lineCount: number;
  paidUnits: number;
  freeUnits: number;
  rejectedUnits: number;
  /** Null when the caller may not see costs. */
  value: string | null;
  items: Array<{
    id: string;
    product: PoProductRef;
    batch: { id: string; batchNo: string; expiryDate: string };
    receivedQty: number;
    freeQty: number;
    rejectedQty: number;
    packs: number | null;
    unitCost: string | null;
    orderedUnitCost: string | null;
    /** How far the billed price moved from the agreed one; positive means dearer. */
    variancePercent: number | null;
  }>;
};

/** One supplier's worth of suggested reordering. */
export type ReorderSuggestionItem = {
  productId: string;
  sku: string;
  name: string;
  available: number;
  onOrderQty: number;
  plannedQty: number;
  reorderLevel: number;
  suggestedQty: number;
  suggestedPacks: number | null;
  unitsPerPack: number;
  packLabel: string | null;
  unitCost: string | null;
  supplierSku: string | null;
  reason: string;
};

export type ReorderSuggestions = {
  branchId: string;
  generatedAt: string;
  suppliers: Array<{
    supplier: { id: string; code: string; name: string; leadTimeDays: number };
    items: ReorderSuggestionItem[];
    estimatedValue: string | null;
  }>;
  unassigned: ReorderSuggestionItem[];
};

export type GoodsReceipt = {
  id: string;
  grnNumber: string;
  receivedOn: string;
  createdAt: string;
  items: GoodsReceiptItem[];
};

export type PurchaseOrderDetail = Omit<PurchaseOrderListItem, "supplier" | "goodsReceipts"> & {
  supplier: SupplierOption;
  goodsReceipts: GoodsReceipt[];
};

export type CreatePoLine = {
  key: string;
  productId: string;
  /** What the buyer is typing in: packs of `unitsPerPack`, or loose units. */
  orderMode: "packs" | "units";
  orderedPacks: string;
  orderedQty: string;
  unitsPerPack: number;
  packLabel: string | null;
  unitCost: string;
  discountPercent: string;
  taxPercent: string;
  /** Set when the supplier's price list filled the cost in, so the form can say so. */
  costFromPriceList?: boolean;
};

export type ReceiveLineForm = {
  productId: string;
  productLabel: string;
  remainingQty: number;
  unitsPerPack: number;
  packLabel: string | null;
  /** How the storekeeper is counting this line at the door. */
  countMode: "packs" | "units";
  packs: string;
  receivedQty: string;
  freeQty: string;
  rejectedQty: string;
  rejectedReason: string;
  batchNo: string;
  expiryDate: string;
  /** What the order agreed this unit would cost — null when the caller may not see costs. */
  orderedCostPrice: string | null;
  costPrice: string;
  sellingPrice: string;
  include: boolean;
};

/** The server asking whether to accept being billed above the agreed price. */
export type PriceRise = {
  productId: string;
  product: string;
  orderedUnitCost: string;
  billedUnitCost: string;
  variancePercent: number;
};

/** The server asking which expiry is right for a batch number it already knows. */
export type ExpiryConflict = {
  productId: string;
  product: string;
  batchNo: string;
  existingExpiry: string;
  enteredExpiry: string;
  /** True only for an imported placeholder expiry nobody has confirmed yet. */
  canCorrect: boolean;
};

/** The server asking what to do about a batch already in stock at another cost. */
export type CostConflict = {
  productId: string;
  product: string;
  batchNo: string;
  existingCost: string;
  incomingCost: string;
};

export type PoStatusFilter = "all" | "overdue" | "receivable" | PoStatus;

export const PAGE_SIZE = 10;

export const DEFAULT_TAX_PERCENT = "18";

export const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

export const PAYMENT_TERMS_OPTIONS = [
  { value: "0", label: "Due on receipt" },
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
  { value: "45", label: "45 days" },
  { value: "60", label: "60 days" },
] as const;
