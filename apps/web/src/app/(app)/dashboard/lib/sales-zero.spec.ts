import type { ReportSyncFreshness } from "@pharmaceylon/shared";
import { salesZeroNote } from "./sales-zero";

type Counter = ReportSyncFreshness["branches"][number]["counters"][number];

function freshness(counters: Partial<Counter>[]): ReportSyncFreshness {
  return {
    days: 1,
    asOf: Date.parse("2026-11-19T06:30:00Z"),
    complete: true,
    branches: [
      {
        branchId: "b1",
        branchName: "Kandy",
        timezone: "Asia/Colombo",
        pendingStockSales: 0,
        counters: counters.map((c, i) => ({
          enrollmentId: `e${i}`,
          terminalLabel: `Counter ${i + 1}`,
          current: true,
          lastAcceptedAt: null,
          lastReceivedAt: null,
          stoppedAt: null,
          openStockCases: 0,
          ...c,
        })),
      },
    ],
  } as unknown as ReportSyncFreshness;
}

const stopped = {
  sequence: 4,
  outcome: "held",
  since: 1,
} as unknown as Counter["stoppedAt"];

it("does not flag a quiet morning: an old offline-journal entry says nothing about today", () => {
  // The counter last went offline a week ago; it sells online today, which the journal never sees.
  const lastWeek = Date.parse("2026-11-12T05:00:00Z");
  expect(
    salesZeroNote(freshness([{ lastAcceptedAt: lastWeek, lastReceivedAt: lastWeek }])),
  ).toEqual({ text: "No sales recorded yet today", warning: false });
  expect(salesZeroNote(freshness([{}, {}])).warning).toBe(false);
});

it("names a counter whose offline upload has stopped, and counts several", () => {
  expect(salesZeroNote(freshness([{}, { stoppedAt: stopped }]))).toEqual({
    text: "Counter 2 has offline sales that haven't uploaded",
    warning: true,
  });
  expect(
    salesZeroNote(freshness([{ stoppedAt: stopped }, { stoppedAt: stopped }])).text,
  ).toBe("2 counters have offline sales that haven't uploaded");
});

it("ignores a retired counter's stopped journal, and is a plain zero with nothing to read", () => {
  expect(salesZeroNote(freshness([{ stoppedAt: stopped, current: false }])).warning).toBe(false);
  expect(salesZeroNote(freshness([])).warning).toBe(false);
  expect(salesZeroNote(null).text).toBe("No sales recorded yet today");
});
