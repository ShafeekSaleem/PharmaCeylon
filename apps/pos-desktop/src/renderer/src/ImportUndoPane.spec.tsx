/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { CounterUndoableImport } from "@pharmaceylon/shared";
import { renderWithKeys, stubPos } from "../test/harness";
import { CounterWork } from "./CounterWork";
import { SERVER_CHECKS, undoSentence } from "./ImportUndoPane";
import { KeyScope } from "./keymap";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function undoable(overrides: Partial<CounterUndoableImport> = {}): CounterUndoableImport {
  return {
    importId: id(1),
    filename: "kollupitiya-otc.xlsx",
    uploaded: { name: "Kasun J.", at: "2026-11-17T04:30:00.000Z" },
    stopped: false,
    productsCreated: 38,
    productsUpdated: 6,
    createdProducts: [
      { productId: id(11), productName: "Dettol Antiseptic 250ml" },
      { productId: id(19), productName: "Catalogue only, no stock" },
    ],
    batches: 44,
    units: 1960,
    lines: [
      { productId: id(11), productName: "Dettol Antiseptic 250ml", packLabel: null, unitsPerPack: 1, batchId: id(21), batchNo: "DT-2511", expiryDate: "2029-03-31", qty: 48, newProduct: true },
      { productId: id(12), productName: "Vicks VapoRub 25g", packLabel: null, unitsPerPack: 1, batchId: id(22), batchNo: "VV-7710", expiryDate: "2028-06-30", qty: 36, newProduct: false },
    ],
    ...overrides,
  };
}

let pos: ReturnType<typeof stubPos>;
let imports: CounterUndoableImport[];
let pending: { commandId: string; operation: string; createdAt: string; staffName: string | null }[];

beforeEach(() => {
  imports = [undoable()];
  pending = [];
  pos = stubPos({
    counterWork: async () => ({ ok: true, value: [] }),
    refundsReady: async () => ({ ok: true, value: [] }),
    stockCasesReady: async () => ({ ok: true, value: [] }),
    pendingCommands: async () => pending,
    undoableImports: async () => ({ ok: true, value: imports }),
    undoCounterImport: async () => ({
      ok: true,
      value: { filename: "kollupitiya-otc.xlsx", batchesRemoved: 44, productsRemoved: 38, productsLeftInPlace: 6, undoneAt: "2026-11-27T12:00:00.000Z" },
    }),
  });
});
afterEach(cleanup);

async function renderWork(props: Parameters<typeof CounterWork>[0] = {}) {
  const view = renderWithKeys(
    <KeyScope active>
      <CounterWork you="Sachini Rathnayake" counterLabel="Counter 2" {...props} />
    </KeyScope>,
  );
  await act(async () => undefined);
  return view;
}
const tabs = () => screen.getByRole("group", { name: "Kind of work" });
const openImports = () => fireEvent.click(within(tabs()).getByRole("button", { name: /^Imports/ }));
const undoButton = () => screen.getByRole("button", { name: /^Undo the import$/ }) as HTMLButtonElement;

