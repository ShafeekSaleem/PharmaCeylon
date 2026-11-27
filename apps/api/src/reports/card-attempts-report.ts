/**
 * W10 #72: external card attempts. A counter records every step of a payment on the separate card
 * machine as a signed event (`OfflineSupportRecord`, kind `external_card_attempt`); several events
 * share one `attemptId`. This report folds each attempt's events into one row that says how it
 * ended, so a manager can see card money that was taken without a sale, given back, still owed, or
 * never confirmed either way.
 */

export type CardAttemptState = "prepared" | "uncertain" | "approved" | "declined" | "linked_to_sale" | "not_used";

/** How an attempt ended, from its furthest state. */
export type CardAttemptOutcome =
  | "charged_sale" // approved and linked to a sale
  | "declined"
  | "reversed" // approved, not used, voided or refunded on the card machine
  | "refund_owed" // approved, not used, and the machine could not reverse it
  | "approved_no_sale" // approved, not yet linked to a sale or ended
  | "unresolved"; // prepared, uncertain, or ended without a settlement we recognise: nobody has confirmed what the machine did

export const CARD_ATTEMPT_OUTCOMES: readonly CardAttemptOutcome[] = [
  "charged_sale",
  "declined",
  "reversed",
  "refund_owed",
  "approved_no_sale",
  "unresolved",
];

/** One signed event, as stored. */
export type CardAttemptEvent = Readonly<{
  attemptId: string;
  recordId: string;
  branchId: string;
  terminalId: string;
  workSessionId: string;
  state: CardAttemptState;
  amountMinor: number;
  providerReference: string | null;
  approvalCode: string | null;
  approvedAt: Date | null;
  saleCommandId: string | null;
  recordedAt: Date;
  /** Server review of this event: `held` until verified. */
  status: "held" | "accepted" | "rejected";
  heldReason: string | null;
  /** `not_used` only, from the signed payload. */
  settlement: "reversed_on_machine" | "refund_owed" | null;
  reversalReference: string | null;
  reason: string | null;
}>;

export type CardAttemptPerson = Readonly<{ id: string; name: string }>;

export type CardAttemptRow = Readonly<{
  attemptId: string;
  branchId: string;
  branchName: string;
  terminalId: string;
  terminalLabel: string | null;
  counterLabel: string | null;
  staff: CardAttemptPerson | null;
  firstRecordedAt: string;
  lastRecordedAt: string;
  events: number;
  /** The furthest state the attempt reached. */
  state: CardAttemptState;
  outcome: CardAttemptOutcome;
  amountMinor: number;
  providerReference: string | null;
  approvalCode: string | null;
  approvedAt: string | null;
  /** The sale the card payment was linked to, when it has synced. */
  sale: { id: string; invoiceNo: string } | null;
  settlement: "reversed_on_machine" | "refund_owed" | null;
  reversalReference: string | null;
  reason: string | null;
  /** `held` when any event still waits on review; otherwise `rejected` if any was, else `accepted`. */
  review: "held" | "accepted" | "rejected";
  /** Why it is held, for a held attempt: the first held event's reason. */
  heldReason: string | null;
}>;

type OutcomeTotals = { count: number; amountMinor: number };

export type CardAttemptsKpis = Readonly<{
  attempts: number;
  amountMinor: number;
  heldForReview: number;
  /** Card money a customer paid with no sale to show for it: approved without a sale, or owed back. */
  chargedWithoutSaleMinor: number;
  /** Card payments of offline sales a manager did not honour, kept apart for a refund or re-sale. */
  collectedNotSold: OutcomeTotals;
}> &
  Readonly<Record<CardAttemptOutcome, OutcomeTotals>>;

export type CardAttemptsCounterRow = Readonly<{
  terminalId: string;
  label: string;
  branchName: string;
  attempts: number;
  problemAttempts: number;
  amountMinor: number;
}>;

export type CardAttemptsReportResponse = Readonly<{
  days: number;
  timeZone: string;
  since: string;
  before: string;
  kpis: CardAttemptsKpis;
  byCounter: CardAttemptsCounterRow[];
  attempts: CardAttemptRow[];
}>;

/** How far along an attempt is; a later event never moves it back. */
const STATE_RANK: Record<CardAttemptState, number> = {
  prepared: 0,
  uncertain: 1,
  approved: 2,
  declined: 3,
  linked_to_sale: 3,
  not_used: 3,
};

export function cardAttemptOutcome(state: CardAttemptState, settlement: CardAttemptEvent["settlement"]): CardAttemptOutcome {
  switch (state) {
    case "linked_to_sale":
      return "charged_sale";
    case "declined":
      return "declined";
    case "not_used":
      // Only a settlement the counter signed counts; a missing or unknown one is a question, not a reversal.
      return settlement === "reversed_on_machine" ? "reversed" : settlement === "refund_owed" ? "refund_owed" : "unresolved";
    case "approved":
      return "approved_no_sale";
    default:
      return "unresolved";
  }
}

/** Outcomes a manager should look at: money taken with no sale, owed back, or unknown. */
export const PROBLEM_OUTCOMES: ReadonlySet<CardAttemptOutcome> = new Set(["refund_owed", "approved_no_sale", "unresolved"]);

