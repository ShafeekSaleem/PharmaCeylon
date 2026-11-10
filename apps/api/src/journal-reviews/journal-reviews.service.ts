import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OfflineJournalSettlementDecision,
  OfflineJournalSettlementStatus,
  Prisma,
  type OfflineJournalReview,
  type OfflineJournalSettlement,
} from "@prisma/client";
import type {
  BranchStockSnapshot,
  CommittedCommandReceipt,
  OfflineGrant,
  OfflineJournalCommand,
  OfflineSaleCommand,
  OfflineShiftCloseCommand,
  OfflineShiftOpenCommand,
  OfflineStaffSignIn,
  ReviewedEntryOutcome,
  Signed,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { StockService } from "../inventory/stock/stock.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import {
  lockOfflineJournalSettlement,
  offlineJournalSettlementDigest,
  offlineJournalSettlementFacts,
} from "../security/offline-journal-settlement-approval-material";
import {
  OFFLINE_JOURNAL_OPERATION,
  lockOfflineJournal,
  offlineJournalHead,
} from "../terminals/journal/journal-chain";
import {
  commitOfflineSale,
  resolveSaleLines,
} from "../terminals/journal/offline-sale-commit";
import {
  replayShiftClose,
  replayShiftOpen,
} from "../terminals/journal/offline-shift-replay";
import { TillShiftsService } from "../terminals/shifts/till-shifts.service";
import {
  RECORD_BLOCKER_MESSAGES,
  SETTLE_BLOCKER_MESSAGES,
  parseDecision,
  parseReason,
  recordedSaleError,
  recordedOccurredAt,
  refusalExplanation,
  type RecordBlocker,
  type SettleBlocker,
} from "./journal-entry-settlement";

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

export const REVIEW_PERMISSION = "sales.review_offline_entries";
const ACTION = "offline_journal_settlement.execute" as const;
const SETTLE_TX = { timeout: 20_000 } as const;

export type PrepareSettlementInput = { decision: unknown; reason: unknown };
export type ApproveSettlementInput = {
  approvalId: string;
  expectedVersion: number;
  expectedDigest: string;
};

/** Where a refused entry stands: blocking its counter, settled by a manager, or overtaken. */
type EntryState = "open" | "settled" | "superseded";

/** What recording would write, or why it can't. */
type Recordability =
  | { ok: true; blocker: null }
  | { ok: false; blocker: RecordBlocker };

/**
 * P5 #51 slice 4: a manager settles an offline journal entry the server rejected, so the counter
 * that sent it can finish synchronising (approved D12) and sell again.
 *
 * Only `rejected` command entries are settled here; held ones repair themselves, and conflicts with
 * the accepted chain are journal recovery (D11). Each decision is prepared, exactly approved
 * (`management_approval`, `offline_journal_settlement.execute`) and written on approval, remotely:
 * - `recorded`: the entry's effect is written as it happened. A sale keeps the counter's prices,
 *   payments, seller and shift, and always waits on an offline stock case (its batches blocked),
 *   which is settled at the counter (slice 2): no stock moves here. A shift open/close is replayed
 *   if the till allows it.
 * - `not_honoured`: nothing is written; cash the counter took shows in that shift's variance.
 *
 * Either way the server's `terminal_command_receipt` is written at the entry's own sequence with its
 * own digest, so later entries chain onto it. The counter learns the outcome by resending the entry:
 * the receipt answers `reviewed` in the signed sync response.
 *
 * Lock order: the settlement, the enrollment's journal (the same advisory lock as intake), the
 * approval evidence, then any till or batch rows (as intake).
 */
