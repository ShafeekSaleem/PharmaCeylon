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
      value: {
        products: [panadol, amoxicillin],
        vatRatePercent: 0,
        maxDiscountPercent: 10,
      },
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

async function renderSell(props: { online?: boolean } = {}) {
  renderWithKeys(
    <KeyScope active>
      <Sell {...props} />
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

describe("line discounts on F9 (P2b #103)", () => {
  const managerId = "00000000-0000-4000-8000-0000000000f1";
  const discountField = () =>
    screen.getByLabelText("Discount percent") as HTMLInputElement;

  /** Panadol × 2 (192.00) on the ticket, paid in full, with F9's sheet open. */
  async function discountSheet() {
    await renderSell();
    await scan(panadol.barcode!);
    press("+", { shiftKey: true });
    press("F9");
    await act(async () => undefined);
    expect(screen.getByRole("dialog", { name: panadol.name })).toBeTruthy();
    expect(document.activeElement).toBe(discountField());
  }

  it("gives a discount up to the limit without a manager, and shows it on the ticket and in the totals", async () => {
    pos.submitCheckout!.mockImplementation(() => new Promise(() => undefined));
    await discountSheet();
    fireEvent.change(discountField(), { target: { value: "10" } });
    expect(screen.queryByText("Manager approval")).toBeNull();
    press("Enter");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(search());

    // The line keeps its full price struck through; the totals take the discount off.
    expect(screen.getByRole("button", { name: `Change the discount on ${panadol.name}` }).textContent).toContain("Discount −10%");
    expect(screen.getByText("Discount", { selector: "dt" })).toBeTruthy();
    expect(screen.getByText("−19.20")).toBeTruthy();
    expect(screen.getAllByText("172.80").length).toBeGreaterThan(0);

    fireEvent.change(cash(), { target: { value: "172.80" } });
    press("F12");
    expect(pos.submitCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ productId: panadol.productId, qty: 2, discountMinor: 1920 }],
        tender: { cashAmount: "172.80" },
      }),
    );
    expect(pos.submitCheckout!.mock.calls[0]![0]).not.toHaveProperty("discountCoSign");
  });

  it("over the limit, asks for a manager's PIN and sends their co-sign with the sale, once", async () => {
    pos.listDiscountApprovers = jest.fn(async () => ({
      ok: true,
      value: [{ userId: managerId, fullName: "Nimal Manager", hasPin: true }],
    })) as never;
    pos.submitCheckout!.mockImplementation(async () => ({
      ok: false,
      error: { code: "DISCOUNT_COSIGN_REFUSED", message: "Incorrect till PIN" },
    }));
    await discountSheet();
    fireEvent.change(discountField(), { target: { value: "25" } });
    await act(async () => undefined);
    expect(screen.getByText(/Over the 10% limit/)).toBeTruthy();
    // Not until someone approves it.
    expect((screen.getByRole("button", { name: /Apply discount/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /Nimal Manager/ }));
    await act(async () => undefined);
    const pin = screen.getByLabelText("Nimal Manager's PIN") as HTMLInputElement;
    expect(document.activeElement).toBe(pin);
    fireEvent.change(pin, { target: { value: "8642" } });
    press("Enter");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Nimal Manager approves as you complete")).toBeTruthy();

    fireEvent.change(cash(), { target: { value: "200" } });
    press("F12");
    await act(async () => undefined);
    expect(pos.submitCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        lines: [{ productId: panadol.productId, qty: 2, discountMinor: 4800 }],
        discountCoSign: { approverUserId: managerId, pin: "8642" },
      }),
    );
    // Refused: back in the sheet with the reason, and the PIN is gone.
    expect(screen.getByRole("dialog", { name: panadol.name })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Incorrect till PIN");
    expect((screen.getByLabelText("Nimal Manager's PIN") as HTMLInputElement).value).toBe("");
  });

  it("asks again for approval of a recalled discount over the limit before completing it", async () => {
    pos.listDiscountApprovers = jest.fn(async () => ({ ok: true, value: [] })) as never;
    pos.listHolds = jest.fn(async () => ({
      ok: true,
      value: [{ holdId: "00000000-0000-4000-8000-0000000000a9", holdRef: "H-0009", label: null, itemCount: 2, total: "144.00", createdAt: "", heldBy: "Ana" }],
    })) as never;
    pos.recallHold = jest.fn(async () => ({
      ok: true,
      value: { lines: [{ productId: panadol.productId, qty: 2, discountMinor: 4800 }], customer: null, prescription: null },
    })) as never;
    pos.submitCheckout!.mockImplementation(() => new Promise(() => undefined));
    await renderSell();
    fireEvent.click(screen.getByRole("button", { name: /^Held/ }));
    fireEvent.click(screen.getByRole("button", { name: "Recall" }));
    await act(async () => undefined);
    // The held discount came back; the approval didn't.
    expect(screen.getByText("Discount over 10% needs a manager")).toBeTruthy();

    fireEvent.change(cash(), { target: { value: "200" } });
    press("F12");
    await act(async () => undefined);
    expect(pos.submitCheckout).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: panadol.name })).toBeTruthy();
    expect((screen.getByLabelText("Discount amount") as HTMLInputElement).value).toBe("48.00");

    // A seller whose role may approve their own says so; the server decides at checkout.
    fireEvent.click(screen.getByRole("button", { name: /approving it myself/ }));
    press("Enter", { ctrlKey: true });
    await act(async () => undefined);
    press("F12");
    expect(pos.submitCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ lines: [{ productId: panadol.productId, qty: 2, discountMinor: 4800 }] }),
    );
    expect(pos.submitCheckout!.mock.calls[0]![0]).not.toHaveProperty("discountCoSign");
  });

  it("is off while the counter is offline, and says why", async () => {
    await renderSell({ online: false });
    await scan(panadol.barcode!);
    press("F9");
    await act(async () => undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
    const button = screen.getByRole("button", { name: /^Discount/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("note").textContent).toContain(
      "Discounts need the server. They're off while the counter is offline.",
    );
  });
});
