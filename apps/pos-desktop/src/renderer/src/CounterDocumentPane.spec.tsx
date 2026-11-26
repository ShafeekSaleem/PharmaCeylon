/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CounterWorkDetail } from "@pharmaceylon/shared";
import type { CounterWorkItem } from "../../shared/ipc-contract";
import { stubPos } from "../test/harness";
import { CounterDocumentPane } from "./CounterDocumentPane";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approval = { evidenceId: id(90), approvedVersion: 3, currentVersion: 3, state: "matches" as const, changes: [] };
const DOESNT_MATCH = "Something doesn't match";

const item: CounterWorkItem = {
  kind: "prepared_receipt",
  id: id(1),
  reference: "PO-2026-0187",
  subject: "Hemas Pharmaceuticals",
  lineCount: 2,
  amount: null,
  readyAt: "2026-11-26T08:00:00.000Z",
  requested: null,
  approved: null,
  dispatched: null,
  approval,
};

function receipt(overrides: Record<string, unknown> = {}): CounterWorkDetail {
  return {
    kind: "prepared_receipt",
    id: id(1),
    reference: "PO-2026-0187",
    subject: "Hemas Pharmaceuticals",
    approval,
    notes: [],
    mismatches: [],
    lines: [
      { index: 0, productId: id(11), productName: "Panadol 500mg", packLabel: "Box of 96", unitsPerPack: 96, batchId: null, batchNo: "B-1", expiryDate: "2028-04-30", packs: 10, receivedQty: 960, freeQty: 0, damagedQty: 0, damagedReason: null, unitsToStock: 960, packCost: null, unitCost: null },
      { index: 1, productId: id(12), productName: "Amoxil 250mg", packLabel: null, unitsPerPack: 1, batchId: null, batchNo: "B-2", expiryDate: null, packs: null, receivedQty: 20, freeQty: 0, damagedQty: 0, damagedReason: null, unitsToStock: 20, packCost: null, unitCost: null },
    ],
    ...overrides,
  } as unknown as CounterWorkDetail;
}

let pos: Record<string, jest.Mock>;
let detail: CounterWorkDetail;
const onReported = jest.fn();

let keys = 0;
beforeEach(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => id(500 + keys++) },
    configurable: true,
  });
  detail = receipt();
  onReported.mockClear();
  pos = stubPos({
    counterWorkDetail: async () => ({ ok: true, value: detail }),
    reportCounterMismatch: async () => ({
      ok: true,
      value: { id: id(70), status: "open", holding: true, problem: "fewer_arrived", reported: { name: "Sachini", at: null } },
    }),
  });
});
afterEach(cleanup);

const open = async (online = true) => {
  render(<CounterDocumentPane item={item} online={online} onReported={onReported} />);
  await screen.findByText("Panadol 500mg");
};

const openForm = () => {
  fireEvent.click(screen.getByRole("button", { name: DOESNT_MATCH }));
  return screen.getByRole("form", { name: DOESNT_MATCH });
};

