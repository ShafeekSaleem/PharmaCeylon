import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  QUARANTINE_REASON_CODES,
  STOCK_ADJUSTMENT_KINDS,
  type QuarantineReasonCode,
  type SignedOperationBody,
  type SignedOperationResult,
  type SignedPhysicalOperation,
} from "@pharmaceylon/shared";
import { PrescriptionsService } from "../customers/prescriptions.service";
import { AdjustmentService } from "../inventory/adjustment.service";
import type { QuarantineBatchDto, ReleaseQuarantineDto } from "../inventory/dto/quarantine-batch.dto";
import { InventoryService } from "../inventory/inventory.service";
import { adjustmentDirection, type StockAdjustmentDto } from "../inventory/dto/stock-adjustment.dto";
import { ImportStockService } from "../product-import/import-stock.service";
import { ProductImportService } from "../product-import/product-import.service";
import { HeldDeliveryService } from "../purchasing/held-delivery.service";
import { PreparedReceiptService } from "../purchasing/prepared-receipt.service";
import { ReturnsService } from "../returns/returns.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import type { OperationDescriptor } from "../security/operation-authorization.service";
import { StocktakesService } from "../stocktakes/stocktakes.service";
import type { CommandProvenance } from "../terminals/command-provenance";
import { TransfersService } from "../transfers/transfers.service";
import { RefundRequestsService } from "../sales/refund-requests.service";
import { SupplierCashPayoutService } from "../purchasing/ledger/supplier-cash-payout.service";
import { StockCasesService } from "../stock-cases/stock-cases.service";
import { invalid, object, text, uuid } from "../terminals/terminal-wire";

type Tx = Prisma.TransactionClient;
export type SignedExecutionContext = Readonly<{
  approvalEvidenceId: string | null;
  command: CommandProvenance;
}>;
export type SignedExecution<O extends SignedPhysicalOperation> = Readonly<{
  result: SignedOperationResult[O];
  /** Runs only after commit; its failure never affects the committed receipt. */
  afterCommit?: () => Promise<void>;
}>;
export type SignedOperation<O extends SignedPhysicalOperation> = Readonly<{
  descriptor: OperationDescriptor<SignedOperationBody[O]>;
  execute(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    body: SignedOperationBody[O],
    context: SignedExecutionContext,
  ): Promise<SignedExecution<O>>;
}>;
type Registry = { [O in SignedPhysicalOperation]: SignedOperation<O> };

