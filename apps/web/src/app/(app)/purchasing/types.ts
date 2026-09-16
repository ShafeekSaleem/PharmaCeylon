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
  unitCost: string;
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
  product: PoProductRef;
  batch: {
    id: string;
    batchNo: string;
    expiryDate: string;
    costPrice: string;
    sellingPrice: string;
  };
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
  orderedQty: string;
  unitCost: string;
  discountPercent: string;
  taxPercent: string;
};

export type ReceiveLineForm = {
  productId: string;
  productLabel: string;
  remainingQty: number;
  receivedQty: string;
  batchNo: string;
  expiryDate: string;
  costPrice: string;
  sellingPrice: string;
  include: boolean;
};

export type PoStatusFilter = "all" | "overdue" | "receivable" | PoStatus;

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);

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
