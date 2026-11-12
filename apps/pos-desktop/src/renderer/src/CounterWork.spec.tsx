/** @jest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import type {
  CounterWorkItem,
  HeldWriteOffAtCounter,
  RefundAtCounter,
  StockCaseAtCounter,
} from "../../shared/ipc-contract";
import { press, renderWithKeys, stubPos } from "../test/harness";
import { CounterWork, shortName, when } from "./CounterWork";
import { KeyScope } from "./keymap";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date();
const today = (h: number, m: number) => {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

function work(overrides: Partial<CounterWorkItem>): CounterWorkItem {
  return {
    kind: "prepared_receipt",
    id: id(1),
    reference: "PO-2026-0187",
    subject: "Hemas Pharmaceuticals",
    lineCount: 12,
    amount: "184320.00",
    readyAt: today(13, 50),
    requested: { name: "Kasun Jayasinghe", at: "2026-10-29T03:42:00.000Z" },
    approved: { name: "Dilini Fernando", at: "2026-10-29T05:10:00.000Z" },
    dispatched: null,
    approval: { evidenceId: id(90), approvedVersion: 3, currentVersion: 3, state: "matches", changes: [] },
    ...overrides,
  };
}

const receive = work({});
const transferIn = work({
  kind: "transfer_receive", id: id(2), reference: "TR-0093", subject: "Bambalapitiya", lineCount: 6, amount: null,
  readyAt: today(12, 15), dispatched: { name: "Ashan Kumara", at: "2026-11-01T06:00:00.000Z" },
});
const refund = work({
  kind: "refund", id: id(3), reference: "RF-0031", subject: "INV-T1-1031-0412", lineCount: 1, amount: "1840.00",
  readyAt: today(11, 40),
});
const writeOff = work({
  kind: "held_adjustment", id: id(4), reference: "B-77", subject: "Augmentin 625mg", lineCount: 1, amount: "6210.00",
  readyAt: today(9, 30),
});
const refundDetail: RefundAtCounter = {
  refundRequestId: id(3), requestNumber: "RF-0031", invoiceNo: "INV-T1-1031-0412", amount: "1840.00",
  refundMethod: "card", reason: "Wrong strength", requestedBy: "Kasun Jayasinghe", approvedBy: "Dilini Fernando",
  approvalEvidenceId: id(90),
};

let pos: Record<string, jest.Mock>;
let items: CounterWorkItem[];
let pending: { commandId: string; operation: string; createdAt: string; staffName: string | null }[];

beforeEach(() => {
  items = [receive, transferIn, refund, writeOff];
  pending = [];
  pos = stubPos({
    counterWork: async () => ({ ok: true, value: items }),
    refundsReady: async () => ({ ok: true, value: [refundDetail] }),
    pendingCommands: async () => pending,
    executeRefund: async () => ({
      ok: true,
      value: {
        requestNumber: "RF-0031", amountMinor: 184000, refundedTo: [{ method: "card", amountMinor: 184000 }],
        alreadyApplied: false, requestedBy: "Kasun Jayasinghe", approvedBy: "Dilini Fernando",
      },
    }),
    retryCommand: async () => ({ ok: true, value: { replayed: true } }),
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

const queue = () => screen.getByLabelText("Waiting at the counter");
const tab = (name: RegExp) =>
  within(screen.getByRole("group", { name: "Kind of work" })).getByRole("button", { name });

describe("the counter work list", () => {
  it("lists every kind with its reference, what it is and who approved it, newest first as given", async () => {
    const onCount = jest.fn();
    await renderWork({ onCount });
    const cards = within(queue()).getAllByRole("button");
    expect(cards.map((c) => c.querySelector("b")?.textContent)).toEqual([
      "Receive goods", "Transfer in", "Refund", "Write-off",
    ]);
    expect(cards[0]!.textContent).toContain("Hemas Pharmaceuticals · 12 lines · Rs 184,320.00");
    expect(cards[0]!.textContent).toContain("Approved by Dilini F.");
    expect(cards[1]!.textContent).toContain("From Bambalapitiya · 6 lines");
    expect(cards[1]!.textContent).toContain("Dispatched by Ashan K.");
    expect(cards[2]!.textContent).toContain("Rs 1,840.00 back to card");
    expect(cards[2]!.textContent).toContain("Authorized by Dilini F.");
    expect(onCount).toHaveBeenLastCalledWith(4);
  });

  it("filters by tab, with each tab's count", async () => {
    await renderWork();
    expect(tab(/^All/).textContent).toBe("All 4");
    expect(tab(/^Receive/).textContent).toBe("Receive 1");
    expect(tab(/^Transfers/).textContent).toBe("Transfers 1");
    expect(tab(/^Refunds/).textContent).toBe("Refunds 1");
    expect(tab(/^Stock/).textContent).toBe("Stock 1");

    fireEvent.click(tab(/^Stock/));
    expect(tab(/^Stock/).getAttribute("aria-pressed")).toBe("true");
    expect(within(queue()).getAllByRole("button").map((c) => c.querySelector("b")?.textContent)).toEqual(["Write-off"]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("B-77 · Over-limit write-off");

    fireEvent.click(tab(/^Transfers/));
    expect(within(queue()).getAllByRole("button").map((c) => c.querySelector("b")?.textContent)).toEqual(["Transfer in"]);
  });

  it("says when nothing is waiting", async () => {
    items = [];
    await renderWork();
    expect(screen.getByText("Nothing is waiting at this counter.")).toBeTruthy();
    fireEvent.click(tab(/^Refunds/));
    expect(screen.getByText("No refunds work is waiting.")).toBeTruthy();
  });

  it("opens the first item, and moves with the arrow keys", async () => {
    await renderWork();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("PO-2026-0187 · Hemas Pharmaceuticals");
    press("ArrowDown");
    await act(async () => undefined);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("TR-0093 · Bambalapitiya");
    fireEvent.click(within(queue()).getAllByRole("button")[3]!);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("B-77 · Over-limit write-off");
  });
});

describe("the shared detail header", () => {
  const trail = () => screen.getByRole("list", { name: /Who asked/ });

  it("shows the requester, the approver with the approved version, and you", async () => {
    await renderWork();
    const steps = within(trail()).getAllByRole("listitem").map((li) => li.textContent);
    expect(steps[0]).toContain("Requested");
    expect(steps[0]).toContain("Kasun Jayasinghe");
    expect(steps[1]).toContain("Approved · v3");
    expect(steps[1]).toContain("Dilini Fernando");
    expect(steps[2]).toContain("Receiving");
    expect(steps[2]).toContain("You · Sachini Rathnayake");
    expect(steps[2]).toContain("Counter 2 · at the counter · now");
    expect(screen.getByRole("status").textContent).toBe(
      "Matches the approved version — nothing has changed since approval.",
    );
  });

  it("says what changed since approval", async () => {
    items = [work({ approval: { evidenceId: id(90), approvedVersion: 3, currentVersion: 4, state: "changed",
      changes: ["the purchase order", "the delivery lines: 1 line changed"] } })];
    await renderWork();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Changed since approval (approved v3, now v4)");
    expect(within(alert).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "the purchase order", "the delivery lines: 1 line changed",
    ]);
    expect(within(queue()).getByRole("button").textContent).toContain("Changed since approval");
  });

  it("says when the approval was withdrawn", async () => {
    items = [work({ approval: { evidenceId: id(90), approvedVersion: 3, currentVersion: 3, state: "revoked", changes: [] } })];
    await renderWork();
    expect(screen.getByRole("alert").textContent).toContain("The approval was withdrawn on the web.");
    expect(within(queue()).getByRole("button").textContent).toContain("Approval withdrawn");
  });

  it("says when no approval was needed", async () => {
    items = [work({ kind: "import_stock", reference: "opening.xlsx", subject: null, approved: null, amount: null,
      approval: { evidenceId: null, approvedVersion: null, currentVersion: 1, state: "not_needed", changes: [] } })];
    await renderWork();
    expect(screen.getByRole("status").textContent).toBe("Opening stock from an import needs no approval.");
    expect(within(trail()).getAllByRole("listitem")[1]!.textContent).toContain("Not needed");
  });

  it("shows a transfer in's dispatcher in the middle step", async () => {
    items = [transferIn];
    await renderWork();
    const middle = within(trail()).getAllByRole("listitem")[1]!.textContent;
    expect(middle).toContain("Dispatched");
    expect(middle).toContain("Ashan Kumara");
  });

  it("holds kinds whose screen isn't built yet, without an action", async () => {
    await renderWork();
    expect(screen.getByText("Done at the counter once its screen is ready")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Post|Refund now/ })).toBeNull();
  });
});

describe("refunds inside the frame", () => {
  it("refunds the open refund with F12 and says who did what", async () => {
    await renderWork();
    fireEvent.click(tab(/^Refunds/));
    expect(screen.getByText("Wrong strength")).toBeTruthy();
    press("F12");
    await act(async () => undefined);
    expect(pos.executeRefund).toHaveBeenCalledWith({ refundRequestId: id(3) });
    expect(screen.getByText(/Refunded RF-0031: Rs 1,840.00 card/).textContent).toContain(
      "Requested by Kasun Jayasinghe, approved by Dilini Fernando, executed by you.",
    );
  });

  it("refunds from the button too, and shows a refusal", async () => {
    pos.executeRefund!.mockImplementation(async () => ({
      ok: false, error: { code: "REFUND_NOT_READY", message: "That refund is not waiting at this counter any more." },
    }));
    await renderWork();
    fireEvent.click(within(queue()).getAllByRole("button")[2]!);
    fireEvent.click(screen.getByRole("button", { name: /Refund now/ }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toBe("That refund is not waiting at this counter any more.");
  });

  it("won't refund one whose approval was withdrawn", async () => {
    items = [{ ...refund, approval: { ...refund.approval, state: "revoked" } }];
    await renderWork();
    expect((screen.getByRole("button", { name: /Refund now/ }) as HTMLButtonElement).disabled).toBe(true);
    press("F12");
    expect(pos.executeRefund).not.toHaveBeenCalled();
  });
});

describe("actions sent but not confirmed", () => {
  beforeEach(() => {
    pending = [{ commandId: id(70), operation: "POST /api/v1/sales/refund-requests/:id/execute",
      createdAt: today(10, 5), staffName: "Sachini Rathnayake" }];
  });

  it("stay at the top of the list and count on the rail", async () => {
    const onCount = jest.fn();
    await renderWork({ onCount });
    const card = within(queue()).getByRole("alert");
    expect(card.textContent).toContain("Sent but not confirmed");
    expect(card.textContent).toContain("Refund");
    expect(card.textContent).toContain("Sent at 10:05 by Sachini Rathnayake");
    expect(onCount).toHaveBeenLastCalledWith(5);
  });

  it("are confirmed with Ctrl+Enter before anything else, and refunds wait for them", async () => {
    items = [refund];
    await renderWork();
    expect((screen.getByRole("button", { name: /Refund now/ }) as HTMLButtonElement).disabled).toBe(true);
    press("F12");
    expect(pos.executeRefund).not.toHaveBeenCalled();
    press("Enter", { ctrlKey: true });
    await act(async () => undefined);
    expect(pos.retryCommand).toHaveBeenCalledWith({ commandId: id(70) });
  });

  it("show a retry that was refused", async () => {
    pos.retryCommand!.mockImplementation(async () => ({
      ok: false, error: { code: "COMMAND_OTHER_STAFF", message: "Only the person who sent it can confirm it." },
    }));
    pending.push({ ...pending[0]!, commandId: id(71) });
    await renderWork();
    fireEvent.click(within(queue()).getAllByRole("button", { name: /Confirm action from 10:05/ })[1]!);
    await act(async () => undefined);
    expect(pos.retryCommand).toHaveBeenCalledWith({ commandId: id(71) });
    expect(within(queue()).getByRole("alert").textContent).toContain("Only the person who sent it can confirm it.");
  });
});

describe("an offline sale's stock (P5 #51)", () => {
  const caseItem = work({
    kind: "stock_case", id: id(5), reference: "INV-2611-000042", subject: "Paracetamol 500mg", lineCount: 1, amount: null,
    readyAt: today(10, 0), requested: { name: "Nimal Perera", at: "2026-11-06T05:10:00.000Z" },
    approved: { name: "Owner Silva", at: "2026-11-06T05:20:00.000Z" },
    approval: { evidenceId: id(91), approvedVersion: 1, currentVersion: 1, state: "matches", changes: [] },
  });
  const plan = (overrides: Partial<StockCaseAtCounter> = {}): StockCaseAtCounter => ({
    resolutionId: id(5), caseId: id(6), invoiceNo: "INV-2611-000042", soldAt: "2026-11-06T04:00:00.000Z",
    kind: "count_and_correct", note: "Shelf looked empty", approvalEvidenceId: id(91), approvalState: "matches",
    requestedBy: "Nimal Perera", approvedBy: "Owner Silva",
    lines: [{ batchId: id(7), productName: "Paracetamol 500mg", batchNo: "PCM-7", expiryDate: "2027-11-01", soldQuantity: 5 }],
    ...overrides,
  });

  it("sits in the Stock tab with the approved plan, matches its approval, and settles with a count", async () => {
    items = [refund, caseItem];
    pos.stockCasesReady!.mockImplementation(async () => ({ ok: true, value: [plan()] }));
    pos.resolveStockCase!.mockImplementation(async () => ({
      ok: true,
      value: {
        invoiceNo: "INV-2611-000042", kind: "count_and_correct", alreadyApplied: false,
        batches: [{ batchId: id(7), method: "counted", countedQty: 0, correctionQty: 2, postedQty: 5, stillBlocked: false }],
        requestedBy: "Nimal Perera", approvedBy: "Owner Silva",
      },
    }));
    await renderWork();
    fireEvent.click(tab(/^Stock/));
    expect(tab(/^Stock/).textContent).toBe("Stock 1");
    const card = within(queue()).getByRole("button");
    expect(card.textContent).toContain("Offline sale stock");
    expect(card.textContent).toContain("Sale INV-2611-000042 · Paracetamol 500mg · 1 batch");
    expect(screen.getByRole("status").textContent).toContain("Matches the approved version");
    expect(screen.getByText(/Count every unit of each batch here/)).toBeTruthy();

    const settle = screen.getByRole("button", { name: /Settle stock/ }) as HTMLButtonElement;
    // Every batch needs a count first; the system quantity is never shown.
    expect(settle.disabled).toBe(true);
    expect(screen.queryByText(/on hand/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("Units of Paracetamol 500mg batch PCM-7 counted"), { target: { value: "0" } });
    expect(settle.disabled).toBe(false);
    fireEvent.click(settle);
    await act(async () => undefined);
    expect(pos.resolveStockCase).toHaveBeenCalledWith({ resolutionId: id(5), counts: [{ batchId: id(7), countedQty: 0 }] });
    const done = screen.getAllByRole("status").find((el) => el.textContent?.includes("Settled"))!;
    expect(done.textContent).toContain("corrected +2, 5 posted");
    expect(done.textContent).toContain("Requested by Nimal Perera, approved by Owner Silva, done by you.");
  });

  it("posts or links without a count, and says when another case keeps the batch paused", async () => {
    items = [caseItem];
    pos.stockCasesReady!.mockImplementation(async () => ({ ok: true, value: [plan({ kind: "post_now", note: null })] }));
    pos.resolveStockCase!.mockImplementation(async () => ({
      ok: true,
      value: {
        invoiceNo: "INV-2611-000042", kind: "post_now", alreadyApplied: false,
        batches: [{ batchId: id(7), method: "posted", countedQty: null, correctionQty: 0, postedQty: 5, stillBlocked: true }],
        requestedBy: "Nimal Perera", approvedBy: "Owner Silva",
      },
    }));
    await renderWork();
    expect(screen.queryByLabelText(/counted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Settle stock/ }));
    await act(async () => undefined);
    expect(pos.resolveStockCase).toHaveBeenCalledWith({ resolutionId: id(5), counts: [] });
    expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("still holds a batch, so it stays paused"))).toBe(true);
  });

  it("refuses a plan that changed since approval, and shows a refusal from the server", async () => {
    items = [work({ ...caseItem, approval: { ...caseItem.approval, state: "changed", changes: ["Another offline sale now waits on one of these batches"] } })];
    pos.stockCasesReady!.mockImplementation(async () => ({ ok: true, value: [plan({ approvalState: "changed" })] }));
    await renderWork();
    expect(screen.getByRole("alert").textContent).toContain("Another offline sale now waits on one of these batches");
    expect((screen.getByRole("button", { name: /Settle stock/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    items = [caseItem];
    pos.stockCasesReady!.mockImplementation(async () => ({ ok: true, value: [plan({ kind: "post_now" })] }));
    pos.resolveStockCase!.mockImplementation(async () => ({
      ok: false, error: { code: "STOCK_NOT_COVERED", message: "Stock no longer covers this sale." },
    }));
    await renderWork();
    fireEvent.click(screen.getByRole("button", { name: /Settle stock/ }));
    await act(async () => undefined);
    expect(screen.getByRole("alert").textContent).toContain("Stock no longer covers this sale.");
  });
});

function heldRow(
  overrides: Partial<HeldWriteOffAtCounter> & Pick<HeldWriteOffAtCounter, "status">,
): HeldWriteOffAtCounter {
  return {
    id: id(40),
    executionApprovalId: overrides.status === "approved" ? id(91) : null,
    kind: "expired",
    kindLabel: "Expired",
    qty: 186,
    value: "6210.00",
    note: null,
    requestReason: "Over limit",
    fromQuarantine: true,
    product: { id: id(50), name: "Augmentin 625mg Tablets", sku: "AUG625" },
    batch: { id: id(51), batchNo: "B-77", expiryDate: "2026-08-01" },
    requester: { id: id(52), fullName: "Shehan Wickramasinghe" },
    requestedAt: "2026-11-01T05:30:00.000Z",
    approvalReview: { expectedVersion: 2, expectedDigest: "abc" },
    ...overrides,
  };
}

describe("held over-limit write-offs", () => {
  it("shows awaiting approval as read-only without a post button", async () => {
    const pending = work({
      kind: "held_adjustment",
      id: id(40),
      reference: "B-77",
      subject: "Augmentin 625mg",
      heldAdjustmentStatus: "awaiting_approval",
      approval: { evidenceId: null, approvedVersion: null, currentVersion: null, state: "not_needed", changes: [] },
    });
    items = [pending];
    pos.heldWriteOffsAtCounter = jest.fn(async () => ({
      ok: true,
      value: [heldRow({ id: id(40), status: "awaiting_approval" })],
    }));
    await renderWork();
    fireEvent.click(tab(/^Stock/));
    await act(async () => undefined);
    expect(screen.getByText("Waiting for accept on the web")).toBeTruthy();
    const post = screen.getByRole("button", { name: /Post write-off/i });
    expect((post as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Read only — approve or reject on the web")).toBeTruthy();
  });

  it("shows rejected with decision note and a disabled post button", async () => {
    const rejected = work({
      kind: "held_adjustment",
      id: id(41),
      reference: "B-78",
      subject: "Panadol",
      heldAdjustmentStatus: "rejected",
      approval: { evidenceId: null, approvedVersion: null, currentVersion: null, state: "not_needed", changes: [] },
    });
    items = [rejected];
    pos.heldWriteOffsAtCounter = jest.fn(async () => ({
      ok: true,
      value: [heldRow({ id: id(41), status: "rejected", decisionNote: "Not justified" })],
    }));
    await renderWork();
    fireEvent.click(tab(/^Stock/));
    fireEvent.click(within(queue()).getByRole("button"));
    await act(async () => undefined);
    expect(screen.getByText("This request was rejected")).toBeTruthy();
    expect(screen.getByText(/Not justified/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Post write-off/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("formatting", () => {
  it("writes people and times as the mockup does", () => {
    expect(shortName("Dilini Fernando")).toBe("Dilini F.");
    expect(shortName("Ruwan")).toBe("Ruwan");
    expect(shortName(null)).toBe("—");
    const base = new Date(2026, 10, 1, 14, 32);
    expect(when(new Date(2026, 10, 1, 13, 50).toISOString(), base)).toBe("13:50");
    expect(when(new Date(2026, 9, 31, 9, 0).toISOString(), base)).toBe("Yesterday");
    expect(when(new Date(2026, 9, 29, 9, 0).toISOString(), base)).toBe("29 Oct 2026");
  });
});
