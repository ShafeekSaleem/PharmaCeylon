export type WorkCategory =
  | "purchasing"
  | "transfers"
  | "returns"
  | "stocktakes"
  | "counter"
  | "inventory";
export type WorkFilter = "all" | "mine" | "approvals" | "overdue" | "counter";

/** Where a work item is done (W9 #71). `counter`: in PharmaCeylon POS at the branch, because
 * the branch is live on desktop POS and the step moves stock or cash. Not-live branches: `web`. */
export type WorkPlace = "web" | "counter";

/** What a work item asks for. New "approved, waiting at the counter" document types add a kind
 * here and an adapter in the API's daily-work kinds registry. */
export const DAILY_WORK_KINDS = [
  "purchase_order.approve",
  "purchase_order.draft",
  "purchase_order.receive",
  "held_delivery.approve",
  "held_delivery.post",
  "held_adjustment.approve",
  "held_adjustment.post",
  "transfer.approve",
  "transfer.ship",
  "transfer.receive",
  "goods_return.approve",
  "goods_return.draft",
  "goods_return.complete",
  "stocktake.approve",
  "stocktake.post",
  "stocktake.complete",
  "stocktake.prepare",
  "stocktake.count",
  "import_stock.post",
  "held_sale.resume",
  "held_sale.pharmacist_review",
  "batch.expiry_review",
  "sale_refund.approve",
  "sale_refund.execute",
] as const;
export type DailyWorkKind = (typeof DAILY_WORK_KINDS)[number];

export type DailyWorkItem = {
  id: string;
  kind: DailyWorkKind;
  /** `counter` items are approved or ready, and wait for someone at the branch's counter. */
  where: WorkPlace;
  category: WorkCategory;
  title: string;
  detail: string;
  reference: string;
  status: string;
  href: string;
  action: string;
  createdAt: string;
  dueAt: string | null;
  owner: string;
  mine: boolean;
  approval: boolean;
  blocked: boolean;
  overdue: boolean;
  priority: number;
};

export type DailyWorkResponse = {
  items: DailyWorkItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<WorkFilter, number>;
  categories: Partial<Record<WorkCategory, number>>;
  asOf: string;
  timezone: string;
  branchName: string;
  /** The branch is live on desktop POS (fallback included), so physical steps are counter work. */
  counterLive: boolean;
};

export type DashboardSalesMetrics = {
  scope: "personal" | "branch";
  timezone: string;
  todayKey: string;
  today: { total: number; count: number; units: number };
  yesterday: { total: number; count: number; units: number };
  month: { total: number; count: number };
  hourly: Array<{ hour: number; total: number; count: number; units: number }>;
  trend: Array<{ label: string; value: number }>;
  payments: Array<{ method: string; value: number }>;
  products: Array<{ id: string; name: string; sku: string; qty: number }>;
  staff: Array<{
    id: string;
    name: string;
    sales: number;
    transactions: number;
  }>;
  holds: { count: number; value: number; pharmacist: number };
  refunds: { count: number; total: number };
};

export type DashboardStockMetrics = {
  low: number;
  out: number;
  controlledLow: number;
  controlledNearExpiry: number;
  controlledAttention: number;
};
