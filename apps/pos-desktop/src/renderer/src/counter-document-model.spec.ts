import { describe, expect, it } from "@jest/globals";
import type { CounterWorkDetail, CounterWorkTransferLine } from "@pharmaceylon/shared";
import {
  buildMismatchInput,
  buildReceiveBody,
  countFor,
  countLabel,
  emptyMismatchForm,
  fillRestAsSent,
  mismatchButtonLabel,
  mismatchIssue,
  mismatchLineChoices,
  problemChoices,
  receiveIssue,
  setCount,
} from "./counter-document-model";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const approval = { evidenceId: id(90), approvedVersion: 3, currentVersion: 3, state: "matches" as const, changes: [] };

const receipt = {
  kind: "prepared_receipt",
  id: id(1),
  approval,
  lines: [
    { index: 0, productName: "Panadol", packs: 10, receivedQty: 100, freeQty: 0, damagedQty: 0 },
    { index: 1, productName: "Amoxil", packs: null, receivedQty: 20, freeQty: 5, damagedQty: 1 },
  ],
} as unknown as CounterWorkDetail;

const transferOut = {
  kind: "transfer_ship",
  id: id(2),
  approval,
  lines: [{ transferItemId: id(7), productName: "Ventolin", qty: 12, receivedQty: 0, remainingQty: 12 }],
} as unknown as CounterWorkDetail;

const transferIn = {
  kind: "transfer_receive",
  id: id(3),
  approval: { ...approval, evidenceId: null },
  lines: [{ transferItemId: id(8), productName: "Ventolin", qty: 12, receivedQty: 4, remainingQty: 8 }],
} as unknown as CounterWorkDetail;

describe("mismatch lines", () => {
  it("counts a delivery in packs where it has them and units where it does not", () => {
    expect(mismatchLineChoices(receipt).map((c) => [c.unit, c.expected])).toEqual([
      ["packs", 10],
      ["units", 26],
    ]);
  });

  it("expects what is still on the way for a transfer in, and the approved quantity for one out", () => {
    expect(mismatchLineChoices(transferIn)[0]!.expected).toBe(8);
    expect(mismatchLineChoices(transferOut)[0]!.expected).toBe(12);
  });

  it("offers a transfer out only the choices its screen draws", () => {
    expect(problemChoices("transfer_ship").map((p) => p.problem)).toEqual([
      "cannot_pick",
      "different_batch_or_expiry",
      "damaged",
    ]);
    expect(mismatchButtonLabel("transfer_ship")).toBe("Can't pick all of it");
    expect(mismatchButtonLabel("prepared_receipt")).toBe("Something doesn't match");
    expect(countLabel("fewer_arrived", "packs", "prepared_receipt")).toBe("Packs that arrived");
    expect(countLabel("fewer_arrived", "packs", "transfer_receive")).toBe("Units that arrived");
  });
});

describe("mismatch report", () => {
  it("needs what is wrong, then the line, then the count, then a note where the server wants one", () => {
    expect(mismatchIssue(emptyMismatchForm)).toBe("Choose what's wrong.");
    expect(mismatchIssue({ ...emptyMismatchForm, problem: "fewer_arrived" })).toBe("Choose the line.");
    expect(mismatchIssue({ problem: "fewer_arrived", lineKey: "0", count: "", note: "" })).toBe("Enter the count.");
    expect(mismatchIssue({ problem: "fewer_arrived", lineKey: "0", count: "-1", note: "" })).toBe("Enter the count.");
    expect(mismatchIssue({ problem: "different_batch_or_expiry", lineKey: "0", count: "", note: " " })).toBe(
      "Add a note saying what you found.",
    );
    expect(mismatchIssue({ problem: "fewer_arrived", lineKey: "0", count: "8", note: "" })).toBeNull();
  });

  it("sends the approval and version the person was looking at, with the line and count", () => {
    const body = buildMismatchInput(
      receipt,
      { problem: "fewer_arrived", lineKey: "0", count: "8", note: " short two " },
      id(55),
    );
    expect(body).toEqual({
      kind: "prepared_receipt",
      documentId: id(1),
      approvalId: id(90),
      documentVersion: 3,
      line: { index: 0 },
      problem: "fewer_arrived",
      countedQty: 8,
      note: "short two",
      idempotencyKey: id(55),
    });
  });

  it("leaves the line out for something not on the note, and carries a null approval for a transfer in", () => {
    const extra = buildMismatchInput(
      receipt,
      { problem: "not_on_note", lineKey: null, count: "", note: "A box of gloves" },
      id(56),
    );
    expect(extra).toMatchObject({ line: null, countedQty: null, note: "A box of gloves" });
    const back = buildMismatchInput(
      transferIn,
      { problem: "fewer_arrived", lineKey: id(8), count: "3", note: "" },
      id(57),
    );
    expect(back).toMatchObject({ approvalId: null, line: { transferItemId: id(8) }, countedQty: 3 });
  });

  it("builds nothing from an incomplete form or a kind that cannot be reported", () => {
    expect(buildMismatchInput(receipt, emptyMismatchForm, id(58))).toBeNull();
    const stocktake = { ...receipt, kind: "stocktake" } as unknown as CounterWorkDetail;
    expect(
      buildMismatchInput(stocktake, { problem: "fewer_arrived", lineKey: "0", count: "1", note: "" }, id(59)),
    ).toBeNull();
  });
});


