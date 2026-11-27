import type { DailyWorkKind } from "./dashboard";
import type { SignedPhysicalOperation } from "./terminal-command-execution";

/** Contract version for additive counter-work task fields (#172). */
export const COUNTER_WORK_CONTRACT_VERSION = 1 as const;

/** Read-only rejected held write-offs drop off the counter list after this many days (#173). */
export const COUNTER_REJECTED_HELD_WRITE_OFF_VISIBLE_DAYS = 30;

export const COUNTER_WORK_AS_OF_HEADER = "X-PharmaCeylon-Counter-Work-As-Of";
export const COUNTER_WORK_CONTRACT_VERSION_HEADER = "X-PharmaCeylon-Counter-Work-Contract-Version";

/** Counter-work document kinds returned by `GET /counter-work` (restricted counter projection). */
export const COUNTER_WORK_KINDS = [
  "prepared_receipt",
  "held_delivery",
  "transfer_ship",
  "transfer_receive",
  "refund",
  "stocktake",
  "held_adjustment",
  "supplier_return",
  "import_stock",
  "stock_case",
  "supplier_cash_payout",
] as const;
export type CounterWorkKind = (typeof COUNTER_WORK_KINDS)[number];

/** P6 desktop operation screen inside the Counter work frame (#52). */
export const COUNTER_WORK_DESTINATIONS = [
  "receiving",
  "held_delivery",
  "transfer_ship",
  "transfer_receive",
  "refund",
  "stocktake",
  "held_write_off",
  "import_post",
  "import_undo",
  "supplier_return",
  "offline_stock_case",
  "quarantine",
  "release_quarantine",
  "supplier_payout",
] as const;
export type CounterWorkDestination = (typeof COUNTER_WORK_DESTINATIONS)[number];

/** Whether the desktop destination screen exists in the shipped client (P6). */
export type CounterWorkDestinationStatus = "available" | "planned";

/** W11 daily-work kind that names the executable step for this counter item. */
export const COUNTER_WORK_DAILY_KIND: Readonly<Record<CounterWorkKind, DailyWorkKind>> = {
  prepared_receipt: "prepared_receipt.post",
  held_delivery: "held_delivery.post",
  transfer_ship: "transfer.ship",
  transfer_receive: "transfer.receive",
  refund: "sale_refund.execute",
  stocktake: "stocktake.post",
  held_adjustment: "held_adjustment.post",
  supplier_return: "goods_return.complete",
  import_stock: "import_stock.post",
  stock_case: "offline_stock_case.resolve",
  supplier_cash_payout: "supplier_cash_payout.execute",
};

/** P6 screen and rollout status per counter-work kind (coverage matrix). */
export const COUNTER_WORK_DESTINATION_BY_KIND: Readonly<
  Record<CounterWorkKind, { destination: CounterWorkDestination; status: CounterWorkDestinationStatus }>
> = {
  prepared_receipt: { destination: "receiving", status: "available" },
  held_delivery: { destination: "held_delivery", status: "available" },
  transfer_ship: { destination: "transfer_ship", status: "available" },
  transfer_receive: { destination: "transfer_receive", status: "available" },
  refund: { destination: "refund", status: "available" },
  stocktake: { destination: "stocktake", status: "available" },
  // The desktop posts held write-offs (#173) and settles offline sale stock (P5 #51) in Counter work.
  held_adjustment: { destination: "held_write_off", status: "available" },
  supplier_return: { destination: "supplier_return", status: "available" },
  import_stock: { destination: "import_post", status: "planned" },
  stock_case: { destination: "offline_stock_case", status: "available" },
  supplier_cash_payout: { destination: "supplier_payout", status: "available" },
};

/** Signed physical operation for each kind (execution after prepare). */
export const COUNTER_WORK_OPERATION: Readonly<Record<CounterWorkKind, SignedPhysicalOperation>> = {
  prepared_receipt: "POST /api/v1/purchasing/prepared-receipts/:id/post",
  held_delivery: "POST /api/v1/purchasing/held-deliveries/:id/post",
  transfer_ship: "POST /api/v1/transfers/:id/ship",
  transfer_receive: "POST /api/v1/transfers/:id/receive",
  refund: "POST /api/v1/sales/refund-requests/:id/execute",
  stocktake: "POST /api/v1/stocktakes/:id/post",
  held_adjustment: "POST /api/v1/inventory/held-adjustments/:id/post",
  supplier_return: "POST /api/v1/returns/:id/complete",
  import_stock: "POST /api/v1/products/import/:importId/stock/post",
  stock_case: "POST /api/v1/offline-stock-cases/resolutions/:id/execute",
  supplier_cash_payout: "POST /api/v1/purchasing/cash-payouts/:id/execute",
};

