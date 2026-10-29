import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  SignedOperationBody,
  SignedOperationResult,
  SignedPhysicalOperation,
} from "@pharmaceylon/shared";
import { AdjustmentService } from "../inventory/adjustment.service";
import { ImportStockService } from "../product-import/import-stock.service";
import { ProductImportService } from "../product-import/product-import.service";
import { HeldDeliveryService } from "../purchasing/held-delivery.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import type { OperationDescriptor } from "../security/operation-authorization.service";
import { StocktakesService } from "../stocktakes/stocktakes.service";
import type { CommandProvenance } from "../terminals/command-provenance";
import { TransfersService } from "../transfers/transfers.service";
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
    deliveries: HeldDeliveryService,
    importStock: ImportStockService,
    imports: ProductImportService,
    transfers: TransfersService,
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
