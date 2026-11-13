import type { QuarantineReasonCode } from "./stock-quarantine";
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
  "POST /api/v1/transfers/:id/ship",
  "POST /api/v1/transfers/:id/receive",
  "POST /api/v1/sales/refund-requests/:id/execute",
  "POST /api/v1/purchasing/prepared-receipts/:id/post",
  "POST /api/v1/returns/:id/complete",
  "POST /api/v1/inventory/adjustments",
  "POST /api/v1/inventory/batches/:id/quarantine",
  "POST /api/v1/inventory/batches/:id/release-quarantine",
  "POST /api/v1/prescriptions",
  "POST /api/v1/offline-stock-cases/resolutions/:id/execute",
  "POST /api/v1/purchasing/cash-payouts/:id/execute",
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
  /** Source counter. approvalEvidenceId = the transfer's executionApprovalId, or null when the
   * tenant does not require transfer approval and the transfer carries none. */
  "POST /api/v1/transfers/:id/ship": Readonly<{ transferId: string }>;
  /** Destination counter (x-branch-id = destination). approvalEvidenceId must be null; the
   * dispatch is pinned by dispatchApprovalId (the transfer's executionApprovalId, null if waived).
   * One entry per counted line; receivedQtyBefore is the line's receivedQty the counter saw. */
  "POST /api/v1/transfers/:id/receive": Readonly<{
    transferId: string;
    dispatchApprovalId: string | null;
    lines: ReadonlyArray<Readonly<{ transferItemId: string; qty: number; receivedQtyBefore: number }>>;
  }>;
  /** The counter refunds a prepared request (stock back, money out). approvalEvidenceId = the
   * request's executionApprovalId, or null when it needs no approval (under the threshold). */
  "POST /api/v1/sales/refund-requests/:id/execute": Readonly<{ refundRequestId: string }>;
  "POST /api/v1/purchasing/prepared-receipts/:id/post": Readonly<{ preparedReceiptId: string }>;
  "POST /api/v1/returns/:id/complete": Readonly<{ goodsReturnId: string }>;
  /** A direct adjustment at the counter. approvalEvidenceId must be null: a write-off that needs
   * approval is refused (WRITE_OFF_APPROVAL_REQUIRED) and goes through a held request instead.
   * movementType is set for a correction only; batchId is null only with newBatch (increases). */
  "POST /api/v1/inventory/adjustments": Readonly<{
    kind: StockAdjustmentKind;
    movementType: "adjustment_in" | "adjustment_out" | null;
    productId: string;
    batchId: string | null;
    newBatch: Readonly<{
      batchNo: string;
      expiryDate: string; // YYYY-MM-DD
      costPriceMinor: number;
      sellingPriceMinor: number;
      supplierId: string | null;
    }> | null;
    qty: number;
    reason: string | null; // required for a correction
    fromQuarantine: boolean; // write-offs only
  }>;
  /** Hold sellable units on a batch. `qty: null` holds everything not already held or reserved.
   * `reason` is required when `reasonCode` is `other`. */
  "POST /api/v1/inventory/batches/:id/quarantine": Readonly<{
    batchId: string;
    qty: number | null;
    reasonCode: QuarantineReasonCode;
    reason: string | null;
  }>;
  /** Return held units to sellable stock after inspection. `qty: null` releases everything held.
   * Refused when the batch is expired. */
  "POST /api/v1/inventory/batches/:id/release-quarantine": Readonly<{
    batchId: string;
    qty: number | null;
    reason: string | null;
  }>;
  /** A prescription presented at the counter. The signed session's staff member must hold a
   * current SLMC registration at the branch (PHARMACIST_REQUIRED otherwise); approvalEvidenceId
   * must be null. Every key is present; text is exact and trimmed; dates are YYYY-MM-DD. */
  "POST /api/v1/prescriptions": Readonly<{
    rxNumber: string | null; // null: the server allocates RX-#####
    patientName: string;
    doctorName: string;
    doctorRegNo: string | null;
    issuedOn: string;
    validUntil: string | null; // null: never lapses
    customerId: string | null;
    notes: string | null;
  }>;
  /** P5 #51: resolve an offline stock discrepancy case with its remotely approved plan, here at
   * the counter. approvalEvidenceId = the plan's executionApprovalId (always required). `counts`
   * is the local physical count of every batch of the case, in any order, for count_and_correct,
   * and empty for the other kinds. A count is every unit of the batch at the branch, sellable or
   * held, after the offline sale left the shelf. */
  "POST /api/v1/offline-stock-cases/resolutions/:id/execute": Readonly<{
    resolutionId: string;
    counts: ReadonlyArray<Readonly<{ batchId: string; countedQty: number }>>;
  }>;
  /** Pay an approved supplier cash payout from the open shift's drawer. */
  "POST /api/v1/purchasing/cash-payouts/:id/execute": Readonly<{ cashPayoutId: string }>;
};

/** P5 #51: how an approved resolution plan settles an offline stock discrepancy case. */
export const OFFLINE_STOCK_RESOLUTION_KINDS = ["post_now", "count_and_correct", "link_existing_settlement"] as const;
export type OfflineStockResolutionKind = typeof OFFLINE_STOCK_RESOLUTION_KINDS[number];

