/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type {
  LocalShift,
  OfflineModeState,
  OfflineReceiptView,
  OfflineStaff,
  ShiftState,
} from "../../shared/ipc-contract";
import {
  deviceState,
  emptyEnrollmentOfflineBackup,
  ids,
  renderWithKeys,
  stubPos,
} from "../test/harness";
import { KeyScope } from "./keymap";
import { slipTime } from "./OfflineCard";
import { OfflineCounter } from "./OfflineCounter";
import type { OfflineStockLine } from "./offline-sell-model";

const mode: OfflineModeState = {
  mode: "offline",
  reason: null,
  clock: null,
  connected: false,
  outageStartedAt: new Date(2026, 10, 17, 15, 48).toISOString(),
  grantExpiresAt: new Date(2026, 10, 18, 8, 12).toISOString(),
  snapshotGeneratedAt: new Date(2026, 10, 17, 15, 41).toISOString(),
};

const people: OfflineStaff["people"] = [
  {
    staffUserId: ids.ana,
    staffName: "Ana Perera",
    canAssistClose: false,
    canAcknowledgeHours: false,
    lockRemainingMs: 0,
  },
  {
    staffUserId: ids.ben,
    staffName: "Ben Silva",
    canAssistClose: true,
    canAcknowledgeHours: true,
    lockRemainingMs: 0,
  },
];
const signedIn = (
  hours: OfflineStaff["hours"] = { status: "open" },
): OfflineStaff => ({
  signedIn: {
    staffUserId: ids.ana,
    staffName: "Ana Perera",
    signedInAt: "x",
    workSessionId: ids.session,
  },
  people,
  hours,
});

const shift = (over: Partial<LocalShift> = {}): ShiftState =>
  ({
    current: {
      workSessionId: ids.session,
      shiftNumber: null,
      staffUserId: ids.ana,
      staffName: "Ana Perera",
      openedAt: new Date(2026, 10, 17, 8, 14).toISOString(),
      openingCashMinor: 500_000,
      openingCount: [],
      status: "open",
      sync: "pending",
      error: null,
      expectedCashMinor: 500_000,
      ...over,
    },
    lastClosed: null,
    unsynced: [],
  }) as unknown as ShiftState;

const panadol: OfflineStockLine = {
  snapshotLineId: "line-panadol",
  productId: "p1",
  batchId: "b1",
  remaining: 18,
  unitPriceMinor: 9600,
  sellBefore: Date.UTC(2027, 7, 1),
  blocked: null,
  display: {
    name: "Panadol 500mg Tablets",
    strength: null,
    barcode: null,
    batchNo: "PN2409",
  },
};
const amoxil: OfflineStockLine = {
  ...panadol,
  snapshotLineId: "line-amoxil",
  productId: "p2",
  blocked: "NOT_SOLD_OFFLINE",
  display: {
    name: "Amoxicillin 500mg Capsules",
    strength: null,
    barcode: null,
    batchNo: "AX1",
  },
};

const receipt: OfflineReceiptView = {
  receiptNumber: "C1R-000186",
  saleCommandId: "00000000-0000-4000-8000-0000000000aa",
  checkoutDraftId: "d",
  soldAt: new Date(2026, 10, 17, 16, 20).getTime(),
  sellerName: "Ana Perera",
  lines: [
    {
      snapshotLineId: "line-panadol",
      productId: "p1",
      batchId: "b1",
      quantity: 2,
      unitPriceMinor: 9600,
      taxMinor: 0,
      lineTotalMinor: 19200,
      display: panadol.display,
    },
  ],
  subtotalMinor: 19200,
  taxMinor: 0,
  totalMinor: 19200,
  payments: [
    {
      method: "cash",
      amountMinor: 19200,
      tenderedMinor: 20000,
      changeMinor: 800,
    },
  ],
  changeMinor: 800,
};

const quote = (
  blocked: {
    snapshotLineId: string;
    quantity: number;
    reason: "STOCK_REVIEW";
    remaining: null;
  }[] = [],
) => ({
  ok: true,
  value: {
    lines: [{ ...receipt.lines[0]!, quantity: 1, lineTotalMinor: 9600 }],
    blocked,
    subtotalMinor: 9600,
    taxMinor: 0,
    totalMinor: 9600,
    digest: "d",
  },
});

