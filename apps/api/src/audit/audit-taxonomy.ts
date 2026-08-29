/**
 * Shared classification for AuditEvent rows, used by both the events list (module/severity
 * filters) and the summary endpoint (KPI counts) so the two stay in lockstep.
 */

export type AuditModuleKey =
  | "sales"
  | "purchasing"
  | "returns"
  | "inventory"
  | "products"
  | "suppliers"
  | "transfers"
  | "stocktakes"
  | "users"
  | "security"
  | "settings";

export const AUDIT_MODULE_EVENT_PREFIXES: Record<AuditModuleKey, string[]> = {
  sales: ["sale"],
  purchasing: ["purchase_order", "goods_receipt"],
  returns: ["return"],
  inventory: ["inventory", "batch", "stock_adjustment"],
  products: ["product", "products"],
  suppliers: ["supplier", "supplier_invoice"],
  transfers: ["transfer"],
  stocktakes: ["stocktake"],
  users: ["user", "role"],
  security: ["auth"],
  settings: ["tenant", "branch", "tenant_settings"],
};

export function eventNamePrefixesForModule(moduleKey: string): string[] | null {
  return AUDIT_MODULE_EVENT_PREFIXES[moduleKey as AuditModuleKey] ?? null;
}

/**
 * Exact eventName values considered critical — void/refund, destructive or
 * access-affecting changes, and security-sensitive events. Kept as an explicit
 * allowlist (rather than inferred from the verb) since e.g. "updated" is routine
 * for most entities but a role permission update is not.
 */
export const CRITICAL_AUDIT_EVENT_NAMES: ReadonlySet<string> = new Set([
  "sale.voided",
  "sale.refunded",
  "user.deleted",
  "user.deactivated",
  "user.sessions.force_logout",
  "user.branch_role.removed",
  "role.deleted",
  "role.permissions_updated",
  "purchase_order.rejected",
  "purchase_order.short_closed",
  "purchase_order.cancelled",
  "transfer.rejected",
  "transfer.cancelled",
  "return.rejected",
  "return.cancelled",
  "batch.quarantined",
  "auth.login_failed",
]);

export function isCriticalAuditEvent(eventName: string): boolean {
  return CRITICAL_AUDIT_EVENT_NAMES.has(eventName);
}
