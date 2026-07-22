export type GoodsReturnType = "customer" | "supplier";

export type GoodsReturnStatus =
  | "draft"
  | "pending_approval"
  | "awaiting_logistics"
  | "in_review"
  | "completed"
  | "rejected"
  | "cancelled";

export type GoodsReturnStatusFilter = "all" | GoodsReturnStatus;

export type GoodsReturnTypeFilter = "all" | GoodsReturnType;

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

export type ReturnUserRef = {
  id: string;
  fullName: string;
};

export type ReturnSupplierRef = {
  id: string;
  name: string;
  code: string;
};

export type ReturnSaleRef = {
  id: string;
  invoiceNo: string;
};

export type ReturnItem = {
  id: string;
  qty: number;
  unitPrice: string | number;
  product: { id: string; sku: string; name: string };
  batch?: { id: string; batchNo: string } | null;
};

export type ReturnListItem = {
  id: string;
  returnNumber: string;
  type: GoodsReturnType;
  status: GoodsReturnStatus;
  customerName: string | null;
  reason: string | null;
  notes: string | null;
  amount: string | number;
  saleId?: string | null;
  supplierId?: string | null;
  branchId: string;
  requestedBy: string;
  approvedBy?: string | null;
  processedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  sale?: ReturnSaleRef | null;
  supplier?: ReturnSupplierRef | null;
  requester: ReturnUserRef;
  approver?: ReturnUserRef | null;
  processor?: ReturnUserRef | null;
  items: ReturnItem[];
};

export type CreateReturnLine = {
  key: string;
  productId: string;
  batchId: string;
  qty: string;
  unitPrice: string;
};

export type CreateReturnLinePayload = {
  productId: string;
  batchId?: string | null;
  qty: number;
  unitPrice?: number;
};

export const PAGE_SIZE = 10;

export const WRITE_ROLES = new Set([
  "owner",
  "manager",
  "pharmacist",
  "inventory_clerk",
]);
export const APPROVE_ROLES = new Set(["owner", "manager"]);
