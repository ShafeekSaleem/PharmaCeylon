import { render, screen } from "@testing-library/react";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
} from "@pharmaceylon/shared";
import {
  CounterOfflineSales,
  offlineSyncSummary,
  syncTime,
  waitingSummary,
} from "./offline-sync";

const now = new Date(2026, 10, 10, 15, 30);
const view = (
  over: Partial<CounterJournalSyncView> = {},
): CounterJournalSyncView => ({
  enrollmentId: "e1",
  terminalId: "t1",
  terminalLabel: "FRONT-PC",
  registerId: "r1",
  current: true,
  revokedAt: null,
  retiredAt: null,
  head: null,
  lastUploadAt: null,
  waiting: 0,
  needsReview: 0,
  stuck: null,
  openStockCases: 0,
  ...over,
});
const counter: TerminalCounterView = {
  registerId: "r1",
  tillId: "till",
  label: "Front",
  isActive: true,
  terminal: {
    terminalId: "t1",
    label: "FRONT-PC",
    enrollmentId: "e1",
    enrolledAt: 0,
  },
};

describe("offline sales summary (P5 #51)", () => {
  it("shows only the clock for today and adds the date otherwise", () => {
    const today = new Date(2026, 10, 10, 14, 2).getTime();
    const earlier = new Date(2026, 10, 3, 14, 2).getTime();
    expect(syncTime(today, now)).toBe(
      new Date(today).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(syncTime(earlier, now)).not.toBe(syncTime(today, now));
    expect(syncTime(earlier, now)).toContain(syncTime(today, now));
  });

  it("leaves out whichever count is zero", () => {
    expect(waitingSummary(view({ waiting: 3, needsReview: 1 }))).toBe(
      "3 waiting / 1 needs review",
    );
    expect(waitingSummary(view({ waiting: 2 }))).toBe("2 waiting");
    expect(waitingSummary(view({ needsReview: 2 }))).toBe("2 need review");
    expect(waitingSummary(view())).toBeNull();
  });

  it("is all on the server only when nothing it sent waits", () => {
    const at = new Date(2026, 10, 10, 14, 2).getTime();
    expect(
      offlineSyncSummary(
        view({ lastUploadAt: at, head: { sequence: 3, acceptedAt: at } }),
        now,
      ),
    ).toEqual({
      text: `All on the server, last sync ${syncTime(at, now)}`,
      tone: "ok",
    });
    expect(
      offlineSyncSummary(view({ lastUploadAt: at, waiting: 1 }), now).tone,
    ).toBe("waiting");
    expect(
      offlineSyncSummary(view({ lastUploadAt: at, needsReview: 1 }), now).tone,
    ).toBe("review");
    expect(offlineSyncSummary(view(), now)).toEqual({
      text: "No offline sales sent yet",
      tone: "none",
    });
  });

  it("explains a journal stopped on a conflict", () => {
    render(
      <CounterOfflineSales
        counter={counter}
        failed={false}
        now={now}
        journal={[
          view({
            needsReview: 1,
            stuck: {
              sequence: 7,
              outcome: "conflict",
              errorCode: "REPLAY_CONFLICT",
              since: 0,
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText("1 needs review")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Stopped at entry 7, which doesn't match the server's copy/,
      ),
    ).toBeInTheDocument();
  });

  it("names a retired computer that still has stock cases open", () => {
    render(
      <CounterOfflineSales
        counter={{ ...counter, terminal: null }}
        failed={false}
        now={now}
        journal={[
          view({
            enrollmentId: "old",
            current: false,
            retiredAt: 0,
            terminalLabel: "OLD-PC",
            openStockCases: 1,
          }),
        ]}
      />,
    );
    expect(
      screen.getByText(/Retired computer OLD-PC: nothing waiting/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "1 stock case open" }),
    ).toHaveAttribute("href", "/inventory/stock-cases");
  });
});
