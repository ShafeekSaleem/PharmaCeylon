import { CounterMismatchStatus, type Prisma } from "@prisma/client";
import type { CounterMismatchKind } from "@pharmaceylon/shared";
import { denied } from "../terminals/terminal-wire";
import type { ApprovalAction } from "./approval-documents";

/** The executions a counter mismatch report can hold, by the approval action that runs them. */
export const MISMATCH_HELD_ACTIONS: Partial<Record<ApprovalAction, CounterMismatchKind>> = {
  "prepared_receipt.post": "prepared_receipt",
  "held_delivery.post": "held_delivery",
  "transfer.ship": "transfer_ship",
};

/**
 * P6 #52 decision 1: the counter said this approved document doesn't match what is in front of
 * it. Until a new approval replaces the one it saw (a corrected version), or the approver keeps
 * the document as it is, that approval does not execute. `approvalId` null is a transfer out
 * whose approval is waived: the report then holds the transfer itself until it is dismissed.
 */
export async function assertNoMismatchHold(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    branchId: string;
    kind: CounterMismatchKind;
    documentId: string;
    approvalId: string | null;
  },
): Promise<void> {
  const held = await tx.counterMismatchReport.findFirst({
    where: {
      tenantId: input.tenantId,
      branchId: input.branchId,
      kind: input.kind,
      documentId: input.documentId,
      approvalId: input.approvalId,
      status: CounterMismatchStatus.open,
    },
    select: { id: true },
  });
  if (held) denied("MISMATCH_REPORTED");
}
