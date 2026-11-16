import type { Prisma } from "@prisma/client";
import { safeTimeZone } from "../../common/business-date.util";

/**
 * The branch's timezone for the back office's journal views (sync status, recoveries, restores),
 * so a manager looking from abroad reads the branch's own clock. A missing or bad zone falls back
 * to the tenant default rather than failing the read.
 */
export async function branchTimeZone(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
): Promise<string> {
  const branch = await tx.branch.findFirst({
    where: { tenantId, id: branchId },
    select: { timezone: true },
  });
  return safeTimeZone(branch?.timezone);
}
