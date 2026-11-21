import { RoleAccessDenied } from "@/components/role-access";
import { ApiError } from "@/lib/api-error";

/** Matches PR #247 review: all three queue routes require `tenant.management`. */
export const SALES_QUEUE_ACCESS_DENIED =
  "Your role can't review recovery queues at this branch. Ask an owner or manager.";

export function isSalesQueueForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export function SalesQueueAccessDenied() {
  return (
    <RoleAccessDenied
      title="Insufficient permissions"
      description={SALES_QUEUE_ACCESS_DENIED}
    />
  );
}
