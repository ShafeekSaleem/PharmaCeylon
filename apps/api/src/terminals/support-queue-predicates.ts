import type { Prisma } from "@prisma/client";

/**
 * Support evidence held reasons that only a manager can clear (P5 #51). Shared by payment-recovery
 * reads and `SupportEvidenceReconciler.listHeld`, so daily work can reuse the same predicates later.
 */
export const SUPPORT_MANAGER_HELD_REASONS = [
  "enrollment_revoked",
  "attempt_mismatch",
  "card_payment_mismatch",
  "sale_not_honoured",
  "card_not_used",
] as const;

export type SupportManagerHeldReason = (typeof SUPPORT_MANAGER_HELD_REASONS)[number];

export function heldSupportRecordWhere(
  tenantId: string,
  branchId: string,
): Prisma.OfflineSupportRecordWhereInput {
  return { tenantId, branchId, status: "held" };
}

export function paymentRecoveryWhere(
  tenantId: string,
  branchId: string,
  heldReason?: SupportManagerHeldReason,
): Prisma.OfflineSupportRecordWhereInput {
  return {
    ...heldSupportRecordWhere(tenantId, branchId),
    kind: "external_card_attempt",
    heldReason: heldReason
      ? heldReason
      : { in: [...SUPPORT_MANAGER_HELD_REASONS] },
  };
}

export function incidentNotesWhere(
  tenantId: string,
  branchId: string,
  status: "accepted" | "held",
): Prisma.OfflineSupportRecordWhereInput {
  return {
    tenantId,
    branchId,
    kind: "sale_incident",
    status,
    ...(status === "held"
      ? { heldReason: { in: [...SUPPORT_MANAGER_HELD_REASONS] } }
      : {}),
  };
}