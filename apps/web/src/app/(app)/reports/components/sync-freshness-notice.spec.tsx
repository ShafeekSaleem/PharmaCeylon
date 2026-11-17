import { render, screen } from "@testing-library/react";
import type {
  ReportSyncFreshness,
  ReportSyncFreshnessBranch,
} from "@pharmaceylon/shared";
import { SyncFreshnessCaveat, freshnessLines } from "./sync-freshness-notice";

jest.mock("../lib/fetchers", () => ({ fetchOfflineSyncFreshness: jest.fn() }));

const ZONE = "Asia/Colombo";
// 15:30 in Colombo (UTC+05:30).
const now = new Date(Date.UTC(2026, 10, 10, 10, 0));
const colombo = (hour: number, minute: number) =>
  Date.UTC(2026, 10, 10, hour, minute) - 5.5 * 3_600_000;

type Counter = ReportSyncFreshnessBranch["counters"][number];
const counter = (over: Partial<Counter> = {}): Counter => ({
  enrollmentId: "e1",
  terminalLabel: "FRONT-PC",
  current: true,
  lastAcceptedAt: colombo(14, 2),
  lastReceivedAt: colombo(14, 2),
  stoppedAt: null,
  openStockCases: 0,
  ...over,
});
const branch = (
  over: Partial<ReportSyncFreshnessBranch> = {},
): ReportSyncFreshnessBranch => ({
  branchId: "b1",
  branchName: "Kandy",
  timezone: ZONE,
  pendingStockSales: 0,
  counters: [counter()],
  ...over,
});
const freshness = (
  branches: ReportSyncFreshnessBranch[],
  complete: boolean,
): ReportSyncFreshness => ({
  days: 30,
  asOf: now.getTime(),
  complete,
  branches,
});

describe("report sync freshness caveat (P5 #51 item 11)", () => {
  it("says nothing when no counter has sent an offline journal", () => {
    const { container } = render(
      <SyncFreshnessCaveat freshness={freshness([], true)} now={now} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("gives each counter's last accepted sync in the branch's time when all is in", () => {
    render(
      <SyncFreshnessCaveat freshness={freshness([branch()], true)} now={now} />,
    );
    expect(screen.getByText(/all in these figures/)).toBeInTheDocument();
    expect(
      screen.getByText("FRONT-PC: last synced 14:02."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Counters" })).toHaveAttribute(
      "href",
      "/settings/counters",
    );
  });

  it("warns that totals may be incomplete for a held or refused journal, stock cases and pending stock", () => {
    const lines = freshnessLines(
      freshness(
        [
          branch({
            pendingStockSales: 2,
            counters: [
              counter({
                stoppedAt: {
                  sequence: 7,
                  outcome: "held",
                  errorCode: "X",
                  since: colombo(13, 0),
                },
              }),
              counter({
                enrollmentId: "e2",
                terminalLabel: "BACK-PC",
                current: false,
                openStockCases: 1,
                stoppedAt: {
                  sequence: 3,
                  outcome: "rejected",
                  errorCode: "X",
                  since: colombo(12, 0),
                },
              }),
            ],
          }),
          branch({
            branchId: "b2",
            branchName: "Galle",
            counters: [counter({ lastAcceptedAt: null })],
          }),
        ],
        false,
      ),
      now,
    );
    expect(lines).toEqual([
      "Kandy · FRONT-PC: last synced 14:02; entry 7 waiting since 13:00; sales after it haven't reached the server yet.",
      "Kandy · BACK-PC (earlier key or computer): last synced 14:02; stopped at refused entry 3 since 12:00; sales after it won't reach the server until it is reviewed; 1 stock case open.",
      "Kandy: 2 offline sales in this range are recorded, but stock hasn't posted yet: stock figures don't show those units leaving.",
      "Galle · FRONT-PC: no offline sales accepted yet.",
    ]);
    render(
      <SyncFreshnessCaveat
        freshness={freshness([branch({ pendingStockSales: 1 })], false)}
        now={now}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "These figures may be incomplete.",
    );
  });
});
