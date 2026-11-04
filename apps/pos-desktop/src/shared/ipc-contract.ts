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

export const readinessReportSchema = z.object({
  ready: z.boolean(),
  checkedAt: z.string(),
  checks: z.array(readinessCheckSchema),
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
      counterLabel: z.string(),
      label: z.string(),
      terminalId: uuid,
      enrollmentId: uuid,
      enrolledAt: z.string().nullable(),
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
export type RecordPrescription = z.infer<typeof recordPrescriptionSchema>;

/** A pharmacist's co-sign for controlled items: their till PIN, or login password if they have none.
 * Sent with one checkout and never stored on this computer. */
export const coSignSchema = z.object({
  approverUserId: uuid,
  pin: z.string().min(4).max(128),
});
export type CoSign = z.infer<typeof coSignSchema>;

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
  lines: z.array(z.object({ name: z.string(), qty: z.number().int(), unitPrice: z.string(), lineTotal: z.string() })),
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
  /** Who rang it up: only they can confirm it, because the server keys retries to the seller. */
  staffName: z.string().nullable(),
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

export const actionErrorSchema = z.object({ code: z.string(), message: z.string() });
export type ActionError = z.infer<typeof actionErrorSchema>;

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
      lines: z.array(z.object({ productId: uuid, qty: z.number().int().min(1).max(9999) })).min(1).max(200),
      tender: tenderSchema,
      dispensing: dispensingSchema.optional(),
      coSign: coSignSchema.optional(),
    }),
    output: result(completedSaleSchema),
  },
  holdCart: {
    channel: "pos:checkout:hold",
    input: z.object({
      lines: z.array(z.object({ productId: uuid, qty: z.number().int().min(1).max(9999) })).min(1).max(200),
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
        lines: z.array(z.object({ productId: z.string(), qty: z.number().int() })),
        customer: customerSchema.nullable(),
        prescription: prescriptionSchema.nullable(),
      }),
    ),
  },
  pendingCheckouts: { channel: "pos:checkout:pending", input: noInput, output: z.array(checkoutDraftSchema) },
  retryCheckout: {
    channel: "pos:checkout:retry",
    input: z.object({ draftId: uuid, coSign: coSignSchema.optional() }),
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
    input: recordPrescriptionSchema,
    output: result(prescriptionSchema),
  },
  listApprovers: { channel: "pos:dispensing:approvers", input: noInput, output: result(z.array(approverSchema)) },
  printSaleReceipt: {
    channel: "pos:checkout:print",
    input: z.object({ saleId: uuid, printerName: z.string().min(1).max(260) }),
    output: printResultSchema,
  },
  refundsReady: { channel: "pos:counter:refunds", input: noInput, output: result(z.array(refundAtCounterSchema)) },
  executeRefund: {
    channel: "pos:counter:execute-refund",
    input: z.object({ refundRequestId: uuid }),
    output: result(refundExecutedSchema),
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
    }),
    output: result(returnOutcomeSchema),
  },
  confirmTestReceipt: {
    channel: "pos:printers:confirm-test-receipt",
    input: z.object({ printerName: z.string().min(1).max(260) }),
    output: result(z.object({ confirmedAt: z.string() })),
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
