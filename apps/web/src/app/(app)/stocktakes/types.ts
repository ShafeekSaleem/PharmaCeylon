export type StocktakeStatus =
  | "draft"
  | "scheduled"
  | "counting"
  | "submitted"
  | "under_review"
  | "approved"
  | "posted"
  | "completed"
  | "cancelled";

export type StocktakeStatusFilter = "all" | StocktakeStatus | "active" | "attention";

export type StocktakeScope =
  | "full"
  | "cycle"
  | "near_expiry"
  | "quarantined"
  | "zero_stock"
  | "custom";

export type StocktakeMovementMode = "continue_and_reconcile" | "freeze_transactions";

export type StocktakeLineFilter =
  | "all"
  | "pending"
  | "counted"
  | "variance"
  | "recount"
  | "quarantined"
  | "near_expiry";

export type StocktakeCountStatus =
  | "pending"
  | "counted"
  | "submitted"
  | "recount_requested"
  | "recounted"
  | "reviewed"
  | "approved"
  | "posted";

export type StocktakeCondition =
  | "saleable"
  | "damaged"
  | "expired"
  | "quarantined"
  | "opened_pack"
  | "missing_label"
  | "temperature_affected";

export type StocktakeVarianceReason =
  | "unrecorded_sale"
  | "unrecorded_receipt"
  | "damaged_stock"
  | "expired_stock"
  | "supplier_shortage"
  | "wrong_batch_used"
  | "unit_conversion_error"
  | "transfer_not_recorded"
  | "return_not_recorded"
  | "counting_error"
  | "suspected_theft_loss"
  | "other";

export type StocktakeUserRef = {
  id: string;
  fullName: string;
};

export type StocktakeCountEntry = {
  id: string;
  countedQty: number;
  condition: StocktakeCondition;
  note: string | null;
  isRecount: boolean;
  countedAt: string;
  counter: StocktakeUserRef;
};

export type StocktakeMovementRef = {
  id: string;
  movementType: string;
  referenceType: string;
  referenceId: string;
  qtyDelta: number;
  reason: string | null;
  occurredAt: string;
};

export type StocktakeLine = {
  id: string;
  productId: string;
  batchId: string;
  systemQty: number | null;
  snapshotQty: number | null;
  countedQty: number | null;
  varianceQty: number | null;
  adjustedVariance: number | null;
  movementDeltaSinceSnapshot: number | null;
  expectedAtReview: number | null;
  countStatus: StocktakeCountStatus;
  condition: StocktakeCondition;
  note: string | null;
  reviewReason: StocktakeVarianceReason | null;
  reviewResolution: string | null;
  reviewNote: string | null;
  countedAt: string | null;
  reviewedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  product: { id: string; sku: string; name: string };
  batch: {
    id: string;
    batchNo: string;
    expiryDate: string;
    isQuarantined: boolean;
    costPrice: number;
  };
  movementRefs: StocktakeMovementRef[];
  countEntries: StocktakeCountEntry[];
};

export type StocktakePosting = {
  id: string;
  postedBy: string;
  postedAt: string;
  note: string | null;
  lines: Array<{
    id: string;
    lineId: string;
    qtyDelta: number;
    movementType: string;
    ledgerReferenceId: string;
    reason: string | null;
  }>;
};

export type StocktakeListItem = {
  id: string;
  stocktakeNumber: string;
  status: StocktakeStatus;
  scope: StocktakeScope;
  movementMode: StocktakeMovementMode;
  blindCount: boolean;
  frozenAt: string | null;
  snapshotAt: string | null;
  scheduledFor: string | null;
  expectedCompletionAt: string | null;
  nearExpiryDays: number | null;
  title: string | null;
  areaLabel: string | null;
  notes: string | null;
  countedBy: string;
  reviewerId: string | null;
  approvedBy: string | null;
  postedBy: string | null;
  completedBy: string | null;
  startedAt: string | null;
  submittedAt: string | null;
  reviewStartedAt: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  counter: StocktakeUserRef;
  reviewer: StocktakeUserRef | null;
  approver: StocktakeUserRef | null;
  poster: StocktakeUserRef | null;
  completer: StocktakeUserRef | null;
  assignments: Array<{
    id: string;
    areaLabel: string | null;
    user: StocktakeUserRef;
  }>;
  lines: StocktakeLine[];
  postings: StocktakePosting[];
  activity?: Array<{
    id: string;
    eventName: string;
    createdAt: string;
    actor: StocktakeUserRef | null;
    payload: unknown;
  }>;
  lineCount: number;
  countedLineCount: number;
  uncountedLineCount: number;
  progressPct: number;
  totalSnapshotQty: number | null;
  totalCountedQty: number;
  varianceLineCount: number | null;
  varianceUnitsIn: number | null;
  varianceUnitsOut: number | null;
  varianceUnitsNet: number | null;
  varianceValueApprox: number | null;
  permissions: {
    canWrite: boolean;
    canReview: boolean;
    canApprove: boolean;
    canPost: boolean;
    canViewExpected: boolean;
  };
};

export type CreateStocktakePayload = {
  title?: string | null;
  areaLabel?: string | null;
  notes?: string | null;
  seedLines?: boolean;
  scope?: StocktakeScope;
  blindCount?: boolean;
  movementMode?: StocktakeMovementMode;
  scheduledFor?: string | null;
  expectedCompletionAt?: string | null;
  reviewerId?: string | null;
  counterIds?: string[];
  nearExpiryDays?: number;
  batchIds?: string[];
};

export type UpdateStocktakePayload = {
  title?: string | null;
  areaLabel?: string | null;
  notes?: string | null;
  scheduledFor?: string | null;
  expectedCompletionAt?: string | null;
  reviewerId?: string | null;
  counterIds?: string[];
};

export const PAGE_SIZE = 10;

export const WRITE_ROLES = new Set(["owner", "manager", "inventory_clerk"]);
export const REVIEW_ROLES = new Set(["owner", "manager"]);