const enrollment = {
  status: "active" as const,
  branchId: ids.branch,
  branchName: "Kollupitiya",
  branchCode: "KOL",
  registerId: ids.register,
  tillId: ids.till,
  counterLabel: "Counter 2",
  label: "PC",
  terminalId: ids.till,
  enrollmentId: ids.register,
  enrolledAt: null,
  enrolledByUserId: ids.ana,
  enrolledByName: null,
  offlineBackup: emptyEnrollmentOfflineBackup,
  enrollmentFactsLive: true,
  lastTestReceipt: null,
  enrollmentStatusFetchedAt: null,
};

const attemptId = "00000000-0000-4000-8000-0000000000c9";

let pos: ReturnType<typeof stubPos>;
async function show(
  staff: OfflineStaff,
  state: ShiftState | null = shift(),
  calls = {},
) {
  pos = stubPos({
    offlineStaff: async () => staff,
    offlineStock: async () => ({ ok: true, value: [panadol, amoxil] }),
    offlineOpenCard: async () => ({ ok: true, value: null }),
    offlineQuote: async () => quote(),
    offlineCommitSale: async () => ({ ok: true, value: receipt }),
    ...calls,
  });
  renderWithKeys(
    <KeyScope active>
      <OfflineCounter
        device={deviceState({ enrollment })}
        mode={mode}
        journal={null}
        shift={state}
        onShift={() => undefined}
        printer={null}
      />
    </KeyScope>,
  );
  await act(async () => undefined);
}

beforeEach(() => {
  if (!globalThis.crypto?.randomUUID)
    Object.defineProperty(globalThis, "crypto", {
      value: { randomUUID: () => "00000000-0000-4000-8000-0000000000d0" },
      configurable: true,
    });
});
afterEach(cleanup);

