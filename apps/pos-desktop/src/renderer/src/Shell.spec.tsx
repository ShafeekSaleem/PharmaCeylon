/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { cleanup, screen } from "@testing-library/react";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
} from "../test/harness";
import { TitleBar } from "./Shell";

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
