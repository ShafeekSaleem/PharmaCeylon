import { randomUUID } from "node:crypto";
import {
  PaymentMethod,
  Prisma,
  SaleStatus,
  SaleStockPosting,
  StockMovementType,
} from "@prisma/client";
import type {
  BranchStockSnapshot,
  OfflineSaleCommand,
  StockPostingOutcome,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import type { AuditService } from "../../audit/audit.service";
import { nextDocumentNumber } from "../../common/document-sequence.util";
import { countsAfterSale } from "../../inventory/stock/counts-after-sale";
import { blockedBatchIds } from "../../inventory/stock/sale-blocks";
import type { StockService } from "../../inventory/stock/stock.service";

type Tx = Prisma.TransactionClient;

/** LKR minor units to the Decimal(12,2) rupees the sale tables store, exactly. */
export const fromMinor = (minor: number) => new Prisma.Decimal(minor).div(100);

/** Why a batch's units are waiting on the case rather than posted. `entry_reviewed`: a manager
 * recorded a refused journal entry (slice 4), so its stock is confirmed at the counter.
 * `counted_after_sale`: a posted count landed after the sale and already took its units off. */
export type PendingReason =
  | "shortfall"
  | "counted_after_sale"
  | "batch_under_review"
  | "sale_pending"
  | "entry_reviewed";

export type BatchDecision = Readonly<{
  batchId: string;
  productId: string;
  soldQuantity: number;
  availableQuantityAtSync: number;
  shortfallQuantity: number;
  /** Null when the whole sale posts. */
  reason: PendingReason | null;
}>;

/**
 * Approved D1, all or nothing: the sale posts its whole stock effect only if every batch it took
 * from has the units available now and none is already held by an open case. Otherwise nothing
 * posts and every batch of the sale waits on one case, each with the reason it waits. A batch an
 * earlier case holds is not posted into, even with units to spare: its count is under review.
 * Nor is a batch counted after the sale was made (`countedAfterSale`): that count already took
 * the sale's units off, and posting them again would deduct them twice.
 * `entryReviewed` (slice 4): a refused entry a manager recorded never posts; every batch waits on
 * its case, and those central stock could cover say so (`entry_reviewed`).
 */
export type DecideStockPostingOptions = {
  entryReviewed?: boolean;
  countedAfterSale?: ReadonlySet<string>;
};

export function decideStockPosting(
  sold: ReadonlyArray<Readonly<{ batchId: string; productId: string; quantity: number }>>,
  available: ReadonlyMap<string, number>,
  blocked: ReadonlySet<string>,
  options: DecideStockPostingOptions = {},
): { posts: boolean; batches: BatchDecision[] } {
  const byBatch = new Map<string, { productId: string; quantity: number }>();
  for (const line of sold) {
    const entry = byBatch.get(line.batchId) ?? { productId: line.productId, quantity: 0 };
    entry.quantity += line.quantity;
    byBatch.set(line.batchId, entry);
  }
  const facts = [...byBatch].map(([batchId, { productId, quantity }]) => {
    const availableQuantityAtSync = Math.max(0, available.get(batchId) ?? 0);
    return {
      batchId,
      productId,
      soldQuantity: quantity,
      availableQuantityAtSync,
      shortfallQuantity: Math.max(0, quantity - availableQuantityAtSync),
      underReview: blocked.has(batchId),
      counted: (options.countedAfterSale ?? new Set<string>()).has(batchId),
    };
  });
  const posts =
    !options.entryReviewed &&
    facts.every((f) => f.shortfallQuantity === 0 && !f.underReview && !f.counted);
  return {
    posts,
    batches: facts.map(({ underReview, counted, ...f }) => ({
      ...f,
      reason: posts
        ? null
        : f.shortfallQuantity > 0
          ? "shortfall"
          : counted
            ? "counted_after_sale"
            : underReview
              ? "batch_under_review"
              : options.entryReviewed
                ? "entry_reviewed"
                : "sale_pending",
    })),
  };
}

/** The sale's lines priced exactly as the signed snapshot priced them (D6), with their batches. */
export type ResolvedSaleLine = Readonly<{
  batchId: string;
  productId: string;
  quantity: number;
  unitPriceMinor: number;
  taxMinor: number;
}>;

export function resolveSaleLines(
  command: OfflineSaleCommand,
  snapshot: BranchStockSnapshot,
): ResolvedSaleLine[] {
  return command.lines.map((line) => {
    const known = snapshot.lines.find((l) => l.snapshotLineId === line.snapshotLineId);
    // The policy check has already matched every line to the snapshot.
    if (!known) throw new Error("Offline sale line is not in its snapshot");
    return {
      batchId: known.batchId,
      productId: known.productId,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      taxMinor: line.taxMinor,
    };
  });
}

export type CommittedOfflineSale = Readonly<{
  saleId: string;
  invoiceNo: string;
  outcome: StockPostingOutcome;
}>;

/**
 * Persist one accepted offline sale in the caller's transaction (which also writes its receipt):
 * the sale at its saved prices and tax, its payments on the offline shift, staff and counter
 * attribution, and then either the full stock effect through StockService or (approved D1) a
 * discrepancy case with a sale block on each of its batches. Never a partial posting, a clamp,
 * an availability bypass or invented stock.
 */
export async function commitOfflineSale(
  tx: Tx,
  deps: { stock: StockService; audit: AuditService },
  input: {
    identity: TerminalIdentity;
    command: OfflineSaleCommand;
    commandHash: string;
    snapshot: BranchStockSnapshot;
    lines: ReadonlyArray<ResolvedSaleLine>;
    uploadedByUserId: string;
    /** Slice 4: a manager recorded this refused entry. It always waits on a stock case, opened
     * in their name; the sale keeps its own seller and time. */
    review?: { settlementId: string; settledByUserId: string; soldAt: Date };
  },
): Promise<CommittedOfflineSale> {
  const { identity, command, snapshot, lines, review } = input;
  const { tenantId, branchId } = identity;
  const soldAt = review?.soldAt ?? new Date(command.occurredAt);
  const staffUserId = command.session.staffUserId;

  // Lock every batch first (id order), then read balances and blocks under those locks: a
  // central checkout of the same batch either finishes first or sees what this sale decides.
  const batchIds = [...new Set(lines.map((l) => l.batchId))];
  await deps.stock.lockBatches(tx, tenantId, batchIds);
  const balances = await deps.stock.balances(tx, tenantId, batchIds);
  const blocked = await blockedBatchIds(tx, tenantId, branchId, batchIds);
  const counted = await countsAfterSale(tx, { tenantId, branchId }, batchIds, soldAt);
  const decision = decideStockPosting(
    lines,
    new Map(batchIds.map((id) => [id, balances.get(id)?.available ?? 0])),
    blocked,
    {
      entryReviewed: review !== undefined,
      countedAfterSale: new Set(counted.map((c) => c.batchId)),
    },
  );

  let subtotalMinor = 0;
  let taxMinor = 0;
  for (const line of lines) {
    subtotalMinor += line.quantity * line.unitPriceMinor;
    taxMinor += line.taxMinor;
  }
  let tenderedMinor = 0;
  let changeMinor = 0;
  for (const payment of command.payments) {
    tenderedMinor += payment.method === "cash" ? payment.tenderedMinor : payment.amountMinor;
    if (payment.method === "cash") changeMinor += payment.changeMinor;
  }

  const saleId = randomUUID();
  const period = `${String(soldAt.getUTCFullYear()).slice(2)}${String(soldAt.getUTCMonth() + 1).padStart(2, "0")}`;
  const invoiceNo = await nextDocumentNumber(tx, tenantId, branchId, "sale", `INV-${period}-`, 6);
  const shiftId = command.session.workSessionId;
  await tx.sale.create({
    data: {
      id: saleId,
      tenantId,
      branchId,
      invoiceNo,
      status: SaleStatus.posted,
      soldAt,
      subtotal: fromMinor(subtotalMinor),
      discountTotal: new Prisma.Decimal(0),
      taxTotal: fromMinor(taxMinor),
      grandTotal: fromMinor(command.totalMinor),
      // As online: cash is recorded as tendered, with the change given back beside it.
      amountPaid: fromMinor(tenderedMinor),
      changeDue: fromMinor(changeMinor),
      soldBy: staffUserId,
      terminalId: identity.terminalId,
      tillId: command.session.tillId,
      // Online this names the seller's server staff session; offline, the signed offline sign-in
      // the sale cites (`offline_staff_sign_in.sign_in_id`). The shift is `shiftId`, as online.
      workSessionId: command.staffSignInId,
      shiftId,
      offlineCommandId: command.commandId,
      stockPosting: decision.posts ? SaleStockPosting.posted : SaleStockPosting.pending_reconciliation,
      items: {
        create: lines.map((l) => ({
          tenantId,
          productId: l.productId,
          batchId: l.batchId,
          qty: l.quantity,
          unitPrice: fromMinor(l.unitPriceMinor),
          discountAmount: new Prisma.Decimal(0),
          taxAmount: fromMinor(l.taxMinor),
          lineTotal: fromMinor(l.quantity * l.unitPriceMinor + l.taxMinor),
        })),
      },
      payments: {
        create: command.payments.map((p) =>
          p.method === "cash"
            ? { tenantId, method: PaymentMethod.cash, amount: fromMinor(p.tenderedMinor), reference: null, shiftId }
            : { tenantId, method: PaymentMethod.card, amount: fromMinor(p.amountMinor), reference: p.providerReference, shiftId },
        ),
      },
    },
  });

  let outcome: StockPostingOutcome;
  if (decision.posts) {
    await deps.stock.issue(
      tx,
      { tenantId, branchId, userId: staffUserId, referenceType: "sale", referenceId: saleId, occurredAt: soldAt },
      lines.map((l) => ({
        productId: l.productId,
        batchId: l.batchId,
        qty: l.quantity,
        movementType: StockMovementType.sale_out,
        from: "sellable" as const,
      })),
    );
    outcome = { stockPosting: "posted", reconciliationCaseId: null };
  } else {
    const caseId = randomUUID();
    await tx.offlineStockDiscrepancy.create({
      data: {
        id: caseId,
        tenantId,
        branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        commandId: command.commandId,
        saleId,
        snapshotId: snapshot.snapshotId,
        snapshotVersion: snapshot.snapshotVersion,
        lines: {
          create: decision.batches.map((b) => ({
            batchId: b.batchId,
            productId: b.productId,
            soldQuantity: b.soldQuantity,
            availableQuantityAtSync: b.availableQuantityAtSync,
            shortfallQuantity: b.shortfallQuantity,
            reason: b.reason!,
          })),
        },
        blocks: { create: decision.batches.map((b) => ({ batchId: b.batchId })) },
      },
    });
    await deps.audit.log(
      {
        tenantId,
        branchId,
        actorUserId: review?.settledByUserId ?? input.uploadedByUserId,
        eventName: "offline_stock_discrepancy.opened",
        entityName: "offline_stock_discrepancy",
        entityId: caseId,
        payload: {
          saleId,
          invoiceNo,
          commandId: command.commandId,
          enrollmentId: identity.enrollmentId,
          snapshotId: snapshot.snapshotId,
          snapshotVersion: snapshot.snapshotVersion,
          batches: decision.batches,
          ...(review ? { journalSettlementId: review.settlementId } : {}),
        },
      },
      tx,
    );
    outcome = { stockPosting: "pending_reconciliation", reconciliationCaseId: caseId };
  }

  await deps.audit.log(
    {
      tenantId,
      branchId,
      actorUserId: staffUserId,
      eventName: "sale.offline_committed",
      entityName: "sale",
      entityId: saleId,
      payload: {
        invoiceNo,
        grandTotalMinor: command.totalMinor,
        soldAt: soldAt.toISOString(),
        shiftId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        commandId: command.commandId,
        commandHash: input.commandHash,
        sequence: command.sequence,
        staffSignInId: command.staffSignInId,
        snapshotId: snapshot.snapshotId,
        offlineSessionId: command.offlineSessionId,
        uploadedByUserId: input.uploadedByUserId,
        stockPosting: outcome.stockPosting,
        reconciliationCaseId: outcome.reconciliationCaseId,
        ...(review ? { journalSettlementId: review.settlementId, settledByUserId: review.settledByUserId } : {}),
      },
    },
    tx,
  );
  return { saleId, invoiceNo, outcome };
}