/** Primary key the signed body uses for the document id (for retry UI). */
export const COUNTER_WORK_SIGNED_ID_KEY: Readonly<Record<CounterWorkKind, string>> = {
  prepared_receipt: "preparedReceiptId",
  held_delivery: "heldDeliveryId",
  transfer_ship: "transferId",
  transfer_receive: "transferId",
  refund: "refundRequestId",
  stocktake: "stocktakeId",
  held_adjustment: "heldAdjustmentId",
  supplier_return: "goodsReturnId",
  import_stock: "importId",
  stock_case: "resolutionId",
  supplier_cash_payout: "cashPayoutId",
};

export type CounterWorkApprovalState = "matches" | "changed" | "revoked" | "not_needed";

/** Lifecycle stage for display (W11 / P6 alignment). */
export type CounterWorkTaskStage = "ready_for_execution" | "blocked_approval";

/** Terminal / operation error the execution path may return in this state (no new codes). */
export type CounterWorkExecuteErrorCode =
  | "PERMISSION_DENIED"
  | "APPROVAL_STALE"
  | "APPROVAL_INVALID"
  | "APPROVAL_REQUIRED"
  | "ONLINE_REQUIRED"
  | "TERMINAL_REQUIRED"
  | "REMOTE_SESSION_DENIED"
  | "IDENTITY_MISMATCH"
  | "MISMATCH_REPORTED";

export type CounterWorkExecuteError = Readonly<{
  /** prepare or execute — when the counter would see this refusal. */
  phase: "prepare" | "execute";
  code: CounterWorkExecuteErrorCode;
}>;

/** Row-level blockers on this list carry only approval-evidence failures; other codes appear at prepare/execute. */
export type CounterWorkRowBlockerCode = "APPROVAL_STALE" | "APPROVAL_INVALID" | "MISMATCH_REPORTED";

export type CounterWorkBlocker = Readonly<{
  code: CounterWorkRowBlockerCode;
  /** Short explanation for staff; not a stack trace. */
  message: string;
}>;

export type CounterWorkNextAction = Readonly<{
  label: string;
  /** When false, the P6 screen must not post (approval/recovery/remote handoff). */
  executable: boolean;
}>;

/** How fresh this row is; server `asOf` is the authoritative snapshot time. */
export type CounterWorkFreshness = Readonly<{
  asOf: string;
  /** When approval evidence last changed (approvedAt), if any. */
  evidenceAt: string | null;
  /** True when approval no longer matches the document (client must not treat as executable). */
  stale: boolean;
}>;

/** Offline / partial-outage display rules (client applies `terminalConnectivity`). */
export type CounterWorkOfflinePolicy = Readonly<{
  /** Counter work list and execution require online signed commands only. */
  list: "online_only";
  execution: "online_only";
  /**
   * While `terminalConnectivity` is `partial_outage`, the client may show the last successful
   * list as read-only; it must label freshness from `task.freshness.asOf` and never invent
   * central completion or refresh approval state offline.
   */
  partialOutage: "last_known_read_only";
}>;

/** Minimal signed-command facts the frame needs for retry and stale-evidence display. */
export type CounterWorkSignedExecution = Readonly<{
  operation: SignedPhysicalOperation;
  /** Pinned on prepare/execute for most kinds when `approval.state` is `matches`; always `null` for `transfer_receive`. */
  approvalEvidenceId: string | null;
  /**
   * `transfer_receive` only: the source branch's dispatch approval (`executionApprovalId` on the
   * transfer), carried in the signed body as `dispatchApprovalId`; `null` when waived or blocked.
   */
  dispatchApprovalId: string | null;
  /** Exact body key and document id for the signed envelope (value is this item's `id`). */
  bodyIdKey: string;
}>;

