import { periodSummaryFromTransfers, receivedPercent } from "./utils";
import type { TransferListItem } from "./types";

const closedShort = {
  status: "received",
  createdAt: new Date().toISOString(),
  shortClosedAt: new Date().toISOString(),
  receivedQty: 6,
  totalQty: 10,
  items: [{ qty: 10, receivedQty: 6 }],
} as unknown as TransferListItem;

describe("a transfer closed short (P6 #52)", () => {
  it("is not shown as fully received", () => {
    expect(receivedPercent({ ...closedShort, receivedPercent: undefined } as TransferListItem)).toBe(60);
  });

  it("counts only the units that arrived in the period totals", () => {
    const summary = periodSummaryFromTransfers([closedShort], "all" as never);
    expect(summary.totalSent).toBe(10);
    expect(summary.totalReceived).toBe(6);
  });
});
