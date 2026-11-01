import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  containsCardNumber,
  type ExternalCardAttemptRecord,
  type OfflineSaleIncident,
  type OfflineSupportRecord,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { BusinessHoursAcknowledgements } from "./business-hours-acknowledgements.service";
import {
  existingSupportRecord,
  replayOrRetainConflict,
  verifySupportUpload,
  type SupportRecordReceipt,
  type VerifiedSupportUpload,
} from "./support-record-intake";
import { hex, invalid, object, parseEnvelope, parseIdentity, text, uuid } from "./terminal-wire";

type Tx = Prisma.TransactionClient;

const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_PROVIDER_REFERENCE_LENGTH = 64;
const MAX_APPROVAL_CODE_LENGTH = 32;
const INCIDENT_CATEGORIES: readonly string[] = [
  "quantity_error",
  "payment_uncertain",
  "customer_dispute",
  "other",
];

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalid();
  return value as number;
}
/** Trimmed, bounded free text that cannot carry a full card number. */
function evidenceText(value: unknown, max: number): string {
  const result = text(value, max);
  if (result.trim() !== result || containsCardNumber(result)) invalid();
  return result;
}

/** Strict exact-key parser for the shared `OfflineSaleIncident` payload. */
export function parseSaleIncident(raw: unknown): OfflineSaleIncident {
  const p = object(raw, [
    "contractVersion",
    "kind",
    "recordId",
    "identity",
    "saleCommandId",
    "recordedByUserId",
    "staffSignInId",
    "workSessionId",
    "recordedAt",
    "category",
    "description",
  ]);
  if (p.contractVersion !== 1 || p.kind !== "sale_incident") invalid();
  for (const key of [
    "recordId",
    "saleCommandId",
    "recordedByUserId",
    "staffSignInId",
    "workSessionId",
  ] as const)
    uuid(p[key]);
  parseIdentity(p.identity);
  safeInteger(p.recordedAt);
  if (typeof p.category !== "string" || !INCIDENT_CATEGORIES.includes(p.category)) invalid();
  evidenceText(p.description, MAX_DESCRIPTION_LENGTH);
  return p as OfflineSaleIncident;
}

/** Strict exact-key parser for one `ExternalCardAttemptRecord` event; each state has its own keys. */
export function parseCardAttempt(raw: unknown): ExternalCardAttemptRecord {
  const common = [
    "contractVersion",
    "kind",
    "recordId",
    "identity",
    "attemptId",
    "checkoutDraftId",
    "reviewedSaleDigest",
    "amountMinor",
    "staffSignInId",
    "workSessionId",
    "recordedAt",
    "state",
  ];
  const state =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).state : undefined;
  const extra: Record<string, string[]> = {
    prepared: [],
    uncertain: [],
    approved: ["providerReference", "approvalCode", "approvedAt"],
    declined: ["providerReference", "verifiedByUserId"],
    linked_to_sale: ["providerReference", "saleCommandId"],
  };
  if (typeof state !== "string" || !Object.hasOwn(extra, state)) invalid();
  const p = object(raw, [...common, ...extra[state]!]);
  if (p.contractVersion !== 1 || p.kind !== "external_card_attempt") invalid();
  for (const key of [
    "recordId",
    "attemptId",
    "checkoutDraftId",
    "staffSignInId",
    "workSessionId",
  ] as const)
    uuid(p[key]);
  parseIdentity(p.identity);
  hex(p.reviewedSaleDigest);
  safeInteger(p.amountMinor, 1);
  const recordedAt = safeInteger(p.recordedAt);
  if (state !== "prepared" && state !== "uncertain")
    evidenceText(p.providerReference, MAX_PROVIDER_REFERENCE_LENGTH);
  if (state === "approved") {
    evidenceText(p.approvalCode, MAX_APPROVAL_CODE_LENGTH);
    // The card machine approved before this event was recorded.
    if (safeInteger(p.approvedAt) > recordedAt) invalid();
  }
  if (state === "declined") uuid(p.verifiedByUserId);
  if (state === "linked_to_sale") uuid(p.saleCommandId);
  return p as ExternalCardAttemptRecord;
}

