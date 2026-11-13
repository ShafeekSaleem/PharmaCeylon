/** @jest-environment jsdom */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { CardAttemptView, OfflineSaleView } from "../../shared/ipc-contract";
import { renderWithKeys, stubPos } from "../test/harness";
import { OfflineRecords } from "./OfflineRecords";

afterEach(cleanup);

const SALE_A = "00000000-0000-4000-8000-0000000000a1";
const SALE_B = "00000000-0000-4000-8000-0000000000a2";
const ATTEMPT = "00000000-0000-4000-8000-0000000000b1";
const DRAFT = "00000000-0000-4000-8000-0000000000c1";

const sale = (overrides: Partial<OfflineSaleView> = {}): OfflineSaleView => ({
  saleCommandId: SALE_A,
  at: "2026-11-12T10:00:00.000Z",
  total: "1250.00",
  itemCount: 3,
  paidByCard: false,
  noteCount: 0,
  ...overrides,
});

const attempt = (overrides: Partial<CardAttemptView> = {}): CardAttemptView => ({
  attemptId: ATTEMPT,
  checkoutDraftId: DRAFT,
  amount: "1250.00",
  startedAt: "2026-11-12T10:00:00.000Z",
  state: "prepared",
  settled: false,
  providerReference: null,
  approvalCode: null,
  ...overrides,
});

function show(sales: OfflineSaleView[], attempts: CardAttemptView[], extra: Record<string, () => unknown> = {}) {
  const pos = stubPos({
    offlineSales: async () => ({ ok: true, value: sales }),
    cardAttempts: async () => ({ ok: true, value: attempts }),
    ...extra,
  });
  renderWithKeys(<OfflineRecords />);
  return pos;
}

