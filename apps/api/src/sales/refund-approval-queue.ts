import { Prisma } from "@prisma/client";

/** Shared by the approval inbox and daily work/notifications. Aliases: r, a, ts. */
export function refundNeedsApprovalSql(): Prisma.Sql {
  return Prisma.sql`(
    (r.execution_approval_id IS NOT NULL OR r.approval_required OR (ts.approval_required_return_threshold IS NOT NULL
      AND r.amount >= ts.approval_required_return_threshold))
    AND (r.execution_approval_id IS NULL OR a.id IS NULL OR a.revoked_at IS NOT NULL)
  )`;
}
