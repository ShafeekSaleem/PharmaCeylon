import { z } from "zod";

/**
 * The whole renderer ↔ main surface. Every channel is declared here with a
 * validator for what goes in and what comes back; the preload bridge and the
 * main-process handlers are both generated from this one table, so there is no
 * channel the renderer can reach that is not listed and validated.
 */

export const checkStatusSchema = z.enum([
  "ok",
  "warning",
  "failed",
  "not_ready",
]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const readinessCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: checkStatusSchema,
  detail: z.string(),
});
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

/** GET `/terminals/enrollments/:id` offline nomination facts (epoch ms; null when N/A). */
export const enrollmentOfflineBackupSchema = z.object({
  authorizedAt: z.number().nullable(),
  authorizedByUserId: z.string().uuid().nullable(),
  authorizedByFullName: z.string().nullable(),
  activatedAt: z.number().nullable(),
  activatedByUserId: z.string().uuid().nullable(),
  activatedByFullName: z.string().nullable(),
});
export type EnrollmentOfflineBackup = z.infer<
  typeof enrollmentOfflineBackupSchema
>;

export const emptyEnrollmentOfflineBackup: EnrollmentOfflineBackup = {
  authorizedAt: null,
  authorizedByUserId: null,
  authorizedByFullName: null,
  activatedAt: null,
  activatedByUserId: null,
  activatedByFullName: null,
};

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

/**
 * The offline journal's upload and the reconnect drain (P5 #51), for the Sell page and This
 * counter. From the main process's encrypted store; it answers while locked or offline.
 */
export const journalSyncSchema = z.object({
  /** Offline journal entries recorded on this counter, and how many the server has accepted. */
  recorded: z.number().int().min(0),
  accepted: z.number().int().min(0),
  waiting: z.number().int().min(0),
  /** Refused for good: they need review before anything after them can be accepted. */
  refused: z.number().int().min(0),
  syncing: z.boolean(),
  /** When the server last confirmed every entry recorded here, ISO. */
  lastSuccessAt: z.string().nullable(),
  /** What stops the journal from being confirmed, in plain words. */
  issue: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** New sales wait while this is set: the counter is finishing its synchronisation. */
  pause: z
    .object({
      reason: z.enum(["draining", "unsynced"]),
      waiting: z.number().int().min(0),
      /** When the outage being synchronised began, ISO. */
      outageStartedAt: z.string().nullable(),
      /** Sent from here with no confirmed outcome: the drain finishes once they are confirmed. */
      unconfirmed: z.object({
        sales: z.number().int().min(0),
        actions: z.number().int().min(0),
      }),
      /**
       * Offline records that also hold the drain: card payments not yet settled, notes and card
       * records the server has not received, and ones it refused (those need support).
       */
      holds: z.object({
        cards: z.number().int().min(0),
        records: z.number().int().min(0),
        refused: z.number().int().min(0),
      }),
    })
    .nullable(),
  /** When the last outage's synchronisation finished, ISO. */
  lastDrainAt: z.string().nullable(),
  /**
   * When the installed offline-authority stock snapshot was generated, ISO. Main fills this from the
   * persisted pair (not the in-memory refresh clock). Null when no snapshot is installed.
   */
  lastStockDownloadAt: z.string().nullable(),
  /**
   * Whether this counter is the branch's nominated offline counter (receives stock snapshots).
   * Null until the first server answer; false and null both mean sales-only UI for sync status.
   */
  stockDownloadNominated: z.boolean().nullable(),
});
export type JournalSync = z.infer<typeof journalSyncSchema>;

/**
 * P4 #50: whether this counter sells online, drains an outage, sells offline, or can do neither,
 * and why. Times are ISO. Worked out in main from its own connection checks and trusted clock.
 */
export const offlineModeSchema = z.object({
  mode: z.enum(["online", "draining", "offline", "stopped"]),
  reason: z
    .enum([
      "NOT_ENROLLED",
      "TERMINAL_REVOKED",
      "NO_OFFLINE_AUTHORITY",
      "SNAPSHOT_STALE",
      "GRANT_EXPIRED",
      "CLOCK_UNTRUSTED",
      "RECONCILIATION_REQUIRED",
      "SYNC_PAUSED",
    ])
    .nullable(),
  /** Why there is no trusted time, when `reason` is `CLOCK_UNTRUSTED`. */
  clock: z.enum(["NO_ANCHOR", "NEW_BOOT"]).nullable(),
  connected: z.boolean(),
  outageStartedAt: z.string().nullable(),
  /** When offline selling ends at the latest: the installed grant's expiry. */
  grantExpiresAt: z.string().nullable(),
  snapshotGeneratedAt: z.string().nullable(),
});
export type OfflineModeState = z.infer<typeof offlineModeSchema>;

/**
 * P4 #50, slice 4c: one entry of this counter's offline journal, as the title bar's upload queue
 * lists it. Local only; times are ISO, money in minor units.
 */
