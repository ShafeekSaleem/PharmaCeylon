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
import { PreparedReceiptService } from "../purchasing/prepared-receipt.service";
import { ReturnsService } from "../returns/returns.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import type { OperationDescriptor } from "../security/operation-authorization.service";
import { StocktakesService } from "../stocktakes/stocktakes.service";
import type { CommandProvenance } from "../terminals/command-provenance";
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
    preparedReceipts: PreparedReceiptService,
    returns: ReturnsService,
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
