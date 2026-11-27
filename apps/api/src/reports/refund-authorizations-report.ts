/**
 * W10 #72: refund authorizations. Every customer refund completed in the window, with who asked
 * for it, who authorized it and who paid it out, so a manager can see where one person did all
 * three. A refund reaches the till one of two ways:
 *
 * - **Request** (`SaleRefundRequest`): prepared, approved ahead (on the web, or co-signed at a
 *   counter) when it met the tenant's threshold, then executed. The approver is recorded from the
 *   approval evidence; under the threshold there is none.
 * - **Direct** (no request): the POS refund, where the seller refunds at once and, over the
 *   threshold, an approver enters their till PIN unless the seller's own role may approve (the
 *   seller is then recorded as approver); and older returns, raised by one person and approved and
 *   completed by others. What counts is whether the approver is someone other than the person who
 *   paid the money out.
 */

export type RefundPath = "request" | "direct";

/** Who authorized the refund. */
export type RefundApproval =
  | "approved_request" // a request approved before it was executed
  | "other_approver" // a direct refund approved by someone other than the payer (a till PIN co-sign, say)
  | "not_required" // a request under the threshold: nobody had to approve it
  | "payer_approved" // a direct refund someone else raised, approved by the person who paid it out
  | "no_separate_approver"; // a direct refund one person raised, authorized and paid out

export const REFUND_APPROVALS: readonly RefundApproval[] = [
  "approved_request",
  "other_approver",
  "not_required",
  "payer_approved",
  "no_separate_approver",
];

export type RefundPerson = Readonly<{ id: string; name: string }>;

export type RefundInput = Readonly<{
  goodsReturnId: string;
  returnNumber: string;
  branchId: string;
  branchName: string;
  createdAt: Date;
  amountMinor: number;
  reasonCode: string | null;
  sale: { id: string; invoiceNo: string } | null;
  requestedBy: RefundPerson;
  /** `GoodsReturn.approvedBy`: the approver, the seller on a POS refund it alone authorized, or null. */
  approvedBy: RefundPerson | null;
  executedBy: RefundPerson | null;
  /** The till shift it was paid from; null when executed on the web. */
  shift: { id: string; shiftNumber: string; counterLabel: string } | null;
  request: { id: string; requestNumber: string; requestedAt: Date; approvedAt: Date | null } | null;
}>;

export type RefundRow = Readonly<{
  goodsReturnId: string;
  returnNumber: string;
  branchId: string;
  branchName: string;
  executedAt: string;
  amountMinor: number;
  reasonCode: string | null;
  sale: { id: string; invoiceNo: string } | null;
  path: RefundPath;
  requestNumber: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  approval: RefundApproval;
  requestedBy: RefundPerson;
  approvedBy: RefundPerson | null;
  executedBy: RefundPerson | null;
  /** Where the money left: a counter and its shift, or the web. */
  where: "counter" | "web";
  counterLabel: string | null;
  shiftNumber: string | null;
  /** Someone other than the person who paid it out authorized it. */
  separated: boolean;
}>;

export type RefundPersonRollup = Readonly<{ id: string; name: string; refunds: number; amountMinor: number }>;

type Totals = { count: number; amountMinor: number };

export type RefundAuthorizationsKpis = Readonly<{
  refunds: number;
  amountMinor: number;
  separated: Totals;
  notSeparated: Totals;
  atCounter: Totals;
  onWeb: Totals;
  byApproval: Readonly<Record<RefundApproval, Totals>>;
  /** Requests still waiting to be approved or executed, whenever they were prepared. */
  openRequests: Totals;
  /** Requests cancelled in the window. */
  cancelledRequests: Totals;
}>;

export type RefundAuthorizationsReportResponse = Readonly<{
  days: number;
  timeZone: string;
  since: string;
  before: string;
  kpis: RefundAuthorizationsKpis;
  byApprover: RefundPersonRollup[];
  byExecutor: RefundPersonRollup[];
  refunds: RefundRow[];
}>;