export type CounterWorkTask = Readonly<{
  contractVersion: typeof COUNTER_WORK_CONTRACT_VERSION;
  stage: CounterWorkTaskStage;
  dailyWorkKind: DailyWorkKind;
  destination: CounterWorkDestination;
  destinationStatus: CounterWorkDestinationStatus;
  nextAction: CounterWorkNextAction;
  blocker: CounterWorkBlocker | null;
  freshness: CounterWorkFreshness;
  offline: CounterWorkOfflinePolicy;
  signedExecution: CounterWorkSignedExecution;
  executeErrors: ReadonlyArray<CounterWorkExecuteError>;
}>;

export type HeldAdjustmentCounterStatus =
  | "awaiting_approval"
  | "approved"
  | "accepted"
  | "rejected";

export type ProjectCounterWorkTaskInput = Readonly<{
  kind: CounterWorkKind;
  id: string;
  approval: Readonly<{
    evidenceId: string | null;
    state: CounterWorkApprovalState;
    changes: ReadonlyArray<string>;
  }>;
  approvedAt: string | null;
  readyAt: string;
  asOf: string;
  /** Read-only held write-off rows on the counter (#173). */
  heldAdjustmentStatus?: HeldAdjustmentCounterStatus;
  /** Decision 1: an open mismatch report holds the approval this item would post. */
  mismatchReported?: boolean;
}>;

const NEXT_ACTION_READY: Readonly<Record<CounterWorkKind, string>> = {
  prepared_receipt: "Receive goods",
  held_delivery: "Book in held delivery",
  transfer_ship: "Pick and dispatch",
  transfer_receive: "Receive transfer",
  refund: "Refund customer",
  stocktake: "Post stocktake",
  held_adjustment: "Post write-off",
  supplier_return: "Complete supplier return",
  import_stock: "Post opening stock",
  stock_case: "Settle offline sale stock",
  supplier_cash_payout: "Pay supplier from drawer",
};

function blockerForApproval(
  state: CounterWorkApprovalState,
  changes: ReadonlyArray<string>,
): CounterWorkBlocker | null {
  if (state === "changed") {
    const detail = changes.length ? ` (${changes.join("; ")})` : "";
    return {
      code: "APPROVAL_STALE",
      message: `This document changed since it was approved${detail}. Ask for it to be approved again on the web.`,
    };
  }
  if (state === "revoked") {
    return {
      code: "APPROVAL_INVALID",
      message: "The approval was withdrawn on the web.",
    };
  }
  return null;
}

const MISMATCH_BLOCKER: CounterWorkBlocker = {
  code: "MISMATCH_REPORTED",
  message:
    "Sent to the approver as not matching. It waits here until a corrected version is approved, or the approver keeps it as it is.",
};

function stageFor(blocker: CounterWorkBlocker | null): CounterWorkTaskStage {
  return blocker ? "blocked_approval" : "ready_for_execution";
}

function executeErrorsFor(blocker: CounterWorkBlocker | null): ReadonlyArray<CounterWorkExecuteError> {
  if (!blocker) return [];
  const code = blocker.code;
  return [
    { phase: "prepare", code },
    { phase: "execute", code },
  ];
}

const OFFLINE_POLICY: CounterWorkOfflinePolicy = {
  list: "online_only",
  execution: "online_only",
  partialOutage: "last_known_read_only",
};

function signedExecutionFor(
  kind: CounterWorkKind,
  approval: ProjectCounterWorkTaskInput["approval"],
): CounterWorkSignedExecution {
  const base = {
    operation: COUNTER_WORK_OPERATION[kind],
    bodyIdKey: COUNTER_WORK_SIGNED_ID_KEY[kind],
  };
  if (kind === "transfer_receive") {
    const blocked = approval.state === "changed" || approval.state === "revoked";
    return {
      ...base,
      approvalEvidenceId: null,
      dispatchApprovalId: blocked ? null : approval.evidenceId,
    };
  }
  return {
    ...base,
    approvalEvidenceId: approval.state === "matches" ? approval.evidenceId : null,
    dispatchApprovalId: null,
  };
}

// ── Counter reads (P6 #52): the lines each operation screen draws ──────────────────────────

