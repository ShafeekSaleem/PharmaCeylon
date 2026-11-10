/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { EnrollmentOfflineBackup } from "../../shared/ipc-contract";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { ThisCounterPage } from "./ThisCounter";

afterEach(cleanup);

const baseEnrollment = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Kollupitiya",
  branchCode: "KOL",
  registerId: ids.register,
  tillId: "00000000-0000-4000-8000-0000000000d1",
  label: "Back counter PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: "2026-10-14T00:00:00.000Z",
  enrolledByUserId: ids.ana,
  enrolledByName: "Dilini Fernando",
  offlineBackup: emptyEnrollmentOfflineBackup,
};

function offlineView(backup: EnrollmentOfflineBackup) {
  const nominated = backup.activatedAt != null;
  return {
    thisCounterNominated: nominated,
    otherCounterNominated: false,
    nominationVersion: 1,
    authorization:
      nominated || !backup.authorizedAt
        ? null
        : {
            authorizationId: ids.register2,
            expectedNominationVersion: 0,
            reason: "Fixture",
            authorizedAt: new Date(backup.authorizedAt).toISOString(),
          },
  };
}

type OfflineCounterStub =
  | { ok: true; value: ReturnType<typeof offlineView> }
  | { ok: false; error: { code: string; message: string } };

async function renderCounter(
  counterLabel: string | null,
  offlineBackup: EnrollmentOfflineBackup,
  offlineCounterResult?: OfflineCounterStub,
) {
  const offlineCounter =
    offlineCounterResult ??
    ({ ok: true, value: offlineView(offlineBackup) } satisfies OfflineCounterStub);
  stubPos({
    listPrinters: () => Promise.resolve([]),
    offlineCounter: () => Promise.resolve(offlineCounter),
  });
  renderWithKeys(
    <ThisCounterPage
      state={deviceState({
        enrollment: { ...baseEnrollment, counterLabel, offlineBackup },
      })}
      info={{
        appVersion: "1.0.0",
        electronVersion: "44.7.0",
        schemaVersion: 14,
        packaged: false,
      }}
      readiness={null}
      onCheck={() => undefined}
    />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Offline backup counter" }),
    ).toBeTruthy(),
  );
}

async function offlinePanel() {
  const heading = await screen.findByRole("heading", {
    name: "Offline backup counter",
  });
  return heading.parentElement!.parentElement!;
}

describe("This counter till name", () => {
  it("shows counterLabel when present", async () => {
    await renderCounter("Counter 2", emptyEnrollmentOfflineBackup);
    expect(screen.getByText("Counter 2 · Kollupitiya")).toBeTruthy();
    expect(screen.getByText(/Till Counter 2/)).toBeTruthy();
  });

  it("falls back to the till id prefix when counterLabel is null", async () => {
    await renderCounter(null, emptyEnrollmentOfflineBackup);
    expect(screen.getByText("00000000 · Kollupitiya")).toBeTruthy();
    expect(screen.getByText(/Till 00000000/)).toBeTruthy();
  });
});

describe("offline backup enrollment facts", () => {
  it("does not show Authorized or Activated when not nominated", async () => {
    await renderCounter("Counter 2", emptyEnrollmentOfflineBackup);
    const panel = await offlinePanel();
    expect(within(panel).queryByText(/^Activated$/)).toBeNull();
    expect(within(panel).queryByText("On the web")).toBeNull();
  });

  it("shows authorization only when authorized but not activated", async () => {
    const backup: EnrollmentOfflineBackup = {
      ...emptyEnrollmentOfflineBackup,
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ana,
      authorizedByFullName: "Dilini Fernando",
    };
    await renderCounter("Counter 2", backup);
    const panel = await offlinePanel();
    expect(
      within(panel).getByText("On the web by Dilini Fernando · 13 Oct 2026"),
    ).toBeTruthy();
    expect(within(panel).queryByText(/^Activated$/)).toBeNull();
  });

  it("shows authorization and activation when activated", async () => {
    const backup: EnrollmentOfflineBackup = {
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ben,
      authorizedByFullName: "Branch Owner",
      activatedAt: Date.UTC(2026, 9, 14, 12),
      activatedByUserId: ids.ana,
      activatedByFullName: "Dilini Fernando",
    };
    await renderCounter("Counter 2", backup);
    const panel = await offlinePanel();
    expect(
      within(panel).getByText("On the web by Branch Owner · 13 Oct 2026"),
    ).toBeTruthy();
    expect(
      within(panel).getByText("Here by Dilini Fernando · 14 Oct 2026"),
    ).toBeTruthy();
  });

  it("handles missing authorizer and activator names", async () => {
    const backup: EnrollmentOfflineBackup = {
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ben,
      authorizedByFullName: null,
      activatedAt: Date.UTC(2026, 9, 14, 12),
      activatedByUserId: ids.ana,
      activatedByFullName: null,
    };
    await renderCounter("Counter 2", backup);
    const panel = await offlinePanel();
    expect(within(panel).getByText("On the web · 13 Oct 2026")).toBeTruthy();
    expect(within(panel).getByText("Here · 14 Oct 2026")).toBeTruthy();
  });
});

