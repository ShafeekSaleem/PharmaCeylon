import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type {
  CommittedCommandReceipt,
  OfflineBusinessHoursAcknowledgement,
  OfflineBusinessHoursEvidence,
  OfflineJournalCommand,
  OfflineSaleCommand,
  OfflineStaffSignIn,
  Signed,
  SupportEvidenceStatus,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { HeldEvidenceVerifier } from "../held-evidence-verifier.service";
import { supportRecordLockKey } from "../support-record-intake";
import { denied, uuid } from "../terminal-wire";
import { OFFLINE_JOURNAL_OPERATION, storedCommand } from "./journal-chain";

type Tx = Prisma.TransactionClient;
type Scope = Readonly<{
  tenantId: string;
  branchId: string;
  enrollmentId: string;
}>;

const RECORD_TX = { timeout: 20_000 } as const;

/**
 * Why a support record or acknowledgement is still held, and what repairs it. The first group
 * clears by itself when the counter uploads what is missing (every sync re-runs promotion); the
 * second waits on a person.
 */
export const SUPPORT_HELD_REASONS = {
  // Waiting on evidence the counter still has to upload.
  sign_in_unverified:
    "Waiting for the counter to upload the staff sign-in this record cites.",
  shift_unverified:
    "Waiting for the shift this record cites to reach the server.",
  sale_unverified:
    "Waiting for the counter to upload the sale entry this record cites.",
  payment_unverified:
    "Waiting for the card approval and the sale it was linked to.",
  outage_unverified:
    "Waiting for a journal entry from the outage this acknowledgement covers.",
  // Intake's first reasons, before any promotion pass has looked at the record.
  grant_unverified: "Not verified yet.",
  // A manager decides.
  enrollment_revoked:
    "Uploaded by a revoked or retired counter: review it with the counter's recovery.",
  attempt_mismatch:
    "The card attempt's events disagree with each other: review the whole attempt.",
  card_payment_mismatch:
    "The linked sale holds no card payment matching this approval and amount.",
  sale_not_honoured:
    "The card was charged for a sale a manager did not honour: settle it with the customer.",
} as const;

/** Held reasons promotion leaves alone: only a person settles them. */
const MANAGER_DECIDES: readonly string[] = [
  "enrollment_revoked",
  "attempt_mismatch",
  "card_payment_mismatch",
  "sale_not_honoured",
];

/** One held record, as a manager reviewing support evidence sees it. */
export type HeldSupportRecordView = Readonly<{
  kind: string;
  recordId: string;
  terminalId: string;
  enrollmentId: string;
  recordedAt: number;
  receivedAt: number;
  heldReason: string | null;
  explanation: string;
  /** True when the counter uploading what is missing clears it; false when a person must decide. */
  clearsOnUpload: boolean;
  attemptId: string | null;
  cardState: string | null;
  saleCommandId: string | null;
}>;

/**
 * P5 #51: promotes held support evidence once everything it cites is on the server, and resolves
 * the D8 acknowledgements journal commands depend on before those commands are judged.
 *
 * A sale-incident note or card-attempt event is accepted when:
 *  - the staff sign-in it cites is uploaded and P3 (`HeldEvidenceVerifier`) finds it on an issued
 *    grant, for prepared staff, on the record's work session (a failure here rejects it);
 *  - the shift (work session) it cites is a till shift at the branch;
 *  - an incident's sale entry is an accepted journal receipt on this enrollment;
 *  - a card approval or sale link is matched by that attempt's other event and an accepted sale
 *    entry holding the very card payment (provider reference, approval code and amount).
 * Prepared, uncertain and declined card events cite no card-machine result beyond the sign-in.
 *
 * Records and their journal entries arrive in any order: the pass runs after every sync, so a
 * record uploaded before its sale is promoted by the sync that brings the sale. Nothing here
 * waits on anything else here. A revoked counter's uploads, disagreeing attempt events, and a
 * linked sale that doesn't match or wasn't honoured stay held for a manager. Promotion moves a
 * record once (the table's trigger enforces it) and never posts a sale, stock, cash or refund.
 */
@Injectable()
export class SupportEvidenceReconciler {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly verifier: HeldEvidenceVerifier,
  ) {}

  /** Re-verify every held record of this enrollment, each in its own transaction. */
  async reconcile(
    user: RequestUser,
    identity: TerminalIdentity,
    now: number = Date.now(),
  ): Promise<void> {
    const scope = scopeOf(identity);
    const where = {
      tenantId: scope.tenantId,
      branchId: scope.branchId,
      enrollmentId: scope.enrollmentId,
      status: "held",
      heldReason: { notIn: [...MANAGER_DECIDES] },
    };
    const acknowledgements =
      await this.prisma.businessHoursAcknowledgement.findMany({
        where,
        select: { recordId: true },
        orderBy: { recordedAt: "asc" },
      });
    for (const { recordId } of acknowledgements)
      await this.prisma.$transaction(
        (tx) => this.promoteAcknowledgement(tx, user, scope, recordId, now),
        RECORD_TX,
      );
    const records = await this.prisma.offlineSupportRecord.findMany({
      where,
      select: { recordId: true },
      orderBy: { recordedAt: "asc" },
    });
    for (const { recordId } of records)
      await this.prisma.$transaction(
        (tx) => this.promoteRecord(tx, user, scope, recordId, now),
        RECORD_TX,
      );
  }

  /**
   * The D8 evidence a journal command cites, resolved first: a held acknowledgement from the
   * command's own outage is verified against the issued grant, its stored manager sign-in and
   * that outage. Accepted → the evidence; rejected, from another outage or never verifiable →
   * none, so the shared policy refuses the command only if it needed one. Missing pieces hold
   * the command (`BUSINESS_HOURS_ACK_REQUIRED`, retryable by uploading them).
   */
  async hoursEvidence(
    tx: Tx,
    user: RequestUser,
    identity: TerminalIdentity,
    command: OfflineJournalCommand,
    now: number,
  ): Promise<OfflineBusinessHoursEvidence | undefined | "missing"> {
    const recordId = command.businessHoursAcknowledgementId;
    if (!recordId) return undefined;
    const scope = scopeOf(identity);
    const where = {
      tenantId_enrollmentId_recordId: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        recordId,
      },
    };
    const row = await tx.businessHoursAcknowledgement.findUnique({
      where,
      select: { envelope: true, status: true, heldReason: true },
    });
    if (!row) return "missing";
    const acknowledgement = (
      row.envelope as unknown as Signed<OfflineBusinessHoursAcknowledgement>
    ).payload;
    const managerSignIn = await storedSignIn(
      tx,
      scope,
      acknowledgement.managerSignInId,
    );
    if (!managerSignIn) return "missing";
    let status = row.status;
    if (
      status === "held" &&
      acknowledgement.offlineSessionId === command.offlineSessionId &&
      !MANAGER_DECIDES.includes(row.heldReason ?? "")
    ) {
      const outcome = await this.verifier.verifyHoursAcknowledgement(
        tx,
        user,
        scope.branchId,
        {
          enrollmentId: scope.enrollmentId,
          recordId,
          managerSignIn,
          outage: {
            offlineSessionId: command.offlineSessionId,
            offlineStartedAt: command.offlineStartedAt,
          },
        },
        now,
      );
      status = outcome.status;
    }
    return status === "accepted"
      ? { acknowledgement, managerSignIn }
      : undefined;
  }

  /** Where this enrollment's support evidence stands, for the sync response. */
  async status(
    client: Tx | PrismaService,
    identity: TerminalIdentity,
  ): Promise<SupportEvidenceStatus> {
    const s = scopeOf(identity);
    const [counts] = await client.$queryRaw<
      Array<{ held: number; rejected: number; unresolved: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM offline_support_record WHERE tenant_id = ${s.tenantId}::uuid
           AND branch_id = ${s.branchId}::uuid AND enrollment_id = ${s.enrollmentId}::uuid AND status = 'held')
        + (SELECT count(*)::int FROM business_hours_acknowledgement WHERE tenant_id = ${s.tenantId}::uuid
           AND branch_id = ${s.branchId}::uuid AND enrollment_id = ${s.enrollmentId}::uuid AND status = 'held') AS held,
        (SELECT count(*)::int FROM offline_support_record WHERE tenant_id = ${s.tenantId}::uuid
           AND branch_id = ${s.branchId}::uuid AND enrollment_id = ${s.enrollmentId}::uuid AND status = 'rejected')
        + (SELECT count(*)::int FROM business_hours_acknowledgement WHERE tenant_id = ${s.tenantId}::uuid
           AND branch_id = ${s.branchId}::uuid AND enrollment_id = ${s.enrollmentId}::uuid AND status = 'rejected') AS rejected,
        (SELECT count(DISTINCT r.attempt_id)::int FROM offline_support_record r
          WHERE r.tenant_id = ${s.tenantId}::uuid AND r.branch_id = ${s.branchId}::uuid
            AND r.enrollment_id = ${s.enrollmentId}::uuid AND r.kind = 'external_card_attempt'
            AND NOT EXISTS (SELECT 1 FROM offline_support_record d
              WHERE d.tenant_id = r.tenant_id AND d.enrollment_id = r.enrollment_id AND d.attempt_id = r.attempt_id
                AND d.status = 'accepted' AND d.card_state IN ('declined', 'linked_to_sale'))) AS unresolved`;
    const { held, rejected, unresolved } = counts!;
    return {
      heldRecords: held,
      rejectedRecords: rejected,
      unresolvedCardAttempts: unresolved,
      supportRecordsAccepted: held === 0 && rejected === 0,
      paymentAttemptsResolved: unresolved === 0,
    };
  }

  /** Held support evidence at the branch and why, for the managers who look after counters. */
  async listHeld(
    user: RequestUser,
    branchId: string,
  ): Promise<HeldSupportRecordView[]> {
    return this.prisma.$transaction(async (tx) => {
      const access = await this.access.resolveLive(user, uuid(branchId), tx);
      if (!access.has("tenant.management")) denied("PERMISSION_DENIED");
      const where = { tenantId: user.tenantId, branchId, status: "held" };
      const base = {
        recordId: true,
        terminalId: true,
        enrollmentId: true,
        recordedAt: true,
        receivedAt: true,
        heldReason: true,
      } as const;
      const [records, acknowledgements] = await Promise.all([
        tx.offlineSupportRecord.findMany({
          where,
          orderBy: { receivedAt: "asc" },
          take: 500,
          select: {
            ...base,
            kind: true,
            attemptId: true,
            cardState: true,
            saleCommandId: true,
          },
        }),
        tx.businessHoursAcknowledgement.findMany({
          where,
          orderBy: { receivedAt: "asc" },
          take: 500,
          select: base,
        }),
      ]);
      const view = (
        row: (typeof acknowledgements)[number],
        extra: Pick<
          HeldSupportRecordView,
          "kind" | "attemptId" | "cardState" | "saleCommandId"
        >,
      ) => {
        const reason = row.heldReason ?? "";
        return {
          ...extra,
          recordId: row.recordId,
          terminalId: row.terminalId,
          enrollmentId: row.enrollmentId,
          recordedAt: row.recordedAt.getTime(),
          receivedAt: row.receivedAt.getTime(),
          heldReason: row.heldReason,
          explanation:
            (SUPPORT_HELD_REASONS as Record<string, string>)[reason] ??
            "Kept for review.",
          clearsOnUpload: !MANAGER_DECIDES.includes(reason),
        };
      };
      return [
        ...records.map((r) =>
          view(r, {
            kind: r.kind,
            attemptId: r.attemptId,
            cardState: r.cardState,
            saleCommandId: r.saleCommandId,
          }),
        ),
        ...acknowledgements.map((r) =>
          view(r, {
            kind: "business_hours_acknowledgement",
            attemptId: null,
            cardState: null,
            saleCommandId: null,
          }),
        ),
      ].sort((a, b) => a.receivedAt - b.receivedAt);
    });
  }

  /** A held acknowledgement with no command judged against it yet: verify it from its outage. */
  private async promoteAcknowledgement(
    tx: Tx,
    user: RequestUser,
    scope: Scope,
    recordId: string,
    now: number,
  ) {
    await this.lock(tx, user, scope, recordId);
    const where = {
      tenantId_enrollmentId_recordId: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        recordId,
      },
    };
    const row = await tx.businessHoursAcknowledgement.findUnique({
      where,
      select: { id: true, status: true, heldReason: true, envelope: true },
    });
    if (
      !row ||
      row.status !== "held" ||
      MANAGER_DECIDES.includes(row.heldReason ?? "")
    )
      return;
    const ack = (
      row.envelope as unknown as Signed<OfflineBusinessHoursAcknowledgement>
    ).payload;
    const managerSignIn = await storedSignIn(tx, scope, ack.managerSignInId);
    if (!managerSignIn)
      return this.holdAcknowledgement(tx, scope, row, "sign_in_unverified");
    // Any accepted entry of the same outage names when it began; the counter signed that too.
    const entry = await tx.terminalCommandReceipt.findFirst({
      where: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        offlineSequence: { not: null },
        command: {
          path: ["payload", "offlineSessionId"],
          equals: ack.offlineSessionId,
        },
      },
      orderBy: { offlineSequence: "asc" },
      select: { command: true },
    });
    const command = entry ? storedCommand(entry) : null;
    if (!command)
      return this.holdAcknowledgement(tx, scope, row, "outage_unverified");
    await this.verifier.verifyHoursAcknowledgement(
      tx,
      user,
      scope.branchId,
      {
        enrollmentId: scope.enrollmentId,
        recordId,
        managerSignIn,
        outage: {
          offlineSessionId: command.offlineSessionId,
          offlineStartedAt: command.offlineStartedAt,
        },
      },
      now,
    );
  }

  private async promoteRecord(
    tx: Tx,
    user: RequestUser,
    scope: Scope,
    recordId: string,
    now: number,
  ) {
    await this.lock(tx, user, scope, recordId);
    const where = {
      tenantId_enrollmentId_recordId: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        recordId,
      },
    };
    const row = await tx.offlineSupportRecord.findUnique({ where });
    if (
      !row ||
      row.status !== "held" ||
      MANAGER_DECIDES.includes(row.heldReason ?? "")
    )
      return;

    const staffSignIn = await storedSignIn(tx, scope, row.staffSignInId);
    if (!staffSignIn) return this.holdRecord(tx, row, "sign_in_unverified");
    // P3: the sign-in is on an issued grant, for prepared staff, on this work session.
    const authority = await this.verifier.verifySupportRecord(
      tx,
      user,
      scope.branchId,
      {
        enrollmentId: scope.enrollmentId,
        recordId,
        staffSignIn,
      },
      now,
    );
    if (authority.status !== "held") return;

    const shift = await tx.tillShift.findFirst({
      where: {
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        id: row.workSessionId,
      },
      select: { id: true },
    });
    if (!shift) return this.holdRecord(tx, row, "shift_unverified");

    let reason: string | null = null;
    if (row.kind === "sale_incident") {
      // A note about an entry a manager did not honour is still a note about that entry.
      if (!(await saleEntry(tx, scope, row.saleCommandId!)))
        reason = "sale_unverified";
    } else if (
      row.cardState === "approved" ||
      row.cardState === "linked_to_sale"
    ) {
      reason = await this.cardPaymentReason(tx, scope, row.attemptId!);
    }
    if (reason) return this.holdRecord(tx, row, reason);

    const moved = await tx.offlineSupportRecord.updateMany({
      where: { id: row.id, tenantId: scope.tenantId, status: "held" },
      data: { status: "accepted", heldReason: null, verifiedAt: new Date(now) },
    });
    if (moved.count !== 1)
      throw new Error("Held support record changed under its record lock");
    await this.audit.log(
      {
        tenantId: scope.tenantId,
        branchId: scope.branchId,
        actorUserId: user.userId,
        eventName: "terminal.support_record_accepted",
        entityName: "offline_support_record",
        entityId: row.id,
        payload: {
          kind: row.kind,
          recordId,
          enrollmentId: scope.enrollmentId,
          staffSignInId: row.staffSignInId,
          workSessionId: row.workSessionId,
          saleCommandId: row.saleCommandId,
          attemptId: row.attemptId,
          cardState: row.cardState,
        },
      },
      tx,
    );
  }

  /**
   * An approval or sale link is verified together: the attempt's approval, its link to a sale,
   * and that accepted sale entry holding the same card payment. Null when all three agree.
   */
  private async cardPaymentReason(
    tx: Tx,
    scope: Scope,
    attemptId: string,
  ): Promise<string | null> {
    const events = await tx.offlineSupportRecord.findMany({
      where: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        kind: "external_card_attempt",
        attemptId,
        status: { not: "rejected" },
      },
      select: {
        cardState: true,
        heldReason: true,
        providerReference: true,
        approvalCode: true,
        amountMinor: true,
        saleCommandId: true,
      },
    });
    if (events.some((e) => e.heldReason === "attempt_mismatch"))
      return "attempt_mismatch";
    const approval = events.find((e) => e.cardState === "approved");
    const link = events.find((e) => e.cardState === "linked_to_sale");
    if (!approval || !link) return "payment_unverified";
    const entry = await saleEntry(tx, scope, link.saleCommandId!);
    if (!entry) return "sale_unverified";
    if ("review" in entry.result && entry.result.decision === "not_honoured")
      return "sale_not_honoured";
    const paid = entry.command.payments.some(
      (p) =>
        p.method === "external_card" &&
        p.providerReference === link.providerReference &&
        p.approvalCode === approval.approvalCode &&
        BigInt(p.amountMinor) === approval.amountMinor,
    );
    return paid ? null : "card_payment_mismatch";
  }

  /** The uploader is live at the branch; then the support record's lock (as intake takes it). */
  private async lock(
    tx: Tx,
    user: RequestUser,
    scope: Scope,
    recordId: string,
  ) {
    await this.access.resolveLive(user, scope.branchId, tx);
    const key = supportRecordLockKey(
      scope.tenantId,
      scope.enrollmentId,
      recordId,
    );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }

  /** Still held: record what it now waits on, so a manager sees the current reason. */
  private async holdRecord(
    tx: Tx,
    row: { id: string; tenantId: string; heldReason: string | null },
    reason: string,
  ) {
    if (row.heldReason === reason) return;
    await tx.offlineSupportRecord.updateMany({
      where: { id: row.id, tenantId: row.tenantId, status: "held" },
      data: { heldReason: reason },
    });
  }

  private async holdAcknowledgement(
    tx: Tx,
    scope: Scope,
    row: { id: string; heldReason: string | null },
    reason: string,
  ) {
    if (row.heldReason === reason) return;
    await tx.businessHoursAcknowledgement.updateMany({
      where: { id: row.id, tenantId: scope.tenantId, status: "held" },
      data: { heldReason: reason },
    });
  }
}

const scopeOf = (identity: TerminalIdentity): Scope => ({
  tenantId: identity.tenantId,
  branchId: identity.branchId,
  enrollmentId: identity.enrollmentId,
});

/** A staff sign-in this enrollment uploaded, as the device signed it. */
async function storedSignIn(
  tx: Tx,
  scope: Scope,
  signInId: string,
): Promise<OfflineStaffSignIn | null> {
  const row = await tx.offlineStaffSignIn.findUnique({
    where: {
      tenantId_enrollmentId_signInId: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        signInId,
      },
    },
    select: { envelope: true },
  });
  return row
    ? (row.envelope as unknown as Signed<OfflineStaffSignIn>).payload
    : null;
}

/** An accepted sale entry of this enrollment's journal (by intake or a manager's settlement). */
async function saleEntry(
  tx: Tx,
  scope: Scope,
  commandId: string,
): Promise<{
  command: OfflineSaleCommand;
  result: CommittedCommandReceipt;
} | null> {
  const receipt = await tx.terminalCommandReceipt.findUnique({
    where: {
      tenantId_enrollmentId_commandId: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        commandId,
      },
    },
    select: {
      offlineSequence: true,
      operation: true,
      command: true,
      result: true,
    },
  });
  if (
    !receipt ||
    receipt.offlineSequence === null ||
    receipt.operation !== `${OFFLINE_JOURNAL_OPERATION}ordinary_sale`
  )
    return null;
  const command = storedCommand(receipt);
  return command?.kind === "ordinary_sale"
    ? { command, result: receipt.result as unknown as CommittedCommandReceipt }
    : null;
}