/**
 * Kinds with a document read at the counter: `GET /counter-work/:kind/:id`. The document detail
 * routes are web routes and refuse a PIN-opened counter login, so the counter reads the exact
 * document it is about to confirm here, and only while it waits in this branch's Counter work.
 */
export const COUNTER_WORK_DETAIL_KINDS = [
  "prepared_receipt",
  "held_delivery",
  "transfer_ship",
  "transfer_receive",
  "stocktake",
  "supplier_return",
  "import_stock",
] as const;
export type CounterWorkDetailKind = (typeof COUNTER_WORK_DETAIL_KINDS)[number];

export function isCounterWorkDetailKind(value: string): value is CounterWorkDetailKind {
  return (COUNTER_WORK_DETAIL_KINDS as readonly string[]).includes(value);
}

/** A person and a time on the document's trail; names are resolved, never user ids. */
export type CounterWorkPerson = Readonly<{ name: string | null; at: string | null }>;

/** A note someone left on the document for the counter, such as the approver's. */
export type CounterWorkNote = Readonly<{
  /** What the note is, for the screen's label: "Approver's note", "Why it was held". */
  label: string;
  text: string;
  by: string | null;
  at: string | null;
}>;

/** What the line is: the product. */
export type CounterWorkLineProduct = Readonly<{
  productId: string;
  productName: string;
  /** "Box of 96 tablets", from the product; null when the product has none. */
  packLabel: string | null;
  unitsPerPack: number;
}>;

/** Where the document names one: the batch. */
export type CounterWorkLineBatch = Readonly<{
  batchId: string | null;
  batchNo: string | null;
  /** Day only, `YYYY-MM-DD`. */
  expiryDate: string | null;
}>;

/** Receiving a prepared receipt or a held delivery: the approved delivery, line by line. */
export type CounterWorkReceiptLine = CounterWorkLineProduct &
  CounterWorkLineBatch &
  Readonly<{
    /** The line's position in the approved delivery; the screen's tick key. */
    index: number;
    /** Packs on the delivery note, when it was prepared in packs. */
    packs: number | null;
    /** Good units billed for. */
    receivedQty: number;
    /** Bonus units at no charge. */
    freeQty: number;
    /** Units that arrived damaged; they go to quarantine in the same posting. */
    damagedQty: number;
    damagedReason: string | null;
    /** Units the posting adds to saleable stock: received + free. */
    unitsToStock: number;
    /** Null without `costs.view`. */
    packCost: string | null;
    unitCost: string | null;
  }>;

/** Why a delivery was held at receiving and what the approver decided on the web. */
export type CounterWorkHeldDecision = Readonly<{
  reasons: ReadonlyArray<string>;
  detail: string | null;
  acceptOverDelivery: boolean;
  acceptPriceVariance: boolean;
  /** The approver corrected the delivery before approving it. */
  corrected: boolean;
}>;

/** A transfer line: the approved batch and quantity, and what has arrived so far. */
export type CounterWorkTransferLine = CounterWorkLineProduct &
  CounterWorkLineBatch &
  Readonly<{
    transferItemId: string;
    /** Units approved to leave (out) or sent (in). */
    qty: number;
    /** Units received at the destination so far; the signed receive sends it as `receivedQtyBefore`. */
    receivedQty: number;
    /** Units still on the way. */
    remainingQty: number;
  }>;

/**
 * A stocktake line, in the terms decision 3 posts: the difference found at the count, applied to
 * stock as it is now, so sales and deliveries since the count are kept.
 */
export type CounterWorkStocktakeLine = CounterWorkLineProduct &
  CounterWorkLineBatch &
  Readonly<{
    lineId: string;
    /** What the counter should have found: snapshot plus movements up to the count. */
    onHandAtCount: number;
    /** Null when the line was never counted; posting leaves it as it is. */
    countedQty: number | null;
    /** counted − on hand at count; null when uncounted. */
    difference: number | null;
    /** On hand now: on hand at count plus movements after the count. */
    now: number;
    /** What posting leaves: now + difference (now when uncounted). */
    afterPost: number;
    /** Difference at batch cost; null without `costs.view` or when uncounted. */
    valueAtCost: string | null;
    reviewNote: string | null;
  }>;

