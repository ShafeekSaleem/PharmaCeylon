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

  it("returns held when an open stock case is linked", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.pending_reconciliation,
        openDiscrepancy: true,
      }),
    ).toBe("held");
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.posted,
        openDiscrepancy: true,
      }),
    ).toBe("held");
  });

  it("returns pending_stock_posting only without an open case", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.pending_reconciliation,
        openDiscrepancy: false,
      }),
    ).toBe("pending_stock_posting");
  });

  it("returns accepted when posted and no open case", () => {
    expect(
      deriveOfflineSyncState({
        offlineCommandId: "cmd-1",
        stockPosting: SaleStockPosting.posted,
        openDiscrepancy: false,
      }),
    ).toBe("accepted");
  });
});

describe("offlineSyncStateWhere", () => {
  it("defines mutually exclusive filters", () => {
    expect(offlineSyncStateWhere("held")).toMatchObject({
      offlineCommandId: { not: null },
      offlineStockDiscrepancy: { is: { status: "open" } },
    });
    expect(offlineSyncStateWhere("pending_stock_posting")).toMatchObject({
      stockPosting: SaleStockPosting.pending_reconciliation,
    });
    expect(offlineSyncStateWhere("pending_stock_posting").NOT).toBeDefined();
    expect(offlineSyncStateWhere("accepted")).toMatchObject({
      stockPosting: SaleStockPosting.posted,
    });
  });
});