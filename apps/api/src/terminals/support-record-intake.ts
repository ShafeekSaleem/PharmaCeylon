import type { Prisma } from "@prisma/client";
import type { OfflineSupportRecord, Signed, TerminalIdentity } from "@pharmaceylon/shared";
import type { AuditService } from "../audit/audit.service";
import type { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { commandText, denied, parseEnvelope, sha256, verifySignature } from "./terminal-wire";

type Tx = Prisma.TransactionClient;

/** A device clock this far ahead of the server is not trusted evidence. */
export const SUPPORT_RECORD_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Outcome of uploading one signed support record. Identical for a first upload and a replay of
 * the same bytes. `conflict` means the record ID already holds other content: the original keeps
 * its receipt and the conflicting upload is retained for repair. The caller commits the
 * transaction either way, so that evidence survives, and reports a conflict as REPLAY_CONFLICT.
 */
export type SupportRecordReceipt =
  | Readonly<{
      recordId: string;
      recordHash: string;
      status: "held" | "accepted" | "rejected";
      heldReason: string | null;
      replayed: boolean;
    }>
  | Readonly<{
      recordId: string;
      recordHash: string;
      status: "conflict";
      originalRecordHash: string;
      replayed: boolean;
    }>;

export type VerifiedSupportUpload<T> = Readonly<{
  envelope: Signed<T>;
  record: T;
  recordHash: string;
  /** The device was revoked or retired: the upload is kept for reconciliation, never accepted. */
  revoked: boolean;
}>;

/**
 * The checks every support record shares, in this order: exact-key parse; identity bound to the
 * caller's tenant and branch; trusted device clock; the uploading staff member live at the
 * branch; transaction-scoped locks (`extraLocks` first, then the record ID); the enrollment's
 * pinned key, never a supplied one; the SHA-256 of the signed payload.
 *
 * Record IDs are one space per tenant + enrollment across every support kind, so all kinds take
 * the same record lock and `existingSupportRecord` looks in every support table.
 */
export async function verifySupportUpload<
  T extends Readonly<{ recordId: string; identity: TerminalIdentity; recordedAt: number }>,
>(
  tx: Tx,
  access: AccessService,
  user: RequestUser,
  branchId: string,
  raw: unknown,
  parse: (payload: unknown) => T,
  now: number,
  extraLocks: (record: T) => readonly string[] = () => [],
): Promise<VerifiedSupportUpload<T>> {
  const envelope = parseEnvelope(raw) as Signed<T>;
  const record = parse(envelope.payload);
  const { identity } = record;
  if (
    identity.tenantId !== user.tenantId ||
    identity.branchId !== branchId ||
    envelope.keyId !== identity.keyId
  )
    denied("IDENTITY_MISMATCH");
  if (record.recordedAt > now + SUPPORT_RECORD_CLOCK_SKEW_MS) denied("CLOCK_UNTRUSTED");
  // The uploader must be live at this branch; the staff, sign-in and shift the record cites are
  // verified against P2/P3 evidence later.
  await access.resolveLive(user, branchId, tx);

  for (const key of [
    ...extraLocks(record),
    `support:${user.tenantId}:${identity.enrollmentId}:${record.recordId}`,
  ])
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
  return {
    envelope,
    record,
    recordHash: sha256(commandText(envelope.payload)),
    revoked: Boolean(enrollment.revokedAt || enrollment.terminal.retiredAt),
  };
}

/** The stored record under this ID, whichever support table holds it. Call under the record lock. */
export async function existingSupportRecord(
  tx: Tx,
  tenantId: string,
  enrollmentId: string,
  recordId: string,
): Promise<{ recordHash: string; status: string; heldReason: string | null } | null> {
  const where = { tenantId_enrollmentId_recordId: { tenantId, enrollmentId, recordId } };
  const select = { recordHash: true, status: true, heldReason: true } as const;
  return (
    (await tx.offlineSupportRecord.findUnique({ where, select })) ??
    (await tx.businessHoursAcknowledgement.findUnique({ where, select }))
  );
}

/** Replay the original receipt, or retain changed content as a conflict. */
export async function replayOrRetainConflict(
  tx: Tx,
  audit: AuditService,
  user: RequestUser,
  branchId: string,
  upload: VerifiedSupportUpload<OfflineSupportRecord>,
  existing: { recordHash: string; status: string; heldReason: string | null },
): Promise<SupportRecordReceipt> {
  const { record, recordHash } = upload;
  if (existing.recordHash === recordHash)
    return {
      recordId: record.recordId,
      recordHash,
      status: existing.status as "held" | "accepted" | "rejected",
      heldReason: existing.heldReason,
      replayed: true,
    };
  const { identity } = record;
  const content = {
    tenantId: user.tenantId,
    enrollmentId: identity.enrollmentId,
    recordId: record.recordId,
    recordHash,
  };
  const kept = await tx.offlineSupportConflict.findUnique({
    where: { tenantId_enrollmentId_recordId_recordHash: content },
    select: { id: true },
  });
  if (!kept) {
    const saved = await tx.offlineSupportConflict.create({
      data: {
        ...content,
        branchId,
        terminalId: identity.terminalId,
        keyId: identity.keyId,
        kind: record.kind,
        originalRecordHash: existing.recordHash,
        envelope: upload.envelope as unknown as Prisma.InputJsonValue,
        receivedByUserId: user.userId,
      },
    });
    await audit.log(
      {
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "terminal.support_record_conflict",
        entityName: "offline_support_conflict",
        entityId: saved.id,
        payload: {
          kind: record.kind,
          recordId: record.recordId,
          recordHash,
          originalRecordHash: existing.recordHash,
          enrollmentId: identity.enrollmentId,
        },
      },
      tx,
    );
  }
  return {
    recordId: record.recordId,
    recordHash,
    status: "conflict",
    originalRecordHash: existing.recordHash,
    replayed: Boolean(kept),
  };
}
