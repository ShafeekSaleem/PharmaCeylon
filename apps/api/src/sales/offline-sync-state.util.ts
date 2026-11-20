import { OfflineStockDiscrepancyStatus, SaleStockPosting } from "@prisma/client";
import type { OfflineSaleSyncState } from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";

type SaleSyncInput = Readonly<{
  offlineCommandId: string | null;
  stockPosting: SaleStockPosting;
  openDiscrepancy: boolean;
}>;

/** Emitted sync states only — `held` is reserved and never returned here. */
export function deriveOfflineSyncState(
  sale: SaleSyncInput,
): OfflineSaleSyncState | null {
  if (!sale.offlineCommandId) return null;
  if (
    sale.stockPosting === SaleStockPosting.pending_reconciliation ||
    sale.openDiscrepancy
  ) {
    return "pending_stock_posting";
  }
  return "accepted";
}

const EMITTED: readonly OfflineSaleSyncState[] = ["accepted", "pending_stock_posting"];

export function offlineSyncStateWhere(
  state: OfflineSaleSyncState,
): Prisma.SaleWhereInput {
  if (!EMITTED.includes(state)) {
    return { id: "00000000-0000-4000-8000-000000000000" };
  }
  const offline: Prisma.SaleWhereInput = { offlineCommandId: { not: null } };
  if (state === "accepted") {
    return {
      ...offline,
      stockPosting: SaleStockPosting.posted,
      offlineStockDiscrepancy: { is: null },
    };
  }
  return {
    ...offline,
    OR: [
      { stockPosting: SaleStockPosting.pending_reconciliation },
      {
        offlineStockDiscrepancy: {
          is: { status: OfflineStockDiscrepancyStatus.open },
        },
      },
    ],
  };
}