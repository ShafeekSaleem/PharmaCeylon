/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type {
  ProductStock,
  StockAttention,
  StockBatch,
  StockRow,
} from "../../shared/ipc-contract";
import { press, renderWithKeys, stubPos } from "../test/harness";
import { KeyScope } from "./keymap";
import { Stock } from "./Stock";

const AUGMENTIN = "00000000-0000-4000-8000-00000000a625";
const AUGMENTIN_375 = "00000000-0000-4000-8000-00000000a375";

const row = (overrides: Partial<StockRow> = {}): StockRow => ({
  productId: AUGMENTIN,
  name: "Augmentin 625mg Tablets",
  strength: null,
  unit: "tab",
  manufacturer: "GSK",
  unitsPerPack: 14,
  packLabel: null,
  requiresPrescription: true,
  isControlled: false,
  reorderLevel: 20,
  stockStatus: "ok",
  available: 146,
  onHand: 164,
  quarantined: 4,
  reserved: 14,
  batchCount: 4,
  nearExpiryBatchCount: 1,
  expiredBatchCount: 0,
  nextExpiry: "2026-11-24",
  ...overrides,
});

const batch = (id: string, overrides: Partial<StockBatch>): StockBatch => ({
  batchId: `00000000-0000-4000-8000-0000000b${id}`,
  batchNo: `AUG-${id}`,
  expiryDate: "2027-02-28",
  daysToExpiry: 119,
  expired: false,
  nearExpiry: false,
  needsExpiryReview: false,
  isQuarantined: false,
  quarantineReason: null,
  onHand: 0,
  available: 0,
  reserved: 0,
  quarantined: 0,
  sellingPrice: "145.00",
  costPrice: "103.00",
  ...overrides,
});

/** The mockup's Augmentin 625mg. */
const augmentin: ProductStock = {
  product: {
    productId: AUGMENTIN,
    name: "Augmentin 625mg Tablets",
    genericName: "Amoxicillin + clavulanic acid",
    strength: null,
    manufacturer: "GSK",
    unit: "tab",
    unitsPerPack: 14,
    packLabel: null,
    requiresPrescription: true,
    isControlled: false,
    reorderLevel: 20,
  },
  stockStatus: "ok",
  totals: { onHand: 164, available: 146, quarantined: 4, reserved: 14, expired: 0 },
  batches: [
    batch("6904", {
      expiryDate: "2026-08-31",
      daysToExpiry: -65,
      expired: true,
      isQuarantined: true,
      onHand: 4,
      quarantined: 4,
    }),
    batch("7311", {
      expiryDate: "2026-11-24",
      daysToExpiry: 23,
      nearExpiry: true,
      onHand: 6,
      available: 6,
    }),
    batch("7520", { expiryDate: "2027-02-28", onHand: 56, reserved: 14, available: 42 }),
    batch("7781", { expiryDate: "2027-12-31", daysToExpiry: 425, onHand: 98, available: 98 }),
  ],
  reservations: [{ qty: 14, label: "TR-0095 to Nugegoda" }],
  otherBranches: [
    { branchId: "00000000-0000-4000-8000-0000000000b2", name: "Bambalapitiya", available: 64, onHand: 64 },
    { branchId: "00000000-0000-4000-8000-0000000000b3", name: "Kandy", available: 0, onHand: 0 },
  ],
  movements: [
    {
      id: "00000000-0000-4000-8000-0000000000f1",
      occurredAt: "2026-10-22T09:00:00.000Z",
      movementType: "purchase_in",
      batchNo: "AUG-7781",
      qtyDelta: 98,
      quarantineDelta: 0,
      actorName: "Hemas",
    },
  ],
  writeOffLimit: "10000.00",
};

const attention: StockAttention = {
  expiringBatches: 6,
  expiredBatches: 0,
  quarantinedProducts: 3,
  quarantinedUnits: 11,
  lowStockProducts: 9,
  expiryWarningDays: 30,
};

let pos: Record<string, jest.Mock>;