describe("the offline counter (P4 #50)", () => {
  it("signs a prepared person in with their PIN, checked on this computer", async () => {
    await show({ signedIn: null, people, hours: null });
    expect(screen.getByText("Ben Silva")).toBeTruthy();
    fireEvent.click(screen.getByText("Ben Silva"));
    for (const digit of ["1", "2", "3", "4"])
      fireEvent.click(screen.getByRole("button", { name: digit }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    });
    expect(pos.offlineSignIn).toHaveBeenCalledWith({
      staffUserId: ids.ben,
      pin: "1234",
    });
  });

  it("sells from the saved stock for cash and shows a normal receipt with its final number", async () => {
    await show(signedIn());
    expect(screen.getByText("Selling from last-known stock")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search offline stock"), {
      target: { value: "amox" },
    });
    expect(screen.getByText("Needs an online check")).toBeTruthy();
    expect(
      (
        screen
          .getByText("Amoxicillin 500mg Capsules")
          .closest("button") as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Search offline stock"), {
      target: { value: "panadol" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Panadol 500mg Tablets"));
    });
    expect(pos.offlineQuote).toHaveBeenCalledWith({
      items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
    });
    const complete = screen.getByRole("button", {
      name: /Complete sale/,
    }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Cash received"), {
      target: { value: "200" },
    });
    expect(screen.getByText("Rs 104.00")).toBeTruthy();
    await act(async () => {
      fireEvent.click(complete);
    });
    expect(pos.offlineCommitSale).toHaveBeenCalledWith({
      checkoutDraftId: expect.any(String),
      items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
      cashTenderedMinor: 20000,
    });
    const paper = screen.getByRole("dialog", { name: "Receipt C1R-000186" });
    expect(paper.textContent).toContain("C1R-000186");
    expect(paper.textContent).not.toMatch(/offline|pending|upload/i);
    // The cashier, not the customer, sees that it's waiting to upload.
    expect(screen.getByText("Pending upload")).toBeTruthy();
  });

  it("won't complete a cart the saved stock refuses, or outside selling hours", async () => {
    await show(signedIn(), shift(), {
      offlineQuote: async () =>
        quote([
          {
            snapshotLineId: "line-panadol",
            quantity: 1,
            reason: "STOCK_REVIEW",
            remaining: null,
          },
        ]),
    });
    fireEvent.change(screen.getByLabelText("Search offline stock"), {
      target: { value: "panadol" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Panadol 500mg Tablets"));
    });
    fireEvent.change(screen.getByLabelText("Cash received"), {
      target: { value: "200" },
    });
    expect(screen.getByText("Stock under review")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Complete sale/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    cleanup();

    await show(signedIn({ status: "needs_acknowledgement" }));
    expect(screen.getByText("It's outside selling hours")).toBeTruthy();
  });

  it("asks for the drawer count when no shift is open, and names whose shift is", async () => {
    await show(signedIn(), {
      current: null,
      lastClosed: null,
      unsynced: [],
    } as unknown as ShiftState);
    expect(screen.getByText("Count the drawer")).toBeTruthy();
    cleanup();
    await show(
      signedIn(),
      shift({ staffUserId: ids.ben, staffName: "Ben Silva" }),
    );
    expect(
      screen.getByText("Ben Silva's shift is open on this till"),
    ).toBeTruthy();
  });

  it("says what waits for the connection on every other page, Hold included", async () => {
    await show(signedIn());
    fireEvent.click(screen.getByRole("button", { name: "Returns" }));
    expect(screen.getByText("Refunds need an online connection")).toBeTruthy();
    expect(screen.getByText("Holding a sale")).toBeTruthy();
  });

  async function addPanadol() {
    fireEvent.change(screen.getByLabelText("Search offline stock"), {
      target: { value: "panadol" },
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Panadol 500mg Tablets"));
    });
  }
  const completeButton = () =>
    screen.getByRole("button", { name: /Complete sale/ }) as HTMLButtonElement;

  it("takes the card on the branch's machine, saved first, then sells with no cash", async () => {
    const cardReceipt: OfflineReceiptView = {
      ...receipt,
      payments: [
        {
          method: "external_card",
          amountMinor: 9600,
          providerReference: "RRN 4471",
          approvalCode: "A12",
        } as OfflineReceiptView["payments"][number],
      ],
      changeMinor: 0,
    };
    await show(signedIn(), shift(), {
      offlinePrepareCard: async () => ({
        ok: true,
        value: { attemptId, digest: "d" },
      }),
      offlineCardOutcome: async () => ({
        ok: true,
        value: { state: "approved" },
      }),
      offlineCommitSale: async () => ({ ok: true, value: cardReceipt }),
    });
    await addPanadol();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: /Charge Rs 96.00 on the card machine/,
        }),
      );
    });
    expect(pos.offlinePrepareCard).toHaveBeenCalledWith({
      checkoutDraftId: expect.any(String),
      items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
      amountMinor: 9600,
    });
    // The sale is fixed while the card is on the machine.
    expect(
      (screen.getByRole("button", { name: /Clear/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Cash" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(completeButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    fireEvent.change(screen.getByLabelText("Slip reference"), {
      target: { value: "RRN 4471" },
    });
    fireEvent.change(screen.getByLabelText("Approval code"), {
      target: { value: "A12" },
    });
    // The slip time starts empty: a default would record when the button was pressed.
    const slipAt = screen.getByLabelText(
      "Time on the slip",
    ) as HTMLInputElement;
    expect(slipAt.value).toBe("");
    expect(
      (
        screen.getByRole("button", {
          name: "Record approval",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(slipAt, { target: { value: "09:41" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
    });
    expect(pos.offlineCardOutcome).toHaveBeenCalledWith({
      attemptId,
      outcome: {
        kind: "approved",
        reference: "RRN 4471",
        approvalCode: "A12",
        approvedAt: expect.any(String),
      },
    });
    expect(screen.getByText("Card approved · Rs 96.00")).toBeTruthy();
    expect(screen.queryByLabelText("Cash received")).toBeNull();
    await act(async () => {
      fireEvent.click(completeButton());
    });
    expect(pos.offlineCommitSale).toHaveBeenCalledWith({
      checkoutDraftId: expect.any(String),
      items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
      cashTenderedMinor: 0,
    });
    const paper = screen.getByRole("dialog", { name: "Receipt C1R-000186" });
    // Note 5: the pharmacy's name is on the receipt, as online.
    expect(paper.textContent).toContain("Kollupitiya");
    expect(paper.textContent).toContain("Card · ref RRN 4471");
  });

  it("splits a sale: part on the card, the rest in cash", async () => {
    await show(signedIn(), shift(), {
      offlinePrepareCard: async () => ({
        ok: true,
        value: { attemptId, digest: "d" },
      }),
      offlineCardOutcome: async () => ({
        ok: true,
        value: { state: "approved" },
      }),
    });
    await addPanadol();
    fireEvent.click(screen.getByRole("button", { name: "Split" }));
    fireEvent.change(screen.getByLabelText("On the card"), {
      target: { value: "50" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: /Charge Rs 50.00 on the card machine/,
        }),
      );
    });
    expect(pos.offlinePrepareCard).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: 5000 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    fireEvent.change(screen.getByLabelText("Slip reference"), {
      target: { value: "R1" },
    });
    fireEvent.change(screen.getByLabelText("Approval code"), {
      target: { value: "C1" },
    });
    fireEvent.change(screen.getByLabelText("Time on the slip"), {
      target: { value: "09:41" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record approval" }));
    });
    fireEvent.change(screen.getByLabelText(/Cash for the rest · Rs 46.00/), {
      target: { value: "50" },
    });
    expect(screen.getByText("Rs 4.00")).toBeTruthy();
    await act(async () => {
      fireEvent.click(completeButton());
    });
    expect(pos.offlineCommitSale).toHaveBeenCalledWith(
      expect.objectContaining({ cashTenderedMinor: 5000 }),
    );
  });

  it("lets the cashier try again after a decline, and won't sell on an unsure card", async () => {
    let state = "uncertain";
    await show(signedIn(), shift(), {
      offlinePrepareCard: async () => ({
        ok: true,
        value: { attemptId, digest: "d" },
      }),
      offlineCardOutcome: async () => ({ ok: true, value: { state } }),
    });
    await addPanadol();
    fireEvent.click(screen.getByRole("button", { name: "Card" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Charge Rs 96.00/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not sure" }));
    });
    expect(
      screen.getByText("Check the card machine before charging again"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not sure" })).toBeNull();
    expect(completeButton().disabled).toBe(true);

    state = "declined";
    fireEvent.click(screen.getByRole("button", { name: "Declined" }));
    fireEvent.change(screen.getByLabelText("Slip reference"), {
      target: { value: "D9" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Record decline" }));
    });
    expect(screen.getByText(/The card was declined\./)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Charge Rs 96.00/ }),
    ).toBeTruthy();
    // Settled, so the cart and the method are free again.
    expect(
      (screen.getByRole("button", { name: "Cash" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("drops the old price when the cart changes, and says when pricing fails (note 2)", async () => {
    let fail = false;
    let resolve: (v: unknown) => void = () => undefined;
    await show(signedIn(), shift(), {
      offlineQuote: async () =>
        fail ? new Promise((r) => (resolve = r)) : quote(),
    });
    await addPanadol();
    fireEvent.change(screen.getByLabelText("Cash received"), {
      target: { value: "500" },
    });
    expect(completeButton().disabled).toBe(false);
    fail = true;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "One more" }));
    });
    // Repricing: the total for the smaller cart can't be used.
    expect(completeButton().disabled).toBe(true);
    await act(async () => {
      resolve({
        ok: false,
        error: { code: "X", message: "The stock snapshot is no longer valid." },
      });
    });
    expect(
      screen.getByText("The stock snapshot is no longer valid."),
    ).toBeTruthy();
    expect(completeButton().disabled).toBe(true);
  });

  it("says when the saved stock can't be read, and tries again (note 3)", async () => {
    let calls = 0;
    await show(signedIn(), shift(), {
      offlineStock: async () =>
        ++calls === 1
          ? {
              ok: false,
              error: {
                code: "X",
                message: "The saved stock could not be checked.",
              },
            }
          : { ok: true, value: [panadol] },
    });
    expect(
      screen.getByText("The saved stock could not be checked."),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    });
    expect(
      screen.queryByText("The saved stock could not be checked."),
    ).toBeNull();
    await addPanadol();
    expect(pos.offlineQuote).toHaveBeenCalled();
  });

  it("brings back a card left on the machine, with its cart, and keeps the counter on Sell until it is settled", async () => {
    // Sell closed with an approved card on the machine (a reload, a restart): main still has it.
    await show(signedIn(), shift(), {
      offlineOpenCard: async () => ({
        ok: true,
        value: {
          checkoutDraftId: "00000000-0000-4000-8000-0000000000e1",
          items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
          totalMinor: 9600,
          attempt: {
            attemptId,
            amountMinor: 9600,
            state: "approved",
            reference: "RRN 4471",
            approvalCode: "A12",
          },
        },
      }),
    });
    await act(async () => undefined);
    expect(screen.getByText("Card approved · Rs 96.00")).toBeTruthy();
    expect(screen.getByText("Panadol 500mg Tablets")).toBeTruthy();
    // Nothing leaves Sell while the card is open.
    for (const name of [
      "Cash & shift",
      "Returns",
      "Stock",
      "This counter",
      "Switch person",
    ])
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    await act(async () => {
      fireEvent.click(completeButton());
    });
    expect(pos.offlineCommitSale).toHaveBeenCalledWith({
      checkoutDraftId: "00000000-0000-4000-8000-0000000000e1",
      items: [{ snapshotLineId: "line-panadol", quantity: 1 }],
      cashTenderedMinor: 0,
    });
    // Settled: the counter can move again.
    expect(
      (
        screen.getByRole("button", {
          name: "Switch person",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("lets a prepared manager acknowledge selling after hours with their own PIN (D8)", async () => {
    const acknowledged = signedIn({
      status: "acknowledged",
      until: new Date(2026, 10, 17, 22, 30).toISOString(),
      managerName: "Ben Silva",
    });
    await show(signedIn({ status: "needs_acknowledgement" }), shift(), {
      offlineAcknowledgeHours: async () => ({ ok: true, value: acknowledged }),
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Manager acknowledges…" }),
    );
    const sheet = screen.getByRole("dialog", {
      name: "Acknowledge selling after hours",
    });
    expect((screen.getByLabelText("Manager") as HTMLSelectElement).value).toBe(
      ids.ben,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 h" }));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Queue at closing" },
    });
    fireEvent.change(screen.getByLabelText("Manager's PIN"), {
      target: { value: "2468" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    });
    expect(pos.offlineAcknowledgeHours).toHaveBeenCalledWith({
      staffUserId: ids.ben,
      pin: "2468",
      minutes: 120,
      reason: "Queue at closing",
    });
    expect(sheet.isConnected).toBe(false);
    expect(screen.getByText("Selling after hours")).toBeTruthy();
    expect(screen.getByText(/acknowledged by Ben Silva/)).toBeTruthy();
  });

  it("closes your own shift offline from the drawer count", async () => {
    await show(signedIn(), shift(), {
      offlineCloseShift: async () => ({ ok: true, value: signedIn() }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Cash & shift" }));
    expect(screen.getByText("Close your shift")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Number of 1,000 notes"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Coins, in rupees"), {
      target: { value: "40" },
    });
    expect(screen.getByText("+40.00")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What happened (optional)"), {
      target: { value: "Extra change" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Close my shift/ }));
    });
    expect(pos.offlineCloseShift).toHaveBeenCalledWith({
      count: expect.objectContaining({ totalMinor: 504_000 }),
      varianceNote: "Extra change",
    });
  });

  it("lets a prepared manager close someone else's shift with their own PIN and a reason", async () => {
    const ben: OfflineStaff = {
      ...signedIn(),
      signedIn: {
        staffUserId: ids.ben,
        staffName: "Ben Silva",
        signedInAt: "x",
        workSessionId: "00000000-0000-4000-8000-0000000000e2",
      },
    };
    await show(ben, shift(), {
      offlineCloseShift: async () => ({ ok: true, value: ben }),
    });
    fireEvent.click(screen.getByRole("button", { name: /Close it for them/ }));
    expect(screen.getByText("Close Ana Perera's shift")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Number of 1,000 notes"), {
      target: { value: "5" },
    });
    const close = screen.getByRole("button", {
      name: /Close their shift/,
    }) as HTMLButtonElement;
    expect(close.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Why you're closing it for them"), {
      target: { value: "Ana went home ill" },
    });
    fireEvent.change(screen.getByLabelText("Your PIN, Ben"), {
      target: { value: "2468" },
    });
    await act(async () => {
      fireEvent.click(close);
    });
    expect(pos.offlineCloseShift).toHaveBeenCalledWith({
      count: expect.objectContaining({ totalMinor: 500_000 }),
      assistance: { pin: "2468", reason: "Ana went home ill" },
    });
  });

  it("explains that only a prepared manager closes someone else's shift", async () => {
    await show(
      signedIn(),
      shift({ staffUserId: ids.ben, staffName: "Ben Silva" }),
    );
    expect(
      screen.queryByRole("button", { name: /Close it for them/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cash & shift" }));
    expect(
      screen.getByText(/a prepared manager closes it for them/),
    ).toBeTruthy();
  });

  it("switches person at the counter, and goes back without signing anyone out", async () => {
    await show(signedIn());
    fireEvent.click(screen.getByRole("button", { name: "Switch person" }));
    expect(screen.getByText("Who's at the counter?")).toBeTruthy();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Back to the counter" }),
      );
    });
    expect(screen.getByText("Selling from last-known stock")).toBeTruthy();
  });

  it("reads the time on the slip as today, or yesterday when it's later than now", () => {
    const now = new Date(2026, 10, 17, 0, 10);
    expect(slipTime("00:05", now)).toBe(
      new Date(2026, 10, 17, 0, 5).toISOString(),
    );
    expect(slipTime("23:58", now)).toBe(
      new Date(2026, 10, 16, 23, 58).toISOString(),
    );
    expect(slipTime("24:00", now)).toBeNull();
    expect(slipTime("noon", now)).toBeNull();
  });
});
