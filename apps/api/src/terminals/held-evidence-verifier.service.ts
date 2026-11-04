import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import type {
  ExternalCardAttemptRecord,
  OfflineBusinessHoursAcknowledgement,
  OfflineGrant,
  OfflineSaleIncident,
  Signed,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  hoursAcknowledgementRefusal,
  parseOutage,
  parseStaffSignIn,
  supportRecordRefusal,
  type HeldEvidenceRefusal,
} from "./held-evidence-verification";
import { denied, uuid } from "./terminal-wire";

type Tx = Prisma.TransactionClient;

/**
 * What verification concluded. `status` is the record's stored status afterwards: `accepted` or
 * `rejected` are final; `held` means something P3 does not decide is still missing, named by
 * `reason`. `decided` is true only on the call that moved the record.
 */
export type HeldEvidenceOutcome = Readonly<{
  recordId: string;
  status: "held" | "accepted" | "rejected";
  reason: string | null;
  decided: boolean;
}>;

/**
 * Held reasons that P3 does not settle: the device was revoked or retired before it uploaded
 * (kept for P5 reconciliation and loss review, never accepted here), or a card attempt's events
 * disagree with each other (P5 reads the whole attempt).
 */
const NOT_P3_TO_DECIDE: readonly string[] = ["enrollment_revoked", "attempt_mismatch"];

/**
 * P3 #49: verifies held offline evidence against the grants this server issued. P5 sync calls
 * it, on its own transaction, after it has verified the device journal the sign-in and outage
 * evidence come from; there is no HTTP route.
 *
 * - The grant is looked up only among `offline_authority_issuance` rows of the record's own
 *   tenant, branch and enrollment, so another counter's grant is as unknown as a made-up one.
 * - Takes the same record lock as intake, so a verification and a replayed upload of the same
 *   record serialize. A decided record is returned as stored: the outcome moves once (the
 *   database trigger from P1 enforces it).
 * - D8 acknowledgements move to `accepted` or `rejected` with the reason.
 * - Sale incidents and card-attempt events move to `rejected` when the grant or staff evidence
 *   fails. When it passes they stay `held` under their existing reason: the sale and the card
 *   result are P5's to verify. They never post a sale, stock, cash or refund effect.
 */