/**
 * Intake for counter-signed support evidence (P1 #47; P5 sync calls this, there is no route yet):
 * sale-incident notes and external-card attempt events, plus D8 hours acknowledgements through
 * `record`, which dispatches on the signed `kind`.
 *
 * - Exact-key parse, no coercion, no card numbers in free text; identity bound to the caller's
 *   tenant and branch; Ed25519 against the enrollment's pinned key; device clock not ahead.
 * - Idempotent per tenant + enrollment + recordId across all support kinds: the same bytes replay
 *   the stored receipt; changed content returns `conflict` and is retained for repair.
 * - Stored as `held` until P3/P5 verify the sign-in, shift, sale and card-machine result cited.
 *   A revoked device's upload is retained, still held. A card event whose draft, digest, amount,
 *   provider reference or linked sale disagrees with an earlier event of the same attempt is
 *   retained as `attempt_mismatch`, so one attempt cannot be paid or linked twice unnoticed.
 *
 * These records never post a sale, payment, stock, cash or refund effect and authorize nothing.
 */
@Injectable()
export class OfflineSupportRecords {
  constructor(
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly hoursAcknowledgements: BusinessHoursAcknowledgements,
  ) {}

  /** One entry point for the whole `OfflineSupportRecord` stream. */
  async record(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    now: number = Date.now(),
  ): Promise<SupportRecordReceipt> {
    const payload = parseEnvelope(raw).payload;
    const kind =
      payload && typeof payload === "object" ? (payload as Record<string, unknown>).kind : undefined;
    switch (kind) {
      case "sale_incident":
        return this.recordIncident(tx, user, branchId, raw, now);
      case "external_card_attempt":
        return this.recordCardAttempt(tx, user, branchId, raw, now);
      case "business_hours_acknowledgement":
        return this.hoursAcknowledgements.record(tx, user, branchId, raw, now);
      default:
        return invalid();
    }
  }

  async recordIncident(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    now: number = Date.now(),
  ): Promise<SupportRecordReceipt> {
    const upload = await verifySupportUpload(tx, this.access, user, branchId, raw, parseSaleIncident, now);
    const replay = await this.replay(tx, user, branchId, upload);
    if (replay) return replay;
    const incident = upload.record;
    return this.save(tx, user, branchId, upload, upload.revoked ? "enrollment_revoked" : "sale_unverified", {
      saleCommandId: incident.saleCommandId,
      recordedByUserId: incident.recordedByUserId,
      incidentCategory: incident.category,
      description: incident.description,
    });
  }