@Injectable()
export class JournalReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
    private readonly stock: StockService,
    private readonly shifts: TillShiftsService,
  ) {}

  // ── Review (read-only) ──────────────────────────────────────────────────────────────────────

  /** The branch's refused entries: `open` (blocking a counter) or `closed` (settled or overtaken). */
  async list(
    tenantId: string,
    branchId: string,
    status: "open" | "closed" = "open",
  ) {
    const rows = await this.prisma.offlineJournalReview.findMany({
      where: { tenantId, branchId, recordKind: "command", outcome: "rejected" },
      include: {
        settlements: { where: { tenantId }, orderBy: { requestedAt: "desc" } },
      },
      orderBy: { firstReceivedAt: "desc" },
      take: 200,
    });
    const heads = await this.heads(
      this.prisma,
      tenantId,
      rows.map((r) => r.enrollmentId),
    );
    const listed = rows
      .map((row) => ({
        row,
        state: entryState(row, heads.get(row.enrollmentId) ?? 0),
      }))
      .filter(({ state }) =>
        status === "open" ? state === "open" : state !== "open",
      );
    const commands = listed.map(({ row }) => entryOf(row));
    const [names, counters] = await Promise.all([
      this.names(
        tenantId,
        commands.map((c) => c.session.staffUserId),
      ),
      this.terminalLabels(
        tenantId,
        branchId,
        listed.map(({ row }) => row.terminalId),
      ),
    ]);
    return listed.map(({ row, state }, i) => {
      const command = commands[i]!;
      const settlement =
        row.settlements.find((s) => s.status !== "cancelled") ?? null;
      return {
        id: row.id,
        state,
        kind: command.kind,
        sequence: Number(row.sequence),
        counter: counters.get(row.terminalId) ?? null,
        occurredAt: new Date(command.occurredAt).toISOString(),
        staff: names.get(command.session.staffUserId) ?? null,
        totalMinor:
          command.kind === "ordinary_sale" ? command.totalMinor : null,
        refusal: {
          code: row.errorCode,
          explanation: refusalExplanation(row.errorCode),
        },
        attempts: row.attempts,
        firstReceivedAt: row.firstReceivedAt.toISOString(),
        settlement: settlement
          ? {
              id: settlement.id,
              decision: settlement.decision,
              status: settlement.status,
            }
          : null,
      };
    });
  }

  /**
   * Everything a manager needs to decide: the entry as the counter signed it (for a sale its items
   * at the saved stock's prices, payments, seller and shift), why it was refused, whether it still
   * blocks the counter, whether it can be recorded as it happened, and the settlements with their
   * approval evidence.
   */
  async detail(tenantId: string, branchId: string, reviewId: string) {
    const row = await this.readReview(
      this.prisma,
      tenantId,
      branchId,
      reviewId,
    );
    const command = entryOf(row);
    const identity = identityOf(row);
    const head = await offlineJournalHead(this.prisma, identity);
    const headSequence = head ? Number(head.offlineSequence) : 0;
    const state = entryState(row, headSequence);
    const settleBlocker = await this.settleBlocker(this.prisma, row, command);
    const recordability = settleBlocker
      ? null
      : await this.recordability(this.prisma, row, command);
    const settlements = await this.prisma.offlineJournalSettlement.findMany({
      where: { tenantId, branchId, reviewId },
      orderBy: { requestedAt: "desc" },
    });
    const [counters, entry, plans] = await Promise.all([
      this.terminalLabels(tenantId, branchId, [row.terminalId]),
      this.entryView(tenantId, branchId, identity, command),
      this.settlementsView(tenantId, branchId, settlements),
    ]);
    const received = await this.names(tenantId, [row.receivedByUserId]);
    return {
      id: row.id,
      state,
      kind: command.kind,
      counter: {
        terminalId: row.terminalId,
        enrollmentId: row.enrollmentId,
        label: counters.get(row.terminalId) ?? null,
      },
      sequence: Number(row.sequence),
      commandId: row.recordId,
      recordHash: row.recordHash,
      acceptedThroughSequence: headSequence,
      refusal: {
        code: row.errorCode,
        explanation: refusalExplanation(row.errorCode),
      },
      attempts: row.attempts,
      firstReceivedAt: row.firstReceivedAt.toISOString(),
      lastReceivedAt: row.lastReceivedAt.toISOString(),
      receivedBy: {
        id: row.receivedByUserId,
        name: received.get(row.receivedByUserId) ?? null,
      },
      entry,
      // Why nothing can be decided here, or (when something can) whether it can be recorded.
      settleBlocker: settleBlocker
        ? {
            code: settleBlocker,
            message: SETTLE_BLOCKER_MESSAGES[settleBlocker],
          }
        : null,
      recordable: recordability
        ? {
            ok: recordability.ok,
            blocker: recordability.blocker,
            message: recordability.blocker
              ? RECORD_BLOCKER_MESSAGES[recordability.blocker]
              : null,
          }
        : null,
      settlements: plans,
    };
  }

  // ── Prepare, approve and settle (remote) ────────────────────────────────────────────────────

  async prepare(
    user: RequestUser,
    branchId: string,
    reviewId: string,
    input: PrepareSettlementInput,
  ) {
    const tenantId = user.tenantId;
    const decision = parseDecision(input.decision);
    const reason = parseReason(input.reason);
    const id = await this.prisma.$transaction(async (tx) => {
      const row = await this.readReview(tx, tenantId, branchId, reviewId);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(REVIEW_PERMISSION))
        throw new ForbiddenException(
          "Your role can't review refused offline sales",
        );
      // The journal lock: the chain can't move while this is checked and prepared.
      await lockOfflineJournal(tx, identityOf(row));
      const command = entryOf(row);
      const blocker = await this.settleBlocker(tx, row, command);
      if (blocker)
        throw new ConflictException(SETTLE_BLOCKER_MESSAGES[blocker]);
      if (decision === "recorded") {
        const recordable = await this.recordability(tx, row, command);
        if (!recordable.ok)
          throw new ConflictException(
            `This record can't be recorded as it happened: ${RECORD_BLOCKER_MESSAGES[recordable.blocker]}`,
          );
      }
      const open = await tx.offlineJournalSettlement.findFirst({
        where: {
          tenantId,
          branchId,
          reviewId,
          status: OfflineJournalSettlementStatus.prepared,
        },
        select: { id: true },
      });
      if (open)
        throw new ConflictException(
          "A decision is already waiting for approval. Cancel it to prepare another.",
        );
      const settlement = await tx.offlineJournalSettlement.create({
        data: {
          id: randomUUID(),
          tenantId,
          branchId,
          reviewId,
          enrollmentId: row.enrollmentId,
          commandId: row.recordId,
          sequence: row.sequence!,
          recordHash: row.recordHash,
          decision: decision as OfflineJournalSettlementDecision,
          reason,
          requestedBy: user.userId,
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "offline_journal_settlement.prepared",
          entityName: "offline_journal_settlement",
          entityId: settlement.id,
          payload: {
            reviewId,
            enrollmentId: row.enrollmentId,
            commandId: row.recordId,
            sequence: Number(row.sequence),
            recordHash: row.recordHash,
            refusalCode: row.errorCode,
            decision,
            reason,
          },
        },
        tx,
      );
      // As with refunds and stock cases: a preparer whose role may approve its own requests
      // approves the exact content they just prepared, which settles it.
      if (actor.canSelfApprove) {
        const facts = (await offlineJournalSettlementFacts(tx, settlement))!;
        await this.approveInTransaction(tx, user, branchId, settlement.id, {
          approvalId: randomUUID(),
          expectedVersion: settlement.approvalVersion,
          expectedDigest: offlineJournalSettlementDigest(facts.material),
        });
      }
      return settlement.id;
    }, SETTLE_TX);
    return this.settlementView(tenantId, branchId, id);
  }

  async approve(
    user: RequestUser,
    branchId: string,
    settlementId: string,
    input: ApproveSettlementInput,
  ) {
    await this.prisma.$transaction(
      (tx) =>
        this.approveInTransaction(tx, user, branchId, settlementId, input),
      SETTLE_TX,
    );
    return this.settlementView(user.tenantId, branchId, settlementId);
  }

  /**
   * Exact approval of the decision as it reads now (the entry, the decision and reason, the chain
   * head it follows), then the settlement itself, in the caller's transaction.
   */
  private async approveInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    settlementId: string,
    input: ApproveSettlementInput,
  ) {
    const tenantId = user.tenantId;
    const binding = await lockOfflineJournalSettlement(
      tx,
      tenantId,
      branchId,
      settlementId,
    );
    if (!binding) throw new NotFoundException("Settlement not found");
    const current = await tx.offlineJournalSettlement.findFirstOrThrow({
      where: { tenantId, branchId, id: settlementId },
    });
    // A retried approval of what it already settled is answered with the settlement.
    if (
      current.status === OfflineJournalSettlementStatus.settled &&
      current.executionApprovalId === input.approvalId
    )
      return;
    if (current.status !== OfflineJournalSettlementStatus.prepared)
      throw new ConflictException(
        "This decision is no longer waiting for approval",
      );
    const row = await this.readReview(tx, tenantId, branchId, current.reviewId);
    const identity = identityOf(row);
    await lockOfflineJournal(tx, identity);
    // Live approve permission, self-approval and the displayed version/digest, under both locks.
    const evidence = await this.approvals.issue(
      tx,
      user,
      branchId,
      ACTION,
      settlementId,
      {
        ...input,
        reason: "Reviewed the refused offline record and the decision on it",
        expiresAt: null,
      },
    );
    const command = entryOf(row);
    const blocker = await this.settleBlocker(tx, row, command);
    if (blocker) throw new ConflictException(SETTLE_BLOCKER_MESSAGES[blocker]);

    const settledAt = new Date();
    const review = {
      settlementId,
      refusalCode: row.errorCode,
      settledAt: settledAt.getTime(),
    };
    let outcome: ReviewedEntryOutcome;
    if (current.decision === OfflineJournalSettlementDecision.not_honoured) {
      outcome = { review, commandKind: command.kind, decision: "not_honoured" };
    } else {
      outcome = await this.record(tx, row, command, {
        settlementId,
        settledByUserId: evidence.approvedByUserId,
        review,
      });
    }

    const receipt = {
      identity,
      commandId: command.commandId,
      commandHash: row.recordHash,
      sequence: command.sequence,
      committedAt: settledAt.getTime(),
      ...outcome,
    } as CommittedCommandReceipt;
    await tx.terminalCommandReceipt.create({
      data: {
        ...identity,
        commandId: command.commandId,
        operation: `${OFFLINE_JOURNAL_OPERATION}${command.kind}`,
        requestDigest: row.recordHash,
        offlineSequence: row.sequence!,
        actorUserId: evidence.approvedByUserId,
        command: row.envelope as Prisma.InputJsonValue,
        result: receipt as unknown as Prisma.InputJsonValue,
        recordedAt: settledAt,
      },
    });
    await tx.offlineJournalSettlement.update({
      where: { id: settlementId, tenantId, branchId },
      data: {
        status: OfflineJournalSettlementStatus.settled,
        executionApprovalId: evidence.approvalId,
        approvedBy: evidence.approvedByUserId,
        settledAt,
        result: outcome as unknown as Prisma.InputJsonValue,
      },
    });
    await this.audit.log(
      {
        tenantId,
        branchId,
        actorUserId: evidence.approvedByUserId,
        eventName: "offline_journal_settlement.settled",
        entityName: "offline_journal_settlement",
        entityId: settlementId,
        payload: {
          reviewId: row.id,
          enrollmentId: row.enrollmentId,
          commandId: command.commandId,
          sequence: command.sequence,
          recordHash: row.recordHash,
          kind: command.kind,
          refusalCode: row.errorCode,
          decision: current.decision,
          reason: current.reason,
          approvalId: evidence.approvalId,
          documentDigest: evidence.document.documentDigest,
          requestedByUserId: current.requestedBy,
          approvedByUserId: evidence.approvedByUserId,
          selfApproved: current.requestedBy === evidence.approvedByUserId,
          outcome: outcome as unknown as Prisma.InputJsonValue,
        },
      },
      tx,
    );
  }

  async cancel(user: RequestUser, branchId: string, settlementId: string) {
    const tenantId = user.tenantId;
    await this.prisma.$transaction(async (tx) => {
      if (
        !(await lockOfflineJournalSettlement(
          tx,
          tenantId,
          branchId,
          settlementId,
        ))
      )
        throw new NotFoundException("Settlement not found");
      const row = await tx.offlineJournalSettlement.findFirstOrThrow({
        where: { tenantId, branchId, id: settlementId },
      });
      if (row.status !== OfflineJournalSettlementStatus.prepared)
        throw new BadRequestException(
          "Only a decision still waiting for approval can be cancelled",
        );
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(REVIEW_PERMISSION))
        throw new ForbiddenException(
          "Your role can't review refused offline sales",
        );
      await tx.offlineJournalSettlement.update({
        where: { id: settlementId, tenantId, branchId },
        data: {
          status: OfflineJournalSettlementStatus.cancelled,
          cancelledBy: user.userId,
          cancelledAt: new Date(),
        },
      });
      await this.audit.log(
        {
          tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "offline_journal_settlement.cancelled",
          entityName: "offline_journal_settlement",
          entityId: settlementId,
          payload: { reviewId: row.reviewId, decision: row.decision },
        },
        tx,
      );
    });
    return this.settlementView(tenantId, branchId, settlementId);
  }

  async settlementView(
    tenantId: string,
    branchId: string,
    settlementId: string,
  ) {
    const row = await this.prisma.offlineJournalSettlement.findFirst({
      where: { tenantId, branchId, id: settlementId },
    });
    if (!row) throw new NotFoundException("Settlement not found");
    const [view] = await this.settlementsView(tenantId, branchId, [row]);
    return view!;
  }

  // ── Recording an entry as it happened ───────────────────────────────────────────────────────

  /**
   * Writes the refused entry's effect as the counter recorded it, under the journal lock. Every
   * check `recordability` makes is made again here; anything else the offline rules required is
   * what the manager decided to set aside.
   */
  private async record(
    tx: Tx,
    row: OfflineJournalReview,
    command: OfflineJournalCommand,
    settlement: {
      settlementId: string;
      settledByUserId: string;
      review: ReviewedEntryOutcome["review"];
    },
  ): Promise<ReviewedEntryOutcome> {
    const identity = identityOf(row);
    const at = recordedOccurredAt(command.occurredAt, row.firstReceivedAt);
    const recordable = await this.recordability(tx, row, command);
    if (!recordable.ok)
      throw new ConflictException(
        `This record can't be recorded as it happened: ${RECORD_BLOCKER_MESSAGES[recordable.blocker]}`,
      );
    if (command.kind === "ordinary_sale") {
      const snapshot = (await this.snapshot(tx, identity, command.snapshotId))!;
      const lines = resolveSaleLines(command, snapshot);
      const sale = await commitOfflineSale(
        tx,
        { stock: this.stock, audit: this.audit },
        {
          identity,
          command,
          commandHash: row.recordHash,
          snapshot,
          lines,
          uploadedByUserId: row.receivedByUserId,
          review: {
            settlementId: settlement.settlementId,
            settledByUserId: settlement.settledByUserId,
            soldAt: at,
          },
        },
      );
      return {
        review: settlement.review,
        commandKind: "ordinary_sale",
        decision: "recorded",
        saleId: sale.saleId,
        ...sale.outcome,
      };
    }
    if (command.kind === "shift_open") {
      await replayShiftOpen(tx, this.audit, {
        identity,
        command,
        uploadedByUserId: row.receivedByUserId,
        journalSettlementId: settlement.settlementId,
        at,
      });
    } else {
      const signIn = (await this.signIn(tx, identity, command.staffSignInId))!;
      const shift = (await this.openShiftFor(tx, identity, command))!;
      await replayShiftClose(
        tx,
        { audit: this.audit, shifts: this.shifts },
        {
          identity,
          command,
          signIn,
          shift,
          uploadedByUserId: row.receivedByUserId,
          journalSettlementId: settlement.settlementId,
          at,
        },
      );
    }
    return {
      review: settlement.review,
      commandKind: command.kind,
      decision: "recorded",
      workSessionId: command.session.workSessionId,
    };
  }

  /**
   * Whether the entry can be recorded as it happened, from the evidence this server holds: the
   * grant and snapshot it issued to this counter, the staff sign-in, the counter's own figures,
   * the batches, and the till's shifts.
   */
  private async recordability(
    db: Db,
    row: OfflineJournalReview,
    command: OfflineJournalCommand,
  ): Promise<Recordability> {
    const identity = identityOf(row);
    const no = (blocker: RecordBlocker): Recordability => ({
      ok: false,
      blocker,
    });
    const grant = await this.grant(db, identity, command.grantId);
    if (!grant) return no("grant_unknown");
    if (!(await this.signIn(db, identity, command.staffSignInId)))
      return no("sign_in_missing");
    if (
      command.session.registerId !== grant.registerId ||
      command.session.tillId !== grant.tillId
    )
      return no("till_mismatch");
    if (command.kind === "ordinary_sale") {
      const snapshot = await this.snapshot(db, identity, command.snapshotId);
      if (!snapshot) return no("snapshot_unknown");
      const money = recordedSaleError(command, snapshot);
      if (money) return no(money);
      const lines = resolveSaleLines(command, snapshot);
      const batches = await db.batch.findMany({
        where: {
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          id: { in: lines.map((l) => l.batchId) },
        },
        select: { id: true, productId: true },
      });
      if (
        lines.some(
          (l) =>
            !batches.some(
              (b) => b.id === l.batchId && b.productId === l.productId,
            ),
        )
      )
        return no("batch_missing");
      // The sale joins the shift it was made on, as at intake; it must be open on the server.
      const shift = await db.tillShift.findFirst({
        where: {
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          id: command.session.workSessionId,
          closedAt: null,
        },
        select: { tillId: true, registerId: true, staffUserId: true },
      });
      if (
        !shift ||
        shift.tillId !== command.session.tillId ||
        shift.registerId !== command.session.registerId
      )
        return no("shift_not_open");
      return { ok: true, blocker: null };
    }
    if (command.kind === "shift_open") {
      const open = await db.tillShift.findFirst({
        where: {
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          tillId: command.session.tillId,
          closedAt: null,
        },
        select: { id: true },
      });
      if (open) return no("till_has_open_shift");
      const used = await db.tillShift.findFirst({
        where: {
          tenantId: identity.tenantId,
          id: command.session.workSessionId,
        },
        select: { id: true },
      });
      if (used) return no("shift_id_used");
      return { ok: true, blocker: null };
    }
    if (!(await this.openShiftFor(db, identity, command)))
      return no("shift_not_open");
    return { ok: true, blocker: null };
  }

  /**
   * Why no decision can be made on this refusal: not a rejected command, already settled, no
   * longer the entry that follows the accepted head (another entry took its place), or a counter
   * whose journal is recovered through D11 instead.
   */
  private async settleBlocker(
    db: Db,
    row: OfflineJournalReview,
    command: OfflineJournalCommand,
  ): Promise<SettleBlocker | null> {
    if (
      row.recordKind !== "command" ||
      row.outcome !== "rejected" ||
      row.sequence === null
    )
      return "not_rejected";
    const settled = await db.offlineJournalSettlement.findFirst({
      where: {
        tenantId: row.tenantId,
        branchId: row.branchId,
        reviewId: row.id,
        status: OfflineJournalSettlementStatus.settled,
      },
      select: { id: true },
    });
    if (settled) return "settled";
    const identity = identityOf(row);
    const head = await offlineJournalHead(db, identity);
    const headSequence = head ? Number(head.offlineSequence) : 0;
    if (
      Number(row.sequence) !== headSequence + 1 ||
      command.previousCommandHash !== (head?.requestDigest ?? null)
    )
      return "not_next";
    const receipt = await db.terminalCommandReceipt.findFirst({
      where: {
        tenantId: row.tenantId,
        enrollmentId: row.enrollmentId,
        commandId: command.commandId,
      },
      select: { id: true },
    });
    if (receipt) return "not_next";
    const enrollment = await db.terminalEnrollment.findFirst({
      where: { tenantId: row.tenantId, id: row.enrollmentId },
      select: { revokedAt: true, terminal: { select: { retiredAt: true } } },
    });
    if (!enrollment || enrollment.revokedAt || enrollment.terminal.retiredAt)
      return "counter_revoked";
    return null;
  }

  // ── Evidence ────────────────────────────────────────────────────────────────────────────────

  private async grant(
    db: Db,
    identity: TerminalIdentity,
    grantId: string,
  ): Promise<OfflineGrant | null> {
    const issuance = await db.offlineAuthorityIssuance.findFirst({
      where: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        enrollmentId: identity.enrollmentId,
        grant: { path: ["payload", "grantId"], equals: grantId },
      },
      select: { grant: true },
    });
    return issuance
      ? (issuance.grant as unknown as Signed<OfflineGrant>).payload
      : null;
  }

  private async snapshot(
    db: Db,
    identity: TerminalIdentity,
    snapshotId: string,
  ): Promise<BranchStockSnapshot | null> {
    const row = await db.offlineStockSnapshot.findFirst({
      where: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        enrollmentId: identity.enrollmentId,
        id: snapshotId,
      },
      select: { envelope: true },
    });
    return row
      ? (row.envelope as unknown as Signed<BranchStockSnapshot>).payload
      : null;
  }

  private async signIn(
    db: Db,
    identity: TerminalIdentity,
    signInId: string,
  ): Promise<OfflineStaffSignIn | null> {
    const row = await db.offlineStaffSignIn.findUnique({
      where: {
        tenantId_enrollmentId_signInId: {
          tenantId: identity.tenantId,
          enrollmentId: identity.enrollmentId,
          signInId,
        },
      },
      select: { envelope: true },
    });
    return row
      ? (row.envelope as unknown as Signed<OfflineStaffSignIn>).payload
      : null;
  }

  /** The open shift a `shift_close` closes: the same shift, till, register and cashier. */
  private openShiftFor(
    db: Db,
    identity: TerminalIdentity,
    command: OfflineShiftCloseCommand,
  ) {
    return db.tillShift.findFirst({
      where: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        id: command.session.workSessionId,
        tillId: command.session.tillId,
        registerId: command.session.registerId,
        staffUserId: command.session.staffUserId,
        closedAt: null,
      },
    });
  }

  /** The entry decoded for the manager: who, when, and for a sale what was sold and paid. */
  private async entryView(
    tenantId: string,
    branchId: string,
    identity: TerminalIdentity,
    command: OfflineJournalCommand,
  ) {
    const staffIds = [command.session.staffUserId];
    const signIn = await this.signIn(
      this.prisma,
      identity,
      command.staffSignInId,
    );
    if (signIn) staffIds.push(signIn.session.staffUserId);
    const shift = await this.prisma.tillShift.findFirst({
      where: { tenantId, branchId, id: command.session.workSessionId },
      select: { shiftNumber: true, closedAt: true, openedAt: true },
    });
    const names = await this.names(tenantId, staffIds);
    const base = {
      occurredAt: new Date(command.occurredAt).toISOString(),
      offlineStartedAt: new Date(command.offlineStartedAt).toISOString(),
      staff: {
        id: command.session.staffUserId,
        name: names.get(command.session.staffUserId) ?? null,
      },
      signedInAs: signIn
        ? {
            id: signIn.session.staffUserId,
            name: names.get(signIn.session.staffUserId) ?? null,
          }
        : null,
      workSessionId: command.session.workSessionId,
      shift: shift
        ? {
            number: shift.shiftNumber,
            openedAt: shift.openedAt.toISOString(),
            closedAt: shift.closedAt?.toISOString() ?? null,
          }
        : null,
    };
    if (command.kind === "shift_open")
      return {
        ...base,
        kind: command.kind,
        openingCashMinor: command.openingCashMinor,
      };
    if (command.kind === "shift_close")
      return {
        ...base,
        kind: command.kind,
        closingCashCountMinor: command.closingCashCountMinor,
        counterExpectedCashMinor: command.expectedCashMinor,
        assistanceReason: command.assistance?.reason ?? null,
      };
    return {
      ...base,
      kind: command.kind,
      ...(await this.saleView(tenantId, branchId, identity, command)),
    };
  }

  private async saleView(
    tenantId: string,
    branchId: string,
    identity: TerminalIdentity,
    command: OfflineSaleCommand,
  ) {
    const snapshot = await this.snapshot(
      this.prisma,
      identity,
      command.snapshotId,
    );
    const known = (id: string) =>
      snapshot?.lines.find((l) => l.snapshotLineId === id) ?? null;
    const batchIds = command.lines
      .map((l) => known(l.snapshotLineId)?.batchId)
      .filter((id): id is string => !!id);
    const batches = await this.prisma.batch.findMany({
      where: { tenantId, branchId, id: { in: batchIds } },
      select: {
        id: true,
        batchNo: true,
        expiryDate: true,
        product: { select: { id: true, name: true } },
      },
    });
    return {
      snapshotVersion: command.snapshotVersion,
      totalMinor: command.totalMinor,
      lines: command.lines.map((line) => {
        const snap = known(line.snapshotLineId);
        const batch = snap
          ? batches.find((b) => b.id === snap.batchId)
          : undefined;
        return {
          snapshotLineId: line.snapshotLineId,
          product: batch
            ? { id: batch.product.id, name: batch.product.name }
            : null,
          batch: batch
            ? {
                id: batch.id,
                batchNo: batch.batchNo,
                expiryDate: batch.expiryDate.toISOString().slice(0, 10),
              }
            : null,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          taxMinor: line.taxMinor,
          lineTotalMinor: line.quantity * line.unitPriceMinor + line.taxMinor,
          inSnapshot: snap !== null,
        };
      }),
      payments: command.payments.map((p) =>
        p.method === "cash"
          ? {
              method: "cash" as const,
              amountMinor: p.amountMinor,
              tenderedMinor: p.tenderedMinor,
              changeMinor: p.changeMinor,
            }
          : {
              method: "external_card" as const,
              amountMinor: p.amountMinor,
              providerReference: p.providerReference,
              approvalCode: p.approvalCode,
            },
      ),
    };
  }

  /** Settlements with their approval evidence, and what to approve for one still waiting. */
  private async settlementsView(
    tenantId: string,
    branchId: string,
    rows: readonly OfflineJournalSettlement[],
  ) {
    const approvalIds = rows
      .map((r) => r.executionApprovalId)
      .filter((id): id is string => !!id);
    const waiting =
      rows.find((r) => r.status === OfflineJournalSettlementStatus.prepared) ??
      null;
    const [approvalRows, facts, people, sales] = await Promise.all([
      this.prisma.managementApproval.findMany({
        where: { tenantId, branchId, id: { in: approvalIds } },
        select: { id: true, approvedAt: true },
      }),
      waiting
        ? this.prisma.$transaction((tx) =>
            offlineJournalSettlementFacts(tx, waiting),
          )
        : null,
      this.names(
        tenantId,
        rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.cancelledBy]),
      ),
      this.salesOf(tenantId, branchId, rows),
    ]);
    const person = (id: string | null) =>
      id ? { id, name: people.get(id) ?? null } : null;
    return rows.map((r) => {
      const result = r.result as unknown as ReviewedEntryOutcome | null;
      const saleId =
        result &&
        result.decision === "recorded" &&
        result.commandKind === "ordinary_sale"
          ? result.saleId
          : null;
      const caseId =
        result &&
        result.decision === "recorded" &&
        result.commandKind === "ordinary_sale"
          ? result.reconciliationCaseId
          : null;
      return {
        id: r.id,
        decision: r.decision,
        reason: r.reason,
        status: r.status,
        approvalVersion: r.approvalVersion,
        executionApprovalId: r.executionApprovalId,
        // Approve exactly what is shown: the current version and digest.
        approvalReview:
          r.status === OfflineJournalSettlementStatus.prepared &&
          facts &&
          waiting?.id === r.id
            ? {
                expectedVersion: r.approvalVersion,
                expectedDigest: offlineJournalSettlementDigest(facts.material),
              }
            : null,
        requester: person(r.requestedBy),
        requestedAt: r.requestedAt.toISOString(),
        approver: person(r.approvedBy),
        approvedAt:
          approvalRows
            .find((a) => a.id === r.executionApprovalId)
            ?.approvedAt.toISOString() ?? null,
        settledAt: r.settledAt?.toISOString() ?? null,
        cancelledBy: person(r.cancelledBy),
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        sale: saleId
          ? {
              id: saleId,
              invoiceNo: sales.get(saleId) ?? null,
              stockCaseId: caseId,
            }
          : null,
        workSessionId:
          result &&
          result.decision === "recorded" &&
          result.commandKind !== "ordinary_sale"
            ? result.workSessionId
            : null,
      };
    });
  }

  private async salesOf(
    tenantId: string,
    branchId: string,
    rows: readonly OfflineJournalSettlement[],
  ) {
    const ids = rows
      .map((r) => r.result as unknown as ReviewedEntryOutcome | null)
      .flatMap((res) =>
        res &&
        res.decision === "recorded" &&
        res.commandKind === "ordinary_sale"
          ? [res.saleId]
          : [],
      );
    if (!ids.length) return new Map<string, string>();
    const sales = await this.prisma.sale.findMany({
      where: { tenantId, branchId, id: { in: ids } },
      select: { id: true, invoiceNo: true },
    });
    return new Map(sales.map((s) => [s.id, s.invoiceNo]));
  }

  private async readReview(
    db: Db,
    tenantId: string,
    branchId: string,
    reviewId: string,
  ) {
    const row = await db.offlineJournalReview.findFirst({
      where: { tenantId, branchId, id: reviewId, recordKind: "command" },
    });
    if (!row || row.sequence === null)
      throw new NotFoundException("Refused offline record not found");
    return row;
  }

  private async heads(db: Db, tenantId: string, enrollmentIds: string[]) {
    const out = new Map<string, number>();
    for (const enrollmentId of new Set(enrollmentIds)) {
      const head = await offlineJournalHead(db, { tenantId, enrollmentId });
      out.set(enrollmentId, head ? Number(head.offlineSequence) : 0);
    }
    return out;
  }

  private async names(
    tenantId: string,
    ids: ReadonlyArray<string | null | undefined>,
  ) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map<string, string>();
    const users = await this.prisma.appUser.findMany({
      where: { tenantId, id: { in: wanted } },
      select: { id: true, fullName: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private async terminalLabels(
    tenantId: string,
    branchId: string,
    ids: string[],
  ) {
    const rows = await this.prisma.operationalTerminal.findMany({
      where: { tenantId, branchId, id: { in: [...new Set(ids)] } },
      select: { id: true, label: true, counter: { select: { label: true } } },
    });
    return new Map(rows.map((r) => [r.id, r.counter?.label ?? r.label]));
  }
}

/** The signed entry the counter sent, as retained with its refusal. */
function entryOf(
  row: Pick<OfflineJournalReview, "envelope">,
): OfflineJournalCommand {
  return (row.envelope as unknown as Signed<OfflineJournalCommand>).payload;
}

function identityOf(
  row: Pick<
    OfflineJournalReview,
    "tenantId" | "branchId" | "terminalId" | "enrollmentId" | "keyId"
  >,
): TerminalIdentity {
  return {
    tenantId: row.tenantId,
    branchId: row.branchId,
    terminalId: row.terminalId,
    enrollmentId: row.enrollmentId,
    keyId: row.keyId,
  };
}

function entryState(
  row: OfflineJournalReview & { settlements?: OfflineJournalSettlement[] },
  headSequence: number,
): EntryState {
  if (
    row.settlements?.some(
      (s) => s.status === OfflineJournalSettlementStatus.settled,
    )
  )
    return "settled";
  return Number(row.sequence) > headSequence ? "open" : "superseded";
}
