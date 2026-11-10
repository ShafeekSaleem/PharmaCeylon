/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { cleanup, screen } from "@testing-library/react";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
} from "../test/harness";
import { SyncBlock, TitleBar } from "./Shell";

afterEach(cleanup);

const enrollmentBase = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Kollupitiya",
  branchCode: "KOL",
  registerId: ids.register,
  tillId: "00000000-0000-4000-8000-0000000000d1",
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

describe("TitleBar till label", () => {
  it("shows counterLabel when present", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({
          enrollment: { ...enrollmentBase, counterLabel: "Counter 2" },
        })}
        api={{ reachable: true, checkedAt: new Date().toISOString(), latencyMs: 12 }}
      />,
    );
    const where = screen.getByText("Kollupitiya").parentElement;
    expect(where?.textContent).toContain("Counter 2");
  });

  it("falls back to till id prefix when counterLabel is null", () => {
    renderWithKeys(
      <TitleBar
        state={deviceState({
          enrollment: { ...enrollmentBase, counterLabel: null },
        })}
        api={{ reachable: true, checkedAt: new Date().toISOString(), latencyMs: 12 }}
      />,
    );
    const where = screen.getByText("Kollupitiya").parentElement;
    expect(where?.textContent).toContain("00000000");
    expect(where?.textContent).not.toContain("Counter");
  });
});

describe("SyncBlock (P5 #51)", () => {
  const sync = {
    recorded: 3, accepted: 1, waiting: 2, refused: 0, syncing: true, lastSuccessAt: null,
    issue: null, lastDrainAt: null,
    pause: { reason: "draining" as const, waiting: 2, outageStartedAt: "2026-11-10T09:00:00.000Z" },
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

  it("asks for attention when a record is refused, with the server's reason", () => {
    renderWithKeys(
      <SyncBlock sync={{ ...sync, refused: 1, issue: { code: "LOCAL_STOCK_EXHAUSTED", message: "A manager reviews it in the back office." } }} />,
    );
    expect(screen.getByRole("heading", { name: "Synchronisation needs attention" })).toBeTruthy();
    expect(screen.getByText("A manager reviews it in the back office.")).toBeTruthy();
  });
});
