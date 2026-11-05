/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { LocalShift, ShiftState } from "../../shared/ipc-contract";
import { deviceState, ids, renderWithKeys, stubPos } from "../test/harness";
import { CashShiftPage, ShiftGate } from "./CashShift";
import { SignInScreen } from "./SignIn";

afterEach(cleanup);

const enrollment = {
  status: "active" as const,
  branchName: "Colombo 03",
  counterLabel: "Counter 1",
  label: "Front desk PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: null,
};
const signedIn = (staffUserId: string, staffName: string) =>
  deviceState({
    enrollment,
    staffSession: { workSessionId: ids.session, staffUserId, staffName, openedAt: "2026-11-04T02:30:00.000Z" },
  });

const shift = (over: Partial<LocalShift> = {}): LocalShift => ({
  workSessionId: ids.register2,
  shiftNumber: "S-0412",
  staffUserId: ids.ana,
  staffName: "Ana Perera",
  openedAt: "2026-11-04T02:32:00.000Z",
  openingCashMinor: 500_000,
  openingCount: [{ denominationMinor: 100_000, count: 5 }],
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
  ...over,
});
const state = (current: LocalShift | null, lastClosed: LocalShift | null = null): ShiftState => ({
  current,
  lastClosed,
  unsynced: [],
});

describe("the Sell gate", () => {
  it("lets the person whose shift is open sell", () => {
    stubPos();
    renderWithKeys(<ShiftGate device={signedIn(ids.ana, "Ana Perera")} shift={state(shift())} onOpen={() => undefined} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends someone with no open shift to open one", () => {
    stubPos();
    let opened = 0;
    renderWithKeys(<ShiftGate device={signedIn(ids.ana, "Ana Perera")} shift={state(null)} onOpen={() => (opened += 1)} />);
    expect(screen.getByRole("alert").textContent).toContain("Open your shift to start selling");
    fireEvent.click(screen.getByRole("button", { name: /Cash & shift/ }));
    expect(opened).toBe(1);
  });

  it("tells someone else that the open shift is handed over with a count first", () => {
    stubPos();
    renderWithKeys(<ShiftGate device={signedIn(ids.ben, "Ben Silva")} shift={state(shift())} onOpen={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("Ana Perera's shift is open on this till");
    expect(screen.getByRole("alert").textContent).toContain("count the drawer and close it first");
  });
});

describe("opening a shift on Cash & shift", () => {
  it("adds up the count and sends it with the PIN", async () => {
    const pos = stubPos({
      openShift: async () => ({ ok: true, value: state(shift()) }),
    });
    let next: ShiftState | null = null;
    renderWithKeys(
      <CashShiftPage device={signedIn(ids.ana, "Ana Perera")} shift={state(null)} onShift={(s) => (next = s)} />,
    );
    fireEvent.change(screen.getByLabelText("Number of 1,000 notes"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Coins, in rupees"), { target: { value: "40" } });
    expect(screen.getByText("5,040.00")).toBeTruthy();
    const open = screen.getByRole("button", { name: /Open my shift/ });
    expect((open as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Your PIN"), { target: { value: "4826" } });
    await act(async () => {
      fireEvent.click(open);
    });
    expect(pos.openShift).toHaveBeenCalledWith({
      pin: "4826",
      count: {
        totalMinor: 504_000,
        lines: [
          { denominationMinor: 100_000, count: 5 },
          { denominationMinor: 100, count: 40 },
        ],
      },
    });
    expect(next).not.toBeNull();
  });
});

describe("the lock screen", () => {
  it("shows whose shift is open and that anyone else hands over with a count", () => {
    stubPos();
    renderWithKeys(
      <SignInScreen
        state={deviceState({
          enrollment,
          counterStaff: [
            { staffUserId: ids.ana, staffName: "Ana Perera", role: "cashier", state: "ready", lockedUntil: null },
            { staffUserId: ids.ben, staffName: "Ben Silva", role: "pharmacist", state: "ready", lockedUntil: null },
          ],
        })}
        onState={() => undefined}
        api={null}
        printer={null}
        shift={shift()}
      />,
    );
    expect(screen.getByText(/Shift open since/)).toBeTruthy();
    expect(document.body.textContent).toContain(
      "Shift S-0412 is open on this till. Ana continues it. Anyone else hands over the shift with a cash count first.",
    );
  });
});
