import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  MAX_HOURS_EXTENSION_MS,
  type OfflineBusinessHoursAcknowledgement,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  existingSupportRecord,
  replayOrRetainConflict,
  SUPPORT_RECORD_CLOCK_SKEW_MS,
  verifySupportUpload,
  type SupportRecordReceipt,
} from "./support-record-intake";
import { invalid, object, parseIdentity, text, uuid } from "./terminal-wire";

type Tx = Prisma.TransactionClient;

/** A device clock this far ahead of the server is not trusted evidence. */
export const ACKNOWLEDGEMENT_CLOCK_SKEW_MS = SUPPORT_RECORD_CLOCK_SKEW_MS;
const MAX_REASON_LENGTH = 500;

/** Outcome of recording one signed acknowledgement; identical for a first upload and a replay. */
export type HoursAcknowledgementReceipt = SupportRecordReceipt;

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}

/** Strict exact-key parser for the shared `OfflineBusinessHoursAcknowledgement` payload. */
export function parseHoursAcknowledgement(raw: unknown): OfflineBusinessHoursAcknowledgement {
  const p = object(raw, [
    "contractVersion",
    "kind",
    "recordId",
    "identity",
    "grantId",
    "grantVersion",
    "nominationVersion",
    "offlineSessionId",
    "managerSignInId",
    "recordedAt",
    "startsAt",
    "endsAt",
    "reason",
  ]);
  if (p.contractVersion !== 1 || p.kind !== "business_hours_acknowledgement") invalid();
  for (const key of ["recordId", "grantId", "offlineSessionId", "managerSignInId"] as const)
    uuid(p[key]);
  parseIdentity(p.identity);
  safeInteger(p.grantVersion, 1);
  safeInteger(p.nominationVersion, 1);
  const recordedAt = safeInteger(p.recordedAt);
  const startsAt = safeInteger(p.startsAt);
  const endsAt = safeInteger(p.endsAt);
  const reason = text(p.reason, MAX_REASON_LENGTH);
  // Same bounds as offlineGrantTimeError, plus one grant's worth of time at most.
  if (
    reason.trim() !== reason ||
    !reason ||
    recordedAt > startsAt ||
    startsAt >= endsAt ||
    endsAt - startsAt > MAX_HOURS_EXTENSION_MS
  )
    invalid();
  return p as OfflineBusinessHoursAcknowledgement;
}

/**
 * Revised D8 evidence intake: a prepared manager's after-hours acknowledgement, signed by an
 * offline counter and uploaded when it reconnects (P5 sync calls this; there is no route yet).
 *
 * - Exact-key parse, no coercion; identity must match the caller's tenant and branch.
 * - The Ed25519 signature is checked against the enrollment's pinned key, never a supplied one.
 * - Idempotent per tenant + enrollment + recordId on the SHA-256 of the signed payload, sharing
 *   one ID space with the other support records (`support-record-intake.ts`): the same bytes
 *   replay the stored receipt; different content under the same ID returns `conflict` and is
 *   retained for repair.
 * - Stored as `held`. The grant, nomination and prepared-manager sign-in it cites do not exist
 *   server-side yet (P3 grants, P2 PIN sign-ins); verification moves it to accepted/rejected.
 *   A revoked device's upload is retained for reconciliation, still held.
 *
 * This record never posts a sale, shift, stock or cash effect, and never authorizes an online
 * command: online after-hours selling uses a web-approved business extension.
 */
@Injectable()
export class BusinessHoursAcknowledgements {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async record(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    now: number = Date.now(),
  ): Promise<HoursAcknowledgementReceipt> {
    const upload = await verifySupportUpload(
      tx,
      this.access,
      user,
      branchId,
      raw,
      parseHoursAcknowledgement,
      now,
    );
    const { envelope, record: ack, recordHash } = upload;
    const { identity } = ack;
    const existing = await existingSupportRecord(tx, user.tenantId, identity.enrollmentId, ack.recordId);
    if (existing) return replayOrRetainConflict(tx, this.audit, user, branchId, upload, existing);

    const heldReason = upload.revoked ? "enrollment_revoked" : "grant_unverified";
    const saved = await tx.businessHoursAcknowledgement.create({
      data: {
        tenantId: user.tenantId,
        branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        recordId: ack.recordId,
        recordHash,
        envelope: envelope as unknown as Prisma.InputJsonValue,
        grantId: ack.grantId,
        grantVersion: ack.grantVersion,
        nominationVersion: ack.nominationVersion,
        offlineSessionId: ack.offlineSessionId,
        managerSignInId: ack.managerSignInId,
        recordedAt: new Date(ack.recordedAt),
        startsAt: new Date(ack.startsAt),
        endsAt: new Date(ack.endsAt),
        reason: ack.reason,
        status: "held",
        heldReason,
        receivedByUserId: user.userId,
      },
    });
    await this.audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.hours_acknowledgement_received",
        entityName: "business_hours_acknowledgement",
        entityId: saved.id,
        payload: {
          recordId: ack.recordId,
          recordHash,
          terminalId: identity.terminalId,
          enrollmentId: identity.enrollmentId,
          managerSignInId: ack.managerSignInId,
          startsAt: ack.startsAt,
          endsAt: ack.endsAt,
          heldReason,
        },
      },
      tx,
    );
    return { recordId: ack.recordId, recordHash, status: "held", heldReason, replayed: false };
  }
}
