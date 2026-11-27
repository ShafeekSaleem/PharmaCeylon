import {
  buildCardAttemptsReport,
  cardAttemptRow,
  type CardAttemptContext,
  type CardAttemptEvent,
} from "./card-attempts-report";

const ctx: CardAttemptContext = {
  branchName: () => "Kandy",
  terminal: (id) => (id === "t1" ? { label: "FRONT-PC", counterLabel: "Counter 1" } : { label: null, counterLabel: null }),
  staff: (session) => (session === "ws1" ? { id: "u1", name: "Nimal" } : null),
  sale: (command) => (command === "cmd1" ? { id: "s1", invoiceNo: "C1R-0001" } : null),
};

let n = 0;
const event = (over: Partial<CardAttemptEvent>): CardAttemptEvent => ({
  attemptId: "a1",
  recordId: `r${++n}`,
  branchId: "b1",
  terminalId: "t1",
  workSessionId: "ws1",
  state: "prepared",
  amountMinor: 150_000,
  providerReference: null,
  approvalCode: null,
  approvedAt: null,
  saleCommandId: null,
  recordedAt: new Date("2026-11-20T04:00:00Z"),
  status: "accepted",
  heldReason: null,
  settlement: null,
  reversalReference: null,
  reason: null,
  ...over,
});
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 4, minute));
const meta = { days: 30, timeZone: "Asia/Colombo", since: new Date("2026-10-28T18:30:00Z"), before: new Date("2026-11-27T18:30:00Z") };

describe("cardAttemptRow", () => {
  it("reads an approved, linked attempt as charged on its sale, whatever order the events arrive in", () => {
    const row = cardAttemptRow(
      [
        event({ state: "linked_to_sale", recordedAt: at(3), providerReference: "RRN1", saleCommandId: "cmd1" }),
        event({ state: "prepared", recordedAt: at(0) }),
        event({ state: "approved", recordedAt: at(2), providerReference: "RRN1", approvalCode: "A12", approvedAt: at(1) }),
      ],
      ctx,
    );
    expect(row).toMatchObject({
      outcome: "charged_sale",
      state: "linked_to_sale",
      events: 3,
      providerReference: "RRN1",
      approvalCode: "A12",
      sale: { id: "s1", invoiceNo: "C1R-0001" },
      counterLabel: "Counter 1",
      staff: { id: "u1", name: "Nimal" },
      firstRecordedAt: at(0).toISOString(),
      lastRecordedAt: at(3).toISOString(),
      review: "accepted",
    });
  });

  it("tells a reversal on the machine from a refund still owed, with the signed reason", () => {
    const reversed = cardAttemptRow(
      [
        event({ state: "approved", recordedAt: at(1) }),
        event({ state: "not_used", recordedAt: at(2), settlement: "reversed_on_machine", reversalReference: "VOID9", reason: "Customer left" }),
      ],
      ctx,
    );
    expect(reversed).toMatchObject({ outcome: "reversed", reversalReference: "VOID9", reason: "Customer left" });
    const owed = cardAttemptRow([event({ state: "not_used", settlement: "refund_owed", status: "held", heldReason: "card_not_used" })], ctx);
    expect(owed).toMatchObject({ outcome: "refund_owed", review: "held", heldReason: "card_not_used" });
  });

  it("never moves an attempt back: an uncertain event after an approval stays approved", () => {
    const row = cardAttemptRow([event({ state: "approved", recordedAt: at(1) }), event({ state: "uncertain", recordedAt: at(2) })], ctx);
    expect(row.outcome).toBe("approved_no_sale");
  });

  it("leaves a prepared or uncertain attempt unresolved", () => {
    expect(cardAttemptRow([event({ state: "uncertain" })], ctx).outcome).toBe("unresolved");
    expect(cardAttemptRow([event({ state: "prepared" })], ctx).staff).toEqual({ id: "u1", name: "Nimal" });
  });
});

describe("buildCardAttemptsReport", () => {
  it("counts each attempt once, totals by outcome and puts the counter with problems first", () => {
    const report = buildCardAttemptsReport(
      [
        event({ attemptId: "a1", state: "approved", recordedAt: at(1) }),
        event({ attemptId: "a1", state: "linked_to_sale", saleCommandId: "cmd1", recordedAt: at(2) }),
        event({ attemptId: "a2", state: "declined", amountMinor: 50_000, terminalId: "t2" }),
        event({ attemptId: "a3", state: "approved", amountMinor: 20_000, status: "held", heldReason: "card_unverified" }),
        event({ attemptId: "a4", state: "not_used", settlement: "refund_owed", amountMinor: 30_000 }),
      ],
      ctx,
      [{ amountMinor: 70_000 }],
      meta,
    );
    expect(report.attempts).toHaveLength(4);
    expect(report.kpis).toMatchObject({
      attempts: 4,
      amountMinor: 250_000,
      heldForReview: 1,
      chargedWithoutSaleMinor: 50_000,
      charged_sale: { count: 1, amountMinor: 150_000 },
      declined: { count: 1, amountMinor: 50_000 },
      approved_no_sale: { count: 1, amountMinor: 20_000 },
      refund_owed: { count: 1, amountMinor: 30_000 },
      reversed: { count: 0, amountMinor: 0 },
      collectedNotSold: { count: 1, amountMinor: 70_000 },
    });
    expect(report.byCounter.map((c) => [c.label, c.attempts, c.problemAttempts])).toEqual([
      ["Counter 1", 3, 2],
      ["Unknown counter", 1, 0],
    ]);
  });
});