export type CardAttemptContext = Readonly<{
  branchName: (branchId: string) => string;
  terminal: (terminalId: string) => { label: string | null; counterLabel: string | null };
  staff: (workSessionId: string) => CardAttemptPerson | null;
  sale: (saleCommandId: string) => { id: string; invoiceNo: string } | null;
}>;

/** Folds one attempt's events (any order) into its row. */
export function cardAttemptRow(events: readonly CardAttemptEvent[], ctx: CardAttemptContext): CardAttemptRow {
  if (!events.length) throw new Error("An attempt has at least one event");
  const byTime = [...events].sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  // The furthest state wins; among equals, the latest event.
  const furthest = byTime.reduce((best, e) => (STATE_RANK[e.state] >= STATE_RANK[best.state] ? e : best));
  const first = byTime[0]!;
  const last = byTime[byTime.length - 1]!;
  const pick = <K extends keyof CardAttemptEvent>(key: K) => {
    for (let i = byTime.length - 1; i >= 0; i--) {
      const v = byTime[i]![key];
      if (v != null) return v;
    }
    return null;
  };
  const held = byTime.find((e) => e.status === "held");
  const linked = byTime.find((e) => e.state === "linked_to_sale" && e.saleCommandId);
  const terminal = ctx.terminal(first.terminalId);
  const approvedAt = pick("approvedAt") as Date | null;
  return {
    attemptId: first.attemptId,
    branchId: first.branchId,
    branchName: ctx.branchName(first.branchId),
    terminalId: first.terminalId,
    terminalLabel: terminal.label,
    counterLabel: terminal.counterLabel,
    staff: ctx.staff(first.workSessionId),
    firstRecordedAt: first.recordedAt.toISOString(),
    lastRecordedAt: last.recordedAt.toISOString(),
    events: byTime.length,
    state: furthest.state,
    outcome: cardAttemptOutcome(furthest.state, furthest.settlement),
    amountMinor: first.amountMinor,
    providerReference: pick("providerReference") as string | null,
    approvalCode: pick("approvalCode") as string | null,
    approvedAt: approvedAt ? approvedAt.toISOString() : null,
    sale: linked ? ctx.sale(linked.saleCommandId!) : null,
    settlement: furthest.state === "not_used" ? furthest.settlement : null,
    reversalReference: furthest.state === "not_used" ? furthest.reversalReference : null,
    reason: furthest.state === "not_used" ? furthest.reason : null,
    review: held ? "held" : byTime.some((e) => e.status === "rejected") ? "rejected" : "accepted",
    heldReason: held?.heldReason ?? null,
  };
}

const zero = (): OutcomeTotals => ({ count: 0, amountMinor: 0 });

export function buildCardAttemptsReport(
  events: readonly CardAttemptEvent[],
  ctx: CardAttemptContext,
  collectedNotSold: OutcomeTotals,
  meta: { days: number; timeZone: string; since: Date; before: Date },
): CardAttemptsReportResponse {
  const byAttempt = new Map<string, CardAttemptEvent[]>();
  for (const e of events) {
    const list = byAttempt.get(e.attemptId) ?? [];
    list.push(e);
    byAttempt.set(e.attemptId, list);
  }
  const attempts = [...byAttempt.values()]
    .map((list) => cardAttemptRow(list, ctx))
    .sort((a, b) => b.firstRecordedAt.localeCompare(a.firstRecordedAt) || a.attemptId.localeCompare(b.attemptId));

  const outcomes = Object.fromEntries(CARD_ATTEMPT_OUTCOMES.map((o) => [o, zero()])) as Record<CardAttemptOutcome, OutcomeTotals>;
  const counters = new Map<string, { terminalId: string; label: string; branchName: string; attempts: number; problemAttempts: number; amountMinor: number }>();
  let amountMinor = 0;
  let heldForReview = 0;
  for (const row of attempts) {
    outcomes[row.outcome].count += 1;
    outcomes[row.outcome].amountMinor += row.amountMinor;
    amountMinor += row.amountMinor;
    if (row.review === "held") heldForReview += 1;
    const counter = counters.get(row.terminalId) ?? {
      terminalId: row.terminalId,
      label: row.counterLabel ?? row.terminalLabel ?? "Unknown counter",
      branchName: row.branchName,
      attempts: 0,
      problemAttempts: 0,
      amountMinor: 0,
    };
    counter.attempts += 1;
    counter.amountMinor += row.amountMinor;
    if (PROBLEM_OUTCOMES.has(row.outcome)) counter.problemAttempts += 1;
    counters.set(row.terminalId, counter);
  }

  return {
    days: meta.days,
    timeZone: meta.timeZone,
    since: meta.since.toISOString(),
    before: meta.before.toISOString(),
    kpis: {
      attempts: attempts.length,
      amountMinor,
      heldForReview,
      chargedWithoutSaleMinor: outcomes.approved_no_sale.amountMinor + outcomes.refund_owed.amountMinor,
      collectedNotSold: { ...collectedNotSold },
      ...outcomes,
    },
    byCounter: [...counters.values()].sort((a, b) => b.problemAttempts - a.problemAttempts || b.attempts - a.attempts || a.label.localeCompare(b.label)),
    attempts,
  };
}
