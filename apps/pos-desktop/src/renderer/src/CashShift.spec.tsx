/** @jest-environment jsdom */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { LocalShift, ShiftState } from "../../shared/ipc-contract";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { CashShiftPage, ShiftGate } from "./CashShift";
import { SignInScreen } from "./SignIn";

afterEach(cleanup);

const enrollment = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Colombo 03",
  branchCode: "C03",
  registerId: ids.register,
  tillId: ids.till,
  counterLabel: "Counter 1",
  label: "Front desk PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: null,
  enrolledByUserId: ids.ana,
  enrolledByName: "Branch enroller",
  offlineBackup: emptyEnrollmentOfflineBackup,
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

const summary = {
  openingCashMinor: 500_000,
  cashTakenMinor: 3_000_000,
  changeGivenMinor: 42_000,
  cashRefundsMinor: 118_000,
  cashPaidOutMinor: 855_000,
  cashPaidInMinor: 0,
  expectedCashMinor: 2_485_000,
  saleCount: 3,
  salesTotalMinor: 4_000_000,
  firstSaleAt: "2026-11-04T02:35:00.000Z",
  lastSaleAt: "2026-11-04T09:00:00.000Z",
  takingsByMethod: [
    { method: "cash", saleCount: 2, takenMinor: 2_958_000, refundedMinor: 118_000 },
    { method: "card", saleCount: 1, takenMinor: 1_042_000, refundedMinor: 0 },
  ],
  takingsByHour: [
    { hour: "2026-11-04T08", saleCount: 1, totalMinor: 1_000_000 },
    { hour: "2026-11-04T14", saleCount: 2, totalMinor: 3_000_000 },
  ],
  refunds: [
    {
      goodsReturnId: ids.branch,
      returnNumber: "RF-0029",
      invoiceNo: "INV-1",
      amountMinor: 118_000,
      paidBack: [{ method: "cash", amountMinor: 118_000 }],
      items: [{ name: "Panadol", qty: 2, disposition: "restock" }],
      processedBy: { id: ids.ana, fullName: "Ana Perera" },
      at: "2026-11-04T06:10:00.000Z",
    },
  ],
  cashMovements: [
    {
      id: ids.till,
      direction: "out" as const,
      amountMinor: 855_000,
      reason: "Supplier payout · PO-2026-0172",
      referenceType: "supplier_payment",
      at: "2026-11-04T03:45:00.000Z",
      recordedBy: { id: ids.ana, fullName: "Ana Perera" },
    },
  ],
};

