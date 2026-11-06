import { z } from "zod";

/**
 * The whole renderer ↔ main surface. Every channel is declared here with a
 * validator for what goes in and what comes back; the preload bridge and the
 * main-process handlers are both generated from this one table, so there is no
 * channel the renderer can reach that is not listed and validated.
 */

export const checkStatusSchema = z.enum(["ok", "warning", "failed", "not_ready"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const readinessCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  detail: z.string(),
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

/** This counter's installed offline authority, for the This counter page (P3 #49). */
export const offlineBackupSchema = z.object({
  /** The grant's expiry and the saved stock's time, ISO; null when nothing is installed. */
  grantExpiresAt: z.string().nullable(),
  snapshotGeneratedAt: z.string().nullable(),
  /** People the installed grant lets sign in offline. */
  authorizedStaff: z.number().int().min(0),
  /** True while the saved stock is young enough for an outage to start on it. */
  usable: z.boolean(),
  /** Consecutive failed renewals, and what the last one needs, in plain words. */
  failures: z.number().int().min(0),
  failure: z.string().nullable(),
});
export type OfflineBackup = z.infer<typeof offlineBackupSchema>;

export const readinessReportSchema = z.object({
  ready: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(readinessCheckSchema),
  offlineBackup: offlineBackupSchema.nullable().optional(),
});
export type ReadinessReport = z.infer<typeof readinessReportSchema>;

export const appInfoSchema = z.object({
  appVersion: z.string(),
  electronVersion: z.string(),
  schemaVersion: z.number().int(),
  packaged: z.boolean(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

/**
 * Deliberately not "online": the spec reserves that word for a reachable API
 * *and* a successful push/pull cycle, and there is no sync engine yet.
 */
export const apiReachabilitySchema = z.object({
  reachable: z.boolean(),
  checkedAt: z.string(),
  latencyMs: z.number().nullable(),
});
export type ApiReachability = z.infer<typeof apiReachabilitySchema>;

export const printerSchema = z.object({
  name: z.string(),
  displayName: z.string(),
});
export type Printer = z.infer<typeof printerSchema>;

export const printResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
});
export type PrintResult = z.infer<typeof printResultSchema>;

const uuid = z.string().uuid();

export const branchSchema = z.object({ id: uuid, code: z.string(), name: z.string() });
export type Branch = z.infer<typeof branchSchema>;

export const counterSchema = z.object({
  registerId: uuid,
  tillId: uuid,
  label: z.string(),
  isActive: z.boolean(),
  terminal: z
    .object({
      terminalId: uuid,
      label: z.string(),
      enrollmentId: uuid.nullable(),
      enrolledAt: z.number().nullable(),
    })
    .nullable(),
});
export type Counter = z.infer<typeof counterSchema>;

/** What the renderer may know about this counter. Never keys, tokens, proofs or signatures. */
export const deviceStateSchema = z.object({
  serverUrl: z.string().nullable(),
  serverUrlEditable: z.boolean(),
  enrollment: z
    .object({
      status: z.enum(["pending", "active", "revoked", "retired"]),
      branchName: z.string(),
      /** Branch short code from tenant context when enrolled; empty string when unknown (older enrollments). */
      branchCode: z.string(),
      /** Register and till tied to this enrollment (UUIDs from the server). */
      registerId: uuid,
      tillId: uuid,
      counterLabel: z.string(),
      label: z.string(),
      terminalId: uuid,
      enrollmentId: uuid,
      enrolledAt: z.string().nullable(),
      enrolledByUserId: uuid,
      /** Enroller display name when stored or backfilled; null when unknown. */
      enrolledByName: z.string().nullable(),
    })
    .nullable(),
  operator: z.object({ userId: uuid, fullName: z.string(), email: z.string() }).nullable(),
  staffSession: z
    .object({ workSessionId: uuid, staffUserId: uuid, staffName: z.string(), openedAt: z.string() })
    .nullable(),
  /** The signed-in person's PIN on this counter; null when nobody is signed in. */
  pin: z.object({ set: z.boolean(), prepared: z.boolean(), lockedUntil: z.string().nullable() }).nullable(),
  locked: z.boolean(),
  /**
   * The people this counter can sign in with a PIN (D-W5): everyone prepared here, the signed-in
   * person included. `role` is their branch role when they prepared; `lockedUntil` is set while
   * wrong PINs have locked them out (null with `locked` when the server's lock time isn't known).
   * `pin_off` is the server switching their PIN off after repeated locks: it has no end, and works
   * again once they sign in with their password.
   */
  counterStaff: z.array(
    z.object({
      staffUserId: uuid,
      staffName: z.string(),
      role: z.string().nullable(),
      state: z.enum(["signed_in", "ready", "locked", "pin_off"]),
      lockedUntil: z.string().nullable(),
    }),
  ),
  branches: z.array(branchSchema),
  windowsSession: z.object({ protocol: z.enum(["console", "rdp", "unknown"]), remoteSession: z.boolean() }),
});
export type DeviceState = z.infer<typeof deviceStateSchema>;

export const offlineCounterSchema = z.object({
  thisCounterNominated: z.boolean(),
  otherCounterNominated: z.boolean(),
  nominationVersion: z.number().int().min(0),
  authorization: z
    .object({
      authorizationId: uuid,
      expectedNominationVersion: z.number().int().min(0),
      reason: z.string(),
      authorizedAt: z.string(),
    })
    .nullable(),
});
export type OfflineCounterView = z.infer<typeof offlineCounterSchema>;

export const catalogProductSchema = z.object({
  productId: uuid,
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  strength: z.string().nullable(),
  unit: z.string().nullable(),
  unitPrice: z.string(),
  available: z.number().int(),
  needsPharmacist: z.boolean(),
  requiresPrescription: z.boolean(),
  isControlled: z.boolean(),
});
export type CatalogProduct = z.infer<typeof catalogProductSchema>;

export const catalogSchema = z.object({
  products: z.array(catalogProductSchema),
  vatRatePercent: z.number().min(0).max(100),
  /** The line discount anyone selling may give (`posMaxDiscountPercent`); above it a manager
   *  approves. Shown only: the server reads the setting again at checkout. */
  maxDiscountPercent: z.number().min(0).max(100),
});
export type CatalogView = z.infer<typeof catalogSchema>;

export const customerSchema = z.object({
  customerId: uuid,
  fullName: z.string(),
  phone: z.string().nullable(),
});
export type CustomerView = z.infer<typeof customerSchema>;

export const prescriptionSchema = z.object({
  prescriptionId: uuid,
  rxNumber: z.string(),
  patientName: z.string(),
  doctorName: z.string(),
  issuedOn: z.string(),
  validUntil: z.string().nullable(),
  expired: z.boolean(),
  customerId: uuid.nullable(),
  customerName: z.string().nullable(),
});
export type PrescriptionView = z.infer<typeof prescriptionSchema>;

export const approverSchema = z.object({
  userId: uuid,
  fullName: z.string(),
  hasPin: z.boolean(),
});
export type ApproverView = z.infer<typeof approverSchema>;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const recordPrescriptionSchema = z.object({
  patientName: z.string().trim().min(2).max(160),
  doctorName: z.string().trim().min(2).max(160),
  doctorRegNo: z.string().trim().max(64).optional(),
  issuedOn: isoDate,
  validUntil: isoDate.optional(),
  customerId: uuid.optional(),
  notes: z.string().trim().max(512).optional(),
});
/** A co-sign on someone else's session: a pharmacist's for controlled items, or (P2b) a manager's
 * for a discount over the limit. Their till PIN, or login password if they have none. Sent with
 * one checkout and never stored on this computer. */
export const coSignSchema = z.object({
  approverUserId: uuid,
  pin: z.string().min(4).max(128),
});
export type CoSign = z.infer<typeof coSignSchema>;

/** Recording a prescription: by the person signed in, if they hold an SLMC registration, or with a
 * registered pharmacist's co-sign (their PIN, sent once to the server and never stored here). */
export const recordPrescriptionWithCoSignSchema = recordPrescriptionSchema.extend({
  coSign: coSignSchema.optional(),
});
export type RecordPrescription = z.infer<typeof recordPrescriptionWithCoSignSchema>;

export const dispensingSchema = z.object({
  customerId: uuid.optional(),
  prescriptionId: uuid.optional(),
});
export type Dispensing = z.infer<typeof dispensingSchema>;

const money = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);
export const tenderSchema = z.object({
  cashAmount: money.optional(),
  cardAmount: money.optional(),
  cardReference: z.string().trim().max(128).optional(),
});
export type Tender = z.infer<typeof tenderSchema>;

/** A line on the counter: the product, how many, and the discount off the line in cents. */
export const saleLineSchema = z.object({
  productId: uuid,
  qty: z.number().int().min(1).max(9999),
  discountMinor: z.number().int().min(0).max(99_999_999_999).optional(),
});
export type SaleLine = z.infer<typeof saleLineSchema>;

export const completedSaleSchema = z.object({
  saleId: uuid,
  invoiceNo: z.string(),
  soldAt: z.string(),
  subtotal: z.string(),
  taxTotal: z.string(),
  discountTotal: z.string(),
  grandTotal: z.string(),
  amountPaid: z.string(),
  changeDue: z.string(),
  sellerName: z.string(),
  /** Who approved a discount over the limit, when one did. */
  discountApproverName: z.string().nullable(),
  lines: z.array(
    z.object({ name: z.string(), qty: z.number().int(), unitPrice: z.string(), discountAmount: z.string(), lineTotal: z.string() }),
  ),
  payments: z.array(z.object({ method: z.string(), amount: z.string(), reference: z.string().nullable() })),
});
export type CompletedSale = z.infer<typeof completedSaleSchema>;

export const checkoutDraftSchema = z.object({
  draftId: uuid,
  staffUserId: uuid,
  estimatedTotal: z.string(),
  createdAt: z.string(),
  lineCount: z.number().int(),
  /** Who co-signed controlled items, so confirming can ask the same pharmacist again. */
  coSignerId: uuid.nullable(),
  /** Who co-signed a discount over the limit, so confirming can ask the same manager again. */
  discountCoSignerId: uuid.nullable(),
  /** Who rang it up. Anyone signed in here can confirm it; it stays this person's sale. */
  staffName: z.string().nullable(),
  /** Whether the person signed in now rang it up: they resend it, anyone else only looks it up. */
  ownSale: z.boolean(),
});
export type CheckoutDraftView = z.infer<typeof checkoutDraftSchema>;

export const refundAtCounterSchema = z.object({
  refundRequestId: uuid,
  requestNumber: z.string(),
  invoiceNo: z.string().nullable(),
  amount: z.string(),
  refundMethod: z.string().nullable(),
  reason: z.string(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvalEvidenceId: uuid.nullable(),
});
export type RefundAtCounter = z.infer<typeof refundAtCounterSchema>;

export const counterWorkKinds = [
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
] as const;
export type CounterWorkKind = (typeof counterWorkKinds)[number];

const counterWorkPersonSchema = z.object({ name: z.string().nullable(), at: z.string().nullable() });

/** Web-approved work waiting at this branch's counter (`GET /counter-work`), with its approval state. */
export const counterWorkItemSchema = z.object({
  kind: z.enum(counterWorkKinds),
  id: uuid,
  reference: z.string(),
  subject: z.string().nullable(),
  lineCount: z.number().int(),
  amount: z.string().nullable(),
  readyAt: z.string(),
  requested: counterWorkPersonSchema.nullable(),
  approved: counterWorkPersonSchema.nullable(),
  dispatched: counterWorkPersonSchema.nullable(),
  approval: z.object({
    evidenceId: uuid.nullable(),
    approvedVersion: z.number().int().nullable(),
    currentVersion: z.number().int().nullable(),
    state: z.enum(["matches", "changed", "revoked", "not_needed"]),
    changes: z.array(z.string()),
  }),
});
export type CounterWorkItem = z.infer<typeof counterWorkItemSchema>;

/** P5 #51: an approved plan for an offline stock case, waiting here, with the batches to count. */
export const stockCaseAtCounterSchema = z.object({
  resolutionId: uuid,
  caseId: uuid,
  invoiceNo: z.string(),
  soldAt: z.string(),
  kind: z.enum(["post_now", "count_and_correct", "link_existing_settlement"]),
  note: z.string().nullable(),
  approvalEvidenceId: uuid.nullable(),
  approvalState: z.enum(["matches", "changed", "revoked"]),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  lines: z.array(
    z.object({
      batchId: uuid,
      productName: z.string(),
      batchNo: z.string(),
      expiryDate: z.string().nullable(),
      soldQuantity: z.number().int(),
    }),
  ),
});
export type StockCaseAtCounter = z.infer<typeof stockCaseAtCounterSchema>;

export const stockCaseResolvedSchema = z.object({
  invoiceNo: z.string(),
  kind: z.enum(["post_now", "count_and_correct", "link_existing_settlement"]),
  alreadyApplied: z.boolean(),
  batches: z.array(
    z.object({
      batchId: uuid,
      method: z.enum(["posted", "counted", "linked"]),
      countedQty: z.number().int().nullable(),
      correctionQty: z.number().int(),
      postedQty: z.number().int(),
      stillBlocked: z.boolean(),
    }),
  ),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
});
export type StockCaseResolved = z.infer<typeof stockCaseResolvedSchema>;

export const refundExecutedSchema = z.object({
  requestNumber: z.string(),
  amountMinor: z.number().int(),
  refundedTo: z.array(z.object({ method: z.string(), amountMinor: z.number().int() })),
  alreadyApplied: z.boolean(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
});
export type RefundExecuted = z.infer<typeof refundExecutedSchema>;

/** Why something came back: the server's `REFUND_REASONS`, in its order. */
export const refundReasonSchema = z.enum([
  "wrong_item",
  "changed_mind",
  "damaged",
  "expired",
  "adverse_reaction",
  "other",
]);
export type RefundReason = z.infer<typeof refundReasonSchema>;

export const paymentMethodSchema = z.enum(["cash", "card", "mobile_wallet", "credit"]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** One line of a sale on the Returns page, with what earlier refunds have left of it. */
export const returnLineSchema = z.object({
  productId: uuid,
  batchId: uuid,
  name: z.string(),
  sku: z.string(),
  batchNo: z.string(),
  expiryDate: z.string().nullable(),
  unit: z.string().nullable(),
  soldQty: z.number().int(),
  remainingQty: z.number().int(),
  /** What the customer paid for the whole line; a partial refund is this × qty ÷ sold. */
  paidTotal: z.string(),
  isControlled: z.boolean(),
  requiresPrescription: z.boolean(),
});
export type ReturnLine = z.infer<typeof returnLineSchema>;

export const returnSaleSchema = z.object({
  saleId: uuid,
  invoiceNo: z.string(),
  status: z.string(),
  soldAt: z.string(),
  grandTotal: z.string(),
  sellerName: z.string().nullable(),
  customer: z.object({ fullName: z.string(), phone: z.string().nullable() }).nullable(),
  /** How the customer paid: refund rows (negative) don't count. */
  payments: z.array(z.object({ method: z.string(), amount: z.string(), reference: z.string().nullable() })),
  /** A prescription or controlled item: refunding needs someone who can approve controlled sales. */
  needsPharmacist: z.boolean(),
  /** The tenant's refund limit; at or over it, the refund needs approval. Null: no limit. */
  refundLimit: z.string().nullable(),
  earlierRefunds: z.array(z.object({ returnNumber: z.string(), amount: z.string(), createdAt: z.string() })),
  lines: z.array(returnLineSchema),
});
export type ReturnSale = z.infer<typeof returnSaleSchema>;

/** A row of the sales history, for finding a sale without the receipt. */
export const saleFoundSchema = z.object({
  saleId: uuid,
  invoiceNo: z.string(),
  status: z.string(),
  soldAt: z.string(),
  grandTotal: z.string(),
  itemCount: z.number().int(),
  customerName: z.string().nullable(),
  customerPhone: z.string().nullable(),
  sellerName: z.string().nullable(),
  paymentMethods: z.array(z.string()),
  summary: z.string(),
});
export type SaleFound = z.infer<typeof saleFoundSchema>;

export const refundTodaySchema = z.object({
  returnNumber: z.string(),
  invoiceNo: z.string().nullable(),
  amount: z.string(),
  createdAt: z.string(),
  reasonCode: z.string().nullable(),
  refundedTo: z.array(z.object({ method: z.string(), amount: z.string() })),
  refundedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  itemCount: z.number().int(),
});
export type RefundToday = z.infer<typeof refundTodaySchema>;

export const returnOutcomeSchema = z.discriminatedUnion("status", [
  /** Refunded here and now: prepared, then executed through the signed command. */
  z.object({ status: z.literal("refunded"), refund: refundExecutedSchema }),
  /** At or over the limit and the person can't approve it: it waits for a manager on the web. */
  z.object({
    status: z.literal("awaiting_approval"),
    refundRequestId: uuid,
    requestNumber: z.string(),
    amount: z.string(),
    /**
     * A manager's co-sign was sent and refused (wrong PIN, no authority, locked out). The request
     * stays prepared: the PIN can be tried again, or the approval left to the web.
     */
    coSignRefusal: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
]);
export type ReturnOutcome = z.infer<typeof returnOutcomeSchema>;

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amountFilter = z.string().regex(/^\d{1,9}(\.\d{1,2})?$/);

export const heldCartSchema = z.object({
  holdId: uuid,
  holdRef: z.string(),
  label: z.string().nullable(),
  itemCount: z.number().int(),
  total: z.string(),
  createdAt: z.string(),
  heldBy: z.string(),
});
export type HeldCart = z.infer<typeof heldCartSchema>;

/** The Stock page (screen=stock). Units are the product's selling unit; nothing here is in packs. */
export const stockStatusSchema = z.enum(["ok", "low", "out"]);
export const stockRowSchema = z.object({
  productId: uuid,
  name: z.string(),
  strength: z.string().nullable(),
  unit: z.string().nullable(),
  manufacturer: z.string().nullable(),
  unitsPerPack: z.number().int(),
  packLabel: z.string().nullable(),
  requiresPrescription: z.boolean(),
  isControlled: z.boolean(),
  reorderLevel: z.number().int(),
  stockStatus: stockStatusSchema,
  available: z.number().int(),
  onHand: z.number().int(),
  quarantined: z.number().int(),
  reserved: z.number().int(),
  batchCount: z.number().int(),
  nearExpiryBatchCount: z.number().int(),
  expiredBatchCount: z.number().int(),
  /** The earliest expiry among in-date batches with stock: YYYY-MM-DD. */
  nextExpiry: z.string().nullable(),
});
export type StockRow = z.infer<typeof stockRowSchema>;

export const stockFilterSchema = z.enum(["all", "low", "prescription", "controlled"]);
export type StockFilter = z.infer<typeof stockFilterSchema>;
/** The Needs attention lists, as `stock-by-product`'s `attention` filter names them. */
export const stockAttentionKindSchema = z.enum(["near_expiry", "expired", "quarantined"]);
export type StockAttentionKind = z.infer<typeof stockAttentionKindSchema>;

export const stockSearchSchema = z.object({
  items: z.array(stockRowSchema),
  total: z.number().int(),
  expiryWarningDays: z.number().int(),
});
export type StockSearch = z.infer<typeof stockSearchSchema>;

export const stockAttentionSchema = z.object({
  expiringBatches: z.number().int(),
  expiredBatches: z.number().int(),
  quarantinedProducts: z.number().int(),
  quarantinedUnits: z.number().int(),
  lowStockProducts: z.number().int(),
  expiryWarningDays: z.number().int(),
});
export type StockAttention = z.infer<typeof stockAttentionSchema>;

export const stockBatchSchema = z.object({
  batchId: uuid,
  batchNo: z.string(),
  expiryDate: isoDate,
  daysToExpiry: z.number().int(),
  expired: z.boolean(),
  nearExpiry: z.boolean(),
  needsExpiryReview: z.boolean(),
  /** Every unit held: checkout skips the batch altogether. */
  isQuarantined: z.boolean(),
  quarantineReason: z.string().nullable(),
  onHand: z.number().int(),
  available: z.number().int(),
  reserved: z.number().int(),
  quarantined: z.number().int(),
  sellingPrice: z.string(),
  /** Null without `costs.view`. */
  costPrice: z.string().nullable(),
});
export type StockBatch = z.infer<typeof stockBatchSchema>;

export const productStockSchema = z.object({
  product: z.object({
    productId: uuid,
    name: z.string(),
    genericName: z.string().nullable(),
    strength: z.string().nullable(),
    manufacturer: z.string().nullable(),
    unit: z.string().nullable(),
    unitsPerPack: z.number().int(),
    packLabel: z.string().nullable(),
    requiresPrescription: z.boolean(),
    isControlled: z.boolean(),
    reorderLevel: z.number().int(),
  }),
  stockStatus: stockStatusSchema,
  totals: z.object({
    onHand: z.number().int(),
    available: z.number().int(),
    quarantined: z.number().int(),
    reserved: z.number().int(),
    expired: z.number().int(),
  }),
  /** In expiry order, oldest first: the order checkout sells them in. */
  batches: z.array(stockBatchSchema),
  reservations: z.array(z.object({ qty: z.number().int(), label: z.string() })),
  /**
   * Every other active branch of the tenant, as a band only: no quantities, costs or batches
   * (decided 2026-11-05). `allowed` is false when the person's role has
   * `inventory.view_other_branches_availability` switched off.
   */
  otherBranches: z.object({
    allowed: z.boolean(),
    branches: z.array(
      z.object({
        branchId: uuid,
        name: z.string(),
        band: z.enum(["in_stock", "low", "out", "ask_pharmacist"]),
      }),
    ),
  }),
  movements: z.array(
    z.object({
      id: uuid,
      occurredAt: z.string(),
      movementType: z.string(),
      batchNo: z.string().nullable(),
      /** Change to on hand; zero for a quarantine move. */
      qtyDelta: z.number().int(),
      /** Units moved into (+) or out of (−) quarantine. */
      quarantineDelta: z.number().int(),
      actorName: z.string().nullable(),
    }),
  ),
  /** At cost; a larger write-off needs a manager. Null: the tenant has no limit. */
  writeOffLimit: z.string().nullable(),
});
export type ProductStock = z.infer<typeof productStockSchema>;

export const stockAdjustmentSchema = z.object({
  productId: uuid,
  batchId: uuid,
  kind: z.enum(["found", "damaged", "expired", "lost", "correction"]),
  /** A correction says which way; the other kinds set it themselves. */
  direction: z.enum(["in", "out"]).optional(),
  qty: z.number().int().min(1).max(99999),
  reason: z.string().trim().max(512).optional(),
  /** A write-off of units already held in quarantine. */
  fromQuarantine: z.boolean(),
});
export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;

export const actionErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ActionError = z.infer<typeof actionErrorSchema>;

/** A drawer count in minor units (cents): the total and the note-and-coin lines it came from. */
export const cashCountSchema = z.object({
  totalMinor: z.number().int().min(0).max(2_000_000_000),
  lines: z
    .array(
      z.object({
        denominationMinor: z.number().int().positive(),
        count: z.number().int().min(0).max(100_000),
      }),
    )
    .max(20),
});
export type CashCount = z.infer<typeof cashCountSchema>;

const minor = z.number().int();
const personSchema = z.object({ id: uuid, fullName: z.string() }).nullable();

/** The server's totals for one shift (API_CONTRACT.md, "Till shifts"). */
export const shiftSummarySchema = z.object({
  openingCashMinor: minor,
  cashTakenMinor: minor,
  changeGivenMinor: minor,
  cashRefundsMinor: minor,
  cashPaidOutMinor: minor,
  cashPaidInMinor: minor,
  expectedCashMinor: minor,
  saleCount: z.number().int(),
  salesTotalMinor: minor,
  firstSaleAt: z.string().nullable(),
  lastSaleAt: z.string().nullable(),
  takingsByMethod: z.array(
    z.object({ method: z.string(), saleCount: z.number().int(), takenMinor: minor, refundedMinor: minor }),
  ),
  takingsByHour: z.array(z.object({ hour: z.string(), saleCount: z.number().int(), totalMinor: minor })),
  refunds: z.array(
    z.object({
      goodsReturnId: uuid,
      returnNumber: z.string(),
      invoiceNo: z.string().nullable(),
      amountMinor: minor,
      paidBack: z.array(z.object({ method: z.string(), amountMinor: minor })),
      items: z.array(z.object({ name: z.string(), qty: z.number().int(), disposition: z.string() })),
      processedBy: personSchema,
      at: z.string(),
    }),
  ),
  cashMovements: z.array(
    z.object({
      id: uuid,
      direction: z.enum(["in", "out"]),
      amountMinor: minor,
      reason: z.string(),
      referenceType: z.string().nullable(),
      at: z.string(),
      recordedBy: personSchema,
    }),
  ),
});
export type ShiftSummary = z.infer<typeof shiftSummarySchema>;

/**
 * This counter's copy of a till shift. `status` is where the shift is on this counter: `opening`
 * and `closing` mean the step is saved here and sent, and `sync` says whether the server has
 * confirmed it. `expectedCashMinor` is the counter's own running figure; `summary` is the
 * server's, from the last time it answered.
 */
export const localShiftSchema = z.object({
  workSessionId: uuid,
  /** `S-0412`, once the server has numbered it; null while an open waits for the server. */
  shiftNumber: z.string().nullable(),
  staffUserId: uuid,
  staffName: z.string(),
  openedAt: z.string(),
  openingCashMinor: minor,
  openingCount: cashCountSchema.shape.lines,
  status: z.enum(["opening", "open", "closing", "closed"]),
  sync: z.enum(["pending", "synced", "failed"]),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  expectedCashMinor: minor,
  closedAt: z.string().nullable(),
  closedByName: z.string().nullable(),
  closingCashCountMinor: minor.nullable(),
  /** The server's expected cash at the close, once it has confirmed it. */
  serverExpectedCashMinor: minor.nullable(),
  varianceMinor: minor.nullable(),
  varianceNote: z.string().nullable(),
  assistanceReason: z.string().nullable(),
  /** An unconfirmed close made for someone else: the manager's PIN is needed to send it again. */
  needsManagerPin: z.boolean(),
  summary: shiftSummarySchema.nullable(),
  summaryAt: z.string().nullable(),
});
export type LocalShift = z.infer<typeof localShiftSchema>;

export const shiftStateSchema = z.object({
  /** The shift open on this till, or being opened or closed. */
  current: localShiftSchema.nullable(),
  lastClosed: localShiftSchema.nullable(),
  /** Every shift step the server hasn't confirmed yet, oldest first. */
  unsynced: z.array(localShiftSchema),
});
export type ShiftState = z.infer<typeof shiftStateSchema>;

/** A shift on this till as the server records it, for Past shifts. */
export const pastShiftSchema = z.object({
  workSessionId: uuid,
  shiftNumber: z.string(),
  staffName: z.string(),
  status: z.enum(["open", "closed"]),
  openedAt: z.string(),
  openingCashMinor: minor,
  closedAt: z.string().nullable(),
  closingCashCountMinor: minor.nullable(),
  expectedCashMinor: minor.nullable(),
  varianceMinor: minor.nullable(),
  varianceNote: z.string().nullable(),
  closedByName: z.string().nullable(),
  closeKind: z.enum(["self", "assisted"]).nullable(),
  assistanceReason: z.string().nullable(),
});
export type PastShift = z.infer<typeof pastShiftSchema>;

/** Actions report refusals as data so the person at the counter sees why, not a generic error. */
function result<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), error: actionErrorSchema }),
  ]);
}
export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: ActionError };

