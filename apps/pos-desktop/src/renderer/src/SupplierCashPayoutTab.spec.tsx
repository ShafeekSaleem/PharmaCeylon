/** @jest-environment jsdom */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LocalShift } from "../../shared/ipc-contract";
import { deviceState, ids, stubPos } from "../test/harness";
import { SupplierCashPayoutTab } from "./SupplierCashPayoutTab";

afterEach(cleanup);

const payoutRow = {
  cashPayoutId: ids.branch,
  payoutNumber: "SCP-0042",
  supplierName: "Hemas Pharmaceuticals",
  purchaseOrderNumber: null,
  amount: "12500.00",
  paidOn: "2026-11-14",
  reference: null,
  notes: null,
  allocations: [],
  executionApprovalId: ids.session,
  requestedBy: "Kasun",
  approvedBy: "Dilini",
};

const shift = (over: Partial<LocalShift> = {}): LocalShift => ({
  workSessionId: ids.register2,
  shiftNumber: "S-0412",
  staffUserId: ids.ana,
  staffName: "Sachini Rathnayake",
  openedAt: "2026-11-04T02:32:00.000Z",
  openingCashMinor: 500_000,
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
  ...over,
});

const signedInDevice = () =>
  deviceState({
    staffSession: {
      workSessionId: ids.session,
      staffUserId: ids.ana,
      staffName: "Sachini Rathnayake",
      openedAt: "2026-11-04T02:30:00.000Z",
    },
  });

describe("SupplierCashPayoutTab", () => {
  it("shows permission denied state", async () => {
    stubPos({
      cashPayoutsReady: async () => ({
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "Your role can't pay suppliers" },
      }),
    });
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={shift()} online />,
    );
    expect(await screen.findByText("Your role can't pay suppliers")).toBeTruthy();
  });

  it("blocks payout while offline", () => {
    stubPos({});
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={shift()} online={false} />,
    );
    expect(screen.getByText(/Supplier payouts need the server/)).toBeTruthy();
  });

  it("blocks payout when no shift is open", () => {
    stubPos({});
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={null} online />,
    );
    expect(screen.getByText(/Open your shift to pay out/)).toBeTruthy();
  });

  it("blocks payout when another person's shift is open", () => {
    stubPos({});
    render(
      <SupplierCashPayoutTab
        device={signedInDevice()}
        shift={shift({ staffUserId: ids.ben, staffName: "Ben Silva" })}
        online
      />,
    );
    expect(screen.getByText(/Ben Silva/)).toBeTruthy();
    expect(screen.getByText(/shift is open on this till/)).toBeTruthy();
  });

  it("marks a payout short when it exceeds expected cash", async () => {
    stubPos({
      cashPayoutsReady: async () => ({
        ok: true,
        value: [{ ...payoutRow, amount: "42775.00" }],
      }),
    });
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={shift()} online />,
    );
    expect(await screen.findByText("Drawer is short")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Pay out/ })).toHaveProperty("disabled", true);
  });

  it("pays out in one confirm and keeps success on the executed payout", async () => {
    const cashPayoutsReady = jest.fn<
      () => Promise<{ ok: boolean; value: (typeof payoutRow)[] }>
    >();
    cashPayoutsReady.mockResolvedValueOnce({ ok: true, value: [payoutRow] });
    cashPayoutsReady.mockResolvedValue({ ok: true, value: [] });
    const executed = {
      payoutNumber: "SCP-0042",
      amountMinor: 1_250_000,
      supplierPaymentId: "44444444-4444-4444-8444-444444444444",
      alreadyApplied: false,
      requestedBy: "Kasun",
      approvedBy: "Dilini",
      movementReason: "Supplier payout · SCP-0042",
      supplierName: "Hemas Pharmaceuticals",
      expectedCashMinorAfter: 1_235_000,
    };
    stubPos({
      cashPayoutsReady,
      executeCashPayout: async () => ({ ok: true, value: executed }),
    });
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={shift()} online />,
    );
    await waitFor(() => expect(screen.getAllByText(/SCP-0042/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: /^Pay out/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Pay out/ }));
    await waitFor(() => expect(screen.getByText("Payout complete")).toBeTruthy());
    expect(screen.getByText(/Expected drawer now/)).toBeTruthy();
    expect(screen.getByText(/Rs 12,350.00/)).toBeTruthy();
    expect(cashPayoutsReady).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(cashPayoutsReady).toHaveBeenCalledTimes(2));
  });

  it("shows server refusal messages in the sheet", async () => {
    stubPos({
      cashPayoutsReady: async () => ({ ok: true, value: [payoutRow] }),
      executeCashPayout: async () => ({
        ok: false,
        error: { code: "INSUFFICIENT_DRAWER_CASH", message: "The drawer does not hold enough cash for this payout." },
      }),
    });
    render(
      <SupplierCashPayoutTab device={signedInDevice()} shift={shift()} online />,
    );
    await waitFor(() => expect(screen.getAllByText(/SCP-0042/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole("button", { name: /^Pay out/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: /^Pay out/ }));
    expect(await within(dialog).findByText(/does not hold enough cash/)).toBeTruthy();
  });
});