@Injectable()
export class HeldEvidenceVerifier {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async verifyHoursAcknowledgement(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    input: Readonly<{ enrollmentId: string; recordId: string; managerSignIn: unknown; outage: unknown }>,
    now: number = Date.now(),
  ): Promise<HeldEvidenceOutcome> {
    const managerSignIn = parseStaffSignIn(input.managerSignIn);
    const outage = parseOutage(input.outage);
    const key = await this.lock(tx, user, branchId, input);
    const row = await tx.businessHoursAcknowledgement.findUnique({
      where: { tenantId_enrollmentId_recordId: key },
      select: { id: true, branchId: true, status: true, heldReason: true, envelope: true },
    });
    if (!row || row.branchId !== branchId) denied("IDENTITY_MISMATCH");
    const settled = this.settled(input.recordId, row);
    if (settled) return settled;

    const ack = (row.envelope as unknown as Signed<OfflineBusinessHoursAcknowledgement>).payload;
    const grant = await this.issuedGrant(tx, user.tenantId, branchId, input.enrollmentId, ack.grantId);
    const refusal = hoursAcknowledgementRefusal(grant, ack, managerSignIn, outage);
    const status = refusal ? "rejected" : "accepted";
    const moved = await tx.businessHoursAcknowledgement.updateMany({
      where: { id: row.id, tenantId: user.tenantId, status: "held" },
      data: { status, heldReason: refusal, verifiedAt: new Date(now) },
    });
    if (moved.count !== 1) throw new Error("Held acknowledgement changed under its record lock");
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: refusal
          ? "terminal.hours_acknowledgement_rejected"
          : "terminal.hours_acknowledgement_accepted",
        entityName: "business_hours_acknowledgement",
        entityId: row.id,
        payload: {
          recordId: input.recordId,
          enrollmentId: input.enrollmentId,
          grantId: ack.grantId,
          grantVersion: ack.grantVersion,
          managerSignInId: ack.managerSignInId,
          managerUserId: managerSignIn.session.staffUserId,
          offlineSessionId: outage.offlineSessionId,
          reason: refusal,
        },
      },
      tx,
    );
    return { recordId: input.recordId, status, reason: refusal, decided: true };
  }

  async verifySupportRecord(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    input: Readonly<{ enrollmentId: string; recordId: string; staffSignIn: unknown }>,
    now: number = Date.now(),
  ): Promise<HeldEvidenceOutcome> {
    const staffSignIn = parseStaffSignIn(input.staffSignIn);
    const key = await this.lock(tx, user, branchId, input);
    const row = await tx.offlineSupportRecord.findUnique({
      where: { tenantId_enrollmentId_recordId: key },
      select: { id: true, branchId: true, kind: true, status: true, heldReason: true, envelope: true },
    });
    if (!row || row.branchId !== branchId) denied("IDENTITY_MISMATCH");
    const settled = this.settled(input.recordId, row);
    if (settled) return settled;

    const record = (row.envelope as unknown as Signed<OfflineSaleIncident | ExternalCardAttemptRecord>)
      .payload;
    const namedStaffUserIds =
      record.kind === "sale_incident"
        ? [record.recordedByUserId]
        : record.state === "declined"
          ? [record.verifiedByUserId]
          : [];
    const grant = await this.issuedGrant(
      tx, user.tenantId, branchId, input.enrollmentId, staffSignIn.grantId,
    );
    const refusal = supportRecordRefusal(grant, { ...record, namedStaffUserIds }, staffSignIn);
    if (!refusal)
      return { recordId: input.recordId, status: "held", reason: row.heldReason, decided: false };

    const moved = await tx.offlineSupportRecord.updateMany({
      where: { id: row.id, tenantId: user.tenantId, status: "held" },
      data: { status: "rejected", heldReason: refusal, verifiedAt: new Date(now) },
    });
    if (moved.count !== 1) throw new Error("Held support record changed under its record lock");
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.support_record_rejected",
        entityName: "offline_support_record",
        entityId: row.id,
        payload: {
          kind: row.kind,
          recordId: input.recordId,
          enrollmentId: input.enrollmentId,
          staffSignInId: record.staffSignInId,
          grantId: staffSignIn.grantId,
          reason: refusal,
        },
      },
      tx,
    );
    return { recordId: input.recordId, status: "rejected", reason: refusal, decided: true };
  }

  /** The verifying user is live at the branch; then the intake's record lock. */
  private async lock(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    input: Readonly<{ enrollmentId: string; recordId: string }>,
  ) {
    uuid(input.enrollmentId);
    uuid(input.recordId);
    await this.access.resolveLive(user, branchId, tx);
    const key = `support:${user.tenantId}:${input.enrollmentId}:${input.recordId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    return { tenantId: user.tenantId, enrollmentId: input.enrollmentId, recordId: input.recordId };
  }

  /** A record already decided, or held for a reason P3 does not settle, is returned as stored. */
  private settled(
    recordId: string,
    row: { status: string; heldReason: string | null },
  ): HeldEvidenceOutcome | null {
    if (row.status === "held" && !NOT_P3_TO_DECIDE.includes(row.heldReason ?? "")) return null;
    return {
      recordId,
      status: row.status as HeldEvidenceOutcome["status"],
      reason: row.heldReason,
      decided: false,
    };
  }

  /** The grant with this ID issued to this exact enrollment, or null. */
  private async issuedGrant(
    tx: Tx,
    tenantId: string,
    branchId: string,
    enrollmentId: string,
    grantId: string,
  ): Promise<OfflineGrant | null> {
    const issuance = await tx.offlineAuthorityIssuance.findFirst({
      where: { tenantId, branchId, enrollmentId, grant: { path: ["payload", "grantId"], equals: grantId } },
      select: { grant: true },
    });
    return issuance ? (issuance.grant as unknown as Signed<OfflineGrant>).payload : null;
  }
}

export type { HeldEvidenceRefusal };