export type CounterWorkStocktakeTotals = Readonly<{
  lines: number;
  /** Counted lines whose difference is not zero: the adjustments posting writes. */
  differences: number;
  /** Sum of the differences at cost; null without `costs.view`. */
  valueAtCost: string | null;
}>;

/** A supplier return line: what leaves, from where, and why. */
export type CounterWorkReturnLine = CounterWorkLineProduct &
  CounterWorkLineBatch &
  Readonly<{
    itemId: string;
    qty: number;
    /** The batch is in quarantine; otherwise it is on the shelf. */
    quarantined: boolean;
    disposition: string;
    /** Null without `costs.view`. */
    unitPrice: string | null;
  }>;

/** An opening-stock import, by category: each category posts once. */
export type CounterWorkImportCategory = Readonly<{
  /** Null for rows with no category. Posting it sends `categoryName: null`. */
  categoryName: string | null;
  rows: number;
  /** Distinct product and batch number pairs the rows post. Rows repeating a pair add none. */
  batches: number;
  units: number;
  /** True once every row in the category is posted. */
  posted: boolean;
}>;

export type CounterWorkImportRow = Readonly<{
  rowNumber: number;
  productId: string;
  productName: string;
  categoryName: string | null;
  batchNo: string;
  expiryDate: string | null;
  qty: number;
  /** Null without `costs.view`. */
  unitCost: string | null;
  posted: boolean;
}>;

type CounterWorkDetailBase<K extends CounterWorkDetailKind> = Readonly<{
  kind: K;
  id: string;
  reference: string;
  subject: string | null;
  /** The approval check, exactly as `GET /counter-work` reports it. */
  approval: Readonly<{
    evidenceId: string | null;
    approvedVersion: number | null;
    currentVersion: number | null;
    state: CounterWorkApprovalState;
    changes: ReadonlyArray<string>;
  }>;
  task: CounterWorkTask;
  requested: CounterWorkPerson | null;
  approved: CounterWorkPerson | null;
  dispatched: CounterWorkPerson | null;
  notes: ReadonlyArray<CounterWorkNote>;
  /** Decision 1: reports this branch sent that are still open. */
  mismatches: ReadonlyArray<CounterMismatchReport>;
}>;

export type CounterWorkReceiptDetail = CounterWorkDetailBase<"prepared_receipt"> &
  Readonly<{
    supplierDeliveryNote: string | null;
    /** Null without `costs.view`. */
    amount: string | null;
    lines: ReadonlyArray<CounterWorkReceiptLine>;
  }>;

export type CounterWorkHeldDeliveryDetail = CounterWorkDetailBase<"held_delivery"> &
  Readonly<{
    supplierDeliveryNote: string | null;
    amount: string | null;
    held: CounterWorkHeldDecision;
    lines: ReadonlyArray<CounterWorkReceiptLine>;
  }>;

export type CounterWorkTransferDetail = CounterWorkDetailBase<"transfer_ship" | "transfer_receive"> &
  Readonly<{
    /** The other branch: destination for a transfer out, source for a transfer in. */
    otherBranch: string;
    lines: ReadonlyArray<CounterWorkTransferLine>;
  }>;

export type CounterWorkStocktakeDetail = CounterWorkDetailBase<"stocktake"> &
  Readonly<{
    totals: CounterWorkStocktakeTotals;
    lines: ReadonlyArray<CounterWorkStocktakeLine>;
  }>;

export type CounterWorkReturnDetail = CounterWorkDetailBase<"supplier_return"> &
  Readonly<{
    amount: string | null;
    lines: ReadonlyArray<CounterWorkReturnLine>;
  }>;

export type CounterWorkImportDetail = CounterWorkDetailBase<"import_stock"> &
  Readonly<{
    /** The staged version the post is pinned to (imports have no approval step). */
    stockVersion: number;
    categories: ReadonlyArray<CounterWorkImportCategory>;
    rows: ReadonlyArray<CounterWorkImportRow>;
  }>;

export type CounterWorkDetail =
  | CounterWorkReceiptDetail
  | CounterWorkHeldDeliveryDetail
  | CounterWorkTransferDetail
  | CounterWorkStocktakeDetail
  | CounterWorkReturnDetail
  | CounterWorkImportDetail;