/** Strict exact-key parsers: they validate and return the signed object unchanged. */
function idBody<K extends string>(key: K) {
  return (raw: unknown) => {
    const body = object(raw, [key]);
    uuid(body[key]);
    return body as Readonly<Record<K, string>>;
  };
}
function importPostBody(
  raw: unknown,
): SignedOperationBody["POST /api/v1/products/import/:importId/stock/post"] {
  const body = object(raw, ["importId", "version", "selection", "categoryName"]);
  uuid(body.importId);
  if (!Number.isSafeInteger(body.version) || (body.version as number) < 1)
    invalid();
  if (body.selection === "all") {
    if (body.categoryName !== null) invalid();
  } else if (body.selection === "category") {
    if (body.categoryName !== null) text(body.categoryName, 500);
  } else invalid();
  return body as SignedOperationBody["POST /api/v1/products/import/:importId/stock/post"];
}
type TransferReceiveBody = SignedOperationBody["POST /api/v1/transfers/:id/receive"];
const count = (value: unknown, min: number) => {
  if (!Number.isSafeInteger(value) || (value as number) < min) invalid();
  return value as number;
};
function transferReceiveBody(raw: unknown): TransferReceiveBody {
  const body = object(raw, ["transferId", "dispatchApprovalId", "lines"]);
  uuid(body.transferId);
  if (body.dispatchApprovalId !== null) uuid(body.dispatchApprovalId);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 500) invalid();
  const seen = new Set<string>();
  for (const raw of body.lines) {
    const line = object(raw, ["transferItemId", "qty", "receivedQtyBefore"]);
    if (seen.has(uuid(line.transferItemId))) invalid();
    seen.add(line.transferItemId as string);
    count(line.qty, 1);
    count(line.receivedQtyBefore, 0);
  }
  return body as TransferReceiveBody;
}
type AdjustmentBody = SignedOperationBody["POST /api/v1/inventory/adjustments"];
/** Batch prices are numeric(12,2): at most 9,999,999,999.99. */
const MAX_PRICE_MINOR = 999_999_999_999;
const trimmed = (value: unknown, max: number) => {
  if (text(value, max) !== (value as string).trim()) invalid();
  return value as string;
};
function adjustmentBody(raw: unknown): AdjustmentBody {
  const body = object(raw, ["kind", "movementType", "productId", "batchId", "newBatch", "qty", "reason", "fromQuarantine"]);
  if (!(STOCK_ADJUSTMENT_KINDS as readonly unknown[]).includes(body.kind)) invalid();
  if (body.kind === "correction") {
    if (body.movementType !== "adjustment_in" && body.movementType !== "adjustment_out") invalid();
    if (body.reason === null) invalid();
  } else if (body.movementType !== null) invalid();
  const increase = adjustmentDirection(body as AdjustmentBody) === "in";
  uuid(body.productId);
  if (body.newBatch === null) uuid(body.batchId);
  else {
    if (body.batchId !== null || !increase) invalid();
    const batch = object(body.newBatch, ["batchNo", "expiryDate", "costPriceMinor", "sellingPriceMinor", "supplierId"]);
    trimmed(batch.batchNo, 64);
    const expiry = batch.expiryDate;
    if (typeof expiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) invalid();
    const day = new Date(`${expiry}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== expiry) invalid();
    if (count(batch.costPriceMinor, 0) > MAX_PRICE_MINOR || count(batch.sellingPriceMinor, 0) > MAX_PRICE_MINOR) invalid();
    if (batch.supplierId !== null) uuid(batch.supplierId);
  }
  count(body.qty, 1);
  if (body.reason !== null) trimmed(body.reason, 512);
  if (typeof body.fromQuarantine !== "boolean" || (body.fromQuarantine && increase)) invalid();
  return body as AdjustmentBody;
}
/** The same request the browser route takes; prices go from minor units back to 2dp amounts. */
type QuarantineBody = SignedOperationBody["POST /api/v1/inventory/batches/:id/quarantine"];
type ReleaseBody = SignedOperationBody["POST /api/v1/inventory/batches/:id/release-quarantine"];
const optionalQty = (value: unknown) => {
  if (value === null) return null;
  return count(value, 1);
};
function quarantineBody(raw: unknown): QuarantineBody {
  const body = object(raw, ["batchId", "qty", "reasonCode", "reason"]);
  uuid(body.batchId);
  optionalQty(body.qty);
  if (!(QUARANTINE_REASON_CODES as readonly unknown[]).includes(body.reasonCode)) invalid();
  if (body.reason !== null) trimmed(body.reason, 512);
  if (body.reasonCode === "other" && (body.reason === null || trimmed(body.reason, 512).length === 0)) invalid();
  return body as QuarantineBody;
}
function releaseBody(raw: unknown): ReleaseBody {
  const body = object(raw, ["batchId", "qty", "reason"]);
  uuid(body.batchId);
  optionalQty(body.qty);
  if (body.reason !== null) trimmed(body.reason, 512);
  return body as ReleaseBody;
}
function quarantineDto(body: QuarantineBody): QuarantineBatchDto {
  return {
    reasonCode: body.reasonCode as QuarantineReasonCode,
    ...(body.qty !== null ? { qty: body.qty } : {}),
    ...(body.reason !== null ? { reason: body.reason } : {}),
  };
}
function releaseDto(body: ReleaseBody): ReleaseQuarantineDto {
  return {
    ...(body.qty !== null ? { qty: body.qty } : {}),
    ...(body.reason !== null ? { reason: body.reason } : {}),
  };
}
function adjustmentDto(body: AdjustmentBody): StockAdjustmentDto {
  const batch = body.newBatch;
  return {
    kind: body.kind,
    productId: body.productId,
    qty: body.qty,
    ...(body.movementType ? { movementType: body.movementType } : {}),
    ...(body.batchId ? { batchId: body.batchId } : {}),
    ...(batch ? { newBatch: {
      batchNo: batch.batchNo,
      expiryDate: batch.expiryDate,
      costPrice: batch.costPriceMinor / 100,
      sellingPrice: batch.sellingPriceMinor / 100,
      ...(batch.supplierId ? { supplierId: batch.supplierId } : {}),
    } } : {}),
    ...(body.reason !== null ? { reason: body.reason } : {}),
    ...(body.fromQuarantine ? { fromQuarantine: true } : {}),
  };
}
type PrescriptionBody = SignedOperationBody["POST /api/v1/prescriptions"];
const calendarDay = (value: unknown) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const day = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) invalid();
  return value;
};
/** The CreatePrescriptionDto limits, with every key present and text already trimmed. */
function prescriptionBody(raw: unknown): PrescriptionBody {
  const body = object(raw, ["rxNumber", "patientName", "doctorName", "doctorRegNo", "issuedOn", "validUntil",
    "customerId", "notes"]);
  if (body.rxNumber !== null) trimmed(body.rxNumber, 64);
  if (trimmed(body.patientName, 160).length < 2 || trimmed(body.doctorName, 160).length < 2) invalid();
  if (body.doctorRegNo !== null) trimmed(body.doctorRegNo, 64);
  calendarDay(body.issuedOn);
  if (body.validUntil !== null && calendarDay(body.validUntil) < (body.issuedOn as string)) invalid();
  if (body.customerId !== null) uuid(body.customerId);
  if (body.notes !== null) trimmed(body.notes, 512);
  return body as PrescriptionBody;
}
type StockCaseBody = SignedOperationBody["POST /api/v1/offline-stock-cases/resolutions/:id/execute"];
/** One count per batch for count_and_correct, none otherwise; the service checks them against the case. */
function stockCaseBody(raw: unknown): StockCaseBody {
  const body = object(raw, ["resolutionId", "counts"]);
  uuid(body.resolutionId);
  if (!Array.isArray(body.counts) || body.counts.length > 200) invalid();
  const seen = new Set<string>();
  for (const raw of body.counts) {
    const line = object(raw, ["batchId", "countedQty"]);
    if (seen.has(uuid(line.batchId))) invalid();
    seen.add(line.batchId as string);
    count(line.countedQty, 0);
  }
  return body as StockCaseBody;
}
/** "12.50" → 1250. Money in a receipt is integer minor units (canonical JSON has no floats). */
const minor = (amount: string) => Math.round(Number(amount) * 100);
const approvalId = (context: SignedExecutionContext) => {
  if (!context.approvalEvidenceId) invalid();
  return context.approvalEvidenceId;
};

/** The closed v1 registry of physical operations a verified signed command may execute.
 * Each adapter calls the same in-transaction domain core as the browser route; none writes
 * stock itself. A request can only select an adapter by the exact signed operation string.
 */
@Injectable()
export class SignedOperations {
  private readonly registry: Readonly<Registry>;

  constructor(
    stocktakes: StocktakesService,
    adjustments: AdjustmentService,
    inventory: InventoryService,
    deliveries: HeldDeliveryService,
    importStock: ImportStockService,
    imports: ProductImportService,
    transfers: TransfersService,
    preparedReceipts: PreparedReceiptService,
    returns: ReturnsService,
    refunds: RefundRequestsService,
    cashPayouts: SupplierCashPayoutService,
    prescriptions: PrescriptionsService,
    stockCases?: StockCasesService,
  ) {
    this.registry = Object.freeze<Registry>({
      "POST /api/v1/stocktakes/:id/post": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/stocktakes/:id/post",
          permission: "stocktakes.review",
          parseBody: idBody("stocktakeId"),
          approval: { action: "stocktake.post", documentId: (b) => b.stocktakeId },
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await stocktakes.postInTransaction(tx, user, branchId, body.stocktakeId, {
            expectedApprovalId: approvalId(context),
            command: context.command,
          });
          return {
            result: {
              type: "stocktake.posted",
              stocktakeId: body.stocktakeId,
              approvalId: approvalId(context),
              effect: posted.applied ? "applied" : "already_applied",
            },
          };
        },
      },
      "POST /api/v1/inventory/held-adjustments/:id/post": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/inventory/held-adjustments/:id/post",
          permission: "inventory.write_off",
          parseBody: idBody("heldAdjustmentId"),
          approval: { action: "held_adjustment.post", documentId: (b) => b.heldAdjustmentId },
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await adjustments.postInTransaction(tx, user, branchId, body.heldAdjustmentId,
            { approvalId: approvalId(context) }, context.command);
          return {
            result: {
              type: "held_adjustment.posted",
              heldAdjustmentId: body.heldAdjustmentId,
              approvalId: approvalId(context),
              stockReferenceId: posted.referenceId as string,
              effect: posted.changed ? "applied" : "already_applied",
            },
            afterCommit: posted.changed
              ? () => adjustments.notifyPosted(user.tenantId, branchId, body.heldAdjustmentId)
              : undefined,
          };
        },
      },
      // A direct adjustment at the counter: increases need inventory.manage, write-offs
      // inventory.write_off. A write-off that needs approval is refused, never held, here.
      "POST /api/v1/inventory/adjustments": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/inventory/adjustments",
          permission: (b) => adjustmentDirection(b) === "in" ? "inventory.manage" : "inventory.write_off",
          parseBody: adjustmentBody,
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await adjustments.postDirectInTransaction(tx, user, branchId, adjustmentDto(body),
            context.command);
          return {
            result: {
              type: "stock_adjustment.posted",
              productId: body.productId,
              batchId: posted.batchId,
              movementType: adjustmentDirection(body) === "in" ? "adjustment_in" : "adjustment_out",
              qty: body.qty,
              stockReferenceId: posted.referenceId,
            },
          };
        },
      },
      "POST /api/v1/inventory/batches/:id/quarantine": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/inventory/batches/:id/quarantine",
          permission: "inventory.quarantine",
          parseBody: quarantineBody,
        },
        async execute(tx, user, branchId, body, context) {
          const held = await inventory.quarantineBatchInTransaction(
            tx,
            user.tenantId,
            branchId,
            user.userId,
            body.batchId,
            quarantineDto(body),
            context.command,
          );
          return {
            result: {
              type: "batch.quarantined",
              batchId: body.batchId,
              productId: held.productId,
              qty: held.qty,
              reasonCode: held.reasonCode,
              stockReferenceId: held.referenceId,
            },
          };
        },
      },
      "POST /api/v1/inventory/batches/:id/release-quarantine": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/inventory/batches/:id/release-quarantine",
          permission: "inventory.release_quarantine",
          parseBody: releaseBody,
        },
        async execute(tx, user, branchId, body, context) {
          const released = await inventory.releaseQuarantineInTransaction(
            tx,
            user.tenantId,
            branchId,
            user.userId,
            body.batchId,
            releaseDto(body),
            context.command,
          );
          return {
            result: {
              type: "batch.quarantine_released",
              batchId: body.batchId,
              productId: released.productId,
              qty: released.qty,
              stockReferenceId: released.referenceId,
            },
          };
        },
      },
      "POST /api/v1/purchasing/held-deliveries/:id/post": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/purchasing/held-deliveries/:id/post",
          permission: "purchasing.receive",
          parseBody: idBody("heldDeliveryId"),
          approval: { action: "held_delivery.post", documentId: (b) => b.heldDeliveryId },
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await deliveries.postInTransaction(tx, user, branchId, body.heldDeliveryId,
            { approvalId: approvalId(context) }, context.command);
          return {
            result: {
              type: "held_delivery.posted",
              heldDeliveryId: body.heldDeliveryId,
              approvalId: approvalId(context),
              goodsReceiptId: posted.goodsReceiptId as string,
              effect: posted.changed ? "applied" : "already_applied",
            },
            afterCommit: posted.changed
              ? () => deliveries.notifyPosted(user.tenantId, branchId, body.heldDeliveryId)
              : undefined,
          };
        },
      },
      "POST /api/v1/products/import/:importId/stock/post": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/products/import/:importId/stock/post",
          permission: "products.import",
          parseBody: importPostBody,
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await importStock.postInTransaction(tx, user, branchId, body.importId,
            body.selection === "all"
              ? { version: body.version }
              : { version: body.version, categoryName: body.categoryName },
            context.command);
          return {
            result: {
              type: "import_stock.posted",
              importId: body.importId,
              version: body.version,
              selection: body.selection,
              categoryName: body.categoryName,
              batchesPosted: posted.batchesPosted,
              unitsPosted: posted.unitsPosted,
              effect: posted.batchesPosted ? "applied" : "already_applied",
            },
          };
        },
      },
      "POST /api/v1/products/import/:importId/undo-stock": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/products/import/:importId/undo-stock",
          permission: "products.import",
          parseBody: idBody("importId"),
        },
        async execute(tx, user, branchId, body, context) {
          const removed = await imports.undoInTransaction(tx, user.tenantId, user.userId, body.importId,
            true, branchId, (client) => importStock.authorize(user, branchId, client), context.command);
          return {
            result: {
              type: "import.undone",
              importId: body.importId,
              batchesRemoved: removed.batches,
              productsRemoved: removed.products,
              productsLeftInPlace: removed.productsLeftInPlace,
            },
          };
        },
      },
      // Source counter (x-branch-id = source branch).
      "POST /api/v1/transfers/:id/ship": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/transfers/:id/ship",
          permission: "transfers.manage",
          parseBody: idBody("transferId"),
          approval: {
            action: "transfer.ship",
            documentId: (b) => b.transferId,
            waived: (tx, user, branchId, b) =>
              transfers.dispatchApprovalWaived(tx, user.tenantId, branchId, b.transferId),
          },
        },
        async execute(tx, user, branchId, body, context) {
          const dispatched = await transfers.dispatchInTransaction(tx, user, branchId, body.transferId,
            { approvalId: context.approvalEvidenceId }, context.command);
          return {
            result: {
              type: "transfer.dispatched",
              transferId: body.transferId,
              approvalId: context.approvalEvidenceId,
              dispatchedQty: dispatched.dispatchedQty,
              effect: dispatched.changed ? "applied" : "already_applied",
            },
          };
        },
      },
      // Destination counter (x-branch-id = destination branch); the enrollment is branch-bound,
      // so a source terminal cannot book stock in at the destination.
      "POST /api/v1/transfers/:id/receive": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/transfers/:id/receive",
          permission: "transfers.manage",
          parseBody: transferReceiveBody,
        },
        async execute(tx, user, branchId, body, context) {
          const received = await transfers.receiveInTransaction(tx, user, branchId, body.transferId,
            { dispatchApprovalId: body.dispatchApprovalId, lines: body.lines.map((line) => ({ ...line })) },
            context.command);
          return {
            result: {
              type: "transfer.received",
              transferId: body.transferId,
              dispatchApprovalId: body.dispatchApprovalId,
              status: received.status as "partially_received" | "received",
              receivedQty: received.receivedQty,
            },
          };
        },
      },
      // The branch counter refunds a request prepared (and, over the threshold, approved)
      // remotely. A request executes once; a distinct later command reports already_applied.
      "POST /api/v1/sales/refund-requests/:id/execute": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/sales/refund-requests/:id/execute",
          permission: "sales.refund",
          parseBody: idBody("refundRequestId"),
          resolveFacts: async (tx, user, branchId, b) => ({
            cashMovement: await refunds.cashMovement(tx, user.tenantId, branchId, b.refundRequestId),
          }),
          approval: {
            action: "sale_refund.execute",
            documentId: (b) => b.refundRequestId,
            waived: (tx, user, branchId, b) =>
              refunds.executionApprovalWaived(tx, user.tenantId, branchId, b.refundRequestId),
          },
        },
        async execute(tx, user, branchId, body, context) {
          const done = await refunds.executeInTransaction(tx, user, branchId, body.refundRequestId,
            { approvalId: context.approvalEvidenceId }, context.command);
          return {
            result: {
              type: "sale_refund.executed",
              refundRequestId: body.refundRequestId,
              approvalId: context.approvalEvidenceId,
              goodsReturnId: done.goodsReturnId,
              amountMinor: minor(done.row.amount.toFixed(2)),
              refundedTo: done.refundedTo.map((part) => ({ method: part.method, amountMinor: minor(part.amount) })),
              effect: done.changed ? "applied" : "already_applied",
            },
          };
        },
      },
      "POST /api/v1/purchasing/cash-payouts/:id/execute": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/purchasing/cash-payouts/:id/execute",
          permission: "suppliers.pay",
          parseBody: idBody("cashPayoutId"),
          resolveFacts: async () => ({ paymentKind: "cash" as const }),
          approval: {
            action: "supplier_cash_payout.execute",
            documentId: (b) => b.cashPayoutId,
          },
        },
        async execute(tx, user, branchId, body, context) {
          const done = await cashPayouts.executeInTransaction(tx, user, branchId, body.cashPayoutId, {
            approvalId: approvalId(context),
            command: context.command,
          });
          return {
            result: {
              type: "supplier_cash_payout.executed",
              cashPayoutId: body.cashPayoutId,
              approvalId: approvalId(context),
              supplierPaymentId: done.paymentId,
              amountMinor: minor(done.row.amount.toFixed(2)),
              effect: done.changed ? "applied" : "already_applied",
            },
          };
        },
      },
      "POST /api/v1/purchasing/prepared-receipts/:id/post": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/purchasing/prepared-receipts/:id/post",
          permission: "purchasing.receive",
          parseBody: idBody("preparedReceiptId"),
          approval: { action: "prepared_receipt.post", documentId: (b) => b.preparedReceiptId },
        },
        async execute(tx, user, branchId, body, context) {
          const posted = await preparedReceipts.postInTransaction(tx, user, branchId, body.preparedReceiptId,
            { approvalId: approvalId(context) }, context.command);
          return {
            result: {
              type: "prepared_receipt.posted",
              preparedReceiptId: body.preparedReceiptId,
              approvalId: approvalId(context),
              goodsReceiptId: posted.goodsReceiptId as string,
              effect: posted.changed ? "applied" : "already_applied",
            },
            afterCommit: posted.changed
              ? () => preparedReceipts.notifyPosted(user.tenantId, branchId, body.preparedReceiptId)
              : undefined,
          };
        },
      },
      "POST /api/v1/returns/:id/complete": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/returns/:id/complete",
          permission: "returns.process",
          parseBody: idBody("goodsReturnId"),
          approval: { action: "goods_return.complete", documentId: (b) => b.goodsReturnId },
        },
        async execute(tx, user, branchId, body, context) {
          const done = await returns.completeInTransaction(tx, user, branchId, body.goodsReturnId,
            { approvalId: approvalId(context) }, context.command);
          return {
            result: {
              type: "goods_return.completed",
              goodsReturnId: body.goodsReturnId,
              approvalId: approvalId(context),
              debitNoteId: done.debitNoteId,
              effect: done.changed ? "applied" : "already_applied",
            },
          };
        },
      },
      // Clinical: the authorization service requires a current SLMC registration
      // (MandatoryOperationEvidence.clinical): the session's staff member's own, or a registered
      // pharmacist's PIN co-sign (`pharmacistEvidenceId`). The executor records which, and whose,
      // in the provenance. No role or permission substitutes for it.
      "POST /api/v1/prescriptions": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/prescriptions",
          permission: "prescriptions.create",
          parseBody: prescriptionBody,
          // A cashier records it at the counter with a registered pharmacist's PIN co-sign; the
          // co-signer needs prescriptions.create, and the cashier the counter's own sales.pos_use.
          cosign: { permission: "sales.pos_use" },
        },
        async execute(tx, user, branchId, body, context) {
          const registrationId = context.command.pharmacistRegistrationId;
          if (!registrationId) throw new Error("Clinical evidence missing from a prescription command");
          const created = await prescriptions.createInTransaction(tx, user.tenantId, branchId, user.userId, {
            patientName: body.patientName,
            doctorName: body.doctorName,
            issuedOn: body.issuedOn,
            ...(body.rxNumber !== null ? { rxNumber: body.rxNumber } : {}),
            ...(body.doctorRegNo !== null ? { doctorRegNo: body.doctorRegNo } : {}),
            ...(body.validUntil !== null ? { validUntil: body.validUntil } : {}),
            ...(body.customerId !== null ? { customerId: body.customerId } : {}),
            ...(body.notes !== null ? { notes: body.notes } : {}),
          }, context.command);
          return {
            result: {
              type: "prescription.recorded",
              prescriptionId: created.id,
              rxNumber: created.rxNumber,
              pharmacistRegistrationId: registrationId,
            },
          };
        },
      },
      // P5 #51: resolve an offline stock case with its remotely approved plan. Physical stock
      // work (revised D10): the count, the correction and the sale's posting happen here only.
      "POST /api/v1/offline-stock-cases/resolutions/:id/execute": {
        descriptor: {
          method: "POST",
          routeTemplate: "/api/v1/offline-stock-cases/resolutions/:id/execute",
          permission: "inventory.manage",
          parseBody: stockCaseBody,
          approval: { action: "offline_stock_resolution.execute", documentId: (b) => b.resolutionId },
        },
        async execute(tx, user, branchId, body, context) {
          if (!stockCases) throw new Error("Stock cases are not wired into signed operations");
          const result = await stockCases.executeInTransaction(tx, user, branchId, body.resolutionId,
            { approvalId: approvalId(context), counts: body.counts.map((c) => ({ ...c })) }, context.command);
          return { result };
        },
      },
    });
  }

  /** Selects an adapter by the exact operation string; anything else is INVALID_COMMAND. */
  get(operation: unknown): SignedOperation<SignedPhysicalOperation> {
    if (typeof operation !== "string" || !Object.hasOwn(this.registry, operation))
      invalid();
    return this.registry[operation as SignedPhysicalOperation] as unknown as SignedOperation<SignedPhysicalOperation>;
  }

  operations(): SignedPhysicalOperation[] {
    return Object.keys(this.registry) as SignedPhysicalOperation[];
  }
}
