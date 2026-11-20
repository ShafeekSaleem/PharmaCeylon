/** Sales workspace tab keys (deep links from Daily work, W4 #66 Phase D). */
export const SALES_VIEW_KEYS = [
  "pending-approvals",
  "incident-notes",
  "payment-recovery",
  "unresolved-money",
] as const;

export type SalesWorkspaceView = (typeof SALES_VIEW_KEYS)[number];

export function isSalesWorkspaceView(value: string | null): value is SalesWorkspaceView {
  return value !== null && (SALES_VIEW_KEYS as readonly string[]).includes(value);
}

export function salesViewHref(view: SalesWorkspaceView | null): string {
  if (!view || view === "pending-approvals") {
    return view === "pending-approvals" ? "/sales?view=pending-approvals" : "/sales";
  }
  return `/sales?view=${view}`;
}