export const offlineJournalEntrySchema = z.object({
  /** The journal command ID; for a sale it is the `saleCommandId` that reprints its receipt. */
  commandId: z.string(),
  sequence: z.number().int().min(1),
  kind: z.enum(["sale", "shift_open", "shift_close"]),
  at: z.string().nullable(),
  /** The number on the customer's receipt (C1R-…), final. Sales only. */
  receiptNumber: z.string().nullable(),
  totalMinor: z.number().int().nullable(),
  /**
   * `waiting`: behind a refused entry, which a manager settles on the web before anything after
   * it can be accepted. `sending` while connected, `queued` while not.
   */
  status: z.enum(["queued", "sending", "accepted", "refused", "waiting"]),
  /** Accepted, and its stock waits on a manager's review. Never why (Q3). */
  stockReview: z.boolean(),
  /** A refused entry a manager settled without recording it. */
  notHonoured: z.boolean(),
  /** Why the server refused it, as its error code, while `refused`. */
  refusalCode: z.string().nullable(),
  /** Its receipt is kept on this counter, so it can be reprinted. */
  printable: z.boolean(),
});
export type OfflineJournalEntry = z.infer<typeof offlineJournalEntrySchema>;
export const offlineJournalQueueSchema = z.object({
  /** Newest first: everything not yet accepted, and the rest of the latest outage. */
  entries: z.array(offlineJournalEntrySchema),
  /** More entries exist than are listed. */
  more: z.boolean(),
});
export type OfflineJournalQueue = z.infer<typeof offlineJournalQueueSchema>;

/** P4 #50: who is signed in offline, and who may sign in. Times are ISO. */
export const offlineStaffSchema = z.object({
  signedIn: z
    .object({
      staffUserId: z.string(),
      staffName: z.string(),
      signedInAt: z.string(),
      workSessionId: z.string(),
    })
    .nullable(),
  people: z.array(
    z.object({
      staffUserId: z.string(),
      staffName: z.string(),
      /** May close someone else's shift for them (a prepared manager). */
      canAssistClose: z.boolean(),
      /** May acknowledge trading outside routine hours (D8, a prepared manager). */
      canAcknowledgeHours: z.boolean(),
      lockRemainingMs: z.number().int().min(0),
    }),
  ),
  /** D8: the counter against its selling hours; null when it can't be told (no trusted time). */
  hours: z
    .discriminatedUnion("status", [
      z.object({ status: z.literal("open") }),
      z.object({
        status: z.literal("acknowledged"),
        until: z.string(),
        managerName: z.string(),
      }),
      z.object({ status: z.literal("needs_acknowledgement") }),
      z.object({ status: z.literal("closed") }),
    ])
    .nullable(),
});
export type OfflineStaff = z.infer<typeof offlineStaffSchema>;

/** P4 #50: offline selling. Money is in minor units (cents), as signed in the journal. */
const offlineBlockReason = z.enum([
  "NOT_SOLD_OFFLINE",
  "STOCK_REVIEW",
  "EXPIRED",
  "NOT_ENOUGH_STOCK",
]);
const offlineSaleItemSchema = z.object({
  snapshotLineId: z.string().min(1),
  quantity: z.number().int().min(1).max(100_000),
});
const offlineQuoteLineSchema = z.object({
  snapshotLineId: z.string(),
  productId: z.string(),
  batchId: z.string(),
  quantity: z.number().int(),
  unitPriceMinor: z.number().int(),
  taxMinor: z.number().int(),
  lineTotalMinor: z.number().int(),
  display: z
    .object({
      name: z.string(),
      strength: z.string().nullable(),
      barcode: z.string().nullable(),
      batchNo: z.string(),
    })
    .nullable(),
});
export const offlineStockLineSchema = z.object({
  snapshotLineId: z.string(),
  productId: z.string(),
  batchId: z.string(),
  remaining: z.number().int(),
  unitPriceMinor: z.number().int(),
  sellBefore: z.number().int(),
  blocked: offlineBlockReason.nullable(),
  display: offlineQuoteLineSchema.shape.display,
});
export const offlineQuoteSchema = z.object({
  lines: z.array(offlineQuoteLineSchema),
  blocked: z.array(
    z.object({
      snapshotLineId: z.string(),
      quantity: z.number().int(),
      reason: offlineBlockReason,
      remaining: z.number().int().nullable(),
    }),
  ),
  subtotalMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  digest: z.string(),
});
export const offlineReceiptSchema = z.object({
  receiptNumber: z.string(),
  saleCommandId: z.string(),
  checkoutDraftId: z.string(),
  soldAt: z.number().int(),
  sellerName: z.string(),
  lines: z.array(offlineQuoteLineSchema),
  subtotalMinor: z.number().int(),
  taxMinor: z.number().int(),
  totalMinor: z.number().int(),
  payments: z.array(
    z.discriminatedUnion("method", [
      z.object({
        method: z.literal("cash"),
        amountMinor: z.number().int(),
        tenderedMinor: z.number().int(),
        changeMinor: z.number().int(),
      }),
      z.object({
        method: z.literal("external_card"),
        amountMinor: z.number().int(),
        providerReference: z.string(),
        approvalCode: z.string(),
        approvedAt: z.number().int(),
      }),
    ]),
  ),
  changeMinor: z.number().int(),
});
export type OfflineReceiptView = z.infer<typeof offlineReceiptSchema>;

/** An offline sale recorded on this counter, as the "note a problem" sheet lists it. */
export const offlineSaleSchema = z.object({
  saleCommandId: z.string().uuid(),
  at: z.string(),
  /** Two-decimal rupees, as saved with the sale. */
  total: z.string(),
  itemCount: z.number().int().min(0),
  paidByCard: z.boolean(),
  /** The card machine's reference and approval code on each card payment of this sale. */
  cardPayments: z.array(
    z.object({ reference: z.string(), approvalCode: z.string() }),
  ),
  /** Notes already saved against this sale. */
  noteCount: z.number().int().min(0),
});
export type OfflineSaleView = z.infer<typeof offlineSaleSchema>;