describe("receiving a transfer in", () => {
  const inLines = [
    { transferItemId: id(8), productName: "Ventolin", qty: 12, receivedQty: 4, remainingQty: 8 },
    { transferItemId: id(9), productName: "Panadol", qty: 30, receivedQty: 0, remainingQty: 30 },
    { transferItemId: id(10), productName: "Amoxil", qty: 5, receivedQty: 5, remainingQty: 0 },
  ] as unknown as ReadonlyArray<CounterWorkTransferLine>;
  const receiving = {
    kind: "transfer_receive",
    id: id(3),
    approval: { ...approval, evidenceId: id(91), state: "matches" },
    lines: inLines,
  } as unknown as CounterWorkDetail;

  it("counts only the lines still on the way, and needs a count on each", () => {
    let counts = setCount({}, inLines[0]!, "8");
    expect(receiveIssue(inLines, counts)).toBe("Count every line (1 of 2).");
    counts = setCount(counts, inLines[1]!, "30");
    expect(receiveIssue(inLines, counts)).toBeNull();
  });

  it("fills only uncounted lines with what is still on the way", () => {
    const counts = fillRestAsSent(inLines, setCount({}, inLines[0]!, "6"));
    expect(countFor(inLines[0]!, counts)).toBe("6");
    expect(countFor(inLines[1]!, counts)).toBe("30");
    expect(countFor(inLines[2]!, counts)).toBeNull();
  });

  it("refuses more than is on the way, and a receive where nothing arrived", () => {
    const over = setCount(setCount({}, inLines[0]!, "9"), inLines[1]!, "0");
    expect(receiveIssue(inLines, over)).toMatch(/More Ventolin than is on the way \(8\)/);
    const none = setCount(setCount({}, inLines[0]!, "0"), inLines[1]!, "0");
    expect(receiveIssue(inLines, none)).toMatch(/Nothing arrived/);
  });

  it("sends the dispatch pin and the counted lines with the already-in the counter saw, leaving zeros out", () => {
    const counts = setCount(setCount({}, inLines[0]!, "8"), inLines[1]!, "0");
    expect(buildReceiveBody(receiving, counts)).toEqual({
      transferId: id(3),
      dispatchApprovalId: id(91),
      lines: [{ transferItemId: id(8), qty: 8, receivedQtyBefore: 4 }],
    });
  });

  it("pins no dispatch when it needed no approval", () => {
    const counts = fillRestAsSent(inLines, {});
    const waived = { ...receiving, approval: { ...approval, evidenceId: null, state: "not_needed" } } as unknown as CounterWorkDetail;
    expect(buildReceiveBody(waived, counts)!.dispatchApprovalId).toBeNull();
  });

  it("drops a count when the line changed under it, so it is never sent against a different already-in", () => {
    const counts = setCount({}, inLines[0]!, "8");
    const moved = { ...inLines[0]!, receivedQty: 6, remainingQty: 6 } as CounterWorkTransferLine;
    expect(countFor(moved, counts)).toBeNull();
  });
});
