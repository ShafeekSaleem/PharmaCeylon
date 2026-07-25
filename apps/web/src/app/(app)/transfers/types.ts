export type TransferStatus =
  | "requested"
  | "approved"
  | "in_transit"
  | "partially_received"
  | "received"
  | "rejected"
  | "cancelled";

export type TransferStatusFilter =
  | "all"
  | "requested"
  | "approved"
  | "in_transit"
  | "partially_received"
  | "received"
  | "overdue"
  | "cancelled"
  | "rejected";

export type SummaryPeriod =
  | "this_month"
  | "last_month"
  | "last_7_days"
  | "last_30_days"
  | "this_quarter"
  | "this_year";

export type TransferBranchRef = {
  id: string;
  code: string;
  name: string;
};

export type TransferUserRef = {
  id: string;
  fullName: string;
};

export type TransferItem = {
  id: string;
  productId: string;
  batchId: string | null;
  qty: number;
  receivedQty: number;
  product: { id: string; sku: string; name: string };
  batch?: { id: string; batchNo: string } | null;
};

export type TransferListItem = {
  id: string;
  transferNumber: string;
  status: TransferStatus;
  fromBranchId: string;
  toBranchId: string;
  notes: string | null;
  expectedOn: string | null;
  requestedBy: string;
  approvedBy: string | null;
  receivedBy: string | null;
  createdAt: string;
  updatedAt: string;
  fromBranch: TransferBranchRef;
  toBranch: TransferBranchRef;
  requester: TransferUserRef;
  approver: TransferUserRef | null;
  receiver: TransferUserRef | null;
  items: TransferItem[];
  totalQty?: number;
  dispatchedQty?: number;
  receivedQty?: number;
  receivedPercent?: number;
};

export type CreateTransferLine = {
  key: string;
  productId: string;
  batchId: string;
  qty: string;
};

export type CreateTransferLinePayload = {
  productId: string;
  batchId: string;
  qty: number;
};

export type ReceiveTransferLineForm = {
  transferItemId: string;
  qty: string;
  max: number;
};

export const PAGE_SIZE = 10;

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
export const APPROVE_ROLES = new Set(["owner", "manager"]);
export const CANCEL_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
