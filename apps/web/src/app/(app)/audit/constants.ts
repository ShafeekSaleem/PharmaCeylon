import type {
  AuditActionFilter,
  AuditDateRangeFilter,
  AuditFilters,
  AuditModuleFilter,
  AuditSeverityFilter,
} from "./types";

export const PAGE_SIZE = 25;

export const MODULE_OPTIONS: { value: AuditModuleFilter; label: string }[] = [
  { value: "all", label: "All modules" },
  { value: "sales", label: "Sales" },
  { value: "purchasing", label: "Purchasing" },
  { value: "returns", label: "Returns" },
  { value: "inventory", label: "Inventory & batches" },
  { value: "products", label: "Products & catalog" },
  { value: "suppliers", label: "Suppliers" },
  { value: "transfers", label: "Transfers" },
  { value: "stocktakes", label: "Stocktakes" },
  { value: "users", label: "Users & roles" },
  { value: "security", label: "Security" },
];

/** Each value is matched against `eventName` with a case-insensitive substring filter. */
export const ACTION_OPTIONS: { value: AuditActionFilter; label: string }[] = [
  { value: "all", label: "Any action" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "cancelled", label: "Cancelled" },
  { value: "deleted", label: "Deleted" },
  { value: "voided", label: "Voided" },
  { value: "refunded", label: "Refunded" },
  { value: "login_failed", label: "Login failed" },
];

export const DATE_RANGE_OPTIONS: { value: AuditDateRangeFilter; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
];

export const DEFAULT_FILTERS: AuditFilters = {
  q: "",
  module: "all",
  action: "all",
  severity: "all",
  dateRange: "all",
  branchScope: "all",
  entityName: null,
  entityId: null,
  entityLabel: null,
};

export type QuickCapsule = {
  key: string;
  label: string;
  module: AuditModuleFilter;
  severity: AuditSeverityFilter;
  dateRange: AuditDateRangeFilter;
};

/**
 * One-click presets layered over the dropdown filters — each fully replaces the
 * module/severity/date-range trio (leaving search/action untouched) rather than
 * merging on top of whatever is already selected.
 */
export const QUICK_CAPSULES: QuickCapsule[] = [
  { key: "all", label: "All activity", module: "all", severity: "all", dateRange: "all" },
  { key: "today", label: "Today", module: "all", severity: "all", dateRange: "today" },
  { key: "critical", label: "Critical", module: "all", severity: "critical", dateRange: "all" },
  { key: "sales", label: "Sales", module: "sales", severity: "all", dateRange: "all" },
  { key: "purchasing", label: "Purchasing", module: "purchasing", severity: "all", dateRange: "all" },
  { key: "inventory", label: "Inventory", module: "inventory", severity: "all", dateRange: "all" },
  { key: "users", label: "Users & roles", module: "users", severity: "all", dateRange: "all" },
  { key: "security", label: "Security", module: "security", severity: "all", dateRange: "all" },
];
