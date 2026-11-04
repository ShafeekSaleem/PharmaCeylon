/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import type { CatalogProduct } from "../../shared/ipc-contract";
import { press, renderWithKeys, stubPos } from "../test/harness";
import { KeyScope } from "./keymap";
import { Sell } from "./Sell";

const panadol: CatalogProduct = {
  productId: "00000000-0000-4000-8000-00000000a001",
  name: "Panadol 500mg Tablets",
  sku: "PAN500",
  barcode: "4791234567890",
  strength: null,
  unit: "strip",
  unitPrice: "96.00",
  available: 40,
  needsPharmacist: false,
  requiresPrescription: false,
  isControlled: false,
};
const amoxicillin: CatalogProduct = {
  ...panadol,
  productId: "00000000-0000-4000-8000-00000000a002",
  name: "Amoxicillin 500mg Capsules",
  sku: "AMX500",
  barcode: "4790000000002",
  needsPharmacist: true,
  requiresPrescription: true,
};

let pos: Record<string, jest.Mock>;

beforeEach(() => {
  jest.useFakeTimers();
  pos = stubPos({
    catalog: async () => ({
      ok: true,
      value: { products: [panadol, amoxicillin], vatRatePercent: 0 },
    }),
    listHolds: async () => ({ ok: true, value: [] }),
    holdCart: async () => ({ ok: true, value: { holdRef: "H-0001" } }),
    pendingCheckouts: async () => [],
    searchPrescriptions: async () => ({ ok: true, value: [] }),
    listApprovers: async () => ({ ok: true, value: [] }),
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

async function renderSell() {
  renderWithKeys(
    <KeyScope active>
      <Sell />
    </KeyScope>,
  );
  await act(async () => undefined);
}

const search = () => screen.getByLabelText("Scan or search") as HTMLInputElement;
const cash = () => document.getElementById("sell-cash") as HTMLInputElement;

/** Types into search and presses Enter, as the scanner does. */
async function scan(code: string) {
  fireEvent.change(search(), { target: { value: code } });
  fireEvent.submit(search().closest("form")!);
  await act(async () => undefined);
}

describe("Sell's keys", () => {
  it("keeps the cursor in search, so the scanner always lands there", async () => {
    await renderSell();
    expect(document.activeElement).toBe(search());
    await scan(panadol.barcode!);
    expect(document.activeElement).toBe(search());
  });

  it("F12 and Ctrl+Enter complete the sale, and only once it is paid for", async () => {
    pos.submitCheckout!.mockImplementation(() => new Promise(() => undefined));
    await renderSell();
    await scan(panadol.barcode!);
    press("F12");
    expect(pos.submitCheckout).not.toHaveBeenCalled();

    fireEvent.change(cash(), { target: { value: "100" } });
    press("Enter", { ctrlKey: true });
    expect(pos.submitCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ productId: panadol.productId, qty: 1 }],
        tender: { cashAmount: "100" },
      }),
    );
  });

  it("F8 holds the sale", async () => {
    await renderSell();
    await scan(panadol.barcode!);
    press("F8");
    await act(async () => undefined);
    expect(pos.holdCart).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ productId: panadol.productId, qty: 1 }],
      }),
    );
    expect(document.activeElement).toBe(search());
  });

  it("+ and − change the selected line from the empty search field", async () => {
    pos.submitCheckout!.mockImplementation(() => new Promise(() => undefined));
    await renderSell();
    await scan(panadol.barcode!);
    press("+", { shiftKey: true });
    press("+", { shiftKey: true });
    press("-");
    fireEvent.change(cash(), { target: { value: "500" } });
    press("F12");
    expect(pos.submitCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ productId: panadol.productId, qty: 2 }],
      }),
    );
  });

  it("types a number key with nothing focused into cash received, once no scan follows it", async () => {
    await renderSell();
    await scan(panadol.barcode!);
    (document.activeElement as HTMLElement).blur();
    press("5");
    act(() => void jest.advanceTimersByTime(200));
    expect(cash().value).toBe("5");
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(cash());
  });

  it("leaves a scan that starts with nothing focused in search, never in cash", async () => {
    await renderSell();
    await scan(panadol.barcode!);
    (document.activeElement as HTMLElement).blur();
    // The first character arrives as a key press; the rest of the burst types into search,
    // which the first key focused.
    press("4");
    expect(document.activeElement).toBe(search());
    fireEvent.change(search(), { target: { value: panadol.barcode } });
    act(() => void jest.advanceTimersByTime(200));
    expect(cash().value).toBe("");
    expect(search().value).toBe(panadol.barcode);
  });

  it("opens the prescription sheet as a layer: Sell's keys are quiet, Esc goes back to the sale", async () => {
    await renderSell();
    await scan(amoxicillin.barcode!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    press("F8");
    await act(async () => undefined);
    expect(pos.holdCart).not.toHaveBeenCalled();

    press("Escape");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(search());

    press("F10");
    await act(async () => undefined);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
