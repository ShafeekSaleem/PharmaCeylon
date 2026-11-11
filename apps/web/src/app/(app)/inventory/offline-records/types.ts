/** P5 #51 slice 4: GET /offline-journal-reviews and /offline-journal-reviews/:id. */

type Person = { id: string; name: string | null } | null;

export type EntryKind = "ordinary_sale" | "shift_open" | "shift_close";
export type Decision = "recorded" | "not_honoured";
export type EntryState = "open" | "settled" | "superseded";

export type RefusedRecordSummary = {
  id: string;
  state: EntryState;
  kind: EntryKind;
  sequence: number;
  counter: string | null;
  /** Null where the counter's clock gave no date at all. */
  occurredAt: string | null;
  staff: string | null;
  totalMinor: number | null;
  refusal: { code: string; explanation: string };
  attempts: number;
  firstReceivedAt: string;
  settlement: {
    id: string;
    decision: Decision;
    status: SettlementStatus;
  } | null;
  /** Card money a not-honoured sale took: collected, not sold. */
  collectedNotSoldMinor: number | null;
};

/** A not-honoured sale's card payment: the customer was charged and no sale exists. */
export type CollectedPayment = {
  id: string;
  method: "external_card";
  amountMinor: number;
  providerReference: string;
  approvalCode: string;
  approvedAt: string | null;
  shiftId: string | null;
  collectedAt: string;
};

export type SettlementStatus = "prepared" | "settled" | "cancelled";

export type Settlement = {
  id: string;
  decision: Decision;
  reason: string;
  status: SettlementStatus;
  approvalVersion: number;
  executionApprovalId: string | null;
  approvalReview: { expectedVersion: number; expectedDigest: string } | null;
  requester: Person;
  requestedAt: string;
  approver: Person;
  approvedAt: string | null;
  settledAt: string | null;
  cancelledBy: Person;
  cancelledAt: string | null;
  sale: {
    id: string;
    invoiceNo: string | null;
    stockCaseId: string | null;
  } | null;
  workSessionId: string | null;
  collectedPayments: CollectedPayment[];
};

type EntryBase = {
  occurredAt: string | null;
  offlineStartedAt: string | null;
  staff: Person;
  signedInAs: Person;
  workSessionId: string;
  shift: { number: string; openedAt: string; closedAt: string | null } | null;
};

export type SaleEntry = EntryBase & {
  kind: "ordinary_sale";
  snapshotVersion: number;
  totalMinor: number;
  lines: Array<{
    snapshotLineId: string;
    product: { id: string; name: string } | null;
    batch: { id: string; batchNo: string; expiryDate: string } | null;
    quantity: number;
    unitPriceMinor: number;
    taxMinor: number;
    lineTotalMinor: number;
    inSnapshot: boolean;
  }>;
  payments: Array<
    | {
        method: "cash";
        amountMinor: number;
        tenderedMinor: number;
        changeMinor: number;
      }
    | {
        method: "external_card";
        amountMinor: number;
        providerReference: string;
        approvalCode: string;
      }
  >;
};

export type ShiftOpenEntry = EntryBase & {
  kind: "shift_open";
  openingCashMinor: number;
};

export type ShiftCloseEntry = EntryBase & {
  kind: "shift_close";
  closingCashCountMinor: number;
  counterExpectedCashMinor: number;
  assistanceReason: string | null;
};

export type RefusedRecordDetail = {
  id: string;
  state: EntryState;
  kind: EntryKind;
  counter: { terminalId: string; enrollmentId: string; label: string | null };
  sequence: number;
  commandId: string;
  recordHash: string;
  acceptedThroughSequence: number;
  refusal: { code: string; explanation: string };
  attempts: number;
  firstReceivedAt: string;
  lastReceivedAt: string;
  receivedBy: Person;
  entry: SaleEntry | ShiftOpenEntry | ShiftCloseEntry;
  settleBlocker: { code: string; message: string } | null;
  recordable: {
    ok: boolean;
    blocker: string | null;
    message: string | null;
  } | null;
  /** Whether it may be not honoured, and what that leaves behind (or why it must be recorded). */
  notHonoured: { ok: boolean; message: string } | null;
  settlements: Settlement[];
};
