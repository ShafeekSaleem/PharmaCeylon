import { OfflineStockDiscrepancyStatus, SaleStockPosting } from "@prisma/client";
import type { OfflineSaleSyncState } from "@pharmaceylon/shared";
import type { Prisma } from "@prisma/client";

type SaleSyncInput = Readonly<{
  offlineCommandId: string | null;
  stockPosting: SaleStockPosting;
  openDiscrepancy: boolean;
}>;

/** Mutually exclusive states for offline-replayed sales on the server. */
export function deriveOfflineSyncState(
  sale: SaleSyncInput,
): OfflineSaleSyncState | null {
  if (!sale.offlineCommandId) return null;
  if (sale.openDiscrepancy) return "held";
  if (sale.stockPosting === SaleStockPosting.pending_reconciliation) {
    return "pending_stock_posting";
  }
  return "accepted";
}

const OPEN_CASE = {
  offlineStockDiscrepancy: {
    is: { status: OfflineStockDiscrepancyStatus.open },
  },
} satisfies Prisma.SaleWhereInput;

/** No row linked, or only a resolved/closed case. */
const NO_OPEN_CASE: Prisma.SaleWhereInput = {
  NOT: OPEN_CASE,
};

export function offlineSyncStateWhere(
  state: OfflineSaleSyncState,
): Prisma.SaleWhereInput {
  const offline: Prisma.SaleWhereInput = { offlineCommandId: { not: null } };
  switch (state) {
    case "held":
      return { ...offline, ...OPEN_CASE };
    case "pending_stock_posting":
      return {
        ...offline,
        stockPosting: SaleStockPosting.pending_reconciliation,
        ...NO_OPEN_CASE,
      };
    case "accepted":
      return {
        ...offline,
        stockPosting: SaleStockPosting.posted,
        ...NO_OPEN_CASE,
      };
    default:
      return { id: "00000000-0000-4000-8000-000000000000" };
  }
}