/** One stock line an undoable import posted. */
export type CounterUndoableImportLine = CounterWorkLineProduct &
  CounterWorkLineBatch &
  Readonly<{
    qty: number;
    /** The import created this product; undo removes it from the catalogue. */
    newProduct: boolean;
  }>;

/**
 * Decision 5: an import uploaded with its stock that this branch's counter can still undo
 * (`GET /counter-work/imports`). Listed only while the undo checks pass, so the list drops an
 * import once anything from it sells or moves.
 */
export type CounterUndoableImport = Readonly<{
  importId: string;
  filename: string;
  uploaded: CounterWorkPerson;
  /** The import was stopped part-way (status `failed`); undo removes what it did post. */
  stopped: boolean;
  productsCreated: number;
  productsUpdated: number;
  /** The catalogue entries undo removes, including ones the import gave no stock. */
  createdProducts: ReadonlyArray<Readonly<{ productId: string; productName: string }>>;
  batches: number;
  units: number;
  lines: ReadonlyArray<CounterUndoableImportLine>;
}>;

/**
 * Pure projection: maps an approved document row plus approval state to W11/P6 task display
 * fields. The API sets `asOf` once per list response.
 */
export function projectCounterWorkTask(input: ProjectCounterWorkTaskInput): CounterWorkTask {
  const { kind, approval, approvedAt, asOf, heldAdjustmentStatus } = input;
  const { destination, status: destinationStatus } = COUNTER_WORK_DESTINATION_BY_KIND[kind];
  const readOnlyHeld =
    kind === "held_adjustment" &&
    (heldAdjustmentStatus === "awaiting_approval" || heldAdjustmentStatus === "rejected");
  const blocker = readOnlyHeld
    ? null
    : (blockerForApproval(approval.state, approval.changes) ??
      (input.mismatchReported ? MISMATCH_BLOCKER : null));
  const stage = readOnlyHeld ? "blocked_approval" : stageFor(blocker);
  const readyLabel = NEXT_ACTION_READY[kind];

  const nextAction: CounterWorkNextAction = readOnlyHeld
    ? {
        label:
          heldAdjustmentStatus === "rejected"
            ? "Rejected on the web"
            : "Waiting for approval on the web",
        executable: false,
      }
    : !blocker
      ? {
          label:
            destinationStatus === "available"
              ? readyLabel
              : `${readyLabel} (screen planned)`,
          executable: destinationStatus === "available",
        }
      : {
          label:
            blocker.code === "APPROVAL_INVALID"
              ? "Approval withdrawn"
              : blocker.code === "MISMATCH_REPORTED"
                ? "Waiting for a corrected version"
                : "Approve again on the web",
          executable: false,
        };

  return {
    contractVersion: COUNTER_WORK_CONTRACT_VERSION,
    stage,
    dailyWorkKind: COUNTER_WORK_DAILY_KIND[kind],
    destination,
    destinationStatus,
    nextAction,
    blocker,
    freshness: {
      asOf,
      evidenceAt: approvedAt,
      stale: approval.state === "changed" || approval.state === "revoked",
    },
    offline: OFFLINE_POLICY,
    signedExecution: signedExecutionFor(kind, approval),
    executeErrors: executeErrorsFor(blocker),
  };
}

/**
 * P6 #52 decision 1: "Something doesn't match" (receiving, transfer in) and "Can't pick all of it"
 * (transfer out), sent from the counter to the approver. Nothing posts from it.
 */
export const COUNTER_MISMATCH_KINDS = [
  "prepared_receipt",
  "held_delivery",
  "transfer_ship",
  "transfer_receive",
] as const satisfies ReadonlyArray<CounterWorkDetailKind>;
export type CounterMismatchKind = (typeof COUNTER_MISMATCH_KINDS)[number];

export function isCounterMismatchKind(value: string): value is CounterMismatchKind {
  return (COUNTER_MISMATCH_KINDS as readonly string[]).includes(value);
}

export const COUNTER_MISMATCH_PROBLEMS = [
  "fewer_arrived",
  "more_arrived",
  "different_batch_or_expiry",
  "damaged",
  "not_on_note",
  "cannot_pick",
] as const;
export type CounterMismatchProblem = (typeof COUNTER_MISMATCH_PROBLEMS)[number];