export const saleIncidentCategorySchema = z.enum([
  "quantity_error",
  "payment_uncertain",
  "customer_dispute",
  "other",
]);

/** Longest note the counter will save; the main process enforces the same limit. */
export const MAX_SALE_NOTE_LENGTH = 1000;

/** An external-card payment started at this counter while offline, and where it stands. */
export const cardAttemptSchema = z.object({
  attemptId: z.string().uuid(),
  checkoutDraftId: z.string().uuid(),
  amount: z.string(),
  startedAt: z.string(),
  state: z.enum([
    "prepared",
    "uncertain",
    "approved",
    "declined",
    "linked_to_sale",
    "not_used",
  ]),
  /** True once it was declined or tied to the sale it paid for. */
  settled: z.boolean(),
  /** From the card machine's slip, once someone has recorded it. */
  providerReference: z.string().nullable(),
  approvalCode: z.string().nullable(),
});
export type CardAttemptView = z.infer<typeof cardAttemptSchema>;

const cardReference = z.string().min(1).max(64);

/**
 * An approved card payment no sale will use (review of #208): reversed on the card machine (with
 * that slip's reference) or owed back to the customer. Ends the payment here; a manager reviews it.
 */
export const cardNotUsedOutcomeSchema = z.object({
  kind: z.literal("not_used"),
  settlement: z.enum(["reversed_on_machine", "refund_owed"]),
  reversalReference: z.string().trim().min(1).max(64).nullable(),
  reason: z.string().trim().min(1).max(500),
});
export type CardNotUsedOutcome = z.infer<typeof cardNotUsedOutcomeSchema>;

/** What the person at the counter saw or knows about a card payment. */
export const cardOutcomeSchema = z.discriminatedUnion("kind", [
  cardNotUsedOutcomeSchema,
  z.object({ kind: z.literal("not_sure") }),
  z.object({
    kind: z.literal("approved"),
    reference: cardReference,
    approvalCode: z.string().min(1).max(32),
    /** When the card machine approved it, as read from the slip (ISO). */
    approvedAt: z.string().datetime(),
  }),
  z.object({ kind: z.literal("declined"), reference: cardReference }),
  /** Checked the card machine: this payment never reached it, so there is no reference to copy. */
  z.object({ kind: z.literal("never_charged") }),
  z.object({
    kind: z.literal("paid_sale"),
    reference: cardReference,
    saleCommandId: z.string().uuid(),
  }),
]);
export type CardOutcomeInput = z.infer<typeof cardOutcomeSchema>;

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

export const branchSchema = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
});
export type Branch = z.infer<typeof branchSchema>;

export const counterSchema = z.object({
  registerId: uuid,
  tillId: uuid,
  label: z.string(),
  isActive: z.boolean(),
  hasHistory: z.boolean(),
  hasOpenShift: z.boolean(),
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
      branchId: uuid,
      branchName: z.string(),
      /** Branch short code from tenant context when enrolled; empty string when unknown (older enrollments). */
      branchCode: z.string(),
      /** Register and till tied to this enrollment (UUIDs from the server). */
      registerId: uuid,
      tillId: uuid,
      /** Till display name from enrollment status; null falls back to a till id prefix in the UI. */
      counterLabel: z.string().nullable(),
      label: z.string(),
      terminalId: uuid,
      enrollmentId: uuid,
      enrolledAt: z.string().nullable(),
      enrolledByUserId: uuid,
      /** Enroller display name when stored or backfilled; null when unknown. */
      enrolledByName: z.string().nullable(),
      offlineBackup: enrollmentOfflineBackupSchema,
      /** False when till name and offline-backup facts come from the local enrollment-status cache. */
      enrollmentFactsLive: z.boolean(),
      /** When `enrollmentFactsLive` is false, when those facts were last fetched from the server. */
      enrollmentStatusFetchedAt: z.string().nullable(),
    })
    .nullable(),
  operator: z
    .object({
      userId: uuid,
      fullName: z.string(),
      email: z.string(),
      branchRoles: z.array(z.object({ branchId: uuid, role: z.string() })),
    })
    .nullable(),
  staffSession: z
    .object({
      workSessionId: uuid,
      staffUserId: uuid,
      staffName: z.string(),
      openedAt: z.string(),
    })
    .nullable(),
  /** The signed-in person's PIN on this counter; null when nobody is signed in. */
  pin: z
    .object({
      set: z.boolean(),
      prepared: z.boolean(),
      lockedUntil: z.string().nullable(),
    })
    .nullable(),
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
  windowsSession: z.object({
    protocol: z.enum(["console", "rdp", "unknown"]),
    remoteSession: z.boolean(),
  }),
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
export const recordPrescriptionWithCoSignSchema =
  recordPrescriptionSchema.extend({
    coSign: coSignSchema.optional(),
  });
export type RecordPrescription = z.infer<
  typeof recordPrescriptionWithCoSignSchema
