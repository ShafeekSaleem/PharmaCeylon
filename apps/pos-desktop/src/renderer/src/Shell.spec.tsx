/** @jest-environment jsdom */
import { afterEach, describe, expect, it, jest } from "@jest/globals";

const titleTick = new Date("2026-11-09T14:32:16.000Z");
const statusBarNow = { current: titleTick };

jest.mock("./format", () => {
  const actual = jest.requireActual<typeof import("./format")>("./format");
  return {
    ...actual,
    useSecondNow: () => statusBarNow.current,
    useNow: () => titleTick,
  };
});

jest.mock("./use-syncing-latch", () => ({
  useSyncingLatch: (syncing: boolean) => syncing,
}));

import { cleanup, screen } from "@testing-library/react";
import type { JournalSync } from "../../shared/ipc-contract";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
} from "../test/harness";
import { Rail, StatusBar, SyncBlock, TitleBar } from "./Shell";
import { timeWithSeconds } from "./format";

afterEach(() => {
  statusBarNow.current = titleTick;
  cleanup();
});

const enrollmentBase = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Kollupitiya",
  branchCode: "KOL",
  registerId: ids.register,
  tillId: "00000000-0000-4000-8000-0000000000d1",
  counterLabel: "Counter 2",
  label: "PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: null,
  enrolledByUserId: ids.ana,
  enrolledByName: null,
  offlineBackup: emptyEnrollmentOfflineBackup,
  enrollmentFactsLive: true,
  enrollmentStatusFetchedAt: null,
};

const journalSynced = (lastSuccessAt: string, over: Partial<JournalSync> = {}): JournalSync => ({
  recorded: 0,
  accepted: 0,
  waiting: 0,
  refused: 0,
  syncing: false,
  lastSuccessAt,
  issue: null,
  pause: null,
  lastDrainAt: null,
  lastStockDownloadAt: null,
  stockDownloadNominated: null,
  ...over,
});

const apiOk = {
  reachable: true,
  checkedAt: "2026-11-09T14:00:00.000Z",
  latencyMs: 5,
};

describe("TitleBar till label", () => {
  it("shows counterLabel when present", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={apiOk}
      />,
    );
    const where = screen.getByText("Kollupitiya").parentElement;
    expect(where?.textContent).toContain("Counter 2");
  });

  it("falls back to till id prefix when counterLabel is null", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({ enrollment: { ...enrollmentBase, counterLabel: null } })}
        api={apiOk}
      />,
    );
    const where = screen.getByText("Kollupitiya").parentElement;
    expect(where?.textContent).toContain("00000000");
    expect(where?.textContent).not.toContain("Counter");
  });
});

