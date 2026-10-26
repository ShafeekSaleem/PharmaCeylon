import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  approvalUseError,
  type ManagementApprovalEvidence,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import {
  boundedCanonical,
  denied,
  hex,
  text,
  uuid,
} from "../terminals/terminal-wire";
import { AccessService, assertMayApprove } from "./access.service";
import {
  approvalAction,
  approvalDocument,
  type ApprovalAction,
} from "./approval-documents";
import type { RequestUser } from "./interfaces/authenticated-request.interface";

type Tx = Prisma.TransactionClient;
type Stored = Prisma.ManagementApprovalGetPayload<{}>;
const evidence = (row: Stored): ManagementApprovalEvidence => ({
  approvalId: row.id,
  document: {
    tenantId: row.tenantId,
    branchId: row.branchId,
    documentType: row.documentType,
    documentId: row.documentId,
    documentVersion: row.documentVersion,
    documentDigest: row.documentDigest,
    requestedByUserId: row.requestedByUserId,
  },
  authorizedAction: row.authorizedAction,
  approvedByUserId: row.approvedByUserId,
  approvedAt: row.approvedAt.getTime(),
  expiresAt: row.expiresAt?.getTime() ?? null,
  status: row.revokedAt ? "revoked" : "approved",
  policyVersion: row.policyVersion,
  reason: row.reason,
});

/** Caller-owned READ COMMITTED transaction; lock order is domain parent then evidence.
 * This records authorization only, never domain status/stock/cash/refund execution.
 */