const offlineAssignmentForbidden: OfflineCounterStub = {
  ok: false,
  error: { code: "FORBIDDEN", message: "You may not do that." },
};

describe("offline backup when offline-assignment is refused", () => {
  it("shows a neutral not-this-counter presentation when not nominated", async () => {
    await renderCounter(
      "Counter 2",
      emptyEnrollmentOfflineBackup,
      offlineAssignmentForbidden,
    );
    const panel = await offlinePanel();
    expect(
      within(panel).getByText("This counter isn't the offline backup"),
    ).toBeTruthy();
    expect(within(panel).getByText("Not this counter")).toBeTruthy();
    expect(within(panel).queryByText("No offline backup counter yet")).toBeNull();
    expect(
      within(panel).queryByText("The owner authorizes one from the back office."),
    ).toBeNull();
  });

  it("shows Authorized from enrollment when authorized but not activated", async () => {
    const backup: EnrollmentOfflineBackup = {
      ...emptyEnrollmentOfflineBackup,
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ana,
      authorizedByFullName: "Dilini Fernando",
    };
    await renderCounter("Counter 2", backup, offlineAssignmentForbidden);
    const panel = await offlinePanel();
    expect(
      within(panel).getByText("On the web by Dilini Fernando · 13 Oct 2026"),
    ).toBeTruthy();
    expect(within(panel).queryByText(/^Activated$/)).toBeNull();
    expect(
      within(panel).queryByRole("button", {
        name: "Activate as the offline backup",
      }),
    ).toBeNull();
  });

  it("shows Authorized and Activated from enrollment when activated", async () => {
    const backup: EnrollmentOfflineBackup = {
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ben,
      authorizedByFullName: "Branch Owner",
      activatedAt: Date.UTC(2026, 9, 14, 12),
      activatedByUserId: ids.ana,
      activatedByFullName: "Dilini Fernando",
    };
    await renderCounter("Counter 2", backup, offlineAssignmentForbidden);
    const panel = await offlinePanel();
    expect(
      within(panel).getByText("On the web by Branch Owner · 13 Oct 2026"),
    ).toBeTruthy();
    expect(
      within(panel).getByText("Here by Dilini Fernando · 14 Oct 2026"),
    ).toBeTruthy();
    expect(
      within(panel).queryByRole("button", {
        name: "Activate as the offline backup",
      }),
    ).toBeNull();
  });
});

describe("offline backup when offline-assignment fails for other reasons", () => {
  it("shows a neutral unchecked state and the refusal instead of enrollment fallback", async () => {
    await renderCounter("Counter 2", emptyEnrollmentOfflineBackup, {
      ok: false,
      error: { code: "NETWORK", message: "Could not reach the server." },
    });
    const panel = await offlinePanel();
    expect(within(panel).getByText("Couldn't check right now")).toBeTruthy();
    expect(within(panel).getByText("Could not reach the server.")).toBeTruthy();
    expect(
      within(panel).queryByText("This counter isn't the offline backup"),
    ).toBeNull();
    expect(within(panel).queryByText("No offline backup counter yet")).toBeNull();
    expect(within(panel).queryByText("Not chosen")).toBeNull();
    expect(
      within(panel).queryByText("The owner authorizes one from the back office."),
    ).toBeNull();
    expect(
      within(panel).queryByRole("button", {
        name: "Activate as the offline backup",
      }),
    ).toBeNull();
  });
});

describe("offline backup activation control", () => {
  it("shows Activate when offline-assignment returns a waiting authorization", async () => {
    const backup: EnrollmentOfflineBackup = {
      ...emptyEnrollmentOfflineBackup,
      authorizedAt: Date.UTC(2026, 9, 13, 12),
      authorizedByUserId: ids.ana,
      authorizedByFullName: "Dilini Fernando",
    };
    await renderCounter("Counter 2", backup);
    expect(
      await screen.findByRole("button", {
        name: "Activate as the offline backup",
      }),
    ).toBeTruthy();
  });
});