>;

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
    z.object({
      name: z.string(),
      qty: z.number().int(),
      unitPrice: z.string(),
      discountAmount: z.string(),
      lineTotal: z.string(),
      /** Filled by checkout for local offline consumption (P4); omitted in older responses. */
      productId: uuid.optional(),
      batchId: uuid.optional(),
    }),
  ),
  payments: z.array(
    z.object({
      method: z.string(),
      amount: z.string(),
      reference: z.string().nullable(),
    }),
  ),
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

const cashPayoutAllocationSchema = z.object({
  invoiceId: uuid,
  amount: z.string(),
});

export const cashPayoutAtCounterSchema = z.object({
  cashPayoutId: uuid,
  payoutNumber: z.string(),
  supplierName: z.string().nullable(),
  purchaseOrderNumber: z.string().nullable(),
  amount: z.string(),
  paidOn: z.string(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  allocations: z.array(cashPayoutAllocationSchema),
  executionApprovalId: uuid.nullable(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
});
export type CashPayoutAtCounter = z.infer<typeof cashPayoutAtCounterSchema>;

export const cashPayoutExecutedSchema = z.object({
  payoutNumber: z.string(),
  amountMinor: z.number().int(),
  supplierPaymentId: uuid,
  supplierPaymentNo: z.string().nullable(),
  executedAt: z.string(),
  alreadyApplied: z.boolean(),
  requestedBy: z.string().nullable(),
  approvedBy: z.string().nullable(),
  movementReason: z.string(),
  supplierName: z.string().nullable(),
  /** Running drawer expected cash on this till after the local posting (when known). */
  expectedCashMinorAfter: z.number().int().nullable(),
});
export type CashPayoutExecuted = z.infer<typeof cashPayoutExecutedSchema>;

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
  "supplier_cash_payout",
] as const;
export type CounterWorkKind = (typeof counterWorkKinds)[number];

const counterWorkPersonSchema = z.object({
  name: z.string().nullable(),
  at: z.string().nullable(),
});

/**
 * The #172 task projection, as far as the counter reads it: stage, next action, blocker and
 * freshness. Other fields pass through untouched. A server from before #172 sends none, and one
 * the counter can't read is dropped rather than failing the whole list.
 */
export const counterWorkTaskSchema = z
  .object({
    contractVersion: z.number().int(),
    stage: z.enum(["ready_for_execution", "blocked_approval"]),
    destinationStatus: z.enum(["available", "planned"]),
    nextAction: z.object({ label: z.string(), executable: z.boolean() }),
    blocker: z.object({ code: z.string(), message: z.string() }).nullable(),
    freshness: z.object({
      asOf: z.string(),
      evidenceAt: z.string().nullable(),
      stale: z.boolean(),
    }),
  })
  .passthrough();
export type CounterWorkTask = z.infer<typeof counterWorkTaskSchema>;

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
  /** Present when the API includes #172 task projection or extended held rows. */
  operation: z.string().optional(),
  task: counterWorkTaskSchema.optional().catch(undefined),
  heldAdjustmentStatus: z
    .enum(["awaiting_approval", "approved", "accepted", "rejected"])
    .optional(),
});
export type CounterWorkItem = z.infer<typeof counterWorkItemSchema>;

/** Full held write-off row (`GET /inventory/held-adjustments` shape) when the counter may read it. */
export const heldWriteOffAtCounterSchema = z.object({
  id: uuid,
  status: z.enum(["awaiting_approval", "approved", "accepted", "rejected"]),
  executionApprovalId: uuid.nullable(),
  kind: z.string(),
  kindLabel: z.string(),
  qty: z.number().int(),
  value: z.string().nullable(),
  note: z.string().nullable(),
  requestReason: z.string().nullable(),
  fromQuarantine: z.boolean(),
  product: z.object({ id: uuid, name: z.string(), sku: z.string().optional() }),
  batch: z.object({
    id: uuid,
    batchNo: z.string(),
    expiryDate: z.string().optional(),
  }),
  requester: z.object({ id: uuid, fullName: z.string() }),
  requestedAt: z.string(),
  decider: z.object({ id: uuid, fullName: z.string() }).nullable().optional(),
  decidedAt: z.string().nullable().optional(),
  decisionNote: z.string().nullable().optional(),
  approvalReview: z.object({
    expectedVersion: z.number().int(),
    expectedDigest: z.string(),
  }),
});
export type HeldWriteOffAtCounter = z.infer<typeof heldWriteOffAtCounterSchema>;

export const quarantineBatchSchema = z.object({
  batchId: uuid,
  qty: z.number().int().min(1).max(99999).nullable(),
  reasonCode: z.enum(["expired", "damaged", "recall", "inspection", "other"]),
  reason: z.string().trim().max(512).nullable(),
});

export const releaseQuarantineSchema = z.object({
  batchId: uuid,
  qty: z.number().int().min(1).max(99999).nullable(),
  reason: z.string().trim().max(512).nullable(),
});

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
  refundRequestId: uuid,
  requestNumber: z.string(),
  amountMinor: z.number().int(),
  refundedTo: z.array(
    z.object({ method: z.string(), amountMinor: z.number().int() }),
  ),
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

