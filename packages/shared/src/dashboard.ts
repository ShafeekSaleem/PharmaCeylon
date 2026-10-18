export type WorkCategory =
  | "purchasing"
  | "transfers"
  | "returns"
  | "stocktakes"
  | "counter"
  | "inventory";
export type WorkFilter = "all" | "mine" | "approvals" | "overdue";

export type DailyWorkItem = {
  id: string;
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
