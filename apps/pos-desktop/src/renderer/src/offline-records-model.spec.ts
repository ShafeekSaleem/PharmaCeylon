import { describe, expect, it } from "@jest/globals";
import type { CardAttemptView, OfflineSaleView } from "../../shared/ipc-contract";
import { drainHoldSentences } from "../../shared/drain-holds";
import {
  approvedOutcome,
  cardStage,
  checkNote,
  declinedOutcome,
  salesForCard,
  saleLabel,
  unsettledSentence,
} from "./offline-records-model";

const attempt = (state: CardAttemptView["state"], amount = "100.00"): CardAttemptView => ({
  attemptId: "a",
  checkoutDraftId: "d",
  amount,
  startedAt: "2026-11-12T10:00:00.000Z",
  state,
  settled: state === "declined" || state === "linked_to_sale",
  providerReference: null,
  approvalCode: null,
});

const sale = (id: string, total: string, paidByCard: boolean): OfflineSaleView => ({
  saleCommandId: id,
  at: "2026-11-12T10:00:00.000Z",
  total,
  itemCount: 1,
  paidByCard,
  noteCount: 0,
});

describe("cardStage", () => {
  it("offers all three answers until something is known, never Not sure twice", () => {
    expect(cardStage(attempt("prepared")).canSay).toEqual({ approved: true, declined: true, notSure: true });
    expect(cardStage(attempt("uncertain")).canSay).toEqual({ approved: true, declined: true, notSure: false });
  });

  it("offers no answers once approved, only the sale to match, and nothing when settled", () => {
    expect(cardStage(attempt("approved"))).toMatchObject({
      needsSale: true,
      canSay: { approved: false, declined: false, notSure: false },
    });
    for (const state of ["declined", "linked_to_sale"] as const)
      expect(cardStage(attempt(state))).toMatchObject({ needsSale: false, canSay: { approved: false } });
  });

  it("uses wording a counter person understands", () => {
    for (const state of ["prepared", "uncertain", "approved", "declined", "linked_to_sale"] as const) {
      const { title, detail } = cardStage(attempt(state));
      expect(`${title} ${detail}`).not.toMatch(/uncertain|linked_to_sale|prepared|attempt|_/);
    }
  });
});

describe("salesForCard", () => {
  it("offers only card sales, same amount first", () => {
    const sales = [sale("1", "50.00", true), sale("2", "100.00", true), sale("3", "100.00", false)];
    expect(salesForCard(attempt("approved"), sales).map((s) => s.saleCommandId)).toEqual(["2", "1"]);
  });

  it("leaves out sales a payment already paid for", () => {
    const sales = [sale("1", "100.00", true), sale("2", "100.00", true)];
    expect(salesForCard(attempt("approved"), sales, new Set(["1"])).map((s) => s.saleCommandId)).toEqual(["2"]);
  });
});

describe("outcomes and notes", () => {
  it("trims, and refuses blank or over-long slip details", () => {
    expect(approvedOutcome(" R ", " C ")).toEqual({ kind: "approved", reference: "R", approvalCode: "C" });
    expect(approvedOutcome("R", "  ")).toBeNull();
    expect(approvedOutcome("R".repeat(65), "C")).toBeNull();
    expect(approvedOutcome("R", "C".repeat(33))).toBeNull();
    expect(declinedOutcome(" R ")).toEqual({ kind: "declined", reference: "R" });
    expect(declinedOutcome("")).toBeNull();
  });

  it("checks a note: trimmed, not empty, within the limit", () => {
    expect(checkNote("  hello ")).toEqual({ ok: true, text: "hello" });
    expect(checkNote("   ")).toMatchObject({ ok: false });
    expect(checkNote("x".repeat(1000))).toMatchObject({ ok: true });
    expect(checkNote("x".repeat(1001))).toMatchObject({ ok: false });
  });

  it("writes a sale and a count the way the counter reads them", () => {
    expect(saleLabel(sale("1", "1250.00", false), () => "10:00")).toBe("10:00 · Rs 1250.00 · 1 item");
    expect(unsettledSentence(1)).toBe("1 card payment is not settled yet.");
    expect(unsettledSentence(3)).toBe("3 card payments are not settled yet.");
  });
});

describe("drainHoldSentences", () => {
  it("is silent when nothing holds the drain", () => {
    expect(drainHoldSentences({ cards: 0, records: 0, refused: 0 })).toEqual([]);
  });

  it("names unsettled card payments and tells staff where to settle them", () => {
    expect(drainHoldSentences({ cards: 2, records: 0, refused: 0 })).toEqual([
      "2 card payments from the outage are not settled yet. Open This counter, find what the card machine did for each and record it.",
    ]);
  });

  it("separates records still on their way from ones the server turned down", () => {
    const sentences = drainHoldSentences({ cards: 0, records: 3, refused: 1 });
    expect(sentences).toEqual([
      "2 notes or card records are still on their way to the server.",
      "The server turned down one note or card record. It will not clear by itself: contact support.",
    ]);
  });

  it("never shows a code, a path or a field name", () => {
    const all = drainHoldSentences({ cards: 1, records: 5, refused: 2 }).join(" ");
    expect(all).not.toMatch(/[A-Z]+_[A-Z_]+|\/api|supportRecord|checkoutDraft/);
  });
});
