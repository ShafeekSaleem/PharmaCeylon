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
import { deviceState, ids, renderWithKeys, stubPos } from "../test/harness";
import { KeyScope } from "./keymap";
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

let pos: ReturnType<typeof stubPos>;
async function show(
  staff: OfflineStaff,
  state: ShiftState | null = shift(),
  calls = {},
) {
  pos = stubPos({
    offlineStaff: async () => staff,
    offlineStock: async () => ({ ok: true, value: [panadol, amoxil] }),
    offlineQuote: async () => quote(),
    offlineCommitSale: async () => ({ ok: true, value: receipt }),
    ...calls,
  });
  renderWithKeys(
    <KeyScope active>
      <OfflineCounter
        device={deviceState()}
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
    expect(
      screen.getByText(/A prepared manager must acknowledge it/),
    ).toBeTruthy();
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
});