beforeEach(() => {
  jest.useFakeTimers();
  pos = stubPos({
    stockSearch: async () => ({
      ok: true,
      value: {
        items: [
          row(),
          row({
            productId: AUGMENTIN_375,
            name: "Augmentin 375mg Tablets",
            stockStatus: "low",
            available: 5,
            reorderLevel: 8,
          }),
        ],
        total: 2,
        expiryWarningDays: 30,
      },
    }),
    stockAttention: async () => ({ ok: true, value: attention }),
    productStock: async () => ({ ok: true, value: augmentin }),
    adjustStock: async () => ({ ok: true, value: { qty: 4, movementType: "adjustment_out" } }),
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

async function settle() {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  await act(async () => undefined);
}

async function renderStock(onCommandSent = jest.fn()) {
  renderWithKeys(
    <KeyScope active>
      <Stock branchName="Kollupitiya" onCommandSent={onCommandSent} />
    </KeyScope>,
  );
  await settle();
  return onCommandSent;
}

const search = () => screen.getByLabelText("Find a product") as HTMLInputElement;
const batchRow = (no: string) =>
  within(screen.getByRole("table", { name: "Batches" }))
    .getByText(no)
    .closest('[role="row"]') as HTMLElement;

describe("Stock lookup", () => {
  it("searches as you type and shows the first match's quantities", async () => {
    await renderStock();
    fireEvent.change(search(), { target: { value: "augm" } });
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ q: "augm", filter: "all" });
    expect(screen.getByText("2 matches")).toBeTruthy();
    expect(screen.getByText("Below reorder (8)")).toBeTruthy();
    expect(pos.productStock).toHaveBeenCalledWith({ productId: AUGMENTIN });
    const tiles = ["Available", "On hand", "Reserved", "Quarantined"].map(
      (label) => screen.getAllByText(label).find((el) => el.tagName === "SMALL")!.parentElement!,
    );
    expect(tiles.map((t) => t.querySelector("b")!.textContent)).toEqual([
      "146tabs",
      "164tabs",
      "14tabs",
      "4tabs",
    ]);
    expect(screen.getByText("Transfer TR-0095 to Nugegoda")).toBeTruthy();
    expect(screen.getByText("Prescription only")).toBeTruthy();
    expect(screen.getByText(/Rs 145.00 \/ tab/)).toBeTruthy();
  });

  it("lists batches oldest expiry first, with recent movements", async () => {
    await renderStock();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("span")!.textContent)).toEqual([
      "AUG-6904",
      "AUG-7311",
      "AUG-7520",
      "AUG-7781",
    ]);
    expect(within(batchRow("AUG-6904")).getByText("Expired 2 months ago")).toBeTruthy();
    expect(screen.getByText(/^Received/).textContent).toBe("Received · AUG-7781 · Hemas");
    expect(screen.getByText("+98")).toBeTruthy();
  });

  it("filters by the chips", async () => {
    await renderStock();
    fireEvent.click(screen.getByRole("button", { name: "Low stock" }));
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ filter: "low" });
    fireEvent.click(screen.getByRole("button", { name: "Prescription" }));
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ filter: "prescription" });
  });

  it("F6 goes to search, ↑/↓ move between products and Esc clears", async () => {
    await renderStock();
    press("F6");
    expect(document.activeElement).toBe(search());
    press("ArrowDown");
    await settle();
    expect(pos.productStock).toHaveBeenLastCalledWith({ productId: AUGMENTIN_375 });
    fireEvent.change(search(), { target: { value: "augm" } });
    press("Escape");
    expect(search().value).toBe("");
  });
});

describe("Sell first", () => {
  it("marks the batch checkout sells next: the earliest in-date one, even when it expires soon", async () => {
    await renderStock();
    // FEFO skips the expired, held AUG-6904; AUG-7311 expires next and is still sellable, so
    // checkout takes it before AUG-7520 (where the mockup draws the label).
    expect(within(batchRow("AUG-7311")).getByText("Sell first · expiring")).toBeTruthy();
    expect(within(batchRow("AUG-7520")).getByText("Good")).toBeTruthy();
    expect(within(batchRow("AUG-6904")).getByText("Quarantined · expired")).toBeTruthy();
  });

  it("moves to the next batch once the expiring one is no longer sellable", async () => {
    pos.productStock!.mockImplementation(async () => ({
      ok: true,
      value: {
        ...augmentin,
        batches: augmentin.batches.map((b) =>
          b.batchNo === "AUG-7311" ? { ...b, isQuarantined: true, quarantined: 6, available: 0 } : b,
        ),
      },
    }));
    await renderStock();
    expect(within(batchRow("AUG-7520")).getByText("Sell first")).toBeTruthy();
    expect(screen.getAllByText(/^Sell first/)).toHaveLength(1);
    expect(within(batchRow("AUG-7781")).getByText("Good")).toBeTruthy();
  });
});