describe("TitleBar connection display (P2b #103)", () => {
  it("keeps first-run setup on Server reachable, not Online or last sync", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState()}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
      />,
    );
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Server reachable");
    expect(pill.textContent).not.toContain("Online");
    expect(pill.textContent).not.toMatch(/sync/i);
  });

  it("shows the Online synced pill when the journal has lastSuccessAt", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
      />,
    );
    const pill = screen.getByRole("status");
    expect(pill.textContent).toContain("Online");
    expect(pill.textContent).toContain("synced 8 s ago");
    expect(pill.textContent).not.toContain("checked");
  });

  it("shows syncing state instead of Server reachable", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={apiOk}
        journal={{ ...journalSynced("2026-11-09T14:32:08.000Z"), syncing: true }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("syncing");
    expect(screen.getByRole("status").textContent).not.toContain("Server reachable");
  });

  it("keeps revoked counters on the reachability pill", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({
          enrollment: { ...enrollmentBase, status: "revoked" },
        })}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Server reachable");
    expect(screen.getByRole("status").textContent).not.toContain("Online");
  });

  it("shows Offline backup · ready until 22:00 from readiness.offlineBackup", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    renderWithKeys(
      <StatusBar
        state={deviceState({ enrollment: enrollmentBase, staffSession: { workSessionId: ids.session, staffUserId: ids.ana, staffName: "Ana", openedAt: "2026-11-09T08:00:00.000Z" } })}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
        offlineBackup={{
          grantExpiresAt: grant,
          snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
          authorizedStaff: 4,
          usable: true,
          failures: 0,
          failure: null,
        }}
        printer={null}
        info={null}
      />,
    );
    expect(screen.getByText(/Offline backup · ready until 22:00/)).toBeTruthy();
  });

  it("hides the offline-backup line after the grant expires on the clock", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    statusBarNow.current = new Date(2026, 10, 9, 21, 0, 0);
    const backupProps = {
      grantExpiresAt: grant,
      snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
      authorizedStaff: 4,
      usable: true,
      failures: 0,
      failure: null,
    };
    const bar = (
      <StatusBar
        state={deviceState({ enrollment: enrollmentBase, staffSession: { workSessionId: ids.session, staffUserId: ids.ana, staffName: "Ana", openedAt: "2026-11-09T08:00:00.000Z" } })}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
        offlineBackup={backupProps}
        printer={null}
        info={null}
      />
    );
    const { rerender } = renderWithKeys(bar);
    expect(screen.getByText(/ready until 22:00/)).toBeTruthy();
    statusBarNow.current = new Date(2026, 10, 9, 22, 0, 1);
    rerender(bar);
    expect(screen.queryByText(/ready until 22:00/)).toBeNull();
  });

  it("hides the offline-backup line when a re-read marks the backup not usable", () => {
    const grant = new Date(2026, 10, 9, 22, 0, 0).toISOString();
    statusBarNow.current = new Date(2026, 10, 9, 21, 0, 0);
    const base = deviceState({
      enrollment: enrollmentBase,
      staffSession: { workSessionId: ids.session, staffUserId: ids.ana, staffName: "Ana", openedAt: "2026-11-09T08:00:00.000Z" },
    });
    const { rerender } = renderWithKeys(
      <StatusBar
        state={base}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
        offlineBackup={{
          grantExpiresAt: grant,
          snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
          authorizedStaff: 4,
          usable: true,
          failures: 0,
          failure: null,
        }}
        printer={null}
        info={null}
      />,
    );
    expect(screen.getByText(/ready until 22:00/)).toBeTruthy();
    rerender(
      <StatusBar
        state={base}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
        offlineBackup={{
          grantExpiresAt: grant,
          snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
          authorizedStaff: 4,
          usable: false,
          failures: 0,
          failure: null,
        }}
        printer={null}
        info={null}
      />,
    );
    expect(screen.queryByText(/ready until 22:00/)).toBeNull();
  });

  it("tags the lead status word so narrow layouts ellipsize detail before the word", () => {
    renderWithKeys(
      <StatusBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={apiOk}
        journal={journalSynced("2026-11-09T14:32:08.000Z")}
        offlineBackup={{
          grantExpiresAt: new Date(2099, 0, 1, 22, 0, 0).toISOString(),
          snapshotGeneratedAt: "2026-11-09T14:00:00.000Z",
          authorizedStaff: 4,
          usable: true,
          failures: 0,
          failure: null,
        }}
        printer={{ name: "EPSON", displayName: "EPSON TM-T82III" }}
        info={{ appVersion: "1.0.0", electronVersion: "44", schemaVersion: 1, packaged: false }}
        shift={{
          workSessionId: ids.session,
          shiftNumber: "S-0412",
          staffUserId: ids.ana,
          staffName: "Sachini Rathnayake",
          openedAt: "2026-11-09T08:02:00.000Z",
          openingCashMinor: 0,
          openingCount: [],
          status: "open",
          sync: "synced",
          error: null,
          expectedCashMinor: 2_485_000,
          closedAt: null,
          closedByName: null,
          closingCashCountMinor: null,
          serverExpectedCashMinor: null,
          varianceMinor: null,
          varianceNote: null,
          assistanceReason: null,
          needsManagerPin: false,
          summary: null,
          summaryAt: null,
        }}
      />,
    );
    const word = screen.getByText("Online");
    expect(word.tagName).toBe("B");
    expect(word.className).toMatch(/sbStatusWord/);
    expect(word.textContent).toBe("Online");
  });

  it("does not use api.checkedAt as last sync in the status bar lead", () => {
    const lastAt = "2026-11-09T14:32:08.000Z";
    renderWithKeys(
      <StatusBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={{ ...apiOk, checkedAt: "2099-01-01T00:00:00.000Z" }}
        journal={journalSynced(lastAt)}
        printer={null}
        info={null}
      />,
    );
    expect(screen.getByText(/Online/).parentElement?.textContent).toContain("Sales sent 14:32");
    expect(screen.getByText(/Online/).parentElement?.textContent).not.toContain("2099");
    expect(screen.getByText(/Online/).parentElement?.textContent).not.toContain("checked");
  });

  it("shows last sync via the real formatter when offline (PR 138)", () => {
    const lastAt = "2026-11-09T14:32:08.000Z";
    const expectedClock = timeWithSeconds(new Date(lastAt));
    renderWithKeys(
      <StatusBar
        state={deviceState({ enrollment: enrollmentBase })}
        api={{ ...apiOk, reachable: false }}
        journal={journalSynced(lastAt)}
        printer={null}
        info={null}
      />,
    );
    expect(screen.getByText(/Offline/).parentElement?.textContent).toContain(
      `last sync ${expectedClock}`,
    );
  });
});

