/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CounterWorkDetail } from "@pharmaceylon/shared";
import type { CounterWorkItem } from "../../shared/ipc-contract";
import { stubPos } from "../test/harness";
import { clearCheckedLines, CounterDocumentPane } from "./CounterDocumentPane";

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
  clearCheckedLines();
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
  render(<CounterDocumentPane item={item} online={online} canPost onReported={onReported} />);
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
    render(<CounterDocumentPane item={item} online canPost onReported={onReported} />);
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
    render(<CounterDocumentPane item={{ ...item, kind: "transfer_ship", id: id(2) }} online canPost onReported={onReported} />);
    await screen.findByText("V-1");
    expect(screen.getByText(/waits here until a corrected version is approved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Can't pick all of it" })).toBeTruthy();
  });
});

describe("posting the receiving", () => {
  const posted = {
    kind: "prepared_receipt",
    reference: "PO-2026-0187",
    goodsReceiptId: "GR-1",
    alreadyApplied: false,
    requestedBy: "Kasun",
    approvedBy: "Dilini",
    postedAt: "2026-11-26T09:00:00.000Z",
  };
  const post = () => screen.getByRole("button", { name: /Post receiving/ }) as HTMLButtonElement;
  const tick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Checked: ${name}` }));

  beforeEach(() => {
    pos.postCounterReceipt = jest.fn(async () => ({ ok: true, value: posted }));
    (window as unknown as { pos: unknown }).pos = pos;
  });

  it("stays off until every line is ticked, then posts only the document", async () => {
    await open();
    expect(post().disabled).toBe(true);
    expect(screen.getByText(/980 units go on the shelf/)).toBeTruthy();
    tick("Panadol 500mg");
    expect(post().disabled).toBe(true);
    tick("Amoxil 250mg");
    expect(post().disabled).toBe(false);
    fireEvent.click(post());
    await waitFor(() => expect(pos.postCounterReceipt).toHaveBeenCalledTimes(1));
    expect(pos.postCounterReceipt).toHaveBeenCalledWith({ kind: "prepared_receipt", id: id(1) });
    expect(await screen.findByText(/Posted\./)).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Post receiving/ })).toBeNull();
  });

  it("keeps a tick on a line a corrected version did not change, and drops it on one it did", async () => {
    await open();
    tick("Panadol 500mg");
    tick("Amoxil 250mg");
    cleanup();
    const corrected = receipt();
    (corrected as unknown as { lines: Array<{ receivedQty: number }> }).lines[1]!.receivedQty = 18;
    detail = corrected;
    await open();
    expect((screen.getByRole("checkbox", { name: "Checked: Panadol 500mg" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Checked: Amoxil 250mg" }) as HTMLInputElement).checked).toBe(false);
  });

  it("will not post while another action here is unconfirmed, offline, held by a report, or after the approval changed", async () => {
    await open();
    tick("Panadol 500mg");
    tick("Amoxil 250mg");
    cleanup();
    render(<CounterDocumentPane item={item} online canPost={false} onReported={onReported} />);
    await screen.findByText("Panadol 500mg");
    expect(post().disabled).toBe(true);
    cleanup();
    await open(false);
    expect(post().disabled).toBe(true);
    cleanup();
    detail = receipt({ mismatches: [{ id: id(72), problem: "damaged", holding: true, reported: { name: "S", at: null } }] });
    await open();
    expect(post().disabled).toBe(true);
    cleanup();
    detail = receipt({ approval: { ...approval, state: "changed", changes: [] } });
    await open();
    expect(screen.queryByRole("button", { name: /Post receiving/ })?.hasAttribute("disabled")).toBe(true);
  });

  it("drops a tick when only a cost or a pack size changed on the line", async () => {
    await open();
    tick("Panadol 500mg");
    tick("Amoxil 250mg");
    cleanup();
    const corrected = receipt();
    const lines = (corrected as unknown as { lines: Array<Record<string, unknown>> }).lines;
    lines[0]!.unitCost = "4.50";
    lines[1]!.unitsPerPack = 10;
    detail = corrected;
    await open();
    expect((screen.getByRole("checkbox", { name: "Checked: Panadol 500mg" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Checked: Amoxil 250mg" }) as HTMLInputElement).checked).toBe(false);
  });

  it("does not post a second time while the first answer is unconfirmed", async () => {
    pos.postCounterReceipt!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "UNCONFIRMED", message: "No answer from the server. Confirm it before doing anything else." },
    }));
    await open();
    tick("Panadol 500mg");
    tick("Amoxil 250mg");
    fireEvent.click(post());
    expect(await screen.findByText(/No answer from the server/)).toBeTruthy();
    // The frame now lists the unconfirmed command and stops passing canPost.
    cleanup();
    render(<CounterDocumentPane item={item} online canPost={false} onReported={onReported} />);
    await screen.findByText("Panadol 500mg");
    expect(post().disabled).toBe(true);
    fireEvent.click(post());
    expect(pos.postCounterReceipt).toHaveBeenCalledTimes(1);
  });

  it("says when a delivery has no lines", async () => {
    detail = receipt({ lines: [] });
    render(<CounterDocumentPane item={item} online canPost onReported={onReported} />);
    expect(await screen.findByText("This delivery has no lines to post.")).toBeTruthy();
  });

  it("shows a refusal and reads the document again, without marking it posted", async () => {
    pos.postCounterReceipt!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "APPROVAL_STALE", message: "This changed since it was approved." },
    }));
    detail = receipt();
    await open();
    tick("Panadol 500mg");
    tick("Amoxil 250mg");
    fireEvent.click(post());
    expect(await screen.findByText("This changed since it was approved.")).toBeTruthy();
    await waitFor(() => expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Posted\./)).toBeNull();
  });
});

describe("dispatching a transfer out", () => {
  function transferOut(overrides: Record<string, unknown> = {}): CounterWorkDetail {
    return {
      kind: "transfer_ship",
      id: id(2),
      reference: "TR-0101",
      subject: "Bambalapitiya",
      approval,
      notes: [],
      mismatches: [],
      otherBranch: "Bambalapitiya",
      lines: [
        { transferItemId: id(7), productId: id(13), productName: "Ventolin Inhaler", packLabel: null, unitsPerPack: 1, batchId: id(31), batchNo: "V-1", expiryDate: "2027-01-31", qty: 12, receivedQty: 0, remainingQty: 12 },
        { transferItemId: id(8), productId: id(14), productName: "Panadol 500mg", packLabel: null, unitsPerPack: 1, batchId: id(32), batchNo: "P-9", expiryDate: "2028-02-29", qty: 30, receivedQty: 0, remainingQty: 30 },
      ],
      ...overrides,
    } as unknown as CounterWorkDetail;
  }
  const shipItem: CounterWorkItem = { ...item, kind: "transfer_ship", id: id(2), reference: "TR-0101" };
  const dispatch = () => screen.getByRole("button", { name: /^Dispatch/ }) as HTMLButtonElement;
  const pick = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Picked: ${name}` }));
  const openShip = async (props: { online?: boolean; canPost?: boolean } = {}) => {
    render(
      <CounterDocumentPane
        item={shipItem}
        online={props.online ?? true}
        canPost={props.canPost ?? true}
        onReported={onReported}
      />,
    );
    await screen.findByText("Ventolin Inhaler");
  };

  beforeEach(() => {
    detail = transferOut();
    pos.dispatchCounterTransfer = jest.fn(async () => ({
      ok: true,
      value: { reference: "TR-0101", otherBranch: "Bambalapitiya", dispatchedQty: 42, alreadyApplied: false, postedAt: "2026-11-26T08:49:00.000Z" },
    }));
  });

  it("stays off until every line is picked, then dispatches only the transfer", async () => {
    await openShip();
    expect(screen.getByText(/42 units leave this branch for Bambalapitiya/)).toBeTruthy();
    expect(dispatch().disabled).toBe(true);
    pick("Ventolin Inhaler");
    expect(dispatch().disabled).toBe(true);
    pick("Panadol 500mg");
    expect(dispatch().disabled).toBe(false);
    fireEvent.click(dispatch());
    await waitFor(() => expect(pos.dispatchCounterTransfer).toHaveBeenCalledTimes(1));
    expect(pos.dispatchCounterTransfer).toHaveBeenCalledWith({ id: id(2) });
    expect(await screen.findByText("Dispatched. 42 units are on the way to Bambalapitiya.")).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Dispatch/ })).toBeNull();
  });

  it("dispatches under a waived policy, and says approval is not needed", async () => {
    detail = transferOut({ approval: { evidenceId: null, approvedVersion: null, currentVersion: 2, state: "not_needed", changes: [] } });
    await openShip();
    expect(screen.getByText(/Approval isn't needed at this branch/)).toBeTruthy();
    pick("Ventolin Inhaler");
    pick("Panadol 500mg");
    expect(dispatch().disabled).toBe(false);
  });

  it("will not dispatch after the approval changed, while a report holds it, offline, or with an action unconfirmed", async () => {
    const pickAll = () => {
      pick("Ventolin Inhaler");
      pick("Panadol 500mg");
    };
    detail = transferOut({ approval: { ...approval, state: "changed", changes: ["Line 1 quantity"] } });
    await openShip();
    pickAll();
    expect(dispatch().disabled).toBe(true);
    cleanup();
    clearCheckedLines();
    detail = transferOut({ mismatches: [{ id: id(73), problem: "cannot_pick", holding: true, reported: { name: "S", at: null } }] });
    await openShip();
    pickAll();
    expect(dispatch().disabled).toBe(true);
    cleanup();
    clearCheckedLines();
    detail = transferOut();
    await openShip({ online: false });
    pickAll();
    expect(dispatch().disabled).toBe(true);
    cleanup();
    await openShip({ canPost: false });
    expect(dispatch().disabled).toBe(true);
    expect(pos.dispatchCounterTransfer).not.toHaveBeenCalled();
  });

  it("drops a pick tick when a corrected version changes that line", async () => {
    await openShip();
    pick("Ventolin Inhaler");
    pick("Panadol 500mg");
    cleanup();
    const corrected = transferOut();
    (corrected as unknown as { lines: Array<{ qty: number; batchId: string }> }).lines[0]!.batchId = id(39);
    detail = corrected;
    await openShip();
    expect((screen.getByRole("checkbox", { name: "Picked: Ventolin Inhaler" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Picked: Panadol 500mg" }) as HTMLInputElement).checked).toBe(true);
  });

  it("shows a refusal, keeps the picks and reads the transfer again", async () => {
    pos.dispatchCounterTransfer!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "APPROVAL_STALE", message: "This transfer changed since it was approved." },
    }));
    await openShip();
    pick("Ventolin Inhaler");
    pick("Panadol 500mg");
    fireEvent.click(dispatch());
    expect(await screen.findByText("This transfer changed since it was approved.")).toBeTruthy();
    await waitFor(() => expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("checkbox", { name: "Picked: Ventolin Inhaler" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText(/^Dispatched\./)).toBeNull();
  });
});


describe("receiving a transfer in", () => {
  function transferIn(overrides: Record<string, unknown> = {}): CounterWorkDetail {
    return {
      kind: "transfer_receive",
      id: id(3),
      reference: "TR-0093",
      subject: "Bambalapitiya",
      approval: { evidenceId: id(91), approvedVersion: null, currentVersion: 2, state: "matches", changes: [] },
      notes: [],
      mismatches: [],
      otherBranch: "Bambalapitiya",
      lines: [
        { transferItemId: id(8), productId: id(13), productName: "Ventolin Inhaler", packLabel: null, unitsPerPack: 1, batchId: id(31), batchNo: "V-1", expiryDate: "2027-01-31", qty: 12, receivedQty: 4, remainingQty: 8 },
        { transferItemId: id(9), productId: id(14), productName: "Panadol 500mg", packLabel: null, unitsPerPack: 1, batchId: id(32), batchNo: "P-9", expiryDate: "2028-02-29", qty: 30, receivedQty: 0, remainingQty: 30 },
        { transferItemId: id(10), productId: id(15), productName: "Amoxil 250mg", packLabel: null, unitsPerPack: 1, batchId: id(33), batchNo: "A-2", expiryDate: null, qty: 5, receivedQty: 5, remainingQty: 0 },
      ],
      ...overrides,
    } as unknown as CounterWorkDetail;
  }
  const inItem: CounterWorkItem = { ...item, kind: "transfer_receive", id: id(3), reference: "TR-0093" };
  const receiveButton = () => screen.getByRole("button", { name: /^Receive/ }) as HTMLButtonElement;
  const arrived = (name: string, value: string) =>
    fireEvent.change(screen.getByRole("textbox", { name: `Arrived: ${name}` }), { target: { value } });
  const openIn = async (props: { online?: boolean; canPost?: boolean } = {}) => {
    render(
      <CounterDocumentPane item={inItem} online={props.online ?? true} canPost={props.canPost ?? true} onReported={onReported} />,
    );
    await screen.findByText("Ventolin Inhaler");
  };

  beforeEach(() => {
    detail = transferIn();
    pos.receiveCounterTransfer = jest.fn(async () => ({
      ok: true,
      value: { transferId: id(3), status: "partially_received", receivedQty: 8, postedAt: "2026-11-26T09:00:00.000Z" },
    }));
  });

  it("starts with empty counts, shows a received line as already in, and stays off until every open line is counted", async () => {
    await openIn();
    expect((screen.getByRole("textbox", { name: "Arrived: Ventolin Inhaler" }) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("textbox", { name: "Arrived: Amoxil 250mg" })).toBeNull();
    expect(screen.getByText("Already in", { selector: "small" })).toBeTruthy();
    expect(receiveButton().disabled).toBe(true);
    arrived("Ventolin Inhaler", "8");
    expect(screen.getByText("Count every line (1 of 2).")).toBeTruthy();
    expect(receiveButton().disabled).toBe(true);
  });

  it("fills only the lines not counted, then receives with the counts as seen, leaving a zero line on the way", async () => {
    await openIn();
    arrived("Panadol 500mg", "0");
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    expect((screen.getByRole("textbox", { name: "Arrived: Ventolin Inhaler" }) as HTMLInputElement).value).toBe("8");
    expect((screen.getByRole("textbox", { name: "Arrived: Panadol 500mg" }) as HTMLInputElement).value).toBe("0");
    fireEvent.click(receiveButton());
    await waitFor(() => expect(pos.receiveCounterTransfer).toHaveBeenCalledTimes(1));
    expect(pos.receiveCounterTransfer).toHaveBeenCalledWith({
      transferId: id(3),
      dispatchApprovalId: id(91),
      lines: [{ transferItemId: id(8), qty: 8, receivedQtyBefore: 4 }],
    });
    expect(await screen.findByText(/The rest stays on the way until it arrives or a manager closes it on the web/)).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
  });

  it("refuses more than is on the way and points to the mismatch report", async () => {
    await openIn();
    arrived("Ventolin Inhaler", "9");
    arrived("Panadol 500mg", "30");
    expect(screen.getByText(/More Ventolin Inhaler than is on the way \(8\)/)).toBeTruthy();
    expect(receiveButton().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Something doesn't match" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("will not receive offline or with an action unconfirmed", async () => {
    await openIn({ online: false });
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    expect(receiveButton().disabled).toBe(true);
    cleanup();
    await openIn({ canPost: false });
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    expect(receiveButton().disabled).toBe(true);
    expect(pos.receiveCounterTransfer).not.toHaveBeenCalled();
  });

  it("after a refusal because part arrived elsewhere, reads again and drops the count on the line that changed", async () => {
    pos.receiveCounterTransfer!.mockImplementationOnce(async () => {
      detail = transferIn();
      (detail as unknown as { lines: Array<{ receivedQty: number; remainingQty: number }> }).lines[0]!.receivedQty = 6;
      (detail as unknown as { lines: Array<{ receivedQty: number; remainingQty: number }> }).lines[0]!.remainingQty = 6;
      return {
        ok: false,
        error: { code: "CONFLICT", message: "Part of this transfer was received since you counted it; refresh and count again" },
      };
    });
    await openIn();
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    fireEvent.click(receiveButton());
    expect(await screen.findByText(/received since you counted it/)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("textbox", { name: "Arrived: Ventolin Inhaler" }) as HTMLInputElement).value).toBe(""),
    );
    expect((screen.getByRole("textbox", { name: "Arrived: Panadol 500mg" }) as HTMLInputElement).value).toBe("30");
    expect(receiveButton().disabled).toBe(true);
  });

  it("after a partial receive, reads the transfer again and lets the rest be received from here", async () => {
    await openIn();
    arrived("Ventolin Inhaler", "8");
    arrived("Panadol 500mg", "0");
    // The server now has Ventolin fully in and Panadol still on the way.
    pos.receiveCounterTransfer!.mockImplementationOnce(async () => {
      detail = transferIn();
      const lines = (detail as unknown as { lines: Array<{ receivedQty: number; remainingQty: number }> }).lines;
      lines[0]!.receivedQty = 12;
      lines[0]!.remainingQty = 0;
      return {
        ok: true,
        value: { transferId: id(3), status: "partially_received", receivedQty: 8, postedAt: "2026-11-26T09:00:00.000Z" },
      };
    });
    fireEvent.click(receiveButton());
    expect(await screen.findByText(/Received 8 units\. The rest stays on the way/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Arrived: Ventolin Inhaler" })).toBeNull());
    expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2);
    expect((screen.getByRole("textbox", { name: "Arrived: Panadol 500mg" }) as HTMLInputElement).value).toBe("");
    arrived("Panadol 500mg", "30");
    expect(receiveButton().disabled).toBe(false);
  });

  it("will not receive when the dispatch changed or was withdrawn, and says so", async () => {
    detail = transferIn({ approval: { evidenceId: id(91), approvedVersion: 1, currentVersion: 2, state: "changed", changes: [] } });
    await openIn();
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    expect(screen.getByText(/Changed after approval/)).toBeTruthy();
    expect(receiveButton().disabled).toBe(true);
    cleanup();
    detail = transferIn({ approval: { evidenceId: id(91), approvedVersion: 2, currentVersion: 2, state: "revoked", changes: [] } });
    await openIn();
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    expect(screen.getByText(/The approval was withdrawn on the web/)).toBeTruthy();
    expect(receiveButton().disabled).toBe(true);
    expect(pos.receiveCounterTransfer).not.toHaveBeenCalled();
  });

  it("says when everything arrived", async () => {
    pos.receiveCounterTransfer!.mockImplementationOnce(async () => ({
      ok: true,
      value: { transferId: id(3), status: "received", receivedQty: 38, postedAt: "2026-11-26T09:00:00.000Z" },
    }));
    await openIn();
    fireEvent.click(screen.getByRole("button", { name: "Fill the rest as sent" }));
    fireEvent.click(receiveButton());
    expect(await screen.findByText("Received. 38 units booked in; nothing is left on the way.")).toBeTruthy();
    // It leaves Counter work, so the pane does not read it again (it would find it gone).
    expect(pos.counterWorkDetail).toHaveBeenCalledTimes(1);
  });
});

describe("posting a stock count", () => {
  function stocktake(overrides: Record<string, unknown> = {}): CounterWorkDetail {
    return {
      kind: "stocktake",
      id: id(4),
      reference: "ST-0009",
      subject: "Aisle B, analgesics",
      approval,
      requested: { name: "Kasun J.", at: null },
      approved: { name: "Dilini Fernando", at: null },
      dispatched: null,
      notes: [],
      mismatches: [],
      totals: { lines: 4, differences: 2, valueAtCost: "-24.00" },
      lines: [
        { lineId: id(41), productId: id(13), productName: "Panadol 500mg", packLabel: "Box of 96", unitsPerPack: 96, batchId: id(31), batchNo: "PN2410", expiryDate: null, onHandAtCount: 1152, countedQty: 1140, difference: -12, now: 1143, afterPost: 1131, valueAtCost: "-54.00", reviewNote: null },
        { lineId: id(42), productId: id(14), productName: "Disprin 300mg", packLabel: null, unitsPerPack: 1, batchId: id(32), batchNo: "DS-221", expiryDate: null, onHandAtCount: 240, countedQty: 250, difference: 10, now: 240, afterPost: 250, valueAtCost: "30.00", reviewNote: "Recounted twice" },
        { lineId: id(43), productId: id(15), productName: "Brufen 400mg", packLabel: null, unitsPerPack: 1, batchId: id(33), batchNo: "BR-778", expiryDate: null, onHandAtCount: 300, countedQty: 300, difference: 0, now: 300, afterPost: 300, valueAtCost: "0.00", reviewNote: null },
        { lineId: id(44), productId: id(16), productName: "Panadeine", packLabel: null, unitsPerPack: 1, batchId: id(34), batchNo: "PD-5501", expiryDate: null, onHandAtCount: 60, countedQty: null, difference: null, now: 58, afterPost: 58, valueAtCost: null, reviewNote: null },
      ],
      ...overrides,
    } as unknown as CounterWorkDetail;
  }
  const stkItem: CounterWorkItem = { ...item, kind: "stocktake", id: id(4), reference: "ST-0009" };
  const postButton = () => screen.getByRole("button", { name: /^Post stock count/ }) as HTMLButtonElement;
  const openStk = async (props: { online?: boolean; canPost?: boolean } = {}) => {
    render(
      <CounterDocumentPane item={stkItem} online={props.online ?? true} canPost={props.canPost ?? true} onReported={onReported} />,
    );
    await screen.findByText("Panadol 500mg");
  };

  beforeEach(() => {
    detail = stocktake();
    pos.postCounterStocktake = jest.fn(async () => ({
      ok: true,
      value: { reference: "ST-0009", alreadyApplied: false, postedAt: "2026-11-27T09:00:00.000Z" },
    }));
  });

  it("opens on the differences, read-only, with the count and cost totals", async () => {
    await openStk();
    expect(screen.getByText("Disprin 300mg")).toBeTruthy();
    expect(screen.queryByText("Brufen 400mg")).toBeNull();
    expect(screen.getByText("−12")).toBeTruthy();
    expect(screen.getByText("+Rs 30.00")).toBeTruthy();
    expect(screen.getByText("−Rs 24.00 at cost")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Something doesn't match" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All lines/ }));
    expect(screen.getByText("Brufen 400mg")).toBeTruthy();
    expect(screen.getByText("Not counted")).toBeTruthy();
  });

  it("confirms the totals before posting, then posts only the count", async () => {
    await openStk();
    fireEvent.click(postButton());
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText(/Post stock count ST-0009\?/)).toBeTruthy();
    expect(within(sheet).getByText(/Matches the version Dilini Fernando approved/)).toBeTruthy();
    expect(within(sheet).getByText(/1 line wasn't counted; posting leaves it as it is/)).toBeTruthy();
    expect(pos.postCounterStocktake).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: /Post 2 adjustments/ }));
    await waitFor(() => expect(pos.postCounterStocktake).toHaveBeenCalledWith({ id: id(4) }));
    expect(await screen.findByText("Posted. ST-0009: 2 adjustments written.")).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Post stock count/ })).toBeNull();
  });

  it("goes back from the sheet without posting", async () => {
    await openStk();
    fireEvent.click(postButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.postCounterStocktake).not.toHaveBeenCalled();
  });

  it("will not post after the approval changed or was withdrawn, offline, or with an action unconfirmed", async () => {
    detail = stocktake({ approval: { ...approval, state: "changed", changes: ["Line 2 count"] } });
    await openStk();
    expect(postButton().disabled).toBe(true);
    expect(screen.getByText(/approved again on the web/)).toBeTruthy();
    cleanup();
    detail = stocktake({ approval: { ...approval, state: "revoked" } });
    await openStk();
    expect(postButton().disabled).toBe(true);
    cleanup();
    detail = stocktake();
    await openStk({ online: false });
    expect(postButton().disabled).toBe(true);
    cleanup();
    await openStk({ canPost: false });
    expect(postButton().disabled).toBe(true);
  });

  it("shows a refusal and reads the count again", async () => {
    pos.postCounterStocktake!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "APPROVAL_STALE", message: "This count changed since it was approved." },
    }));
    await openStk();
    fireEvent.click(postButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Post 2 adjustments/ }));
    expect(await screen.findByText("This count changed since it was approved.")).toBeTruthy();
    await waitFor(() => expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2));
  });

  it("closes the sheet when posting stops being possible while it is open", async () => {
    const view = render(<CounterDocumentPane item={stkItem} online canPost onReported={onReported} />);
    await screen.findByText("Panadol 500mg");
    fireEvent.click(postButton());
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    view.rerender(<CounterDocumentPane item={stkItem} online={false} canPost onReported={onReported} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(postButton().disabled).toBe(true);
    // The approval moved on: the frame's next read brings a changed version.
    view.rerender(<CounterDocumentPane item={stkItem} online canPost onReported={onReported} />);
    fireEvent.click(postButton());
    expect(screen.getByRole("dialog")).toBeTruthy();
    detail = stocktake({ approval: { ...approval, currentVersion: 4, state: "changed", changes: ["Line 2 count"] } });
    const moved = { ...stkItem, approval: { ...stkItem.approval, currentVersion: 4 } } as CounterWorkItem;
    view.rerender(<CounterDocumentPane item={moved} online canPost onReported={onReported} />);
    await screen.findByText(/approved again on the web/);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(postButton().disabled).toBe(true);
    expect(pos.postCounterStocktake).not.toHaveBeenCalled();
  });

  it("keeps Post off after a lost answer, so nothing is sent twice", async () => {
    pos.postCounterStocktake!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "UNCONFIRMED", message: "No answer from the server. Confirm it before doing anything else." },
    }));
    const view = render(<CounterDocumentPane item={stkItem} online canPost onReported={onReported} />);
    await screen.findByText("Panadol 500mg");
    fireEvent.click(postButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Post 2 adjustments/ }));
    expect(await screen.findByText(/No answer from the server/)).toBeTruthy();
    // The frame now lists the unconfirmed command and stops passing canPost.
    view.rerender(<CounterDocumentPane item={stkItem} online canPost={false} onReported={onReported} />);
    await screen.findByText("Panadol 500mg");
    expect(postButton().disabled).toBe(true);
    fireEvent.click(postButton());
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.postCounterStocktake).toHaveBeenCalledTimes(1);
  });

  it("says plainly when no line was counted", async () => {
    const lines = (stocktake() as unknown as { lines: Record<string, unknown>[] }).lines.map((l) => ({
      ...l,
      countedQty: null,
      difference: null,
      valueAtCost: null,
    }));
    detail = stocktake({ totals: { lines: 4, differences: 0, valueAtCost: "0.00" }, lines });
    await openStk();
    expect(screen.getByText("0 lines counted")).toBeTruthy();
    expect(screen.getAllByText("Not counted")).toHaveLength(4);
    fireEvent.click(postButton());
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByText(/Writes no adjustments/)).toBeTruthy();
    expect(within(sheet).getByText(/4 lines weren't counted; posting leaves them as they are/)).toBeTruthy();
  });

  it("shows a long count a page at a time", async () => {
    const lines = Array.from({ length: 230 }, (_, n) => ({
      lineId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      productId: id(13),
      productName: `Product ${n + 1}`,
      packLabel: null,
      unitsPerPack: 1,
      batchId: id(31),
      batchNo: `B${n}`,
      expiryDate: null,
      onHandAtCount: 10,
      countedQty: 9,
      difference: -1,
      now: 10,
      afterPost: 9,
      valueAtCost: "-1.00",
      reviewNote: null,
    }));
    detail = stocktake({ totals: { lines: 230, differences: 230, valueAtCost: "-230.00" }, lines });
    render(<CounterDocumentPane item={stkItem} online canPost onReported={onReported} />);
    await screen.findByText("Product 1");
    expect(screen.queryByText("Product 101")).toBeNull();
    expect(screen.getByText("Showing 100 of 230 lines.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 100 more" }));
    expect(screen.getByText("Product 200")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 30 more" }));
    expect(screen.getByText("Product 230")).toBeTruthy();
    expect(screen.queryByText(/^Showing/)).toBeNull();
  });

  it("posts a count where everything matched", async () => {
    detail = stocktake({
      totals: { lines: 1, differences: 0, valueAtCost: "0.00" },
      lines: [(stocktake() as unknown as { lines: unknown[] }).lines[2]],
    });
    render(<CounterDocumentPane item={stkItem} online canPost onReported={onReported} />);
    await screen.findByText("Brufen 400mg");
    fireEvent.click(postButton());
    expect(within(screen.getByRole("dialog")).getByText(/Writes no adjustments/)).toBeTruthy();
  });
});