export const STOCK_ADJUSTMENT_KINDS = ["found", "damaged", "expired", "lost", "opening", "correction"] as const;
export type StockAdjustmentKind = typeof STOCK_ADJUSTMENT_KINDS[number];

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
  "POST /api/v1/transfers/:id/ship": Readonly<{
    type: "transfer.dispatched"; transferId: string; approvalId: string | null; dispatchedQty: number;
    effect: SignedOperationEffect;
  }>;
  "POST /api/v1/transfers/:id/receive": Readonly<{
    type: "transfer.received"; transferId: string; dispatchApprovalId: string | null;
    status: "partially_received" | "received"; receivedQty: number;
  }>;
  /** Money in LKR minor units. "already_applied": the request was executed by another command;
   * refundedTo is then empty (read the sale for its payments). */
  "POST /api/v1/sales/refund-requests/:id/execute": Readonly<{
    type: "sale_refund.executed"; refundRequestId: string; approvalId: string | null; goodsReturnId: string;
    amountMinor: number; refundedTo: ReadonlyArray<Readonly<{ method: string; amountMinor: number }>>;
    effect: SignedOperationEffect;
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
  /** Each command is its own adjustment; a replay returns this original receipt. */
  "POST /api/v1/inventory/adjustments": Readonly<{
    type: "stock_adjustment.posted"; productId: string; batchId: string;
    movementType: "adjustment_in" | "adjustment_out"; qty: number; stockReferenceId: string;
  }>;
  /** Each command is its own quarantine move; a replay returns the original receipt. */
  "POST /api/v1/inventory/batches/:id/quarantine": Readonly<{
    type: "batch.quarantined"; batchId: string; productId: string; qty: number;
    reasonCode: QuarantineReasonCode; stockReferenceId: string;
  }>;
  /** Each command is its own release move; a replay returns the original receipt. */
  "POST /api/v1/inventory/batches/:id/release-quarantine": Readonly<{
    type: "batch.quarantine_released"; batchId: string; productId: string; qty: number;
    stockReferenceId: string;
  }>;
  /** Each command is its own prescription; a replay returns this original receipt. */
  "POST /api/v1/prescriptions": Readonly<{
    type: "prescription.recorded"; prescriptionId: string; rxNumber: string;
    // The SLMC registration relied on: the signed-in pharmacist's own, or the co-signer's when the
    // command carried a co-sign (`pharmacistEvidenceId`). The co-signer is in the audit provenance.
    pharmacistRegistrationId: string;
  }>;
  /** Each batch of the case, once: what was posted, corrected or linked. */
  "POST /api/v1/purchasing/cash-payouts/:id/execute": Readonly<{
    type: "supplier_cash_payout.executed"; cashPayoutId: string; approvalId: string;
    supplierPaymentId: string; amountMinor: number; effect: SignedOperationEffect;
  }>;
  "POST /api/v1/offline-stock-cases/resolutions/:id/execute": Readonly<{
    type: "offline_stock_case.resolved"; resolutionId: string; caseId: string; saleId: string; approvalId: string;
    kind: OfflineStockResolutionKind; effect: SignedOperationEffect;
    batches: ReadonlyArray<Readonly<{
      batchId: string;
      method: "posted" | "counted" | "linked";
      soldQty: number;
      countedQty: number | null;
      /** Units added (positive) or taken off (negative) to bring the batch to the count. */
      correctionQty: number;
      postedQty: number;
      /** Batches another open case still holds stay blocked. */
      stillBlocked: boolean;
    }>>;
  }>;
};

/** POST /api/v1/terminal-commands/prepare (Bearer + x-branch-id). Returns OnlineTerminalCommand<body>.
 * approvalEvidenceId is required for stocktake/held posting, must be null for import operations,
 * direct adjustments, quarantine/release, prescriptions and transfer receipt, and is the transfer's approval (or null where waived) for transfer dispatch;
 * pharmacistEvidenceId is null, or for a clinical operation (prescriptions) a co-sign from
 * POST /terminal-commands/pharmacist-cosigns; operatingHoursExceptionId must be null for every v1 operation.
 */
export type TerminalCommandPrepareRequest<O extends SignedPhysicalOperation = SignedPhysicalOperation> = Readonly<{
  workSessionId: string;
  operation: O;
  body: SignedOperationBody[O];
  approvalEvidenceId: string | null;
  pharmacistEvidenceId: string | null;
  operatingHoursExceptionId: null;
}>;

/** Operations a registered pharmacist may co-sign by PIN for the signed-in staff member. */
export const COSIGNABLE_OPERATIONS = ["POST /api/v1/prescriptions"] as const;
export type CosignableOperation = typeof COSIGNABLE_OPERATIONS[number];

/** POST /api/v1/terminal-commands/pharmacist-cosigns (Bearer + x-branch-id). The PIN is checked
 * here and never stored, signed or logged; the co-sign it creates is single-use, bound to this
 * tenant, branch, counter staff session, operation and exact body, and short-lived. The command
 * then carries only `pharmacistEvidenceId`.
 */
export type PharmacistCosignRequest<O extends CosignableOperation = CosignableOperation> = Readonly<{
  workSessionId: string;
  operation: O;
  body: SignedOperationBody[O];
  pharmacistUserId: string;
  pin: string;
}>;
export type PharmacistCosign = Readonly<{
  pharmacistEvidenceId: string;
  pharmacistUserId: string;
  pharmacistRegistrationId: string; // the registration it was checked against when created
  expiresAt: number; // epoch ms; prepare and execute before then
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
