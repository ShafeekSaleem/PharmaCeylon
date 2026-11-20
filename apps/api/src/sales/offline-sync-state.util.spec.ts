import { SaleStockPosting } from "@prisma/client";
import { deriveOfflineSyncState, offlineSyncStateWhere } from "./offline-sync-state.util";

describe("deriveOfflineSyncState", () => {
  it("returns null for online sales", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: null,
        stockPosting: SaleStockPosting.posted,
        openDiscrepancy: false,
      }),
    ).toBeNull();
  });

  it("returns accepted when stock is posted and no open case", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.posted,
        openDiscrepancy: false,
      }),
    ).toBe("accepted");
  });

  it("returns pending_stock_posting when stock is pending or a case is open", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.pending_reconciliation,
        openDiscrepancy: false,
      }),
    ).toBe("pending_stock_posting");
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.posted,
        openDiscrepancy: true,
      }),
    ).toBe("pending_stock_posting");
  });
});

describe("offlineSyncStateWhere", () => {
  it("reserved held matches nothing", () => {
    expect(offlineSyncStateWhere("held")).toEqual({
      id: "00000000-0000-4000-8000-000000000000",
    });
  });
});