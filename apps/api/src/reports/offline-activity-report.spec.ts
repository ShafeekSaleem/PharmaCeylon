import { buildOfflineActivityReport, median, outageRow, type OfflineActivityContext, type OfflineEntry } from "./offline-activity-report";

const ctx: OfflineActivityContext = {
  branchName: () => "Kandy",
  terminal: (id) => (id === "t1" ? { label: "FRONT-PC", counterLabel: "Counter 1" } : { label: null, counterLabel: null }),
  person: (id) => (id === "u1" ? "Amara" : "Kamal"),
};

const base = Date.UTC(2026, 10, 20, 4, 0);
const min = (m: number) => new Date(base + m * 60_000);
const meta = { days: 30, timeZone: "Asia/Colombo", since: new Date("2026-10-28T18:30:00Z"), before: new Date("2026-11-27T18:30:00Z") };

let n = 0;
const entry = (over: Partial<OfflineEntry>): OfflineEntry => ({
  commandId: `c${++n}`,
  branchId: "b1",
  terminalId: "t1",
  offlineSessionId: "o1",
  offlineStartedAt: min(0),
  occurredAt: min(10),
  kind: "ordinary_sale",
  totalMinor: 10_000,
  syncedAt: min(70),
  receivedAt: min(70),
  review: null,
  staffUserId: "u1",
  saleRecorded: true,
  stockPending: false,
  ...over,
});

describe("outageRow", () => {
  it("measures the outage from going offline to the last entry, and sync from the last entry", () => {
    const row = outageRow(
      [
        entry({ kind: "shift_open", occurredAt: min(1), totalMinor: 0, saleRecorded: false, syncedAt: min(65), receivedAt: min(65) }),
        entry({ occurredAt: min(10), totalMinor: 25_000 }),
        entry({ occurredAt: min(40), totalMinor: 5_000, staffUserId: "u2", stockPending: true, syncedAt: min(75), receivedAt: min(75) }),
      ],
      ctx,
    );
    expect(row).toMatchObject({
      key: "t1:o1",
      counterLabel: "Counter 1",
      offlineForMs: 40 * 60_000,
      entries: 3,
      sales: 2,
      salesTotalMinor: 30_000,
      shiftsOpened: 1,
      firstSyncedAt: min(65).toISOString(),
      lastSyncedAt: min(75).toISOString(),
      timeToSyncMs: 35 * 60_000,
      firstSyncAfterMs: 25 * 60_000,
      stockPendingSales: 1,
      status: "synced",
    });
    expect(row.staff.map((s) => s.name)).toEqual(["Amara", "Kamal"]);
  });

  it("leaves time to sync open while an entry waits for review, and does not count it as a sale", () => {
    const row = outageRow(
      [entry({}), entry({ occurredAt: min(20), review: "held", syncedAt: null, receivedAt: min(80), saleRecorded: false })],
      ctx,
    );
    expect(row).toMatchObject({ sales: 1, awaitingReview: 1, timeToSyncMs: null, status: "needs_review" });
  });

  it("counts a sale entry a manager did not honour apart from recorded sales", () => {
    const row = outageRow([entry({}), entry({ saleRecorded: false, totalMinor: 9_000 })], ctx);
    expect(row).toMatchObject({ sales: 1, salesTotalMinor: 10_000, salesNotHonoured: 1 });
  });
});

describe("buildOfflineActivityReport", () => {
  it("groups by counter and session, keeps outages that started in the window, and rolls up", () => {
    const report = buildOfflineActivityReport(
      [
        entry({}),
        entry({ offlineSessionId: "o2", offlineStartedAt: min(200), occurredAt: min(260), syncedAt: min(261), receivedAt: min(261) }),
        entry({ terminalId: "t2", offlineSessionId: "o1", review: "rejected", syncedAt: null, saleRecorded: false }),
        // Started before the window: left out even though it synced inside it.
        entry({ offlineSessionId: "old", offlineStartedAt: new Date("2026-10-01T00:00:00Z"), occurredAt: new Date("2026-10-01T01:00:00Z") }),
      ],
      ctx,
      meta,
    );
    expect(report.outages.map((o) => o.key)).toEqual(["t1:o2", "t1:o1", "t2:o1"]);
    expect(report.kpis).toMatchObject({
      outages: 3,
      countersAffected: 2,
      offlineForMs: 80 * 60_000,
      longestOfflineForMs: 60 * 60_000,
      sales: 2,
      salesTotalMinor: 20_000,
      medianTimeToSyncMs: 30.5 * 60_000,
      longestTimeToSyncMs: 60 * 60_000,
      outagesNeedingReview: 1,
      entriesAwaitingReview: 1,
    });
    expect(report.byCounter.map((c) => [c.label, c.outages])).toEqual([
      ["Counter 1", 2],
      ["Unknown counter", 1],
    ]);
  });

  it("takes the middle of the sync times", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(3);
  });
});