const railSession = {
  workSessionId: ids.session,
  staffUserId: ids.ana,
  staffName: "Ana Perera",
  openedAt: "2026-11-09T08:00:00.000Z",
};

describe("Rail Counter work (epic #103)", () => {
  it("hides Counter work when showWork is false", () => {
    renderWithKeys(
      <Rail
        page="sell"
        onPage={() => undefined}
        workCount={0}
        showWork={false}
        session={railSession}
        personOpen={false}
        onPerson={() => undefined}
        onLock={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: /Counter work/i })).toBeNull();
  });

  it("shows Counter work for a restricted role when waiting work keeps showWork true", () => {
    renderWithKeys(
      <Rail
        page="sell"
        onPage={() => undefined}
        workCount={3}
        showWork
        session={railSession}
        personOpen={false}
        onPerson={() => undefined}
        onLock={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Counter work/i })).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("shows Counter work with its waiting count when the role may execute", () => {
    renderWithKeys(
      <Rail
        page="sell"
        onPage={() => undefined}
        workCount={7}
        showWork
        session={railSession}
        personOpen={false}
        onPerson={() => undefined}
        onLock={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /Counter work/i })).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });
});

describe("SyncBlock (P5 #51)", () => {
  const sync = {
    recorded: 3, accepted: 1, waiting: 2, refused: 0, syncing: true, lastSuccessAt: null,
    issue: null, lastDrainAt: null, lastStockDownloadAt: null, stockDownloadNominated: null,
    pause: {
      reason: "draining" as const, waiting: 2, outageStartedAt: "2026-11-10T09:00:00.000Z",
      unconfirmed: { sales: 0, actions: 0 },
    },
  };

  it("says new sales wait while the offline records upload, and that the sale on screen is kept", () => {
    renderWithKeys(<SyncBlock sync={sync} />);
    expect(screen.getByRole("heading", { name: "Synchronising offline sales" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("2 offline records are on the way to the server.");
    expect(screen.getByRole("status").textContent).toContain("The sale on screen is kept.");
  });

  it("waits for fresh stock once every record is on the server", () => {
    renderWithKeys(<SyncBlock sync={{ ...sync, accepted: 3, waiting: 0, pause: { ...sync.pause, waiting: 0 } }} />);
    expect(screen.getByRole("status").textContent).toContain("fresh stock is on its way");
  });

  it("says what sent from here still needs confirming, and holds the unconfirmed sales so they can be", () => {
    renderWithKeys(
      <SyncBlock sync={{ ...sync, accepted: 3, waiting: 0, pause: { ...sync.pause, waiting: 0, unconfirmed: { sales: 2, actions: 1 } } }}>
        <button type="button">Confirm with server</button>
      </SyncBlock>,
    );
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("The offline sales are on the server. New sales");
    expect(text).not.toContain("fresh stock is on its way");
    expect(text).toContain("The 2 sales below were sent but not confirmed: synchronisation finishes once they are.");
    expect(text).toContain("An action sent from here waits in Counter work for the person who sent it to confirm it.");
    expect(screen.getByRole("button", { name: "Confirm with server" })).toBeTruthy();
  });

  it("asks for attention when a record is refused, with the server's reason", () => {
    renderWithKeys(
      <SyncBlock sync={{ ...sync, refused: 1, issue: { code: "LOCAL_STOCK_EXHAUSTED", message: "A manager reviews it in the back office." } }} />,
    );
    expect(screen.getByRole("heading", { name: "Synchronisation needs attention" })).toBeTruthy();
    expect(screen.getByText("A manager reviews it in the back office.")).toBeTruthy();
  });
});
