import type { DailyWorkKind } from "./dashboard";
import type { SignedPhysicalOperation } from "./terminal-command-execution";

/** Contract version for additive counter-work task fields (#172). */
export const COUNTER_WORK_CONTRACT_VERSION = 1 as const;

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
  prepared_receipt: { destination: "receiving", status: "planned" },
  held_delivery: { destination: "held_delivery", status: "planned" },
  transfer_ship: { destination: "transfer_ship", status: "planned" },
  transfer_receive: { destination: "transfer_receive", status: "planned" },
  refund: { destination: "refund", status: "available" },
  stocktake: { destination: "stocktake", status: "planned" },
  held_adjustment: { destination: "held_write_off", status: "planned" },
  supplier_return: { destination: "supplier_return", status: "planned" },
  import_stock: { destination: "import_post", status: "planned" },
  stock_case: { destination: "offline_stock_case", status: "planned" },
  supplier_cash_payout: { destination: "supplier_payout", status: "planned" },
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
  | "IDENTITY_MISMATCH";

export type CounterWorkExecuteError = Readonly<{
  /** prepare or execute — when the counter would see this refusal. */
  phase: "prepare" | "execute";
  code: CounterWorkExecuteErrorCode;
}>;

/** Row-level blockers on this list carry only approval-evidence failures; other codes appear at prepare/execute. */
export type CounterWorkRowBlockerCode = "APPROVAL_STALE" | "APPROVAL_INVALID";

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

/**
 * Pure projection: maps an approved document row plus approval state to W11/P6 task display
 * fields. The API sets `asOf` once per list response.
 */
export function projectCounterWorkTask(input: ProjectCounterWorkTaskInput): CounterWorkTask {
  const { kind, approval, approvedAt, asOf } = input;
  const { destination, status: destinationStatus } = COUNTER_WORK_DESTINATION_BY_KIND[kind];
  const blocker = blockerForApproval(approval.state, approval.changes);
  const stage = stageFor(blocker);
  const readyLabel = NEXT_ACTION_READY[kind];

  const nextAction: CounterWorkNextAction = !blocker
    ? {
        label:
          destinationStatus === "available"
            ? readyLabel
            : `${readyLabel} (screen planned)`,
        executable: destinationStatus === "available",
      }
    : {
        label: blocker.code === "APPROVAL_INVALID" ? "Approval withdrawn" : "Approve again on the web",
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
