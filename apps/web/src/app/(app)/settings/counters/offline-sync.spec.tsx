import { render, screen } from "@testing-library/react";
import type {
  CounterJournalSyncView,
  TerminalCounterView,
} from "@pharmaceylon/shared";
import {
  CounterOfflineSales,
  offlineSyncSummary,
  stoppedHint,
  syncTime,
} from "./offline-sync";

const ZONE = "Asia/Colombo";
// 15:30 in Colombo (UTC+05:30).
const now = new Date(Date.UTC(2026, 10, 10, 10, 0));
const colombo = (day: number, hour: number, minute: number) =>
  Date.UTC(2026, 10, day, hour, minute) - 5.5 * 3_600_000;
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
  lastReceivedAt: null,
  stoppedAt: null,
  openStockCases: 0,
  ...over,
});
const stopped = (
  outcome: "held" | "rejected" | "conflict",
  sequence = 7,
): CounterJournalSyncView["stoppedAt"] => ({
  sequence,
  outcome,
  errorCode: "X",
  since: colombo(10, 14, 2),
});
const counter: TerminalCounterView = {
  registerId: "r1",
  tillId: "till",
  label: "Front",
  isActive: true,
  hasHistory: true,
  hasOpenShift: false,
  terminal: {
    terminalId: "t1",
    label: "FRONT-PC",
    enrollmentId: "e1",
    enrolledAt: 0,
  },
};

describe("offline sales summary (P5 #51)", () => {
  it("reads times on the branch's clock: only the time today, the date otherwise", () => {
    expect(syncTime(colombo(10, 14, 2), ZONE, now)).toBe("14:02");
    expect(syncTime(colombo(3, 14, 2), ZONE, now)).toBe("3 Nov, 14:02");
    // 23:30 on the 10th in Colombo is already the 11th's 00:30 there, though both are the 10th in UTC.
    const lateNow = new Date(Date.UTC(2026, 10, 10, 19, 0));
    const lastNight = Date.UTC(2026, 10, 10, 18, 0);
    expect(syncTime(lastNight, ZONE, lateNow)).toBe("10 Nov, 23:30");
    expect(syncTime(lastNight, "Europe/London", lateNow)).toBe("18:00");
  });

  it("is all on the server, with the last time something arrived, only while nothing stopped", () => {
    const at = colombo(10, 14, 2);
    expect(
      offlineSyncSummary(
        view({ lastReceivedAt: at, head: { sequence: 3, acceptedAt: at } }),
        ZONE,
        now,
      ),
    ).toEqual({ text: "All on the server, last received 14:02", tone: "ok" });
    expect(offlineSyncSummary(view(), ZONE, now)).toEqual({
      text: "No offline sales sent yet",
      tone: "none",
    });
  });

  it("names the entry it stopped at, never a count it can't know", () => {
    expect(
      offlineSyncSummary(view({ stoppedAt: stopped("held") }), ZONE, now),
    ).toEqual({ text: "Stopped at entry 7", tone: "waiting" });
    for (const outcome of ["rejected", "conflict"] as const)
      expect(
        offlineSyncSummary(view({ stoppedAt: stopped(outcome) }), ZONE, now)
          .tone,
      ).toBe("review");
  });

  it("says what moves each kind of stop on", () => {
    expect(stoppedHint(view(), ZONE, now)).toBeNull();
    expect(
      stoppedHint(view({ stoppedAt: stopped("held") }), ZONE, now),
    ).toMatch(
      /^Held since 14:02: the counter hasn't sent something it needs yet/,
    );
    expect(
      stoppedHint(view({ stoppedAt: stopped("rejected") }), ZONE, now),
    ).toBe("Refused 14:02. Nothing after it syncs until it is reviewed.");
    expect(
      stoppedHint(view({ stoppedAt: stopped("conflict") }), ZONE, now),
    ).toMatch(/doesn't match the server's copy.*journal is recovered/);
  });

  it("explains a journal stopped on a conflict", () => {
    render(
      <CounterOfflineSales
        counter={counter}
        failed={false}
        now={now}
        timeZone={ZONE}
        journal={[view({ stoppedAt: stopped("conflict") })]}
      />,
    );
    expect(screen.getByText("Stopped at entry 7")).toBeInTheDocument();
    expect(
      screen.getByText(/It doesn't match the server's copy/),
    ).toBeInTheDocument();
  });

  it("names a retired computer that still has stock cases open", () => {
    render(
      <CounterOfflineSales
        counter={{ ...counter, terminal: null }}
        failed={false}
        now={now}
        timeZone={ZONE}
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