export const paymentMethodSchema = z.enum([
  "cash",
  "card",
  "mobile_wallet",
  "credit",
]);
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
  customer: z
    .object({ fullName: z.string(), phone: z.string().nullable() })
    .nullable(),
  /** How the customer paid: refund rows (negative) don't count. */
  payments: z.array(
    z.object({
      method: z.string(),
      amount: z.string(),
      reference: z.string().nullable(),
    }),
  ),
  /** A prescription or controlled item: refunding needs someone who can approve controlled sales. */
  needsPharmacist: z.boolean(),
  /** The tenant's refund limit; at or over it, the refund needs approval. Null: no limit. */
  refundLimit: z.string().nullable(),
  earlierRefunds: z.array(
    z.object({
      returnNumber: z.string(),
      amount: z.string(),
      createdAt: z.string(),
    }),
  ),
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
    coSignRefusal: z
      .object({ code: z.string(), message: z.string() })
      .optional(),
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

export const stockFilterSchema = z.enum([
  "all",
  "low",
  "prescription",
  "controlled",
]);
export type StockFilter = z.infer<typeof stockFilterSchema>;
/** The Needs attention lists, as `stock-by-product`'s `attention` filter names them. */
export const stockAttentionKindSchema = z.enum([
  "near_expiry",
  "expired",
  "quarantined",
]);
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