describe("the Imports filter (decision 5)", () => {
  it("shows only when an import can still be undone, and is left out of All and the badge", async () => {
    const onCount = jest.fn();
    imports = [];
    const view = await renderWork({ onCount });
    expect(within(tabs()).queryByRole("button", { name: /^Imports/ })).toBeNull();
    view.unmount();
    imports = [undoable()];
    await renderWork({ onCount });
    expect(within(tabs()).getByRole("button", { name: /^Imports/ }).textContent).toContain("1");
    expect(within(tabs()).getByRole("button", { name: /^All/ }).textContent).toContain("0");
    expect(onCount).toHaveBeenLastCalledWith(0);
  });

  it("opens the import with what undo removes and what stays", async () => {
    await renderWork();
    openImports();
    const card = within(screen.getByLabelText("Waiting at the counter")).getByRole("button", { name: /Undo an import/ });
    expect(card.textContent).toContain("kollupitiya-otc.xlsx");
    expect(card.textContent).toContain("38 new products");
    const pane = screen.getByRole("region", { name: "Undo kollupitiya-otc.xlsx" });
    expect(within(pane).getByText("New product")).toBeTruthy();
    expect(within(pane).getByText("Updated · product stays")).toBeTruthy();
    expect(within(pane).getByText(/Undo also removes 1 product the import created without stock: Catalogue only, no stock\./)).toBeTruthy();
    expect(within(pane).getByText(/not listed here: correct it with a stock adjustment/)).toBeTruthy();
  });

  it("confirms, then undoes with only the import, and says so once it leaves the list", async () => {
    await renderWork();
    openImports();
    fireEvent.click(undoButton());
    const sheet = screen.getByRole("dialog");
    expect(document.activeElement).toBe(sheet);
    expect(within(sheet).getByText(undoSentence(undoable()))).toBeTruthy();
    expect(undoSentence(undoable())).toBe(
      "Undo takes back the whole import: the 38 products it created are removed from the catalogue, along with all the stock it posted (44 batches, 1,960 units). The 6 products it only updated stay, but lose the stock the import added to them.",
    );
    // The sold/moved checks are the server's, run on undo: stated as such, never ticked here.
    expect(within(sheet).getByText(SERVER_CHECKS)).toBeTruthy();
    expect(within(sheet).queryByText("No stock from this import has been sold or moved")).toBeNull();
    // Ctrl+Enter does not undo: it is a click on purpose.
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(pos.undoCounterImport).not.toHaveBeenCalled();
    imports = [];
    fireEvent.click(within(sheet).getByRole("button", { name: /Undo the import/ }));
    await waitFor(() => expect(pos.undoCounterImport).toHaveBeenCalledWith({ importId: id(1) }));
    expect(
      await screen.findByText(
        "Undone kollupitiya-otc.xlsx: 38 products removed from the catalogue and 44 batches of stock taken back; 6 products kept with the import's changes.",
      ),
    ).toBeTruthy();
    expect(await screen.findByText("No import here can still be undone.")).toBeTruthy();
    // The result belongs to the Imports filter: another tab doesn't carry it.
    fireEvent.click(within(tabs()).getByRole("button", { name: /^All/ }));
    expect(screen.queryByText(/^Undone kollupitiya-otc\.xlsx/)).toBeNull();
  });

  it("goes back from the sheet with Esc", async () => {
    await renderWork();
    openImports();
    fireEvent.click(undoButton());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.undoCounterImport).not.toHaveBeenCalled();
  });

  it("says a refusal and reads the list again", async () => {
    (pos.undoCounterImport as jest.Mock).mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "NOT_UNDOABLE", message: "This import can't be undone any more: something from it has sold or moved, or it was undone already." },
    }));
    await renderWork();
    openImports();
    const reads = (pos.undoableImports as jest.Mock).mock.calls.length;
    fireEvent.click(undoButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Undo the import/ }));
    expect(await screen.findByText(/can't be undone any more/)).toBeTruthy();
    await waitFor(() => expect((pos.undoableImports as jest.Mock).mock.calls.length).toBeGreaterThan(reads));
  });

  it("will not undo offline or while an action waits to be confirmed", async () => {
    const view = await renderWork({ online: false });
    openImports();
    expect(undoButton().disabled).toBe(true);
    view.unmount();
    pending = [{ commandId: id(9), operation: "POST /api/v1/stocktakes/:id/post", createdAt: "2026-11-27T11:00:00.000Z", staffName: null }];
    await renderWork();
    openImports();
    expect(undoButton().disabled).toBe(true);
    expect(screen.getByText("Confirm the action waiting at this counter first.")).toBeTruthy();
  });

  it("says a stopped import only takes back what it posted, and leaves updates out when there were none", async () => {
    imports = [undoable({ stopped: true, productsCreated: 0, productsUpdated: 0 })];
    await renderWork();
    openImports();
    expect(screen.getByText(/stopped part-way; undo removes what it did post/)).toBeTruthy();
    expect(undoSentence(imports[0]!)).toBe("Undo takes back all the stock it posted (44 batches, 1,960 units).");
  });
});