/** The choices each screen offers under "What's wrong". */
export const COUNTER_MISMATCH_PROBLEMS_BY_KIND: Readonly<
  Record<CounterMismatchKind, ReadonlyArray<CounterMismatchProblem>>
> = {
  prepared_receipt: ["fewer_arrived", "more_arrived", "different_batch_or_expiry", "damaged", "not_on_note"],
  held_delivery: ["fewer_arrived", "more_arrived", "different_batch_or_expiry", "damaged", "not_on_note"],
  transfer_ship: ["cannot_pick", "different_batch_or_expiry", "damaged"],
  transfer_receive: ["fewer_arrived", "more_arrived", "different_batch_or_expiry", "damaged"],
};

/** Problems that need the count ("Packs that arrived", "Units you can pick"). */
export const COUNTER_MISMATCH_NEEDS_COUNT: ReadonlyArray<CounterMismatchProblem> = [
  "fewer_arrived",
  "more_arrived",
  "damaged",
  "cannot_pick",
];

/** Words for each problem, shared by the counter and the web. */
export const COUNTER_MISMATCH_PROBLEM_LABEL: Readonly<Record<CounterMismatchProblem, string>> = {
  fewer_arrived: "Fewer arrived",
  more_arrived: "More arrived",
  different_batch_or_expiry: "Different batch or expiry",
  damaged: "Damaged",
  not_on_note: "Not on the delivery note",
  cannot_pick: "Can't pick all of it",
};

/**
 * Whether an open report holds the item at the counter. A transfer in is never held: the counter
 * still receives what arrived, and a manager closes the rest on the web (decision 2).
 */
export const COUNTER_MISMATCH_HOLDS: Readonly<Record<CounterMismatchKind, boolean>> = {
  prepared_receipt: true,
  held_delivery: true,
  transfer_ship: true,
  transfer_receive: false,
};

/** The line the report is about: a delivery line by its index, or a transfer line. */
export type CounterMismatchLine = Readonly<{ index: number }> | Readonly<{ transferItemId: string }>;

/** `POST /counter-work/mismatches`, sent with an `Idempotency-Key`. */
export type ReportCounterMismatchBody = Readonly<{
  kind: CounterMismatchKind;
  documentId: string;
  /** `approval.evidenceId` from the item the counter shows; null where it is null. */
  approvalId: string | null;
  /** `approval.currentVersion` from the same item. */
  documentVersion: number;
  /** Null only for "not_on_note". */
  line: CounterMismatchLine | null;
  problem: CounterMismatchProblem;
  /** Required for the problems in `COUNTER_MISMATCH_NEEDS_COUNT`; packs where the line has packs. */
  countedQty: number | null;
  note: string | null;
}>;

/** `POST /counter-work/mismatches/:id/dismiss` on the web: keep the document as approved. */
export type DismissCounterMismatchBody = Readonly<{ note: string | null }>;

export type CounterMismatchReport = Readonly<{
  id: string;
  kind: CounterMismatchKind;
  documentId: string;
  reference: string;
  approvalId: string | null;
  documentVersion: number;
  line: CounterMismatchLine | null;
  /** The product, as the counter saw the line. */
  lineLabel: string | null;
  problem: CounterMismatchProblem;
  countedQty: number | null;
  countUnit: "packs" | "units" | null;
  note: string | null;
  status: "open" | "dismissed";
  /** Open, and the approval it was raised against is still the document's (nothing replaced it). */
  holding: boolean;
  reported: CounterWorkPerson;
  dismissed: CounterWorkPerson | null;
  dismissNote: string | null;
}>;

/** P6 #52 decision 2: closing what is still on the way, on the web. */
export const TRANSFER_SHORT_CLOSE_REASONS = ["never_left_source", "lost_in_transit"] as const;
export type TransferShortCloseReason = (typeof TRANSFER_SHORT_CLOSE_REASONS)[number];

/** `POST /transfers/:id/close-short`. `remaining` pins what the manager saw still on the way. */
export type CloseShortTransferBody = Readonly<{
  reason: TransferShortCloseReason;
  note: string;
  remaining: ReadonlyArray<Readonly<{ transferItemId: string; qty: number }>>;
}>;
