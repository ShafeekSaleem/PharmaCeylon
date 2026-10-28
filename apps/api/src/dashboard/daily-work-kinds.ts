import type { DailyWorkKind, WorkPlace } from "@pharmaceylon/shared";
import {
  APPROVAL_ACTIONS,
  type ApprovalAction,
} from "../security/approval-documents";
import { MUTATION_ACTIONS } from "../security/mutation-actions";
import { classifyProfile } from "../security/operation-classification";

type MutationKey = keyof typeof MUTATION_ACTIONS;

/**
 * Each daily-work kind names the step that finishes it. `approvalAction`: the item is an approved
 * document waiting for that registry action, which also supplies the executing route; `executes`:
 * any other step's route. `null`: management work, always done on the web.
 */
type KindDef =
  | { approvalAction: ApprovalAction }
  | { executes: MutationKey | null };

export const DAILY_WORK_KIND_DEFS: Readonly<Record<DailyWorkKind, KindDef>> = {
  "purchase_order.approve": { executes: null },
  "purchase_order.draft": { executes: null },
  "purchase_order.receive": { approvalAction: "purchase_order.receive" },
  "held_delivery.approve": { executes: null },
  "held_delivery.post": { approvalAction: "held_delivery.post" },
  "prepared_receipt.approve": { executes: null },
  "prepared_receipt.post": { approvalAction: "prepared_receipt.post" },
  "held_adjustment.approve": { executes: null },
  "held_adjustment.post": { approvalAction: "held_adjustment.post" },
  "transfer.approve": { executes: null },
  "transfer.ship": { approvalAction: "transfer.ship" },
  "transfer.receive": { executes: "POST /api/v1/transfers/:id/receive" },
  "goods_return.approve": { executes: null },
  "goods_return.draft": { executes: null },
  "goods_return.complete": { approvalAction: "goods_return.complete" },
  "stocktake.approve": { executes: null },
  "stocktake.post": { approvalAction: "stocktake.post" },
  "stocktake.complete": { executes: "POST /api/v1/stocktakes/:id/complete" },
  "stocktake.prepare": { executes: null },
  "stocktake.count": { executes: "PATCH /api/v1/stocktakes/:id/lines" },
  // Staged opening stock (D-W2) has no approval: staging it is the management decision.
  "import_stock.post": {
    executes: "POST /api/v1/products/import/:importId/stock/post",
  },
  "held_sale.resume": { executes: "POST /api/v1/sales/checkout" },
  "held_sale.pharmacist_review": { executes: "POST /api/v1/sales/checkout" },
  "batch.expiry_review": {
    executes: "POST /api/v1/inventory/batches/:id/quarantine",
  },
};

export function kindOperation(kind: DailyWorkKind): MutationKey | null {
  const def = DAILY_WORK_KIND_DEFS[kind];
  return "approvalAction" in def
    ? (APPROVAL_ACTIONS[def.approvalAction].operation as MutationKey)
    : def.executes;
}

/** Whether a route's effects need an enrolled counter (D10). Checkout and refunds always move
 * stock, so a profile that needs per-request facts counts as physical. */
export function isPhysicalOperation(operation: string): boolean {
  if (!Object.hasOwn(MUTATION_ACTIONS, operation))
    throw new Error(`Unclassified daily-work operation: ${operation}`);
  try {
    return classifyProfile(MUTATION_ACTIONS[operation as MutationKey])
      .requiresLocalTerminal;
  } catch {
    return true;
  }
}

/** Kinds finished by an approved document's physical execution: "approved, waiting at the counter". */
export function approvedWaitingKinds(): DailyWorkKind[] {
  return (Object.keys(DAILY_WORK_KIND_DEFS) as DailyWorkKind[]).filter(
    (kind) => {
      const def = DAILY_WORK_KIND_DEFS[kind];
      return (
        ("approvalAction" in def || kind === "import_stock.post") &&
        isPhysicalOperation(kindOperation(kind)!)
      );
    },
  );
}

/** At a live branch (fallback included: other pages keep their counter handoffs), a step whose
 * route is physical is done at the counter. Not-live branches keep today's web behaviour. */
export function counterKinds(live: boolean): DailyWorkKind[] {
  if (!live) return [];
  return (Object.keys(DAILY_WORK_KIND_DEFS) as DailyWorkKind[]).filter(
    (kind) => {
      const operation = kindOperation(kind);
      return operation !== null && isPhysicalOperation(operation);
    },
  );
}

export function workPlace(kind: DailyWorkKind, live: boolean): WorkPlace {
  return counterKinds(live).includes(kind) ? "counter" : "web";
}