  async recordCardAttempt(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    raw: unknown,
    now: number = Date.now(),
  ): Promise<SupportRecordReceipt> {
    // Serialize every event of one attempt so the binding comparison below sees them all.
    const upload = await verifySupportUpload(
      tx,
      this.access,
      user,
      branchId,
      raw,
      parseCardAttempt,
      now,
      (r) => [`card_attempt:${user.tenantId}:${r.identity.enrollmentId}:${r.attemptId}`],
    );
    const replay = await this.replay(tx, user, branchId, upload);
    if (replay) return replay;
    const event = upload.record;
    const earlier = await tx.offlineSupportRecord.findMany({
      where: {
        tenantId: user.tenantId,
        enrollmentId: event.identity.enrollmentId,
        kind: "external_card_attempt",
        attemptId: event.attemptId,
      },
      select: {
        checkoutDraftId: true,
        reviewedSaleDigest: true,
        amountMinor: true,
        providerReference: true,
        approvalCode: true,
        approvedAt: true,
        saleCommandId: true,
      },
    });
    const reference = "providerReference" in event ? event.providerReference : null;
    const saleCommandId = event.state === "linked_to_sale" ? event.saleCommandId : null;
    const approval = event.state === "approved" ? { code: event.approvalCode, at: event.approvedAt } : null;
    const mismatch = earlier.some(
      (e) =>
        e.checkoutDraftId !== event.checkoutDraftId ||
        e.reviewedSaleDigest !== event.reviewedSaleDigest ||
        e.amountMinor !== BigInt(event.amountMinor) ||
        (reference !== null && e.providerReference !== null && e.providerReference !== reference) ||
        (saleCommandId !== null && e.saleCommandId !== null && e.saleCommandId !== saleCommandId) ||
        // Two approvals of one attempt must be the same approval.
        (approval !== null && e.approvalCode !== null &&
          (e.approvalCode !== approval.code || e.approvedAt?.getTime() !== approval.at)),
    );
    const heldReason = upload.revoked
      ? "enrollment_revoked"
      : mismatch
        ? "attempt_mismatch"
        : "payment_unverified";
    return this.save(tx, user, branchId, upload, heldReason, {
      attemptId: event.attemptId,
      checkoutDraftId: event.checkoutDraftId,
      reviewedSaleDigest: event.reviewedSaleDigest,
      amountMinor: BigInt(event.amountMinor),
      cardState: event.state,
      providerReference: reference,
      approvalCode: event.state === "approved" ? event.approvalCode : null,
      approvedAt: event.state === "approved" ? new Date(event.approvedAt) : null,
      verifiedByUserId: event.state === "declined" ? event.verifiedByUserId : null,
      saleCommandId,
    });
  }

  private async replay(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    upload: VerifiedSupportUpload<OfflineSupportRecord>,
  ): Promise<SupportRecordReceipt | null> {
    const { record } = upload;
    const existing = await existingSupportRecord(
      tx,
      user.tenantId,
      record.identity.enrollmentId,
      record.recordId,
    );
    return existing ? replayOrRetainConflict(tx, this.audit, user, branchId, upload, existing) : null;
  }

  private async save(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    upload: VerifiedSupportUpload<OfflineSaleIncident | ExternalCardAttemptRecord>,
    heldReason: string,
    fields: Omit<
      Prisma.OfflineSupportRecordUncheckedCreateInput,
      | "tenantId"
      | "branchId"
      | "terminalId"
      | "enrollmentId"
      | "keyId"
      | "kind"
      | "recordId"
      | "recordHash"
      | "envelope"
      | "staffSignInId"
      | "workSessionId"
      | "recordedAt"
      | "receivedByUserId"
    >,
  ): Promise<SupportRecordReceipt> {
    const { record, recordHash } = upload;
    const { identity } = record;
    const saved = await tx.offlineSupportRecord.create({
      data: {
        tenantId: user.tenantId,
        branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        kind: record.kind,
        recordId: record.recordId,
        recordHash,
        envelope: upload.envelope as unknown as Prisma.InputJsonValue,
        staffSignInId: record.staffSignInId,
        workSessionId: record.workSessionId,
        recordedAt: new Date(record.recordedAt),
        ...fields,
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
        eventName:
          record.kind === "sale_incident"
            ? "terminal.sale_incident_received"
            : "terminal.card_attempt_received",
        entityName: "offline_support_record",
        entityId: saved.id,
        // No free text or card-machine codes in the audit trail; the record holds them.
        payload: {
          recordId: record.recordId,
          recordHash,
          terminalId: identity.terminalId,
          enrollmentId: identity.enrollmentId,
          ...(record.kind === "sale_incident"
            ? { saleCommandId: record.saleCommandId, category: record.category }
            : { attemptId: record.attemptId, state: record.state, amountMinor: record.amountMinor }),
          heldReason,
        },
      },
      tx,
    );
    return { recordId: record.recordId, recordHash, status: "held", heldReason, replayed: false };
  }
}
