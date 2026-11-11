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
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import {
  isPrismaUniqueFieldError,
  normalizeIdempotencyKey,
} from "../common/idempotency.util";
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
  lockTillForEntry,
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
  NOT_HONOUR_BLOCKER_MESSAGES,
  RECORD_BLOCKER_MESSAGES,
  SETTLE_BLOCKER_MESSAGES,
  isoOrNull,
  notHonourBlocker,
  notHonouredEffect,
  parseDecision,
  parseReason,
  recordedSaleError,
  recordedOccurredAt,
  refusalExplanation,
  signInMatches,
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
 *   if the till allows it, and then must be: not honouring it would strand the rest of its shift.
 * - `not_honoured`: no sale, payment or stock is written; cash the counter took shows in that
 *   shift's variance, and a card payment it took is kept as collected, not sold
 *   (`offline_collected_payment`), for a refund or a re-sale.
 *
 * Either way the server's `terminal_command_receipt` is written at the entry's own sequence with its
 * own digest, so later entries chain onto it. The counter learns the outcome by resending the entry:
 * the receipt answers `reviewed` in the signed sync response.
 *
 * Lock order: the settlement, the enrollment's journal (the same advisory lock as intake), the
 * approval evidence, then the till rows the entry touches (`lockTillForEntry`, as intake) before
 * anything about the till is checked, then batch rows.
 *
 * Prepare accepts an `Idempotency-Key` (scope `offline_journal_settlement_prepare`): a self-approved
 * prepare writes the sale, so a resend after a lost response returns the first result.
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
    // Filtered in the query, before any limit, so an entry still blocking its counter (past that
    // counter's accepted head, unsettled) is never crowded out by newer settled or overtaken ones.
    const refused = {
      tenantId,
      branchId,
      recordKind: "command",
      outcome: "rejected",
      sequence: { not: null },
    } satisfies Prisma.OfflineJournalReviewWhereInput;
    const enrollments = await this.prisma.offlineJournalReview.findMany({
      where: refused,
      distinct: ["enrollmentId"],
      select: { enrollmentId: true },
    });
    if (!enrollments.length) return [];
    const heads = await this.heads(
      this.prisma,
      tenantId,
      enrollments.map((e) => e.enrollmentId),
    );
    const settled = {
      tenantId,
      status: OfflineJournalSettlementStatus.settled,
    };
    const againstHead = (past: boolean) =>
      [...heads].map(([enrollmentId, head]) => ({
        enrollmentId,
        sequence: past ? { gt: BigInt(head) } : { lte: BigInt(head) },
      }));
    const rows = await this.prisma.offlineJournalReview.findMany({
      where:
        status === "open"
          ? {
              ...refused,
              settlements: { none: settled },
              OR: againstHead(true),
            }
          : {
              ...refused,
              OR: [{ settlements: { some: settled } }, ...againstHead(false)],
            },
      include: {
        settlements: {
          where: { tenantId },
          orderBy: { requestedAt: "desc" },
          include: { collectedPayments: { where: { tenantId } } },
        },
      },
      orderBy: { firstReceivedAt: "desc" },
      // Open entries are few (the one after each counter's head); the closed ones are capped.
      ...(status === "closed" ? { take: 200 } : {}),
    });
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
        occurredAt: isoOrNull(command.occurredAt),
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
        // Card money a not-honoured sale took: collected, not sold.
        collectedNotSoldMinor: settlement?.collectedPayments.length
          ? settlement.collectedPayments.reduce(
              (sum, p) => sum + Number(p.amountMinor),
              0,
            )
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
    const settlements = await this.prisma.offlineJournalSettlement.findMany({
      where: { tenantId, branchId, reviewId },
      orderBy: { requestedAt: "desc" },
    });
    const head = await offlineJournalHead(this.prisma, identity);
    const headSequence = head ? Number(head.offlineSequence) : 0;
    const state = entryState({ ...row, settlements }, headSequence);
    const settleBlocker = await this.settleBlocker(this.prisma, row, command);
    const recordability = settleBlocker
      ? null
      : await this.recordability(this.prisma, row, command);
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
      // Whether it may be not honoured, and what that leaves behind.
      notHonoured: recordability ? notHonourView(command, recordability) : null,
      settlements: plans,
    };
  }

  // ── Prepare, approve and settle (remote) ────────────────────────────────────────────────────

  async prepare(
    user: RequestUser,
    branchId: string,
    reviewId: string,
    input: PrepareSettlementInput,
    idempotencyKeyRaw?: string,
  ) {
    const tenantId = user.tenantId;
    const decision = parseDecision(input.decision);
    const reason = parseReason(input.reason);
    const key = normalizeIdempotencyKey(idempotencyKeyRaw);
    // What a resend under the same key must match.
    const requestBody = { reviewId, decision, reason };
    if (key) {
      const replay = await this.replayPrepare(user, branchId, key, requestBody);
      if (replay) return replay;
    }
    let id: string;
    try {
      id = await this.prepareInTransaction(
        user,
        branchId,
        reviewId,
        decision,
        reason,
        key ? { key, requestBody } : null,
      );
    } catch (error) {
      if (
        key &&
        (error instanceof KeyCommitted ||
          isPrismaUniqueFieldError(error, "idempotency"))
      ) {
        const replay = await this.replayPrepare(
          user,
          branchId,
          key,
          requestBody,
        );
        if (replay) return replay;
      }
      throw settleError(error);
    }
    return this.settlementView(tenantId, branchId, id);
  }

  /** The settlement a key already prepared, as it reads now, or null for a new key. */
  private async replayPrepare(
    user: RequestUser,
    branchId: string,
    key: string,
    requestBody: Prisma.InputJsonObject,
  ) {
    const record = await this.prisma.idempotencyRecord.findUnique({
      where: prepareKey(user, key),
    });
    if (!record) return null;
    const settlement = await this.prisma.offlineJournalSettlement.findFirst({
      where: { tenantId: user.tenantId, branchId, id: record.resourceId },
      select: { id: true },
    });
    if (!settlement || !isDeepStrictEqual(record.requestBody, requestBody))
      throw new BadRequestException(
        "Idempotency-Key already used for a different decision",
      );
    return this.settlementView(user.tenantId, branchId, settlement.id);
  }

  private prepareInTransaction(
    user: RequestUser,
    branchId: string,
    reviewId: string,
    decision: OfflineJournalSettlementDecision,
    reason: string,
    keyed: { key: string; requestBody: Prisma.InputJsonObject } | null,
  ) {
    const tenantId = user.tenantId;
    return this.prisma.$transaction(async (tx) => {
      const row = await this.readReview(tx, tenantId, branchId, reviewId);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(REVIEW_PERMISSION))
        throw new ForbiddenException(
          "Your role can't review refused offline sales",
        );
      // The journal lock: the chain can't move while this is checked and prepared.
      await lockOfflineJournal(tx, identityOf(row));
      // A resend under the same key waited here behind its first attempt: answer with that one.
      if (
        keyed &&
        (await tx.idempotencyRecord.findUnique({
          where: prepareKey(user, keyed.key),
        }))
      )
        throw new KeyCommitted();
      const command = entryOf(row);
      const blocker = await this.settleBlocker(tx, row, command);
      if (blocker)
        throw new ConflictException(SETTLE_BLOCKER_MESSAGES[blocker]);
      // Advisory here; approval checks again with the till locked.
      const recordable = await this.recordability(tx, row, command);
      if (decision === "recorded" && !recordable.ok)
        throw new ConflictException(
          `This record can't be recorded as it happened: ${RECORD_BLOCKER_MESSAGES[recordable.blocker]}`,
        );
      const mustRecord = notHonourBlocker(command.kind, recordable.ok);
      if (decision === "not_honoured" && mustRecord)
        throw new ConflictException(NOT_HONOUR_BLOCKER_MESSAGES[mustRecord]);
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
          decision,
          reason,
          requestedBy: user.userId,
        },
      });
      if (keyed)
        await tx.idempotencyRecord.create({
          data: {
            ...prepareKey(user, keyed.key).tenantId_userId_scope_idempotencyKey,
            resourceId: settlement.id,
            requestBody: keyed.requestBody,
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
  }

  async approve(
    user: RequestUser,
    branchId: string,
    settlementId: string,
    input: ApproveSettlementInput,
  ) {
    try {
      await this.prisma.$transaction(
        (tx) =>
          this.approveInTransaction(tx, user, branchId, settlementId, input),
        SETTLE_TX,
      );
    } catch (error) {
      throw settleError(error);
    }
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
    // The till rows the decision depends on, locked as intake locks them, before any check: an
    // online close, open or sale on that till waits until this settlement commits.
    await lockTillForEntry(tx, identity, command);
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
      if (command.kind === "ordinary_sale")
        await this.keepCollectedPayments(tx, row, command, settlementId);
      else if (
        notHonourBlocker(
          command.kind,
          (await this.recordability(tx, row, command)).ok,
        )
      )
        throw new ConflictException(
          "The till can take this shift record now, so it is recorded: cancel this decision and prepare to record it.",
        );
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
   * Writes the refused entry's effect as the counter recorded it, under the journal lock and the
   * till locks the caller took (`lockTillForEntry`), so this check and the write see one state.
   * Every check `recordability` makes is made again here; anything else the offline rules required
   * is what the manager decided to set aside.
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
   * A not-honoured sale's card payments: the customer was charged and no sale exists, so each is
   * kept as collected, not sold, against the shift it was taken in (when that shift is on the
   * server), for a refund or a re-sale at the counter. Cash stays in the drawer, as variance.
   */
  private async keepCollectedPayments(
    tx: Tx,
    row: OfflineJournalReview,
    command: OfflineSaleCommand,
    settlementId: string,
  ) {
    const cards = command.payments.flatMap((p, paymentIndex) =>
      p.method === "external_card" ? [{ card: p, paymentIndex }] : [],
    );
    if (!cards.length) return;
    const shift = await tx.tillShift.findFirst({
      where: {
        tenantId: row.tenantId,
        branchId: row.branchId,
        id: command.session.workSessionId,
      },
      select: { id: true },
    });
    const collectedAt = recordedOccurredAt(
      command.occurredAt,
      row.firstReceivedAt,
    );
    await tx.offlineCollectedPayment.createMany({
      data: cards.map(({ card, paymentIndex }) => ({
        id: randomUUID(),
        tenantId: row.tenantId,
        branchId: row.branchId,
        settlementId,
        enrollmentId: row.enrollmentId,
        commandId: command.commandId,
        paymentIndex,
        method: "external_card",
        amountMinor: BigInt(card.amountMinor),
        providerReference: card.providerReference,
        approvalCode: card.approvalCode,
        approvedAt: isoOrNull(card.approvedAt)
          ? new Date(card.approvedAt)
          : null,
        workSessionId: command.session.workSessionId,
        shiftId: shift?.id ?? null,
        staffUserId: command.session.staffUserId,
        collectedAt,
      })),
    });
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
    // As at intake: the sign-in is this counter's, for the entry's own person and shift.
    const signIn = await this.signIn(db, identity, command.staffSignInId);
    if (!signIn) return no("sign_in_missing");
    if (!signInMatches(identity, command, signIn))
      return no("sign_in_mismatch");
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
        select: {
          tillId: true,
          registerId: true,
          staffUserId: true,
          terminalId: true,
          enrollmentId: true,
        },
      });
      if (
        !shift ||
        shift.tillId !== command.session.tillId ||
        shift.registerId !== command.session.registerId
      )
        return no("shift_not_open");
      // As at intake: only onto the seller's own shift, opened on this counter.
      if (
        shift.staffUserId !== command.session.staffUserId ||
        shift.terminalId !== identity.terminalId ||
        shift.enrollmentId !== identity.enrollmentId
      )
        return no("shift_not_theirs");
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
    // Two different signed records at this one place in the journal (a restored backup that signed
    // again): a forked journal, recovered through D11, never settled one-sidedly here.
    const fork = await db.offlineJournalReview.findFirst({
      where: {
        tenantId: row.tenantId,
        enrollmentId: row.enrollmentId,
        recordKind: "command",
        sequence: row.sequence,
        recordHash: { not: row.recordHash },
      },
      select: { id: true },
    });
    if (fork) return "forked";
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
      occurredAt: isoOrNull(command.occurredAt),
      offlineStartedAt: isoOrNull(command.offlineStartedAt),
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
    const [approvalRows, facts, people, sales, collected] = await Promise.all([
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
      this.prisma.offlineCollectedPayment.findMany({
        where: {
          tenantId,
          branchId,
          settlementId: { in: rows.map((r) => r.id) },
        },
        orderBy: { paymentIndex: "asc" },
      }),
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
        // A not-honoured sale's card payments, kept as collected, not sold.
        collectedPayments: collected
          .filter((c) => c.settlementId === r.id)
          .map((c) => ({
            id: c.id,
            method: c.method,
            amountMinor: Number(c.amountMinor),
            providerReference: c.providerReference,
            approvalCode: c.approvalCode,
            approvedAt: c.approvedAt?.toISOString() ?? null,
            shiftId: c.shiftId,
            collectedAt: c.collectedAt.toISOString(),
          })),
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

/** A resend under an Idempotency-Key whose first attempt committed while this one waited. */
class KeyCommitted extends Error {}

function prepareKey(user: RequestUser, idempotencyKey: string) {
  return {
    tenantId_userId_scope_idempotencyKey: {
      tenantId: user.tenantId,
      userId: user.userId,
      scope: IDEMPOTENCY_SCOPE.offlineJournalSettlementPrepare,
      idempotencyKey,
    },
  } satisfies Prisma.IdempotencyRecordWhereUniqueInput;
}

/**
 * A unique index on the till's shifts refusing a settlement's write: an online shift opened or
 * closed on that till at the same moment. The locks make this rare; it is a conflict, not a fault.
 */
function settleError(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002" &&
    /till_shift|till_id/.test(
      JSON.stringify((error as { meta?: unknown }).meta ?? {}),
    )
  )
    return new ConflictException(
      "The till's shifts changed meanwhile. Open the record again.",
    );
  return error;
}

/** Whether a refused entry may be not honoured, and what that leaves behind. */
function notHonourView(
  command: OfflineJournalCommand,
  recordability: Recordability,
) {
  const blocker = notHonourBlocker(command.kind, recordability.ok);
  return blocker
    ? { ok: false, message: NOT_HONOUR_BLOCKER_MESSAGES[blocker] }
    : { ok: true, message: notHonouredEffect(command, recordability.blocker) };
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