describe("the approved lines", () => {
  it("shows the delivery as approved, read-only", async () => {
    await open();
    expect(screen.getByText("Box of 96")).toBeTruthy();
    expect(screen.getByText("B-1")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(pos.counterWorkDetail).toHaveBeenCalledWith({ kind: "prepared_receipt", id: id(1) });
  });

  it("says so when the lines cannot be read, and lets the person try again", async () => {
    pos.counterWorkDetail!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "NOT_WAITING", message: "That is not waiting at this counter any more." },
    }));
    render(<CounterDocumentPane item={item} online onReported={onReported} />);
    expect(await screen.findByText("That is not waiting at this counter any more.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Panadol 500mg")).toBeTruthy();
  });

  it("turns the report off when the approval changed or the counter is offline", async () => {
    detail = receipt({ approval: { ...approval, state: "changed", changes: ["Line 2 quantity"] } });
    await open();
    expect(screen.getByText(/Changed after approval/)).toBeTruthy();
    expect((screen.getByRole("button", { name: DOESNT_MATCH }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    detail = receipt();
    await open(false);
    expect((screen.getByRole("button", { name: DOESNT_MATCH }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("something does not match", () => {
  it("sends the line, count and note to the approver and posts nothing", async () => {
    await open();
    const form = openForm();
    const send = within(form).getByRole("button", { name: /Send to the approver/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(form).getByRole("radio", { name: "Fewer arrived" }));
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "0" } });
    expect(within(form).getByText(/Packs that arrived \(the document says 10\)/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/Packs that arrived/), { target: { value: "8" } });
    fireEvent.change(within(form).getByLabelText(/Note/), { target: { value: "Two boxes short" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(pos.reportCounterMismatch).toHaveBeenCalledTimes(1));
    expect(pos.reportCounterMismatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prepared_receipt",
        documentId: id(1),
        approvalId: id(90),
        documentVersion: 3,
        line: { index: 0 },
        problem: "fewer_arrived",
        countedQty: 8,
        note: "Two boxes short",
      }),
    );
    expect(await screen.findByText(/Nothing was posted/)).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
  });

  it("asks for a note, and for no line, when something is not on the delivery note", async () => {
    await open();
    const form = openForm();
    fireEvent.click(within(form).getByRole("radio", { name: "Not on the delivery note" }));
    expect(within(form).queryByRole("combobox")).toBeNull();
    expect(within(form).getByText("Add a note saying what you found.")).toBeTruthy();
  });

  it("keeps the same key when the answer is lost, so a second try returns the same report", async () => {
    pos.reportCounterMismatch!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "UNEXPECTED", message: "Something went wrong. Please try again." },
    }));
    await open();
    const form = openForm();
    fireEvent.click(within(form).getByRole("radio", { name: "Damaged" }));
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "1" } });
    fireEvent.change(within(form).getByLabelText(/Damaged units/), { target: { value: "2" } });
    const send = within(form).getByRole("button", { name: /Send to the approver/ });
    fireEvent.click(send);
    expect(await within(form).findByRole("alert")).toBeTruthy();
    fireEvent.click(send);
    await waitFor(() => expect(pos.reportCounterMismatch).toHaveBeenCalledTimes(2));
    const keys = pos.reportCounterMismatch!.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
  });

  it("sends a different report under a new key when the form is edited after a lost answer", async () => {
    pos.reportCounterMismatch!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "UNEXPECTED", message: "Something went wrong. Please try again." },
    }));
    await open();
    const form = openForm();
    fireEvent.click(within(form).getByRole("radio", { name: "Fewer arrived" }));
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "0" } });
    fireEvent.change(within(form).getByLabelText(/Packs that arrived/), { target: { value: "8" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send to the approver/ }));
    expect(await within(form).findByRole("alert")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(/Packs that arrived/), { target: { value: "7" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send to the approver/ }));
    await waitFor(() => expect(pos.reportCounterMismatch).toHaveBeenCalledTimes(2));
    const sent = pos.reportCounterMismatch!.mock.calls.map((c) => c[0] as { idempotencyKey: string; countedQty: number });
    expect(sent[1]!.countedQty).toBe(7);
    expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  });

  it("starts a cancelled report afresh, and moves between choices with the arrow keys", async () => {
    await open();
    let form = openForm();
    const first = within(form).getByRole("radio", { name: "Fewer arrived" });
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(within(form).getByRole("radio", { name: "More arrived" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    form = openForm();
    expect(within(form).getByRole("radio", { name: "More arrived" }).getAttribute("aria-checked")).toBe("false");
  });

  it("says why reporting is off when the counter is offline", async () => {
    await open(false);
    expect(screen.getByText(/needs the server/)).toBeTruthy();
  });

  it("reads the document again when the server says it changed", async () => {
    pos.reportCounterMismatch!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "CHANGED_SINCE_OPENED", message: "This changed since you opened it. Open it again." },
    }));
    await open();
    const form = openForm();
    fireEvent.click(within(form).getByRole("radio", { name: "Fewer arrived" }));
    fireEvent.change(within(form).getByRole("combobox"), { target: { value: "0" } });
    fireEvent.change(within(form).getByLabelText(/Packs that arrived/), { target: { value: "8" } });
    fireEvent.click(within(form).getByRole("button", { name: /Send to the approver/ }));
    await waitFor(() => expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("This changed since you opened it. Open it again.")).toBeTruthy();
  });

  it("uses the transfer-out wording and shows a report that holds the transfer", async () => {
    detail = {
      kind: "transfer_ship",
      id: id(2),
      approval,
      notes: [],
      mismatches: [
        { id: id(71), problem: "cannot_pick", lineLabel: "Ventolin", countedQty: 5, countUnit: "units", note: null, holding: true, reported: { name: "Sachini", at: null }, kind: "transfer_ship" },
      ],
      otherBranch: "Bambalapitiya",
      lines: [{ transferItemId: id(7), productId: id(13), productName: "Ventolin", packLabel: null, unitsPerPack: 1, batchId: null, batchNo: "V-1", expiryDate: "2027-01-31", qty: 12, receivedQty: 0, remainingQty: 12 }],
    } as unknown as CounterWorkDetail;
    render(<CounterDocumentPane item={{ ...item, kind: "transfer_ship", id: id(2) }} online onReported={onReported} />);
    await screen.findByText("V-1");
    expect(screen.getByText(/waits here until a corrected version is approved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Can't pick all of it" })).toBeTruthy();
  });
});
