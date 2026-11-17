import type { CounterJournalSyncView } from "@pharmaceylon/shared";
import { reportSyncFreshness, type FreshnessInput } from "./report-sync-freshness";

const view = (over: Partial<CounterJournalSyncView> = {}): CounterJournalSyncView => ({
  enrollmentId: "e1",
  terminalId: "t1",
  terminalLabel: "Front till",
  registerId: "r1",
  current: true,
  revokedAt: null,
  retiredAt: null,
  head: null,
  lastReceivedAt: null,
  stoppedAt: null,
  openStockCases: 0,
  ...over,
});

const branch = (over: Partial<FreshnessInput> = {}): FreshnessInput => ({
  branchId: "b1",
  branchName: "Kandy",
  timezone: "Asia/Colombo",
  pendingStockSales: 0,
  views: [],
  ...over,
});

const asOf = new Date(1_800_000_000_000);

describe("reportSyncFreshness (P5 #51 item 11)", () => {
  it("leaves out counters that never sent an offline journal, and branches with nothing to say", () => {
    const result = reportSyncFreshness(30, asOf, [branch({ views: [view()] })]);
    expect(result).toEqual({ days: 30, asOf: asOf.getTime(), complete: true, branches: [] });
  });

  it("names each synced counter's last accepted time and stays complete while nothing is outstanding", () => {
    const result = reportSyncFreshness(7, asOf, [
      branch({ views: [view({ head: { sequence: 12, acceptedAt: 1_000 }, lastReceivedAt: 1_500 })] }),
    ]);
    expect(result.complete).toBe(true);
    expect(result.branches[0]!.counters).toEqual([
      {
        enrollmentId: "e1",
        terminalLabel: "Front till",
        current: true,
        lastAcceptedAt: 1_000,
        lastReceivedAt: 1_500,
        stoppedAt: null,
        openStockCases: 0,
      },
    ]);
  });

  it.each([
    ["a held journal", { stoppedAt: { sequence: 4, outcome: "held" as const, errorCode: "SEQUENCE_GAP", since: 9 } }],
    ["a refused journal", { stoppedAt: { sequence: 4, outcome: "rejected" as const, errorCode: "X", since: 9 } }],
    ["an open stock case", { openStockCases: 1, head: { sequence: 3, acceptedAt: 5 } }],
  ])("is incomplete with %s", (_label, over) => {
    expect(reportSyncFreshness(30, asOf, [branch({ views: [view(over)] })]).complete).toBe(false);
  });

  it("is incomplete with in-range sales whose stock is pending, even with no counter listed", () => {
    const result = reportSyncFreshness(30, asOf, [branch({ pendingStockSales: 2 })]);
    expect(result.complete).toBe(false);
    expect(result.branches).toMatchObject([{ branchId: "b1", pendingStockSales: 2, counters: [] }]);
  });
});
