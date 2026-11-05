/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { CheckoutDraftView } from "../../shared/ipc-contract";
import { ids, renderWithKeys, stubPos } from "../test/harness";
import { KeyScope } from "./keymap";
import { Sell } from "./Sell";

const draft = (overrides: Partial<CheckoutDraftView> = {}): CheckoutDraftView => ({
  draftId: "00000000-0000-4000-8000-0000000000f1",
  staffUserId: ids.ana,
  estimatedTotal: "250.00",
  createdAt: new Date(2026, 10, 4, 10, 15).toISOString(),
  lineCount: 2,
  coSignerId: null,
  staffName: "Ana Perera",
  ownSale: false,
  ...overrides,
});

let pos: Record<string, jest.Mock>;
function stub(drafts: CheckoutDraftView[], retry: () => unknown) {
  pos = stubPos({
    catalog: async () => ({ ok: true, value: { products: [], vatRatePercent: 0 } }),
    listHolds: async () => ({ ok: true, value: [] }),
    pendingCheckouts: async () => drafts,
    listApprovers: async () => ({ ok: true, value: [] }),
    retryCheckout: retry,
  });
}

async function renderSell() {
  renderWithKeys(
    <KeyScope active>
      <Sell />
    </KeyScope>,
  );
  await act(async () => undefined);
}

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

describe("Sell's unconfirmed sales", () => {
  it("lets a colleague confirm a sale someone else started, and names who started it", async () => {
    stub([draft({ coSignerId: ids.ben })], async () => ({
      ok: false,
      error: { code: "CHECKOUT_NEVER_LANDED", message: "That sale never went through, and now it can't." },
    }));
    await renderSell();
    expect(screen.getByText(/started by Ana Perera/)).toBeTruthy();
    expect(screen.queryByText(/who must confirm it/)).toBeNull();
    // Looking it up needs no co-sign: no PIN field for a colleague.
    expect(screen.queryByLabelText("Co-signing pharmacist's PIN")).toBeNull();
    const button = screen.getByRole("button", { name: "Confirm with server" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(pos.retryCheckout).toHaveBeenCalledWith({ draftId: draft().draftId });
    expect(screen.getByText("That sale never went through, and now it can't.")).toBeTruthy();
  });

  it("asks the seller for the co-signer's PIN on their own co-signed sale", async () => {
    stub([draft({ ownSale: true, coSignerId: ids.ben })], async () => new Promise(() => undefined));
    await renderSell();
    expect(screen.getByText(/rung up by you/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Co-signing pharmacist's PIN"), { target: { value: "4321" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm with server" }));
    });
    expect(pos.retryCheckout).toHaveBeenCalledWith({
      draftId: draft().draftId,
      coSign: { approverUserId: ids.ben, pin: "4321" },
    });
  });

  it("names a seller who has since signed out", async () => {
    stub([draft({ staffName: null })], async () => new Promise(() => undefined));
    await renderSell();
    expect(screen.getByText(/started by someone who has signed out/)).toBeTruthy();
  });
});
