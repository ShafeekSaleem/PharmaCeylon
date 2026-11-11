/** P5 #51: the API's offline stock case shapes (GET /offline-stock-cases, /offline-stock-cases/:id). */
export type Person = { id: string; name: string | null } | null;
export type ResolutionKind = "post_now" | "count_and_correct" | "link_existing_settlement";
export type PlanStatus = "prepared" | "approved" | "executed" | "cancelled";

export type StockCaseSummary = {
  id: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
  saleId: string;
  invoiceNo: string;
  soldAt: string;
  grandTotal: string;
  soldBy: string | null;
  counter: string | null;
  batchCount: number;
  pendingUnits: number;
  shortfallUnits: number;
  plan: { id: string; kind: ResolutionKind; status: PlanStatus } | null;
};

export type SettlementLink =
  | { batchId: string; source: "stocktake"; stocktakeId: string }
  | { batchId: string; source: "movements"; ledgerEntryIds: string[] };

export type StockCasePlan = {
  id: string;
  kind: ResolutionKind;
  links: SettlementLink[];
  note: string | null;
  status: PlanStatus;
  approvalVersion: number;
  executionApprovalId: string | null;
  /** none: not approved yet. changed: the case or plan moved since approval. */
  approvalState: "none" | "matches" | "changed" | "revoked";
  approvalReview: { expectedVersion: number; expectedDigest: string } | null;
  readyAtCounter: boolean;
  requester: Person;
  requestedAt: string;
  approver: Person;
  approvedAt: string | null;
  executor: Person;
  executedAt: string | null;
  executionCommandId: string | null;
  cancelledBy: Person;
  cancelledAt: string | null;
};

export type TimelineEntry = {
  id: string;
  occurredAt: string;
  movementType: string;
  bucket: string;
  qtyDelta: number;
  referenceType: string;
  referenceId: string;
  reference: string | null;
  reason: string | null;
  actor: Person;
};

export type CaseBatch = {
  batchId: string;
  batchNo: string | null;
  expiryDate: string | null;
  productId: string;
  productName: string | null;
  sku: string | null;
  reason:
    | "shortfall"
    | "counted_after_sale"
    | "batch_under_review"
    | "sale_pending"
    | "entry_reviewed";
  soldQuantity: number;
  availableQuantityAtSync: number;
  shortfallQuantity: number;
  pending: {
    thisCase: number;
    otherOpenCases: Array<{ caseId: string; invoiceNo: string; soldQuantity: number; openedAt: string }>;
    total: number;
  };
  stock: { onHand: number; quarantined: number; reserved: number; available: number };
  blocked: boolean;
  heldByThisCase: boolean;
  /** The latest rows only when true; the digest is then null. */
  timelineTruncated: boolean;
  timelineDigest: string | null;
  timeline: TimelineEntry[];
  stocktakes: Array<{
    stocktakeId: string;
    stocktakeNumber: string;
    status: string;
    lineId: string;
    systemQty: number;
    countedQty: number | null;
    varianceQty: number | null;
    countedAt: string | null;
    postedAt: string | null;
    countedBy: Person;
    settlesThisSale: boolean;
  }>;
  reservations: Array<{ qty: number; sourceType: string; sourceId: string; createdAt: string }>;
  movementCandidates: Array<{ ledgerEntryId: string; occurredAt: string; qty: number; remaining: number; reason: string | null }>;
};

export type StockCaseDetail = {
  id: string;
  status: "open" | "resolved";
  openedAt: string;
  resolvedAt: string | null;
  snapshot: { id: string; version: number; generatedAt: string | null };
  offline: {
    commandId: string;
    counter: string | null;
    sequence: number | null;
    occurredAt: string;
    signIn: { signInId: string; staff: Person; authenticatedAt: string } | null;
    syncedAt: string;
    uploadedBy: Person;
  };
  sale: {
    id: string;
    invoiceNo: string;
    status: string;
    stockPosting: "posted" | "pending_reconciliation";
    soldAt: string;
    soldBy: Person;
    subtotal: string;
    taxTotal: string;
    grandTotal: string;
    amountPaid: string;
    changeDue: string;
    items: Array<{ productId: string; productName: string; batchId: string; batchNo: string; qty: number; unitPrice: string; lineTotal: string }>;
    payments: Array<{ method: string; amount: string; reference: string | null }>;
  };
  batches: CaseBatch[];
  plans: StockCasePlan[];
  settlements: Array<{
    batchId: string;
    method: "posted" | "counted" | "linked";
    soldQuantity: number;
    onHandBefore: number;
    pendingOnBatch: number;
    countedQuantity: number | null;
    countedAt: string | null;
    countedBy: Person;
    correctionQuantity: number;
    postedQuantity: number;
    linkedStocktakeId: string | null;
    linkedMovements: Array<{ ledgerEntryId: string; quantity: number }>;
  }>;
};