describe("handing over a supplier return", () => {
  function supplierReturn(overrides: Record<string, unknown> = {}): CounterWorkDetail {
    return {
      kind: "supplier_return",
      id: id(5),
      reference: "RT-0012",
      subject: "Hemas Pharmaceuticals",
      approval,
      requested: { name: "Kasun J.", at: null },
      approved: { name: "Dilini Fernando", at: null },
      dispatched: null,
      notes: [{ label: "Reason", text: "Expired and damaged", by: null, at: null }],
      mismatches: [],
      amount: "6210.00",
      lines: [
        { itemId: id(51), productId: id(13), productName: "Augmentin 625mg", packLabel: "Pack of 14", unitsPerPack: 14, batchId: id(31), batchNo: "AUG-7781", expiryDate: "2027-12-31", qty: 28, quarantined: true, disposition: "quarantine", unitPrice: "90.00" },
        { itemId: id(52), productId: id(14), productName: "Cetirizine 10mg", packLabel: "Pack of 100", unitsPerPack: 100, batchId: id(32), batchNo: "CTZ-0990", expiryDate: "2027-01-31", qty: 600, quarantined: false, disposition: "restock", unitPrice: "6.15" },
      ],
      ...overrides,
    } as unknown as CounterWorkDetail;
  }
  const retItem: CounterWorkItem = { ...item, kind: "supplier_return", id: id(5), reference: "RT-0012" };
  const printer = { name: "EPSON", displayName: "EPSON TM-T82" };
  const handOver = () => screen.getByRole("button", { name: /^Hand over and complete/ }) as HTMLButtonElement;
  const pack = (name: string) => fireEvent.click(screen.getByRole("checkbox", { name: `Packed: ${name}` }));
  const props = { online: true, canPost: true, printer };
  const show = async (over: Partial<typeof props> = {}) => {
    const p = { ...props, ...over };
    const view = render(
      <CounterDocumentPane item={retItem} online={p.online} canPost={p.canPost} printer={p.printer} onReported={onReported} />,
    );
    await screen.findByText("Augmentin 625mg");
    return view;
  };

  beforeEach(() => {
    detail = supplierReturn();
    pos.completeCounterReturn = jest.fn(async () => ({
      ok: true,
      value: { reference: "RT-0012", alreadyApplied: false, debitNoteRaised: true, completedAt: "2026-11-27T10:00:00.000Z" },
    }));
    pos.printCounterReturnNote = jest.fn(async () => ({
      ok: true,
      value: { ok: true, error: null, printed: ["supplier", "branch"] as ("supplier" | "branch")[] },
    }));
  });

  it("shows where each line is, in packs and units, and waits until every line is packed", async () => {
    await show();
    expect(screen.getByText("2 packs · 28")).toBeTruthy();
    expect(screen.getByText("6 packs · 600")).toBeTruthy();
    expect(screen.getByText("Quarantine")).toBeTruthy();
    expect(screen.getByText("Shelf")).toBeTruthy();
    expect(screen.getByText("Rs 2,520.00")).toBeTruthy();
    expect(screen.getByText("Why: Expired and damaged")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /doesn't match/ })).toBeNull();
    expect(handOver().disabled).toBe(true);
    expect(screen.getByText("Pack the last line first.")).toBeTruthy();
    pack("Augmentin 625mg");
    expect(handOver().disabled).toBe(true);
    pack("Cetirizine 10mg");
    expect(handOver().disabled).toBe(false);
  });

  it("prints the return note from the server's copy, twice", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: /Print return note/ }));
    await waitFor(() => expect(pos.printCounterReturnNote).toHaveBeenCalledWith({ id: id(5), printerName: "EPSON" }));
    expect(await screen.findByText(/Two copies sent to the printer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Print again/ })).toBeTruthy();
  });

  it("says when the note did not print, and leaves Print off without a printer", async () => {
    pos.printCounterReturnNote!.mockImplementationOnce(async () => ({ ok: true, value: { ok: false, error: "Out of paper.", printed: [] } }));
    const view = await show();
    fireEvent.click(screen.getByRole("button", { name: /Print return note/ }));
    expect(await screen.findByText("Out of paper.")).toBeTruthy();
    view.unmount();
    await show({ printer: null as never });
    expect((screen.getByRole("button", { name: /Print return note/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("prints only the copy a failed print left out, and says which one printed", async () => {
    pos.printCounterReturnNote!.mockImplementationOnce(async () => ({
      ok: true,
      value: { ok: false, error: "Out of paper.", printed: ["supplier"] },
    }));
    await show();
    fireEvent.click(screen.getByRole("button", { name: /Print return note/ }));
    expect(await screen.findByText("The supplier copy printed; the branch copy did not. Out of paper.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Print the branch copy$/ }));
    await waitFor(() =>
      expect(pos.printCounterReturnNote).toHaveBeenLastCalledWith({ id: id(5), printerName: "EPSON", copies: ["branch"] }),
    );
    expect(await screen.findByText(/The branch copy is printed now/)).toBeTruthy();
    // Both copies are out, so a reprint is both again.
    expect(screen.getByRole("button", { name: /^Print again$/ })).toBeTruthy();
  });

  it("will not print the note for a version nobody approved", async () => {
    for (const state of ["changed", "revoked"] as const) {
      detail = supplierReturn({ approval: { ...approval, state } });
      await show();
      expect((screen.getByRole("button", { name: /Print return note/ }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/prints once this version of the return is approved/)).toBeTruthy();
      cleanup();
    }
    expect(pos.printCounterReturnNote).not.toHaveBeenCalled();
  });

  it("confirms the units and the debit note, then completes with only the return", async () => {
    await show();
    pack("Augmentin 625mg");
    pack("Cetirizine 10mg");
    fireEvent.click(handOver());
    const sheet = screen.getByRole("dialog");
    expect(document.activeElement).toBe(sheet);
    expect(within(sheet).getByText(/Hand over RT-0012 to Hemas Pharmaceuticals\?/)).toBeTruthy();
    expect(within(sheet).getByText(/28 from quarantine and 600 from the shelf/)).toBeTruthy();
    expect(within(sheet).getByText(/debit note for Rs 6,210.00 against Hemas Pharmaceuticals/)).toBeTruthy();
    expect(within(sheet).getByText(/hasn't been printed here/)).toBeTruthy();
    expect(pos.completeCounterReturn).not.toHaveBeenCalled();
    fireEvent.click(within(sheet).getByRole("button", { name: /Hand over and complete/ }));
    await waitFor(() => expect(pos.completeCounterReturn).toHaveBeenCalledWith({ id: id(5) }));
    expect(
      await screen.findByText("Handed over. RT-0012 has left stock; a debit note was raised against Hemas Pharmaceuticals."),
    ).toBeTruthy();
    expect(onReported).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Hand over and complete/ })).toBeNull();
  });

  it("says no debit note was raised when there was nothing to claim", async () => {
    detail = supplierReturn({ amount: "0.00" });
    pos.completeCounterReturn!.mockImplementationOnce(async () => ({
      ok: true,
      value: { reference: "RT-0012", alreadyApplied: false, debitNoteRaised: false, completedAt: "2026-11-27T10:00:00.000Z" },
    }));
    await show();
    pack("Augmentin 625mg");
    pack("Cetirizine 10mg");
    fireEvent.click(handOver());
    expect(within(screen.getByRole("dialog")).getByText(/worth nothing to claim/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Hand over and complete/ }));
    expect(await screen.findByText(/has left stock; there was nothing to claim, so no debit note/)).toBeTruthy();
  });

  it("will not hand over after the approval changed or was withdrawn, offline, or with an action unconfirmed", async () => {
    for (const [state, over] of [
      ["changed", {}],
      ["revoked", {}],
      ["matches", { online: false }],
      ["matches", { canPost: false }],
    ] as const) {
      detail = supplierReturn({ approval: { ...approval, state } });
      await show(over);
      pack("Augmentin 625mg");
      pack("Cetirizine 10mg");
      expect(handOver().disabled).toBe(true);
      cleanup();
      clearCheckedLines();
    }
  });

  it("closes the sheet when handing over stops being possible while it is open", async () => {
    const view = await show();
    pack("Augmentin 625mg");
    pack("Cetirizine 10mg");
    fireEvent.click(handOver());
    expect(screen.getByRole("dialog")).toBeTruthy();
    view.rerender(<CounterDocumentPane item={retItem} online={false} canPost printer={printer} onReported={onReported} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.completeCounterReturn).not.toHaveBeenCalled();
  });

  it("shows a refusal and reads the return again", async () => {
    pos.completeCounterReturn!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "APPROVAL_STALE", message: "This return changed since it was approved." },
    }));
    await show();
    pack("Augmentin 625mg");
    pack("Cetirizine 10mg");
    fireEvent.click(handOver());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Hand over and complete/ }));
    expect(await screen.findByText("This return changed since it was approved.")).toBeTruthy();
    await waitFor(() => expect(pos.counterWorkDetail).toHaveBeenCalledTimes(2));
  });

  it("keeps Hand over off after a lost answer, so nothing is sent twice", async () => {
    pos.completeCounterReturn!.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: "UNCONFIRMED", message: "No answer from the server. Confirm it before doing anything else." },
    }));
    const view = await show();
    pack("Augmentin 625mg");
    pack("Cetirizine 10mg");
    fireEvent.click(handOver());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Hand over and complete/ }));
    expect(await screen.findByText(/No answer from the server/)).toBeTruthy();
    view.rerender(<CounterDocumentPane item={retItem} online canPost={false} printer={printer} onReported={onReported} />);
    await screen.findByText("Augmentin 625mg");
    expect(handOver().disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.completeCounterReturn).toHaveBeenCalledTimes(1);
  });
});