@Injectable()
export class ManagementApprovalsService {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async preview(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    action: ApprovalAction,
    documentId: string,
  ) {
    const doc = await approvalDocument(
      tx,
      user.tenantId,
      branchId,
      action,
      documentId,
      "approval",
    );
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(approvalAction(action).approvalPermission))
      denied("PERMISSION_DENIED");
    return doc;
  }

  async issue(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    action: ApprovalAction,
    documentId: string,
    input: {
      approvalId: string;
      expectedVersion: number;
      expectedDigest: string;
      reason: string;
      expiresAt: number | null;
    },
  ) {
    uuid(input.approvalId);
    hex(input.expectedDigest);
    text(input.reason, 500);
    if (
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    )
      denied("APPROVAL_INVALID");
    const doc = await this.preview(tx, user, branchId, action, documentId);
    // Recheck current self-approval settings after the document lock wait.
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(approvalAction(action).approvalPermission))
      denied("PERMISSION_DENIED");
    assertMayApprove(
      actor,
      doc.requesters,
      doc.identity.documentType,
    );
    if (
      doc.identity.documentVersion !== input.expectedVersion ||
      doc.identity.documentDigest !== input.expectedDigest
    )
      denied("APPROVAL_STALE");
    const prior = await tx.managementApproval.findFirst({
      where: { tenantId: user.tenantId, branchId, id: input.approvalId },
    });
    if (prior) {
      if (
        boundedCanonical(evidence(prior).document) !==
          boundedCanonical(doc.identity) ||
        prior.authorizedAction !== action ||
        prior.approvedByUserId !== user.userId ||
        prior.reason !== input.reason ||
        (prior.expiresAt?.getTime() ?? null) !== input.expiresAt ||
        prior.revokedAt
      )
        denied("APPROVAL_INVALID");
      return evidence(prior);
    }
    const now = Date.now();
    if (
      input.expiresAt !== null &&
      (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now)
    )
      denied("APPROVAL_EXPIRED");
    const row = await tx.managementApproval.create({
      data: {
        id: input.approvalId,
        ...doc.identity,
        material: doc.material,
        authorizedAction: action,
        approvedByUserId: user.userId,
        approvedAt: new Date(now),
        expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt),
        reason: input.reason,
      },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "management_approval.issued",
        entityName: "management_approval",
        entityId: row.id,
        payload: {
          action,
          documentId,
          documentVersion: row.documentVersion,
          documentDigest: row.documentDigest,
          requestedByUserId: row.requestedByUserId,
          approvedByUserId: user.userId,
        },
      },
      tx,
    );
    return evidence(row);
  }

  async requireForExecution(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    action: ApprovalAction,
    documentId: string,
    approvalId: string,
  ) {
    const doc = await approvalDocument(
      tx,
      user.tenantId,
      branchId,
      action,
      documentId,
      "execution",
    );
    uuid(approvalId);
    await tx.$queryRaw`SELECT id FROM management_approval WHERE tenant_id = ${user.tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${approvalId}::uuid FOR UPDATE`;
    const actor = await this.access.resolveLive(user, branchId, tx);
    const policy = approvalAction(action);
    if (!actor.has(policy.executionPermission)) denied("PERMISSION_DENIED");
    const row = await tx.managementApproval.findFirst({
      where: { tenantId: user.tenantId, branchId, id: approvalId },
    });
    if (!row) denied("APPROVAL_REQUIRED");
    let approver;
    try {
      approver = await this.access.resolveApprovalAuthority(
        { tenantId: user.tenantId, userId: row.approvedByUserId },
        branchId,
        tx,
      );
    } catch {
      denied("APPROVAL_INVALID");
    }
    const approval = evidence(row);
    const error = approvalUseError(approval, {
      currentDocument: doc.identity,
      authorizedAction: action,
      trustedNow: Date.now(),
      approverStillAuthorized: approver.has(policy.approvalPermission),
      mayApproveOwnRequests: approver.canSelfApprove,
    });
    if (error) denied(error);
    assertMayApprove(approver, doc.requesters, doc.identity.documentType);
    return approval;
  }

  async revoke(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    approvalId: string,
    reason: string,
  ) {
    uuid(approvalId);
    text(reason, 500);
    const row = await tx.managementApproval.findFirst({
      where: { tenantId: user.tenantId, branchId, id: approvalId },
    });
    if (!row) denied("APPROVAL_INVALID");
    // Same lock order as execution, even after the document has completed/cancelled.
    // The row's exact action is server-persisted and the resolver still validates its identity.
    await this.lockDocumentForRevocation(tx, row);
    await tx.$queryRaw`SELECT id FROM management_approval WHERE tenant_id = ${user.tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${approvalId}::uuid FOR UPDATE`;
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(approvalAction(row.authorizedAction).approvalPermission))
      denied("PERMISSION_DENIED");
    const changed = await tx.managementApproval.updateMany({
      where: {
        tenantId: user.tenantId,
        branchId,
        id: approvalId,
        revokedAt: null,
      },
      data: { revokedAt: new Date(), revocationReason: reason },
    });
    if (changed.count)
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "management_approval.revoked",
          entityName: "management_approval",
          entityId: approvalId,
          payload: { reason },
        },
        tx,
      );
  }

  private async lockDocumentForRevocation(tx: Tx, row: Stored) {
    if (row.documentType === "stocktake")
      await tx.$queryRaw`SELECT id FROM stocktake WHERE tenant_id = ${row.tenantId}::uuid AND branch_id = ${row.branchId}::uuid AND id = ${row.documentId}::uuid FOR UPDATE`;
    else if (row.documentType === "purchase_order")
      await tx.$queryRaw`SELECT id FROM purchase_order WHERE tenant_id = ${row.tenantId}::uuid AND branch_id = ${row.branchId}::uuid AND id = ${row.documentId}::uuid FOR UPDATE`;
    else if (row.documentType === "transfer")
      await tx.$queryRaw`SELECT id FROM transfer WHERE tenant_id = ${row.tenantId}::uuid AND from_branch_id = ${row.branchId}::uuid AND id = ${row.documentId}::uuid FOR UPDATE`;
    else if (row.documentType === "goods_return")
      await tx.$queryRaw`SELECT id FROM goods_return WHERE tenant_id = ${row.tenantId}::uuid AND branch_id = ${row.branchId}::uuid AND id = ${row.documentId}::uuid FOR UPDATE`;
    else denied("APPROVAL_INVALID");
  }
}
