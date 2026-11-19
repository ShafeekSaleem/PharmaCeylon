import type { ReportSyncFreshness } from "@pharmaceylon/shared";
import { salesZeroNote } from "./sales-zero";

const now = new Date("2026-11-19T06:30:00Z"); // 12:00 in Colombo

type Counter = ReportSyncFreshness["branches"][number]["counters"][number];

function freshness(counters: Partial<Counter>[]): ReportSyncFreshness {
  return {
    days: 1,
    asOf: now.getTime(),
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

it("names the counter that hasn't reported since the branch's day began", () => {
  // 23:00 on the 18th in Colombo: the same UTC date as "today", a different branch day.
  const lastNight = Date.parse("2026-11-18T17:30:00Z");
  expect(
    salesZeroNote(freshness([{ lastAcceptedAt: lastNight }]), now),
  ).toEqual({
    text: "Counter 1 hasn't sent sales yet today",
    warning: true,
  });
});

it("counts several quiet counters and puts a stopped upload first", () => {
  expect(salesZeroNote(freshness([{}, {}]), now).text).toBe(
    "2 counters haven't sent sales yet today",
  );
  const stopped = {
    sequence: 4,
    outcome: "held",
    since: 1,
  } as unknown as Counter["stoppedAt"];
  expect(salesZeroNote(freshness([{}, { stoppedAt: stopped }]), now)).toEqual({
    text: "Counter 2 has stopped sending sales",
    warning: true,
  });
});

it("is a plain zero when every counter has reported or there are none", () => {
  const thisMorning = Date.parse("2026-11-19T03:00:00Z");
  expect(
    salesZeroNote(freshness([{ lastAcceptedAt: thisMorning }]), now),
  ).toEqual({
    text: "Every counter has reported; no sales yet",
    warning: false,
  });
  expect(salesZeroNote(freshness([]), now).warning).toBe(false);
  expect(salesZeroNote(null, now).text).toBe("No sales recorded yet today");
});
