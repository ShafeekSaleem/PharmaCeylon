import type { OfflineJournalSettlement, Prisma } from "@prisma/client";
import { offlineJournalHead } from "../terminals/journal/journal-chain";
import { approvalMaterialDigest } from "./approval-material-digest";

type Db = Prisma.TransactionClient;
type Settlement = Pick<
  OfflineJournalSettlement,
  | "id"
  | "tenantId"
  | "branchId"
  | "reviewId"
  | "enrollmentId"
  | "commandId"
  | "sequence"
  | "recordHash"
  | "decision"
  | "reason"
>;

/**
 * Locks one journal settlement (FOR UPDATE): every path that touches one takes it first, then the
 * enrollment's journal lock, then any till or batch row. Null when it is not at this branch.
 */
export async function lockOfflineJournalSettlement(
  db: Db,
  tenantId: string,
  branchId: string,
  settlementId: string,
) {
  const binding = await db.offlineJournalSettlement.findFirst({
    where: { tenantId, branchId, id: settlementId },
    select: { id: true, enrollmentId: true },
  });
  if (!binding) return null;
  await db.$queryRaw`SELECT id FROM offline_journal_settlement WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${settlementId}::uuid FOR UPDATE`;
  return binding;
}

/**
 * P5 #51 slice 4: what approving a journal settlement covers. The refused entry exactly as the
 * counter signed it (identity, command ID, sequence, digest), the decision and reason, and the
 * accepted chain head it would follow. A different entry taking that place in the chain changes the
 * head, so the approval no longer matches. Read on the caller's client after the settlement lock;
 * the settling transaction also holds the enrollment's journal lock, so the head can't move.
 */
export async function offlineJournalSettlementFacts(
  db: Db,
  settlement: Settlement,
) {
  const review = await db.offlineJournalReview.findFirst({
    where: {
      tenantId: settlement.tenantId,
      branchId: settlement.branchId,
      id: settlement.reviewId,
    },
    select: {
      id: true,
      terminalId: true,
      enrollmentId: true,
      keyId: true,
      recordKind: true,
      outcome: true,
    },
  });
  if (!review || review.enrollmentId !== settlement.enrollmentId) return null;
  const head = await offlineJournalHead(db, {
    tenantId: settlement.tenantId,
    enrollmentId: settlement.enrollmentId,
  });
  const material: Prisma.InputJsonObject = {
    items: [
      {
        reviewId: review.id,
        terminalId: review.terminalId,
        enrollmentId: review.enrollmentId,
        keyId: review.keyId,
        recordKind: review.recordKind,
        outcome: review.outcome,
        commandId: settlement.commandId,
        sequence: Number(settlement.sequence),
        recordHash: settlement.recordHash,
      },
    ],
    decision: settlement.decision,
    reason: settlement.reason,
    chain: {
      headSequence: head ? Number(head.offlineSequence) : 0,
      headHash: head?.requestDigest ?? null,
    },
  };
  return { review, head, material };
}

export const offlineJournalSettlementDigest = (
  material: Prisma.InputJsonObject,
) => approvalMaterialDigest("offline_journal_settlement", material);