export function refundApproval(input: Pick<RefundInput, "request" | "requestedBy" | "approvedBy" | "executedBy">): RefundApproval {
  if (input.request) return input.approvedBy ? "approved_request" : "not_required";
  const payer = input.executedBy?.id;
  if (input.approvedBy && input.approvedBy.id !== payer) return "other_approver";
  return input.requestedBy.id !== payer ? "payer_approved" : "no_separate_approver";
}

export function refundRow(input: RefundInput): RefundRow {
  const approval = refundApproval(input);
  // A POS refund records the seller as its approver when nobody else signed; that is not an
  // approval anyone gave, so it reads as none. (`payer_approved` keeps its approver: they approved
  // someone else's return, even if they then paid it out themselves.)
  const approvedBy = approval === "no_separate_approver" ? null : input.approvedBy;
  return {
    goodsReturnId: input.goodsReturnId,
    returnNumber: input.returnNumber,
    branchId: input.branchId,
    branchName: input.branchName,
    executedAt: input.createdAt.toISOString(),
    amountMinor: input.amountMinor,
    reasonCode: input.reasonCode,
    sale: input.sale,
    path: input.request ? "request" : "direct",
    requestNumber: input.request?.requestNumber ?? null,
    requestedAt: input.request?.requestedAt.toISOString() ?? null,
    approvedAt: input.request?.approvedAt?.toISOString() ?? null,
    approval,
    requestedBy: input.requestedBy,
    approvedBy,
    executedBy: input.executedBy,
    where: input.shift ? "counter" : "web",
    counterLabel: input.shift?.counterLabel ?? null,
    shiftNumber: input.shift?.shiftNumber ?? null,
    separated: !!approvedBy && approvedBy.id !== input.executedBy?.id,
  };
}

function rollup(rows: readonly RefundRow[], pick: (row: RefundRow) => RefundPerson | null): RefundPersonRollup[] {
  const out = new Map<string, { id: string; name: string; refunds: number; amountMinor: number }>();
  for (const row of rows) {
    const person = pick(row);
    if (!person) continue;
    const entry = out.get(person.id) ?? { id: person.id, name: person.name, refunds: 0, amountMinor: 0 };
    entry.refunds += 1;
    entry.amountMinor += row.amountMinor;
    out.set(person.id, entry);
  }
  return [...out.values()].sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name));
}

const add = (t: Totals, amountMinor: number) => {
  t.count += 1;
  t.amountMinor += amountMinor;
};
const zero = (): Totals => ({ count: 0, amountMinor: 0 });

export function buildRefundAuthorizationsReport(
  inputs: readonly RefundInput[],
  requests: { open: readonly { amountMinor: number }[]; cancelled: readonly { amountMinor: number }[] },
  meta: { days: number; timeZone: string; since: Date; before: Date },
): RefundAuthorizationsReportResponse {
  const refunds = inputs
    .map(refundRow)
    .sort((a, b) => b.executedAt.localeCompare(a.executedAt) || a.returnNumber.localeCompare(b.returnNumber));
  const separated = zero();
  const notSeparated = zero();
  const atCounter = zero();
  const onWeb = zero();
  const byApproval = Object.fromEntries(REFUND_APPROVALS.map((a) => [a, zero()])) as Record<RefundApproval, Totals>;
  let amountMinor = 0;
  for (const row of refunds) {
    amountMinor += row.amountMinor;
    add(row.separated ? separated : notSeparated, row.amountMinor);
    add(row.where === "counter" ? atCounter : onWeb, row.amountMinor);
    add(byApproval[row.approval], row.amountMinor);
  }
  const total = (list: readonly { amountMinor: number }[]): Totals => ({
    count: list.length,
    amountMinor: list.reduce((acc, r) => acc + r.amountMinor, 0),
  });
  return {
    days: meta.days,
    timeZone: meta.timeZone,
    since: meta.since.toISOString(),
    before: meta.before.toISOString(),
    kpis: {
      refunds: refunds.length,
      amountMinor,
      separated,
      notSeparated,
      atCounter,
      onWeb,
      byApproval,
      openRequests: total(requests.open),
      cancelledRequests: total(requests.cancelled),
    },
    byApprover: rollup(refunds, (r) => r.approvedBy),
    byExecutor: rollup(refunds, (r) => r.executedBy),
    refunds,
  };
}