export const actionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
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
    z.object({
      method: z.string(),
      saleCount: z.number().int(),
      takenMinor: minor,
      refundedMinor: minor,
    }),
  ),
  takingsByHour: z.array(
    z.object({
      hour: z.string(),
      saleCount: z.number().int(),
      totalMinor: minor,
    }),
  ),
  refunds: z.array(
    z.object({
      goodsReturnId: uuid,
      returnNumber: z.string(),
      invoiceNo: z.string().nullable(),
      amountMinor: minor,
      paidBack: z.array(z.object({ method: z.string(), amountMinor: minor })),
      items: z.array(
        z.object({
          name: z.string(),
          qty: z.number().int(),
          disposition: z.string(),
        }),
      ),
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
export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ActionError };

const credentials = z.object({
  email: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(256),
});
const label = z.string().trim().min(1).max(120);
const pin = z.string().regex(/^\d{4,8}$/);

const noInput = z.undefined();

/** The counter app's light/dark choice on this computer (Epic UI1 #205); "system" follows Windows. */
export const counterThemeSchema = z.enum(["system", "light", "dark"]);
export type CounterTheme = z.infer<typeof counterThemeSchema>;

/** What the counter is showing, and whether the owner has locked it (the switch is then hidden). */
export const counterThemeViewSchema = z.object({
  theme: counterThemeSchema,
  locked: z.boolean(),
});
export type CounterThemeView = z.infer<typeof counterThemeViewSchema>;

/**
 * The pharmacy brand as the counter draws it (UI1 #205): the accent stylesheet main built from the
 * owner's colour (null for the default teal, which tokens.css already is) and the status colour
 * set. Cached on this computer, so it is drawn offline and before anyone signs in.
 */
export const counterBrandSchema = z.object({
  css: z.string().max(4000).nullable(),
  statusSet: z.enum(["standard", "colour-blind"]),
});
export type CounterBrand = z.infer<typeof counterBrandSchema>;

export const ipcContract = {
  getCounterTheme: {
    channel: "pos:theme:get",
    input: noInput,
    output: counterThemeViewSchema,
  },
  setCounterTheme: {
    channel: "pos:theme:set",
    input: z.object({ theme: counterThemeSchema }),
    output: counterThemeViewSchema,
  },
  getCounterBrand: {
    channel: "pos:brand:get",
    input: noInput,
    output: counterBrandSchema,
  },
  getAppInfo: {
    channel: "pos:app:info",
    input: noInput,
    output: appInfoSchema,
  },
  getReadiness: {
    channel: "pos:readiness:get",
    input: noInput,
    output: readinessReportSchema,
  },
  checkApi: {
    channel: "pos:api:check",
    input: noInput,
    output: apiReachabilitySchema,
  },
  listPrinters: {
    channel: "pos:printers:list",
    input: noInput,
    output: z.array(printerSchema),
  },
  printTestReceipt: {
    channel: "pos:printers:test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: printResultSchema,
  },
  getDeviceState: {
    channel: "pos:device:state",
    input: noInput,
    output: deviceStateSchema,
  },
  setServerUrl: {
    channel: "pos:device:server-url",
    input: z.object({ url: z.string().trim().min(1).max(2048) }),
    output: result(deviceStateSchema),
  },
  signIn: {
    channel: "pos:auth:sign-in",
    input: credentials,
    output: result(deviceStateSchema),
  },
  signOut: {
    channel: "pos:auth:sign-out",
    input: noInput,
    output: result(deviceStateSchema),
  },
  refreshEnrollment: {
    channel: "pos:device:refresh",
    input: noInput,
    output: result(deviceStateSchema),
  },
  listCounters: {
    channel: "pos:enrollment:counters",
    input: z.object({
      branchId: uuid,
      includeInactive: z.boolean().optional(),
    }),
    output: result(z.array(counterSchema)),
  },
  /** Rename a counter, or stop using it / start using it again. */
  updateCounter: {
    channel: "pos:enrollment:update-counter",
    input: z.object({
      branchId: uuid,
      registerId: uuid,
      label: label.optional(),
      isActive: z.boolean().optional(),
    }),
    output: result(counterSchema),
  },
  /** Delete a counter that has never been used. */
  deleteCounter: {
    channel: "pos:enrollment:delete-counter",
    input: z.object({ branchId: uuid, registerId: uuid }),
    output: result(z.object({}).strict()),
  },
  createCounter: {
    channel: "pos:enrollment:create-counter",
    input: z.object({ branchId: uuid, label }),
    output: result(counterSchema),
  },
  enrollWithCode: {
    channel: "pos:enrollment:enroll-with-code",
    input: z.object({
      branchId: uuid,
      code: z.string().trim().min(4).max(32),
      label,
    }),
    output: result(deviceStateSchema),
  },
  catalog: {
    channel: "pos:checkout:catalog",
    input: noInput,
    output: result(catalogSchema),
  },
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
  listHolds: {
    channel: "pos:checkout:holds",
    input: noInput,
    output: result(z.array(heldCartSchema)),
  },
  recallHold: {
    channel: "pos:checkout:recall",
    input: z.object({ holdId: uuid }),
    output: result(
      z.object({
        lines: z.array(
          z.object({
            productId: z.string(),
            qty: z.number().int(),
            discountMinor: z.number().int().min(0),
          }),
        ),
        customer: customerSchema.nullable(),
        prescription: prescriptionSchema.nullable(),
      }),
    ),
  },
  pendingCheckouts: {
    channel: "pos:checkout:pending",
    input: noInput,
    output: z.array(checkoutDraftSchema),
  },
  retryCheckout: {
    channel: "pos:checkout:retry",
    input: z.object({
      draftId: uuid,
      coSign: coSignSchema.optional(),
      discountCoSign: coSignSchema.optional(),
    }),
    output: result(completedSaleSchema),
  },
  searchCustomers: {
    channel: "pos:dispensing:customers",
    input: z.object({ q: z.string().trim().min(1).max(120) }),
    output: result(z.array(customerSchema)),
  },
  searchPrescriptions: {
    channel: "pos:dispensing:prescriptions",
    input: z.object({
      q: z.string().trim().max(120).optional(),
      customerId: uuid.optional(),
    }),
    output: result(z.array(prescriptionSchema)),
  },
  recordPrescription: {
    channel: "pos:dispensing:record-prescription",
    input: recordPrescriptionWithCoSignSchema,
    output: result(prescriptionSchema),
  },
  listApprovers: {
    channel: "pos:dispensing:approvers",
    input: noInput,
    output: result(z.array(approverSchema)),
  },
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
  counterWork: {
    channel: "pos:counter:work",
    input: noInput,
    output: result(z.array(counterWorkItemSchema)),
  },
  refundsReady: {
    channel: "pos:counter:refunds",
    input: noInput,
    output: result(z.array(refundAtCounterSchema)),
  },
  executeRefund: {
    channel: "pos:counter:execute-refund",
    input: z.object({ refundRequestId: uuid }),
    output: result(refundExecutedSchema),
  },
  cashPayoutsReady: {
    channel: "pos:counter:cash-payouts",
    input: noInput,
    output: result(z.array(cashPayoutAtCounterSchema)),
  },
  executeCashPayout: {
    channel: "pos:counter:execute-cash-payout",
    input: z.object({ cashPayoutId: uuid }),
    output: result(cashPayoutExecutedSchema),
  },
  printSupplierCashPayoutReceipt: {
    channel: "pos:counter:print-cash-payout",
    input: z.object({
      printerName: z.string().min(1).max(260),
      payoutNumber: z.string(),
      amountMinor: z.number().int(),
      supplierPaymentId: uuid,
      supplierPaymentNo: z.string().nullable().optional(),
      supplierName: z.string().nullable(),
      movementReason: z.string(),
      executedAt: z.string(),
    }),
    output: printResultSchema,
  },
  stockCasesReady: {
    channel: "pos:counter:stock-cases",
    input: noInput,
    output: result(z.array(stockCaseAtCounterSchema)),
  },
  resolveStockCase: {
    channel: "pos:counter:resolve-stock-case",
    input: z.object({
      resolutionId: uuid,
      counts: z
        .array(
          z.object({
            batchId: uuid,
            countedQty: z.number().int().min(0).max(10_000_000),
          }),
        )
        .max(200),
    }),
    output: result(stockCaseResolvedSchema),
  },
  pendingCommands: {
    channel: "pos:counter:pending-commands",
    input: noInput,
    output: z.array(
      z.object({
        commandId: uuid,
        operation: z.string(),
        createdAt: z.string(),
        staffName: z.string().nullable(),
      }),
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
  returnsToday: {
    channel: "pos:returns:today",
    input: noInput,
    output: result(z.array(refundTodaySchema)),
  },
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
    input: z.object({
      saleId: uuid,
      refundRequestId: uuid,
      coSign: coSignSchema,
    }),
    output: result(returnOutcomeSchema),
  },
  confirmTestReceipt: {
    channel: "pos:printers:confirm-test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: result(
      z.object({
        /** Server clock for the confirmation (ISO). */
        confirmedAt: z.string(),
        /** Display name of the person who confirmed (signed-in staff session). */
        confirmedByName: z.string().nullable(),
      }),
    ),
  },
  offlineCounter: {
    channel: "pos:offline:status",
    input: noInput,
    output: result(offlineCounterSchema),
  },
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
  preparePin: {
    channel: "pos:staff:prepare-pin",
    input: z.object({ pin }),
    output: result(deviceStateSchema),
  },
  lock: {
    channel: "pos:staff:lock",
    input: noInput,
    output: result(deviceStateSchema),
  },
  unlock: {
    channel: "pos:staff:unlock",
    input: z.object({ pin }),
    output: result(deviceStateSchema),
  },
  /** Signs a prepared person in with their PIN, checked by the server; it ends the current session. */
  pinSignIn: {
    channel: "pos:staff:pin-sign-in",
    input: z.object({ staffUserId: uuid, pin }),
    output: result(deviceStateSchema),
  },
  /** This counter's copy of its till shifts. Local only: it answers while locked or offline. */
  getShift: {
    channel: "pos:shift:get",
    input: noInput,
    output: shiftStateSchema,
  },
  /** The offline journal's upload and the reconnect pause (P5 #51). Local only. */
  getJournalSync: {
    channel: "pos:journal-sync:get",
    input: noInput,
    output: journalSyncSchema,
  },
  /** Online, draining an outage, selling offline, or stopped, and why (P4 #50). Local only. */
  getOfflineMode: {
    channel: "pos:offline-mode:get",
    input: noInput,
    output: offlineModeSchema,
  },
  /** This counter's offline journal as the upload queue lists it, newest first (P4 #50). Local only. */
  getOfflineJournalQueue: {
    channel: "pos:journal-queue:get",
    input: noInput,
    output: offlineJournalQueueSchema,
  },
  /** Offline sales recorded on this counter, for noting a problem with one (P4 #50). Local only. */
  offlineSales: {
    channel: "pos:offline-support:sales",
    input: noInput,
    output: result(z.array(offlineSaleSchema)),
  },
  /** A note on an offline sale. It changes nothing about the sale, stock or cash. */
  noteSaleProblem: {
    channel: "pos:offline-support:note",
    input: z.object({
      saleCommandId: uuid,
      category: saleIncidentCategorySchema,
      description: z.string().min(1).max(MAX_SALE_NOTE_LENGTH),
    }),
    output: result(z.object({ recordedAt: z.string() })),
  },
  /** External-card payments started here while offline, newest first. Local only. */
  cardAttempts: {
    channel: "pos:offline-support:card-attempts",
    input: noInput,
    output: result(z.array(cardAttemptSchema)),
  },
  /** Saves a card payment before the card machine is asked to charge. Refused while one is unsettled. */
  prepareCardAttempt: {
    channel: "pos:offline-support:card-prepare",
    input: z.object({
      checkoutDraftId: uuid,
      reviewedSaleDigest: z.string().regex(/^[a-f0-9]{64}$/),
      amountMinor: z.number().int().min(1),
    }),
    output: result(z.object({ attemptId: uuid })),
  },
  /** What the card machine did, or which sale the approved payment went to. */
  recordCardOutcome: {
    channel: "pos:offline-support:card-outcome",
    input: z.object({ attemptId: uuid, outcome: cardOutcomeSchema }),
    output: result(z.object({ state: cardAttemptSchema.shape.state })),
  },
  /** Asks the server, adopts what it says, and resends a saved close that wasn't confirmed. */
  refreshShift: {
    channel: "pos:shift:refresh",
    input: noInput,
    output: result(shiftStateSchema),
  },
  openShift: {
    channel: "pos:shift:open",
    input: z.object({ pin, count: cashCountSchema }),
    output: result(shiftStateSchema),
  },
  /** Who is signed in offline, and who may sign in (P4 #50). Local only; empty unless offline. */
  offlineStaff: {
    channel: "pos:offline-staff:get",
    input: noInput,
    output: offlineStaffSchema,
  },
  /** Signs a prepared person in offline with their PIN, checked on this counter (P4 #50). */
  offlineSignIn: {
    channel: "pos:offline-staff:sign-in",
    input: z.object({ staffUserId: uuid, pin }),
    output: result(offlineStaffSchema),
  },
  /** Opens the offline-signed-in person's shift as a journal entry (P4 #50). */
  offlineOpenShift: {
    channel: "pos:offline-shift:open",
    input: z.object({ pin, count: cashCountSchema }),
    output: result(offlineStaffSchema),
  },
  /** Closes the open shift as a journal entry; someone else's needs a manager's `assistance` (P4 #50). */
  offlineCloseShift: {
    channel: "pos:offline-shift:close",
    input: z.object({
      count: cashCountSchema,
      varianceNote: z.string().trim().max(500).optional(),
      assistance: z
        .object({ pin, reason: z.string().trim().min(1).max(500) })
        .optional(),
    }),
    output: result(offlineStaffSchema),
  },
  /**
   * D8: a prepared manager lets the counter keep selling outside routine hours, with their own PIN,
   * a reason and how long (P4 #50). Never past a mandatory restriction or the grant's expiry.
   */
  offlineAcknowledgeHours: {
    channel: "pos:offline-hours:acknowledge",
    input: z.object({
      staffUserId: uuid,
      pin,
      minutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
      reason: z.string().trim().min(1).max(500),
    }),
    output: result(offlineStaffSchema),
  },
  /** What the saved stock still lets this counter sell offline (P4 #50). */
  offlineStock: {
    channel: "pos:offline-sale:stock",
    input: noInput,
    output: result(z.array(offlineStockLineSchema)),
  },
  /** Prices a cart from the saved stock; items that can't be sold offline come back blocked. */
  offlineQuote: {
    channel: "pos:offline-sale:quote",
    input: z.object({ items: z.array(offlineSaleItemSchema).max(200) }),
    output: result(offlineQuoteSchema),
  },
  /** Saves a card payment for this cart before the card machine is asked to charge it. */
  offlinePrepareCard: {
    channel: "pos:offline-sale:card-prepare",
    input: z.object({
      checkoutDraftId: uuid,
      items: z.array(offlineSaleItemSchema).max(200),
      amountMinor: z.number().int().min(1),
    }),
    output: result(z.object({ attemptId: z.string(), digest: z.string() })),
  },
  /**
   * The card payment this counter left unsettled, with the cart it was prepared for, so Sell
   * shows it again after a person switch, a reload or a restart. Null when there is none.
   */
  offlineOpenCard: {
    channel: "pos:offline-sale:card-open",
    input: noInput,
    output: result(
      z
        .object({
          checkoutDraftId: uuid,
          items: z.array(offlineSaleItemSchema).nullable(),
          totalMinor: z.number().int().nullable(),
          attempt: z.object({
            attemptId: uuid,
            amountMinor: z.number().int(),
            state: z.enum(["prepared", "uncertain", "approved"]),
            reference: z.string().nullable(),
            approvalCode: z.string().nullable(),
          }),
        })
        .nullable(),
    ),
  },
  /** What the card machine did with a prepared offline card payment. */
  offlineCardOutcome: {
    channel: "pos:offline-sale:card-outcome",
    input: z.object({
      attemptId: uuid,
      outcome: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("not_sure") }),
        z.object({
          kind: z.literal("approved"),
          reference: cardReference,
          approvalCode: z.string().min(1).max(32),
          approvedAt: z.string().datetime(),
        }),
        z.object({ kind: z.literal("declined"), reference: cardReference }),
        z.object({ kind: z.literal("never_charged") }),
        cardNotUsedOutcomeSchema,
      ]),
    }),
    output: result(z.object({ state: cardAttemptSchema.shape.state })),
  },
  /** Completes an offline sale: settled card payments plus cash for the rest. Idempotent per draft. */
  offlineCommitSale: {
    channel: "pos:offline-sale:commit",
    input: z.object({
      checkoutDraftId: uuid,
      items: z.array(offlineSaleItemSchema).min(1).max(200),
      cashTenderedMinor: z.number().int().min(0).optional(),
    }),
    output: result(offlineReceiptSchema),
  },
  /** Prints (or reprints) the receipt of a sale committed offline on this counter. */
  printOfflineReceipt: {
    channel: "pos:offline-sale:print",
    input: z.object({
      saleCommandId: uuid,
      printerName: z.string().min(1).max(260),
    }),
    output: printResultSchema,
  },
  /** Closes the open shift; someone else's needs `assistance` (their own PIN and why). */
  closeShift: {
    channel: "pos:shift:close",
    input: z.object({
      count: cashCountSchema,
      varianceNote: z.string().trim().max(500).optional(),
      assistance: z
        .object({ pin, reason: z.string().trim().min(1).max(500) })
        .optional(),
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
  listShifts: {
    channel: "pos:shift:list",
    input: noInput,
    output: result(z.array(pastShiftSchema)),
  },
  shiftDetail: {
    channel: "pos:shift:detail",
    input: z.object({ workSessionId: uuid }),
    output: result(
      z.object({ shift: pastShiftSchema, summary: shiftSummarySchema }),
    ),
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
  stockAttention: {
    channel: "pos:stock:attention",
    input: noInput,
    output: result(stockAttentionSchema),
  },
  productStock: {
    channel: "pos:stock:product",
    input: z.object({ productId: uuid }),
    output: result(productStockSchema),
  },
  /** A direct adjustment or write-off, through the signed command (#95). */
  adjustStock: {
    channel: "pos:stock:adjust",
    input: stockAdjustmentSchema,
    output: result(
      z.object({
        qty: z.number().int(),
        movementType: z.enum(["adjustment_in", "adjustment_out"]),
      }),
    ),
  },
  quarantineBatch: {
    channel: "pos:stock:quarantine",
    input: quarantineBatchSchema,
    output: result(
      z.object({
        qty: z.number().int(),
        stockReferenceId: z.string().optional(),
      }),
    ),
  },
  releaseQuarantine: {
    channel: "pos:stock:release-quarantine",
    input: releaseQuarantineSchema,
    output: result(
      z.object({
        qty: z.number().int(),
        stockReferenceId: z.string().optional(),
      }),
    ),
  },
  stockPermissions: {
    channel: "pos:stock:permissions",
    input: noInput,
    output: result(
      z.object({
        quarantine: z.boolean(),
        releaseQuarantine: z.boolean(),
        writeOff: z.boolean(),
      }),
    ),
  },
  /** Held write-offs for the counter frame (approved + read-only when the API supplies them). */
  heldWriteOffsAtCounter: {
    channel: "pos:work:held-write-offs",
    input: noInput,
    output: result(z.array(heldWriteOffAtCounterSchema)),
  },
  postHeldWriteOff: {
    channel: "pos:work:post-held-write-off",
    input: z.object({
      heldAdjustmentId: uuid,
      approvalEvidenceId: uuid.nullable(),
    }),
    output: result(
      z.object({
        heldAdjustmentId: uuid,
        stockReferenceId: z.string(),
        alreadyApplied: z.boolean(),
      }),
    ),
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