describe("OfflineRecords: card payments", () => {
  it("offers Approved, Declined and Not sure for a payment whose result is not recorded", async () => {
    show([], [attempt()]);
    const group = await screen.findByRole("group", { name: "What did the card machine say?" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Approved",
      "Declined",
      "Not sure",
    ]);
    expect(screen.getByText("1 to settle")).toBeTruthy();
    expect(screen.getByText(/Nobody is charged again until it is settled/)).toBeTruthy();
  });

  it("records Not sure straight away and then only offers Approved or Declined", async () => {
    const pos = show([], [attempt()], {
      recordCardOutcome: async () => ({ ok: true, value: { state: "uncertain" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Not sure" }));
    await waitFor(() =>
      expect(pos.recordCardOutcome).toHaveBeenCalledWith({ attemptId: ATTEMPT, outcome: { kind: "not_sure" } }),
    );
    expect(pos.cardAttempts).toHaveBeenCalledTimes(2);
  });

  it("asks for the slip's reference and approval code, trims them, and refuses blanks", async () => {
    const pos = show([], [attempt()], {
      recordCardOutcome: async () => ({ ok: true, value: { state: "approved" } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Approved" }));
    const save = screen.getByRole("button", { name: "Save as approved" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Card machine reference"), { target: { value: "  REF-9 " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Approval code"), { target: { value: " A123 " } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(pos.recordCardOutcome).toHaveBeenCalledWith({
        attemptId: ATTEMPT,
        outcome: { kind: "approved", reference: "REF-9", approvalCode: "A123" },
      }),
    );
  });

  it("only records a decline once the card machine's own reference is given", async () => {
    const pos = show([], [attempt({ state: "uncertain" })], {
      recordCardOutcome: async () => ({ ok: true, value: { state: "declined" } }),
    });
    expect(screen.queryByRole("button", { name: "Not sure" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Declined" }));
    expect(screen.getByText(/card machine itself shows/)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save as declined" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Card machine reference"), { target: { value: "REF-2" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(pos.recordCardOutcome).toHaveBeenCalledWith({
        attemptId: ATTEMPT,
        outcome: { kind: "declined", reference: "REF-2" },
      }),
    );
  });

  it("shows the refusal in the words main sent, with nothing to decode", async () => {
    show([], [attempt()], {
      recordCardOutcome: async () => ({
        ok: false,
        error: { code: "ATTEMPT_MISMATCH", message: "That card machine reference does not match the one already saved for this payment." },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Not sure" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That card machine reference does not match the one already saved for this payment.");
  });

  it("matches an approved payment to a card sale, same amount first, using the saved reference", async () => {
    const pos = show(
      [
        sale({ saleCommandId: SALE_A, total: "99.00", paidByCard: true }),
        sale({ saleCommandId: SALE_B, total: "1250.00", paidByCard: true }),
        sale({ saleCommandId: "00000000-0000-4000-8000-0000000000a3", paidByCard: false }),
      ],
      [attempt({ state: "approved", providerReference: "REF-9", approvalCode: "A123" })],
      { recordCardOutcome: async () => ({ ok: true, value: { state: "linked_to_sale" } }) },
    );
    const buttons = await screen.findAllByRole("button", { name: "This is the sale" });
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByText(/Same amount as this payment|Different amount/).map((n) => n.textContent)).toEqual([
      "Same amount as this payment",
      "Different amount",
    ]);
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(pos.recordCardOutcome).toHaveBeenCalledWith({
        attemptId: ATTEMPT,
        outcome: { kind: "paid_sale", reference: "REF-9", saleCommandId: SALE_B },
      }),
    );
  });

  it("says no sale is waiting rather than guessing one", async () => {
    show([sale()], [attempt({ state: "approved", providerReference: "REF-9", approvalCode: "A1" })]);
    expect(await screen.findByText(/No offline sale paid by card is waiting/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "This is the sale" })).toBeNull();
  });

  it("lists settled payments quietly and no longer counts them", async () => {
    show([], [attempt({ state: "declined", settled: true })]);
    await screen.findByText("Settled");
    expect(screen.queryByText(/to settle/)).toBeNull();
    expect(screen.getByText(/Declined/)).toBeTruthy();
  });
});

describe("OfflineRecords: noting a problem with a sale", () => {
  it("says plainly when there is nothing yet", async () => {
    show([], []);
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  it("opens the sheet with plain categories and saves a trimmed note", async () => {
    const pos = show([sale({ noteCount: 1 })], [], {
      noteSaleProblem: async () => ({ ok: true, value: { recordedAt: "2026-11-12T10:05:00.000Z" } }),
    });
    expect(await screen.findByText(/1 note saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Note a problem" }));
    const dialog = screen.getByRole("dialog", { name: "Note a problem with this sale" });
    expect(within(dialog).getAllByRole("radio").map((r) => (r.closest("label") as HTMLElement).querySelector("b")!.textContent)).toEqual([
      "Wrong quantity",
      "Not sure the payment went through",
      "Customer disagrees with the sale",
      "Something else",
    ]);
    expect(within(dialog).getByText(/does not change the sale, the stock, the cash or the card payment/)).toBeTruthy();
    expect(within(dialog).getByText(/Never type a card number/)).toBeTruthy();
    const save = within(dialog).getByRole("button", { name: "Save note" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("radio", { name: /Customer disagrees/ }));
    fireEvent.change(within(dialog).getByLabelText("Tell the back office what happened"), {
      target: { value: "  Change was short by 50  " },
    });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(pos.noteSaleProblem).toHaveBeenCalledWith({
        saleCommandId: SALE_A,
        category: "customer_dispute",
        description: "Change was short by 50",
      }),
    );
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stops at the limit and keeps the sheet open with main's reason when the note is refused", async () => {
    show([sale()], [], {
      noteSaleProblem: async () => ({
        ok: false,
        error: { code: "CARD_NUMBER_IN_TEXT", message: "That looks like a card number. Never type a card number here — describe the problem without it." },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Note a problem" }));
    const area = screen.getByLabelText("Tell the back office what happened") as HTMLTextAreaElement;
    expect(area.maxLength).toBe(1000);
    fireEvent.change(area, { target: { value: "paid with a card" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/looks like a card number/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes without saving", async () => {
    const pos = show([sale()], []);
    fireEvent.click(await screen.findByRole("button", { name: "Note a problem" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(pos.noteSaleProblem).not.toHaveBeenCalled();
  });
});

void jest;
