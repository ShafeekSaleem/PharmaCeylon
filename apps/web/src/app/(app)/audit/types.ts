export type AuditActor = { id: string; fullName: string; email: string } | null;
export type AuditBranch = { id: string; name: string } | null;

export type AuditEventRow = {
  id: string;
  tenantId: string;
  branchId: string | null;
  actorUserId: string | null;
  eventName: string;
  entityName: string;
  entityId: string;
  payload: unknown;
  createdAt: string;
  critical: boolean;
  actor: AuditActor;
  branch: AuditBranch;
  /** Human-readable name/reference for the entity (product name, PO number, ...), when resolvable. */
  entityLabel: string | null;
};

export type AuditEventsResponse = {
  items: AuditEventRow[];
  total: number;
  take: number;
  skip: number;
};

export type AuditSummary = {
  eventsToday: number;
  activeActors: number;
  criticalActions: number;
  failedLogins: number;
};

export type AuditModuleFilter =
  | "all"
  | "sales"
  | "purchasing"
  | "returns"
  | "inventory"
  | "products"
  | "suppliers"
  | "transfers"
  | "stocktakes"
  | "users"
  | "security";

export type AuditActionFilter = "all" | string;
export type AuditSeverityFilter = "all" | "critical";
export type AuditDateRangeFilter = "all" | "today" | "7" | "30" | "90";
/** "branch" resolves to whatever branch is currently selected in the topbar switcher. */
export type AuditBranchScope = "all" | "branch";

export type AuditFilters = {
  q: string;
  module: AuditModuleFilter;
  action: AuditActionFilter;
  severity: AuditSeverityFilter;
  dateRange: AuditDateRangeFilter;
  branchScope: AuditBranchScope;
  /** Deep-link scoping from another page's "view audit trail" link — not user-editable. */
  entityName: string | null;
  entityId: string | null;
  /** Human-readable name for the scoped entity (e.g. a product name), when the linking page sent one. */
  entityLabel: string | null;
};
