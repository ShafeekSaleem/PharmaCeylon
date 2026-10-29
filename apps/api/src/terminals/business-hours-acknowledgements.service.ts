import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  MAX_HOURS_EXTENSION_MS,
  type OfflineBusinessHoursAcknowledgement,
  type Signed,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  commandText,
  denied,
  invalid,
  object,
  parseEnvelope,
  parseIdentity,
  sha256,
  text,
  uuid,
  verifySignature,
} from "./terminal-wire";

type Tx = Prisma.TransactionClient;

/** A device clock this far ahead of the server is not trusted evidence. */
export const ACKNOWLEDGEMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_REASON_LENGTH = 500;

/** Outcome of recording one signed acknowledgement; identical for a first upload and a replay. */
export type HoursAcknowledgementReceipt = Readonly<{
  recordId: string;
  recordHash: string;
  status: "held" | "accepted" | "rejected";
  heldReason: string | null;
  replayed: boolean;
}>;

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
 * - Idempotent per tenant + enrollment + recordId on the SHA-256 of the signed payload: the same
 *   bytes replay the stored receipt; different content under the same ID is REPLAY_CONFLICT.
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
    const envelope = parseEnvelope(raw) as Signed<OfflineBusinessHoursAcknowledgement>;
    const ack = parseHoursAcknowledgement(envelope.payload);
    const { identity } = ack;
    if (
      identity.tenantId !== user.tenantId ||
      identity.branchId !== branchId ||
      envelope.keyId !== identity.keyId
    )
      denied("IDENTITY_MISMATCH");
    if (ack.recordedAt > now + ACKNOWLEDGEMENT_CLOCK_SKEW_MS) denied("CLOCK_UNTRUSTED");
    // The uploading staff member must be live at this branch; the acknowledging manager's own
    // authority is checked against the grant's prepared staff when the record is verified.
    await this.access.resolveLive(user, branchId, tx);

    const key = `hours_ack:${user.tenantId}:${identity.enrollmentId}:${ack.recordId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    const enrollment = await tx.terminalEnrollment.findFirst({
      where: {
        id: identity.enrollmentId,
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
      },
      select: { publicKeyHex: true, revokedAt: true, terminal: { select: { retiredAt: true } } },
    });
    if (!enrollment) denied("IDENTITY_MISMATCH");
    verifySignature(envelope, enrollment.publicKeyHex);
    const recordHash = sha256(commandText(envelope.payload));

    const existing = await tx.businessHoursAcknowledgement.findUnique({
      where: {
        tenantId_enrollmentId_recordId: {
          tenantId: user.tenantId,
          enrollmentId: identity.enrollmentId,
          recordId: ack.recordId,
        },
      },
    });
    if (existing) {
      if (existing.recordHash !== recordHash)
        throw new ConflictException({
          code: "REPLAY_CONFLICT",
          message: "This acknowledgement ID was already recorded with different content",
        });
      return {
        recordId: existing.recordId,
        recordHash,
        status: existing.status as HoursAcknowledgementReceipt["status"],
        heldReason: existing.heldReason,
        replayed: true,
      };
    }

    const heldReason =
      enrollment.revokedAt || enrollment.terminal.retiredAt ? "enrollment_revoked" : "grant_unverified";
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
