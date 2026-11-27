import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OfflineActivityReportResponse, OfflineOutageRow } from "../lib/types";
import { duration, OfflineActivitySection } from "./offline-activity-section";
import { fetchOfflineActivityReport } from "../lib/fetchers";

jest.mock("../lib/fetchers", () => ({ fetchOfflineActivityReport: jest.fn() }));

const MIN = 60_000;
const row = (over: Partial<OfflineOutageRow>): OfflineOutageRow => ({
  key: "t1:o1",
  offlineSessionId: "o1",
  branchId: "b1",
  branchName: "Kandy",
  terminalId: "t1",
  terminalLabel: "FRONT-PC",
  counterLabel: "Counter 1",
  startedAt: "2026-11-25T03:00:00.000Z",
  lastEntryAt: "2026-11-25T05:05:00.000Z",
  offlineForMs: 125 * MIN,
  entries: 4,
  sales: 3,
  salesTotalMinor: 450_000,
  salesNotHonoured: 0,
  shiftsOpened: 1,
  shiftsClosed: 0,
  firstSyncedAt: "2026-11-25T05:20:00.000Z",
  lastSyncedAt: "2026-11-25T05:25:00.000Z",
  timeToSyncMs: 20 * MIN,
  firstSyncAfterMs: 15 * MIN,
  awaitingReview: 0,
  rejected: 0,
  stockPendingSales: 1,
  staff: [{ id: "u1", name: "Amara" }],
  status: "synced",
  ...over,
});

const held = row({
  key: "t1:o2",
  offlineSessionId: "o2",
  startedAt: "2026-11-26T03:00:00.000Z",
  offlineForMs: 30 * MIN,
  sales: 1,
  salesTotalMinor: 9_000,
  timeToSyncMs: null,
  awaitingReview: 2,
  stockPendingSales: 0,
  status: "needs_review",
});

const response: OfflineActivityReportResponse = {
  days: 30,
  timeZone: "Asia/Colombo",
  since: "2026-10-28T18:30:00.000Z",
  before: "2026-11-27T18:30:00.000Z",
  kpis: {
    outages: 2,
    countersAffected: 1,
    offlineForMs: 155 * MIN,
    longestOfflineForMs: 125 * MIN,
    sales: 4,
    salesTotalMinor: 459_000,
    salesNotHonoured: 0,
    medianTimeToSyncMs: 20 * MIN,
    longestTimeToSyncMs: 20 * MIN,
    outagesNeedingReview: 1,
    entriesAwaitingReview: 2,
    stockPendingSales: 1,
  },
  byCounter: [{ terminalId: "t1", label: "Counter 1", branchName: "Kandy", outages: 2, offlineForMs: 155 * MIN, sales: 4, salesTotalMinor: 459_000, awaitingReview: 2 }],
  outages: [held, row({})],
};

describe("duration", () => {
  it("reads minutes, hours and days", () => {
    expect(duration(null)).toBe("—");
    expect(duration(20_000)).toBe("<1 min");
    expect(duration(45 * MIN)).toBe("45 min");
    expect(duration(125 * MIN)).toBe("2 h 5 min");
    expect(duration(120 * MIN)).toBe("2 h");
    expect(duration(76 * 60 * MIN)).toBe("3 d 4 h");
  });
});

describe("OfflineActivitySection", () => {
  beforeEach(() => (fetchOfflineActivityReport as jest.Mock).mockResolvedValue(response));

  it("shows each outage with how long it lasted, what it sold and how it synced", async () => {
    render(<OfflineActivitySection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    expect(await screen.findByText("2 entries to review")).toBeInTheDocument();
    expect(screen.getAllByText("2 h 5 min").length).toBeGreaterThan(0);
    expect(screen.getByText("1 sale with a stock case")).toBeInTheDocument();
    expect(screen.getByText("Not yet")).toBeInTheDocument();
    expect(screen.getByText("2 entries awaiting review")).toBeInTheDocument();
  });

  it("filters to the outages with entries to review", async () => {
    render(<OfflineActivitySection scope="branch" isOwner={false} days={30} onExportData={jest.fn()} />);
    await screen.findByText("2 entries to review");
    fireEvent.click(screen.getByRole("button", { name: "Status" }));
    fireEvent.click(screen.getByRole("option", { name: "Fully synced" }));
    await waitFor(() => expect(screen.queryByText("2 entries to review")).not.toBeInTheDocument());
    expect(screen.getByText("Synced")).toBeInTheDocument();
  });

  it("exports every outage with its durations in minutes", async () => {
    const onExport = jest.fn();
    render(<OfflineActivitySection scope="branch" isOwner={false} days={30} onExportData={onExport} />);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.objectContaining({ filename: "offline-activity-30d.csv" })));
    const payload = onExport.mock.calls.find((c) => c[0])![0];
    expect(payload.rows).toHaveLength(2);
    expect(payload.rows[1]).toEqual(expect.arrayContaining(["o1", "Counter 1", "Amara", 125, "4500.00", 20, "synced"]));
    expect(payload.rows[0]).toEqual(expect.arrayContaining(["o2", "", "needs_review"]));
  });
});