describe("Needs attention", () => {
  it("lists this branch's expiring, quarantined and low-stock items", async () => {
    await renderStock();
    const list = screen.getByLabelText("Needs attention");
    expect(within(list).getByText("6 batches expire within 30 days")).toBeTruthy();
    expect(within(list).getByText("11 units in quarantine")).toBeTruthy();
    expect(within(list).getByText("9 products below reorder level")).toBeTruthy();
    expect(screen.getByText("Kollupitiya")).toBeTruthy();
  });

  it("opens each list with the stock-by-product filter", async () => {
    await renderStock();
    fireEvent.click(screen.getByText("6 batches expire within 30 days"));
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ filter: "all", attention: "near_expiry" });
    expect(screen.getByRole("button", { name: /Expiring soon/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByText("11 units in quarantine"));
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ filter: "all", attention: "quarantined" });
    fireEvent.click(screen.getByText("9 products below reorder level"));
    await settle();
    expect(pos.stockSearch).toHaveBeenLastCalledWith({ filter: "low" });
  });

  it("reads nothing until the page is first shown", async () => {
    renderWithKeys(
      <KeyScope active>
        <Stock branchName="Kollupitiya" active={false} />
      </KeyScope>,
    );
    await settle();
    expect(pos.stockSearch).not.toHaveBeenCalled();
    expect(pos.stockAttention).not.toHaveBeenCalled();
  });
});

describe("other branches", () => {
  it("shows what the server returned for the branches this person works at", async () => {
    await renderStock();
    const card = screen.getByText("Other branches").parentElement!;
    expect(within(card).getByText("Bambalapitiya").parentElement!.textContent).toContain("64");
    expect(within(card).getByText("Kandy").parentElement!.textContent).toContain("0");
    expect(within(card).getByText("Transfers are requested and approved on the web.")).toBeTruthy();
  });
});

describe("stock actions", () => {
  it("leaves quarantine disabled, with the reason", async () => {
    await renderStock();
    const quarantine = within(batchRow("AUG-7311")).getByRole("button", { name: "Quarantine" });
    expect((quarantine as HTMLButtonElement).disabled).toBe(true);
    expect(quarantine.getAttribute("title")).toMatch(/on the web for now/);
  });

  it("writes off the held expired batch with Ctrl+Enter, under the limit", async () => {
    const sent = await renderStock();
    expect(screen.getByText("Write off AUG-6904 · 4 tabs · Rs 412.00 at cost")).toBeTruthy();
    press("Enter", { ctrlKey: true });
    await settle();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByTestId("write-off-limit").textContent).toBe(
      "Rs 412.00 at cost: under the Rs 10,000.00 limit, so no manager approval is needed.",
    );
    press("Enter", { ctrlKey: true });
    await settle();
    expect(pos.adjustStock).toHaveBeenCalledWith({
      productId: AUGMENTIN,
      batchId: augmentin.batches[0]!.batchId,
      kind: "expired",
      qty: 4,
      fromQuarantine: true,
    });
    expect(sent).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Wrote off 4 tabs of AUG-6904.")).toBeTruthy();
  });

  it("says a manager is needed when the server refuses a write-off over the limit", async () => {
    pos.adjustStock!.mockImplementation(async () => ({
      ok: false,
      error: { code: "WRITE_OFF_APPROVAL_REQUIRED", message: "needs approval" },
    }));
    await renderStock();
    press("Enter", { ctrlKey: true });
    await settle();
    press("Enter", { ctrlKey: true });
    await settle();
    expect(screen.getByRole("alert").textContent).toMatch(/needs a manager/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("asks for a reason before a correction, and Esc closes the form", async () => {
    await renderStock();
    fireEvent.click(within(batchRow("AUG-7781")).getByRole("button", { name: "Adjust" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("What happened"), {
      target: { value: "correction_out" },
    });
    fireEvent.submit(dialog);
    await settle();
    expect(within(dialog).getByRole("alert").textContent).toMatch(/why/);
    expect(pos.adjustStock).not.toHaveBeenCalled();
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
