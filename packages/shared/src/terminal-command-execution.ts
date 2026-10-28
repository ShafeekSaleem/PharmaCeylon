import type { OnlineTerminalCommand, Signed, TerminalIdentity } from "./terminal-contracts";

/** P1 online signed execution, contract v1. See docs/API_CONTRACT.md "Signed terminal commands".
 * The server issues commandId/serverNonce via prepare; the desktop signs the returned payload
 * verbatim and keeps the signed envelope until it receives a receipt or a definitive error.
 * Online commands carry no sequence; offline sequences belong to P5.
 */
export const SIGNED_PHYSICAL_OPERATIONS = [
  "POST /api/v1/stocktakes/:id/post",
  "POST /api/v1/inventory/held-adjustments/:id/post",
  "POST /api/v1/purchasing/held-deliveries/:id/post",
  "POST /api/v1/products/import/:importId/stock/post",
  "POST /api/v1/products/import/:importId/undo-stock",
  "POST /api/v1/purchasing/prepared-receipts/:id/post",
  "POST /api/v1/returns/:id/complete",
] as const;
export type SignedPhysicalOperation = typeof SIGNED_PHYSICAL_OPERATIONS[number];

/** Exact signed bodies: no extra, missing or coerced fields. */
export type SignedOperationBody = {
  "POST /api/v1/stocktakes/:id/post": Readonly<{ stocktakeId: string }>;
  "POST /api/v1/inventory/held-adjustments/:id/post": Readonly<{ heldAdjustmentId: string }>;
  "POST /api/v1/purchasing/held-deliveries/:id/post": Readonly<{ heldDeliveryId: string }>;
  "POST /api/v1/products/import/:importId/stock/post": Readonly<{
    importId: string;
    version: number; // displayed staged-stock version
    selection: "all" | "category"; // "all" posts every remaining staged row
    categoryName: string | null; // "all": must be null; "category": the name, or null = uncategorised rows
  }>;
  "POST /api/v1/products/import/:importId/undo-stock": Readonly<{ importId: string }>;
  "POST /api/v1/purchasing/prepared-receipts/:id/post": Readonly<{ preparedReceiptId: string }>;
  "POST /api/v1/returns/:id/complete": Readonly<{ goodsReturnId: string }>;
};

/** "already_applied": a distinct command found the document already posted; no second effect. */
export type SignedOperationEffect = "applied" | "already_applied";
export type SignedOperationResult = {
  "POST /api/v1/stocktakes/:id/post": Readonly<{
    type: "stocktake.posted"; stocktakeId: string; approvalId: string; effect: SignedOperationEffect;
  }>;
  "POST /api/v1/inventory/held-adjustments/:id/post": Readonly<{
    type: "held_adjustment.posted"; heldAdjustmentId: string; approvalId: string; stockReferenceId: string;
    effect: SignedOperationEffect;
  }>;
  "POST /api/v1/purchasing/held-deliveries/:id/post": Readonly<{
    type: "held_delivery.posted"; heldDeliveryId: string; approvalId: string; goodsReceiptId: string;
    effect: SignedOperationEffect;
  }>;
  "POST /api/v1/products/import/:importId/stock/post": Readonly<{
    type: "import_stock.posted"; importId: string; version: number; selection: "all" | "category";
    categoryName: string | null; batchesPosted: number; unitsPosted: number; effect: SignedOperationEffect;
  }>;
  "POST /api/v1/products/import/:importId/undo-stock": Readonly<{
    type: "import.undone"; importId: string; batchesRemoved: number; productsRemoved: number;
    productsLeftInPlace: number;
  }>;
  "POST /api/v1/purchasing/prepared-receipts/:id/post": Readonly<{
    type: "prepared_receipt.posted"; preparedReceiptId: string; approvalId: string; goodsReceiptId: string;
    effect: SignedOperationEffect;
  }>;
  "POST /api/v1/returns/:id/complete": Readonly<{
    type: "goods_return.completed"; goodsReturnId: string; approvalId: string;
    debitNoteId: string | null; // null when the returned lines are worth nothing to claim
    effect: SignedOperationEffect;
  }>;
};

/** POST /api/v1/terminal-commands/prepare (Bearer + x-branch-id). Returns OnlineTerminalCommand<body>.
 * approvalEvidenceId is required for stocktake/held posting and must be null for import operations;
 * pharmacist/hours evidence IDs must be null for every v1 operation.
 */
export type TerminalCommandPrepareRequest<O extends SignedPhysicalOperation = SignedPhysicalOperation> = Readonly<{
  workSessionId: string;
  operation: O;
  body: SignedOperationBody[O];
  approvalEvidenceId: string | null;
  pharmacistEvidenceId: null;
  operatingHoursExceptionId: null;
}>;

/** POST /api/v1/terminal-commands/execute. attendanceProofId comes from P2's attendance provider. */
export type TerminalCommandExecuteRequest<O extends SignedPhysicalOperation = SignedPhysicalOperation> = Readonly<{
  command: Signed<OnlineTerminalCommand<SignedOperationBody[O]>>;
  attendanceProofId: string;
}>;

/** Identical on every replay except `replayed`. requestDigest = sha256 hex of
 * UTF-8 terminalSigningText("command", payload) — the exact signed bytes.
 */
export type OnlineCommandReceipt<O extends SignedPhysicalOperation = SignedPhysicalOperation> = Readonly<{
  contractVersion: 1;
  kind: "online_command_receipt";
  receiptId: string;
  commandId: string;
  identity: TerminalIdentity;
  workSessionId: string;
  operation: O;
  requestDigest: string;
  actorUserId: string;
  recordedAt: number;
  replayed: boolean;
  result: SignedOperationResult[O];
}>;