describe("this shift on Cash & shift", () => {
  const open = shift({ summary, summaryAt: "2026-11-04T09:02:00.000Z" });

  it("shows the four figures, takings by payment and by hour, and the cash in and out", () => {
    stubPos();
    renderWithKeys(
      <CashShiftPage device={signedIn(ids.ana, "Ana Perera")} shift={state(open)} onShift={() => undefined} />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Shift S-0412 · Ana Perera");
    expect(text).toContain("+29,580.00"); // cash taken, net of change
    expect(text).toContain("−9,730.00"); // a cash refund and a supplier payout
    expect(text).toContain("1 refund · 1 supplier payout");
    expect(text).toContain("24,850.00");
    expect(text).toContain("RF-0029 · Panadol × 2");
    expect(text).toContain("Cash refund · RF-0029");
    expect(text).toContain("Supplier payout · PO-2026-0172");
    fireEvent.click(screen.getByRole("button", { name: "By hour" }));
    expect(document.body.textContent).toContain("14:00");
    expect(document.body.textContent).toContain("30,000.00");
    // Nothing counted yet: no difference is claimed.
    expect(document.body.textContent).not.toContain("Short");
  });

  it("closes by counting the drawer, shows the difference, and hands over", async () => {
    const pos = stubPos({ closeShift: async () => ({ ok: true, value: state(null, open) }) });
    let handedTo: string | null | undefined;
    renderWithKeys(
      <CashShiftPage
        device={deviceState({
          enrollment,
          staffSession: { workSessionId: ids.session, staffUserId: ids.ana, staffName: "Ana Perera", openedAt: "" },
          counterStaff: [
            { staffUserId: ids.ben, staffName: "Ben Silva", role: "cashier", state: "ready", lockedUntil: null },
          ],
        })}
        shift={state(open)}
        onShift={() => undefined}
        onHandover={(next) => (handedTo = next)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Number of 5,000 notes"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Number of 1,000 notes"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Coins, in rupees"), { target: { value: "650" } });
    expect(document.body.textContent).toContain("Short");
    expect(document.body.textContent).toContain("−200.00");
    fireEvent.change(screen.getByLabelText("Note on the difference"), { target: { value: "Too much change" } });
    fireEvent.change(screen.getByLabelText("Who takes over next"), { target: { value: ids.ben } });
    expect(document.body.textContent).toContain("Next: Ben Silva");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Close shift and hand over/ }));
    });
    expect(pos.closeShift).toHaveBeenCalledWith({
      count: {
        totalMinor: 2_465_000,
        lines: [
          { denominationMinor: 500_000, count: 4 },
          { denominationMinor: 100_000, count: 4 },
          { denominationMinor: 100, count: 650 },
        ],
      },
      varianceNote: "Too much change",
    });
    expect(handedTo).toBe(ids.ben);
  });

  it("End of day closes without handing over", async () => {
    stubPos({ closeShift: async () => ({ ok: true, value: state(null, open) }) });
    let handedOver = false;
    renderWithKeys(
      <CashShiftPage
        device={signedIn(ids.ana, "Ana Perera")}
        shift={state(open)}
        onShift={() => undefined}
        onHandover={() => (handedOver = true)}
      />,
    );
    fireEvent.change(screen.getByLabelText("Coins, in rupees"), { target: { value: "24850" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "End of day" }));
    });
    expect(handedOver).toBe(false);
  });

  it("asks a manager closing someone else's shift for a reason and their own PIN", async () => {
    const pos = stubPos({ closeShift: async () => ({ ok: true, value: state(null, open) }) });
    renderWithKeys(
      <CashShiftPage device={signedIn(ids.ben, "Ben Silva")} shift={state(open)} onShift={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText("Coins, in rupees"), { target: { value: "24850" } });
    const close = screen.getByRole("button", { name: /Close their shift/ }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why you're closing it for them"), { target: { value: "Went home ill" } });
    fireEvent.change(screen.getByLabelText("Your PIN"), { target: { value: "1234" } });
    await act(async () => {
      fireEvent.click(close);
    });
    expect(pos.closeShift).toHaveBeenCalledWith({
      count: { totalMinor: 2_485_000, lines: [{ denominationMinor: 100, count: 24_850 }] },
      assistance: { pin: "1234", reason: "Went home ill" },
    });
  });

  it("shows a close the server hasn't confirmed as saved, and sends it again", async () => {
    const pos = stubPos({ retryShiftClose: async () => ({ ok: true, value: state(null, open) }) });
    renderWithKeys(
      <CashShiftPage
        device={signedIn(ids.ana, "Ana Perera")}
        shift={state(
          shift({
            status: "closing",
            sync: "pending",
            closingCashCountMinor: 2_465_000,
            closedByName: "Ana Perera",
            error: { code: "NETWORK", message: "The server could not be reached." },
          }),
        )}
        onShift={() => undefined}
      />,
    );
    expect(document.body.textContent).toContain("Saved, not yet synced");
    expect(document.body.textContent).toContain("Not yet synced");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send the close again/ }));
    });
    expect(pos.retryShiftClose).toHaveBeenCalledWith({});
  });

  it("prints an X report on the receipt printer and leaves the shift open", async () => {
    const pos = stubPos({ printXReport: async () => ({ ok: true, value: { ok: true, error: null } }) });
    renderWithKeys(
      <CashShiftPage
        device={signedIn(ids.ana, "Ana Perera")}
        shift={state(open)}
        onShift={() => undefined}
        printer={{ name: "EPSON", displayName: "EPSON TM-T82III" }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Print X report/ }));
    });
    expect(pos.printXReport).toHaveBeenCalledWith({ printerName: "EPSON" });
    expect(screen.getByRole("button", { name: /Printed/ })).toBeTruthy();
    expect(pos.closeShift).not.toHaveBeenCalled();
  });
});