const credentials = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });
const label = z.string().trim().min(1).max(120);
const pin = z.string().regex(/^\d{4,8}$/);

const noInput = z.undefined();

export const ipcContract = {
  getAppInfo: { channel: "pos:app:info", input: noInput, output: appInfoSchema },
  getReadiness: { channel: "pos:readiness:get", input: noInput, output: readinessReportSchema },
  checkApi: { channel: "pos:api:check", input: noInput, output: apiReachabilitySchema },
  listPrinters: { channel: "pos:printers:list", input: noInput, output: z.array(printerSchema) },
  printTestReceipt: {
    channel: "pos:printers:test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: printResultSchema,
  },
  getDeviceState: { channel: "pos:device:state", input: noInput, output: deviceStateSchema },
  setServerUrl: {
    channel: "pos:device:server-url",
    input: z.object({ url: z.string().trim().min(1).max(2048) }),
    output: result(deviceStateSchema),
  },
  signIn: { channel: "pos:auth:sign-in", input: credentials, output: result(deviceStateSchema) },
  signOut: { channel: "pos:auth:sign-out", input: noInput, output: result(deviceStateSchema) },
  refreshEnrollment: { channel: "pos:device:refresh", input: noInput, output: result(deviceStateSchema) },
  listCounters: {
    channel: "pos:enrollment:counters",
    input: z.object({ branchId: uuid }),
    output: result(z.array(counterSchema)),
  },
  createCounter: {
    channel: "pos:enrollment:create-counter",
    input: z.object({ branchId: uuid, label }),
    output: result(counterSchema),
  },
  enrollWithCode: {
    channel: "pos:enrollment:enroll-with-code",
    input: z.object({ branchId: uuid, code: z.string().trim().min(4).max(32), label }),
    output: result(deviceStateSchema),
  },
  catalog: { channel: "pos:checkout:catalog", input: noInput, output: result(catalogSchema) },
  submitCheckout: {
    channel: "pos:checkout:submit",
    input: z.object({
      lines: z.array(saleLineSchema).min(1).max(200),
      tender: tenderSchema,
      dispensing: dispensingSchema.optional(),
      coSign: coSignSchema.optional(),
      /** A manager's co-sign for a discount over the limit (P2b #103). Online only. */
      discountCoSign: coSignSchema.optional(),
    }),
    output: result(completedSaleSchema),
  },
  holdCart: {
    channel: "pos:checkout:hold",
    input: z.object({
      lines: z.array(saleLineSchema).min(1).max(200),
      label: z.string().trim().max(120).optional(),
      dispensing: dispensingSchema.optional(),
    }),
    output: result(z.object({ holdRef: z.string() })),
  },
  listHolds: { channel: "pos:checkout:holds", input: noInput, output: result(z.array(heldCartSchema)) },
  recallHold: {
    channel: "pos:checkout:recall",
    input: z.object({ holdId: uuid }),
    output: result(
      z.object({
        lines: z.array(z.object({ productId: z.string(), qty: z.number().int(), discountMinor: z.number().int().min(0) })),
        customer: customerSchema.nullable(),
        prescription: prescriptionSchema.nullable(),
      }),
    ),
  },
  pendingCheckouts: { channel: "pos:checkout:pending", input: noInput, output: z.array(checkoutDraftSchema) },
  retryCheckout: {
    channel: "pos:checkout:retry",
    input: z.object({ draftId: uuid, coSign: coSignSchema.optional(), discountCoSign: coSignSchema.optional() }),
    output: result(completedSaleSchema),
  },
  searchCustomers: {
    channel: "pos:dispensing:customers",
    input: z.object({ q: z.string().trim().min(1).max(120) }),
    output: result(z.array(customerSchema)),
  },
  searchPrescriptions: {
    channel: "pos:dispensing:prescriptions",
    input: z.object({ q: z.string().trim().max(120).optional(), customerId: uuid.optional() }),
    output: result(z.array(prescriptionSchema)),
  },
  recordPrescription: {
    channel: "pos:dispensing:record-prescription",
    input: recordPrescriptionWithCoSignSchema,
    output: result(prescriptionSchema),
  },
  listApprovers: { channel: "pos:dispensing:approvers", input: noInput, output: result(z.array(approverSchema)) },
  /** People who can approve a discount over the limit at this branch, for the co-sign picker. */
  listDiscountApprovers: {
    channel: "pos:checkout:discount-approvers",
    input: noInput,
    output: result(z.array(approverSchema)),
  },
  printSaleReceipt: {
    channel: "pos:checkout:print",
    input: z.object({ saleId: uuid, printerName: z.string().min(1).max(260) }),
    output: printResultSchema,
  },
  counterWork: { channel: "pos:counter:work", input: noInput, output: result(z.array(counterWorkItemSchema)) },
  refundsReady: { channel: "pos:counter:refunds", input: noInput, output: result(z.array(refundAtCounterSchema)) },
  executeRefund: {
    channel: "pos:counter:execute-refund",
    input: z.object({ refundRequestId: uuid }),
    output: result(refundExecutedSchema),
  },
  stockCasesReady: { channel: "pos:counter:stock-cases", input: noInput, output: result(z.array(stockCaseAtCounterSchema)) },
  resolveStockCase: {
    channel: "pos:counter:resolve-stock-case",
    input: z.object({
      resolutionId: uuid,
      counts: z.array(z.object({ batchId: uuid, countedQty: z.number().int().min(0).max(10_000_000) })).max(200),
    }),
    output: result(stockCaseResolvedSchema),
  },
  pendingCommands: {
    channel: "pos:counter:pending-commands",
    input: noInput,
    output: z.array(
      z.object({ commandId: uuid, operation: z.string(), createdAt: z.string(), staffName: z.string().nullable() }),
    ),
  },
  retryCommand: {
    channel: "pos:counter:retry-command",
    input: z.object({ commandId: uuid }),
    output: result(z.object({ replayed: z.boolean() })),
  },
  /** Returns: the sale on a receipt (barcode or typed invoice number), with what is left to return. */
  returnFindSale: {
    channel: "pos:returns:find-sale",
    input: z.object({ invoiceNo: z.string().trim().min(1).max(64) }),
    output: result(returnSaleSchema),
  },
  /** Returns without the receipt: the branch's sales history by phone, amount, date and who sold it. */
  returnSearchSales: {
    channel: "pos:returns:search-sales",
    input: z.object({
      customerPhone: z.string().trim().max(32).optional(),
      minTotal: amountFilter.optional(),
      maxTotal: amountFilter.optional(),
      from: dateKey.optional(),
      to: dateKey.optional(),
      soldByMe: z.boolean().optional(),
      paymentMethod: paymentMethodSchema.optional(),
    }),
    output: result(z.array(saleFoundSchema)),
  },
  returnsToday: { channel: "pos:returns:today", input: noInput, output: result(z.array(refundTodaySchema)) },
  /** Refund at the counter: prepared, then executed here unless it needs approval on the web. */
  submitReturn: {
    channel: "pos:returns:submit",
    input: z.object({
      saleId: uuid,
      lines: z
        .array(
          z.object({
            productId: uuid,
            batchId: uuid,
            qty: z.number().int().min(1).max(9999),
            disposition: z.enum(["restock", "quarantine"]),
          }),
        )
        .min(1)
        .max(200),
      reasonCode: refundReasonSchema,
      note: z.string().trim().max(500).optional(),
      /** Omitted: back the way the sale was paid. */
      refundMethod: paymentMethodSchema.optional(),
      /** Over the limit: a manager on this counter approves with their own PIN. Never stored. */
      coSign: coSignSchema.optional(),
    }),
    output: result(returnOutcomeSchema),
  },
  /** Who may co-sign a refund over the limit here: people with `returns.approve`, not the one signed in. */
  listRefundApprovers: {
    channel: "pos:returns:approvers",
    input: noInput,
    output: result(z.array(approverSchema)),
  },
  /** A refund already waiting for approval: a manager co-signs it here, and it is refunded at once. */
  approveReturn: {
    channel: "pos:returns:approve",
    input: z.object({ saleId: uuid, refundRequestId: uuid, coSign: coSignSchema }),
    output: result(returnOutcomeSchema),
  },
  confirmTestReceipt: {
    channel: "pos:printers:confirm-test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: result(
      z.object({
        confirmedAt: z.string(),
        /** ISO time from the server when available; otherwise same as confirmedAt. */
        confirmedByAt: z.string(),
        /** Display name of the person who confirmed, when the API returns it. */
        confirmedByName: z.string().nullable(),
      }),
    ),
  },
  offlineCounter: { channel: "pos:offline:status", input: noInput, output: result(offlineCounterSchema) },
  activateOffline: {
    channel: "pos:offline:activate",
    input: z.object({ authorizationId: uuid }),
    output: result(offlineCounterSchema),
  },
  setPin: {
    channel: "pos:staff:set-pin",
    input: z.object({ pin, password: z.string().min(1).max(256) }),
    output: result(deviceStateSchema),
  },
  preparePin: { channel: "pos:staff:prepare-pin", input: z.object({ pin }), output: result(deviceStateSchema) },
  lock: { channel: "pos:staff:lock", input: noInput, output: result(deviceStateSchema) },
  unlock: { channel: "pos:staff:unlock", input: z.object({ pin }), output: result(deviceStateSchema) },
  /** Signs a prepared person in with their PIN, checked by the server; it ends the current session. */
  pinSignIn: {
    channel: "pos:staff:pin-sign-in",
    input: z.object({ staffUserId: uuid, pin }),
    output: result(deviceStateSchema),
  },
  /** This counter's copy of its till shifts. Local only: it answers while locked or offline. */
  getShift: { channel: "pos:shift:get", input: noInput, output: shiftStateSchema },
  /** Asks the server, adopts what it says, and resends a saved close that wasn't confirmed. */
  refreshShift: { channel: "pos:shift:refresh", input: noInput, output: result(shiftStateSchema) },
  openShift: {
    channel: "pos:shift:open",
    input: z.object({ pin, count: cashCountSchema }),
    output: result(shiftStateSchema),
  },
  /** Closes the open shift; someone else's needs `assistance` (their own PIN and why). */
  closeShift: {
    channel: "pos:shift:close",
    input: z.object({
      count: cashCountSchema,
      varianceNote: z.string().trim().max(500).optional(),
      assistance: z.object({ pin, reason: z.string().trim().min(1).max(500) }).optional(),
    }),
    output: result(shiftStateSchema),
  },
  /** Sends an unconfirmed close again; a close made for someone else needs the manager's PIN. */
  retryShiftClose: {
    channel: "pos:shift:retry-close",
    input: z.object({ pin: pin.optional() }),
    output: result(shiftStateSchema),
  },
  /** Shifts on this till, newest first, from the server. */
  listShifts: { channel: "pos:shift:list", input: noInput, output: result(z.array(pastShiftSchema)) },
  shiftDetail: {
    channel: "pos:shift:detail",
    input: z.object({ workSessionId: uuid }),
    output: result(z.object({ shift: pastShiftSchema, summary: shiftSummarySchema })),
  },
  /** Prints a mid-shift summary on the receipt printer; the shift stays open. */
  printXReport: {
    channel: "pos:shift:x-report",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: result(printResultSchema),
  },
  stockSearch: {
    channel: "pos:stock:search",
    input: z.object({
      q: z.string().trim().max(120).optional(),
      filter: stockFilterSchema,
      attention: stockAttentionKindSchema.optional(),
    }),
    output: result(stockSearchSchema),
  },
  stockAttention: { channel: "pos:stock:attention", input: noInput, output: result(stockAttentionSchema) },
  productStock: {
    channel: "pos:stock:product",
    input: z.object({ productId: uuid }),
    output: result(productStockSchema),
  },
  /** A direct adjustment or write-off, through the signed command (#95). */
  adjustStock: {
    channel: "pos:stock:adjust",
    input: stockAdjustmentSchema,
    output: result(z.object({ qty: z.number().int(), movementType: z.enum(["adjustment_in", "adjustment_out"]) })),
  },
  enroll: {
    channel: "pos:enrollment:enroll",
    input: z.object({ branchId: uuid, registerId: uuid, label }),
    output: result(deviceStateSchema),
  },
} as const;

export type IpcContract = typeof ipcContract;
export type IpcMethod = keyof IpcContract;
export type IpcInput<M extends IpcMethod> = z.infer<IpcContract[M]["input"]>;
export type IpcOutput<M extends IpcMethod> = z.infer<IpcContract[M]["output"]>;

/** What the preload script exposes as `window.pos`. */
export type PosBridge = {
  [M in IpcMethod]: undefined extends IpcInput<M>
    ? () => Promise<IpcOutput<M>>
    : (input: IpcInput<M>) => Promise<IpcOutput<M>>;
};
