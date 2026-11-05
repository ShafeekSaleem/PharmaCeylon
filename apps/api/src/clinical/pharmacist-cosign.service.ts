import { ForbiddenException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  COSIGNABLE_OPERATIONS,
  type CosignableOperation,
  type OnlineTerminalCommand,
  type PharmacistCosign,
} from "@pharmaceylon/shared";
import { AuditService } from "../audit/audit.service";
import { boundedCanonical, denied, sha256 } from "../terminals/terminal-wire";
import { type ClinicalEvidence, PharmacistRegistrationService } from "./pharmacist-registration.service";

type Tx = Prisma.TransactionClient;

/** Long enough to prepare, attend, sign and execute one command; short enough that a co-sign
 * left unused at a counter is gone before anyone else sits down. */
export const COSIGN_LIFETIME_MS = 5 * 60_000;

/** What a signed clinical command relied on: whose registration, and the co-sign if there was one. */
export type CommandClinicalEvidence = ClinicalEvidence &
  Readonly<{ pharmacistUserId: string; pharmacistEvidenceId: string | null }>;

export const isCosignable = (operation: string): operation is CosignableOperation =>
  (COSIGNABLE_OPERATIONS as readonly string[]).includes(operation);

/** The exact work a co-sign covers. The command's own digest can't be used: it contains the
 * co-sign's ID. */
export const cosignBodyDigest = (operation: string, body: unknown) =>
  sha256(boundedCanonical({ operation, body }));

/**
 * P1 #47: a registered pharmacist co-signs one signed clinical command at a counter with their PIN,
 * so a cashier can record a prescription without the pharmacist switching in.
 *
 * - **Issue** (`issueInTransaction`), after the PIN has been checked online: the co-signer must hold
 *   a current registration at the branch now, or `APPROVER_NOT_QUALIFIED`. The row binds the
 *   tenant, branch, counter staff session, the person signed in there, the operation and the digest
 *   of the exact body, and expires after five minutes. Nothing secret is stored.
 * - **Spend** (`consume`), inside the command's transaction as its clinical evidence: the row is
 *   locked, must match the command exactly and be unspent and unexpired (`COSIGN_INVALID`), and the
 *   co-signer's registration is checked again with the same share lock as any clinical check. Then
 *   it is marked spent by this command, with the registration relied on. A refusal rolls all of it
 *   back, so the co-sign is spent only by a command that succeeds.
 */
@Injectable()
export class PharmacistCosignService {
  constructor(
    private readonly registrations: PharmacistRegistrationService,
    private readonly audit: AuditService,
  ) {}

  async issueInTransaction(
    tx: Tx,
    input: {
      tenantId: string;
      branchId: string;
      workSessionId: string;
      staffUserId: string;
      pharmacistUserId: string;
      operation: CosignableOperation;
      body: unknown;
    },
    now: Date = new Date(),
  ): Promise<PharmacistCosign> {
    const qualified = await this.qualified(tx, input, now);
    const row = await tx.pharmacistCosignEvidence.create({
      data: {
        tenantId: input.tenantId,
        branchId: input.branchId,
        workSessionId: input.workSessionId,
        staffUserId: input.staffUserId,
        pharmacistUserId: input.pharmacistUserId,
        operation: input.operation,
        bodyDigest: cosignBodyDigest(input.operation, input.body),
        createdAt: now,
        expiresAt: new Date(now.getTime() + COSIGN_LIFETIME_MS),
      },
    });
    await this.audit.log(
      {
        tenantId: input.tenantId,
        branchId: input.branchId,
        actorUserId: input.staffUserId,
        eventName: "pharmacist_cosign.issued",
        entityName: "pharmacist_cosign_evidence",
        entityId: row.id,
        payload: {
          operation: input.operation,
          workSessionId: input.workSessionId,
          pharmacistUserId: input.pharmacistUserId,
          pharmacistRegistrationId: qualified.registrationId,
          slmcNumber: qualified.slmcNumber,
          expiresAt: row.expiresAt.toISOString(),
        },
      },
      tx,
    );
    return {
      pharmacistEvidenceId: row.id,
      pharmacistUserId: input.pharmacistUserId,
      pharmacistRegistrationId: qualified.registrationId,
      expiresAt: row.expiresAt.getTime(),
    };
  }

  /** The `MandatoryOperationEvidence.clinical` provider for a command carrying `pharmacistEvidenceId`. */
  async consume(
    tx: Tx,
    command: OnlineTerminalCommand<unknown>,
    at: Date = new Date(),
  ): Promise<CommandClinicalEvidence> {
    const evidenceId = command.pharmacistEvidenceId;
    if (evidenceId === null || !isCosignable(command.operation)) denied("INVALID_COMMAND");
    const { tenantId, branchId } = command.identity;
    const rows = await tx.$queryRaw<
      {
        pharmacist_user_id: string;
        operation: string;
        body_digest: string;
        expires_at: Date;
        consumed_at: Date | null;
      }[]
    >`SELECT pharmacist_user_id, operation, body_digest, expires_at, consumed_at
      FROM pharmacist_cosign_evidence
      WHERE id = ${evidenceId}::uuid AND tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid
        AND work_session_id = ${command.session.workSessionId}::uuid
        AND staff_user_id = ${command.session.staffUserId}::uuid
      FOR UPDATE`;
    const row = rows[0];
    if (
      !row ||
      row.consumed_at !== null ||
      row.expires_at <= at ||
      row.operation !== command.operation ||
      row.body_digest !== cosignBodyDigest(command.operation, command.body)
    )
      denied("COSIGN_INVALID");
    const qualified = await this.qualified(
      tx,
      { tenantId, branchId, pharmacistUserId: row.pharmacist_user_id },
      at,
    );
    const spent = await tx.pharmacistCosignEvidence.updateMany({
      where: { id: evidenceId, tenantId, consumedAt: null },
      data: { consumedAt: at, commandId: command.commandId, registrationId: qualified.registrationId },
    });
    if (spent.count !== 1) denied("COSIGN_INVALID");
    return {
      ...qualified,
      pharmacistUserId: row.pharmacist_user_id,
      pharmacistEvidenceId: evidenceId,
    };
  }

  /** The co-signer's registration at the branch, or a refusal that says it was the co-signer. */
  private async qualified(
    tx: Tx,
    staff: { tenantId: string; branchId: string; pharmacistUserId: string },
    at: Date,
  ): Promise<ClinicalEvidence> {
    try {
      return await this.registrations.assertQualified(
        tx,
        { tenantId: staff.tenantId, branchId: staff.branchId, userId: staff.pharmacistUserId },
        at,
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException &&
        (error.getResponse() as { code?: unknown }).code === "PHARMACIST_REQUIRED"
      )
        throw new ForbiddenException({
          code: "APPROVER_NOT_QUALIFIED",
          message:
            "The co-signing pharmacist has no current SLMC registration at this branch, so they can't co-sign this.",
        });
      throw error;
    }
  }
}
