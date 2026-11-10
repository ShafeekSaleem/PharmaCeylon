import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type OfflineJournalRecovery } from "@prisma/client";
import {
  continuesJournalChain,
  type CounterJournalRecovery,
  type JournalPosition,
  type JournalRecoveryEntrySummary,
  type JournalRecoveryRefusal,
  type OfflineCounterReplacementView,
  type OfflineJournalChainPage,
  type OfflineJournalCommand,
  type OfflineJournalRecoveriesView,
  type OfflineJournalRecoveryView,
  type OfflineStaffSignIn,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { offlineAuthorityCutoff, type AuthorityCutoff } from "../grant-cutoff";
import { acceptedJournalHead } from "../offline-authority-issuance";
import {
  OfflineAssignmentService,
  type OfflineAssignmentAuthority,
} from "../offline-assignment.service";
import { denied, verifySignature } from "../terminal-wire";
import {
  liveSignOff,
  maySignOff,
  signOffAvailableAt,
  signOffCurrent,
} from "./journal-recovery-evidence";
import {
  parseChainRequest,
  parseIdentityRequest,
  parseRecoveryCompletionEnvelope,
  parseRecoveryUpload,
} from "./journal-recovery-wire";
import {
  authenticateJournalUploader,
  lockEnrollmentJournal,
} from "./journal-uploader";
import {
  journalHash,
  parseCommandEnvelope,
  parseSignInEnvelope,
  type JournalItem,
} from "./offline-journal-wire";

type Tx = Prisma.TransactionClient;
type Recovery = OfflineJournalRecovery;
const TX = { timeout: 20_000 } as const;
const IDENTITY_KEYS: ReadonlyArray<keyof TerminalIdentity> = [
  "tenantId",
  "branchId",
  "terminalId",
  "enrollmentId",
  "keyId",
];
const sameIdentity = (a: TerminalIdentity, b: TerminalIdentity) =>
  IDENTITY_KEYS.every((k) => a[k] === b[k]);
const samePosition = (a: JournalPosition, b: JournalPosition) =>
  a.sequence === b.sequence && a.hash === b.hash;
const OPEN: Recovery["status"][] = ["awaiting_approval", "approved"];
/** A stale recovery was superseded: committed first, then refused. */
const SUPERSEDED = Symbol("superseded");

export const JOURNAL_RECOVERY_ERRORS = {
  stale: "JOURNAL_RECOVERY_STALE",
  invalid: "JOURNAL_RECOVERY_INVALID",
  notNeeded: "JOURNAL_RECOVERY_NOT_NEEDED",
  notApproved: "JOURNAL_RECOVERY_NOT_APPROVED",
  incomplete: "JOURNAL_RECOVERY_EVIDENCE_INCOMPLETE",
  tooEarly: "JOURNAL_SIGN_OFF_TOO_EARLY",
  notDelegated: "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
  noCounter: "NO_OFFLINE_COUNTER",
  versionChanged: "NOMINATION_VERSION_CHANGED",
} as const;
const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException({ code, message, ...extra });

const position = (
  sequence: bigint | number | null,
  hash: string | null,
): JournalPosition => ({
  sequence: Number(sequence ?? 0),
  hash,
});
const serverHeadOf = (row: Recovery) =>
  position(row.serverHeadSequence, row.serverHeadHash);
const localHeadOf = (row: Recovery) =>
  position(row.localHeadSequence, row.localHeadHash);
const commonOf = (row: Recovery) =>
  position(row.commonSequence, row.commonHash);

/**
 * P5 #51, approved D11 (decisions of 2026-11-10): journal recovery for a restored counter, and
 * the missing-journal sign-off that lets another counter take over offline selling.
 *
 * **Restored counter.** A counter whose journal is not the server's (`JOURNAL_MISMATCH`) fetches
 * the accepted chain (`chain`: entries it signed itself, so it can verify every one), finds the
 * last entry both agree on, and reports (`report`) — device-signed, with every local entry the
 * server never accepted as evidence. Nothing changes centrally and no grant is issued to it while
 * the recovery is open. The owner or a delegated manager approves exactly what was reported
 * (`approve`), recording how the unmatched sales' stock and cash were settled. The counter then
 * sets those entries aside, restores the accepted entries, moves its head to the server's and
 * removes its restored grant, and confirms with a device-signed completion (`complete`). It never
 * writes at a sequence the server has accepted, and only a pair issued after completion sells.
 *
 * **Missing journal.** The owner or a delegated manager signs off the branch's offline counter's
 * journal (`signOffMissingJournal`): what the server accepted, with anything it never received
 * reviewed as lost. Possible only once that counter's last issued grant has expired, even if it
 * was revoked. Activation of a replacement reads it (`missingJournalEvidence`).
 *
 * Unmatched entries are evidence only: they are never posted as sales.
 */
@Injectable()
export class OfflineJournalRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly assignments: OfflineAssignmentService,
  ) {}

  // ── counter ────────────────────────────────────────────────────────────────

  /** Accepted entries after `afterSequence`, oldest first, with the sign-ins they cite. */
  async chain(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<OfflineJournalChainPage> {
    const request = parseChainRequest(raw);
    return this.prisma.$transaction(async (tx) => {
      await authenticateJournalUploader(
        tx,
        this.access,
        user,
        branchId,
        request.identity,
      );
      const scope = {
        tenantId: request.identity.tenantId,
        enrollmentId: request.identity.enrollmentId,
      };
      const receipts = await tx.terminalCommandReceipt.findMany({
        where: {
          ...scope,
          offlineSequence: { gt: BigInt(request.afterSequence) },
        },
        orderBy: { offlineSequence: "asc" },
        take: request.limit,
        select: { command: true },
      });
      const entries = receipts.map(
        (r) => r.command as unknown as Signed<OfflineJournalCommand>,
      );
      const signIns = await tx.offlineStaffSignIn.findMany({
        where: {
          ...scope,
          signInId: { in: [...citedSignIns(entries.map((e) => e.payload))] },
        },
        select: { envelope: true },
      });
      return {
        head: await acceptedJournalHead(tx, request.identity),
        entries,
        staffSignIns: signIns.map(
          (s) => s.envelope as unknown as Signed<OfflineStaffSignIn>,
        ),
      };
    }, TX);
  }

  /**
   * A device-signed report and one page of its unmatched entries. The first call opens the
   * recovery (superseding any open one for the counter); later calls with the same report add
   * the next page. A recovery that is no longer awaiting approval takes no more pages.
   */
  async report(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<CounterJournalRecovery> {
    const upload = parseRecoveryUpload(raw);
    const report = upload.report.payload;
    const { identity } = report;
    const unmatched = upload.unmatched.map(parseCommandEnvelope);
    const signIns = upload.staffSignIns.map(parseSignInEnvelope);
    for (const item of [...unmatched, ...signIns])
      if (!sameIdentity(item.payload.identity, identity))
        denied("IDENTITY_MISMATCH");
    return this.prisma.$transaction(async (tx) => {
      const { publicKeyHex } = await authenticateJournalUploader(
        tx,
        this.access,
        user,
        branchId,
        identity,
      );
      for (const envelope of [
        upload.report,
        ...unmatched.map((i) => i.envelope),
        ...signIns.map((i) => i.envelope),
      ])
        verifySignature(envelope, publicKeyHex);
      await lockEnrollmentJournal(tx, identity.tenantId, identity.enrollmentId);

      let row = await tx.offlineJournalRecovery.findUnique({
        where: {
          tenantId_enrollmentId_reportId: {
            tenantId: identity.tenantId,
            enrollmentId: identity.enrollmentId,
            reportId: report.reportId,
          },
        },
      });
      if (row) {
        if (
          row.kind !== "counter_restore" ||
          journalHash(row.report) !== journalHash(report)
        )
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.invalid,
            "This report ID was already used for another report.",
          );
      } else {
        await this.checkReport(tx, identity, report);
        await tx.offlineJournalRecovery.updateMany({
          where: {
            tenantId: identity.tenantId,
            enrollmentId: identity.enrollmentId,
            kind: "counter_restore",
            status: { in: OPEN },
          },
          data: { status: "superseded", supersededAt: new Date() },
        });
        row = await tx.offlineJournalRecovery.create({
          data: {
            id: randomUUID(),
            ...identity,
            kind: "counter_restore",
            status: "awaiting_approval",
            serverHeadSequence: BigInt(report.serverHead.sequence),
            serverHeadHash: report.serverHead.hash,
            reportId: report.reportId,
            report: report as unknown as Prisma.InputJsonValue,
            localHeadSequence: BigInt(report.localHead.sequence),
            localHeadHash: report.localHead.hash,
            commonSequence: BigInt(report.commonPrefix.sequence),
            commonHash: report.commonPrefix.hash,
            createdByUserId: user.userId,
          },
        });
        await this.audit.log(
          {
            tenantId: identity.tenantId,
            branchId: identity.branchId,
            actorUserId: user.userId,
            eventName: "terminal.journal_recovery_reported",
            entityName: "offline_journal_recovery",
            entityId: row.id,
            payload: {
              enrollmentId: identity.enrollmentId,
              terminalId: identity.terminalId,
              serverHead: report.serverHead,
              commonPrefix: report.commonPrefix,
              localHead: report.localHead,
              unmatched:
                report.localHead.sequence - report.commonPrefix.sequence,
            },
          },
          tx,
        );
      }
      if (row.status === "awaiting_approval")
        await this.addEvidence(tx, row, unmatched, signIns);
      return this.counterView(tx, row);
    }, TX);
  }

  /** The counter's latest restore recovery, if any (a superseded one tells it to report again). */
  async status(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<CounterJournalRecovery | null> {
    const identity = parseIdentityRequest(raw);
    return this.prisma.$transaction(async (tx) => {
      await authenticateJournalUploader(
        tx,
        this.access,
        user,
        branchId,
        identity,
      );
      await lockEnrollmentJournal(tx, identity.tenantId, identity.enrollmentId);
      const row = await tx.offlineJournalRecovery.findFirst({
        where: {
          tenantId: identity.tenantId,
          enrollmentId: identity.enrollmentId,
          kind: "counter_restore",
        },
        orderBy: { createdAt: "desc" },
      });
      if (!row) return null;
      // The server's journal moved on since the report: tell the counter to report again.
      if (await this.stale(tx, row))
        return this.counterView(tx, await this.supersede(tx, row));
      return this.counterView(tx, row);
    }, TX);
  }

  /** The counter's device-signed confirmation that it applied the approved recovery. */
  async complete(
    user: RequestUser,
    branchId: string,
    recoveryId: string,
    raw: unknown,
  ): Promise<CounterJournalRecovery> {
    const envelope = parseRecoveryCompletionEnvelope(raw);
    const completion = envelope.payload;
    const { identity } = completion;
    if (completion.recoveryId !== recoveryId) denied("IDENTITY_MISMATCH");
    const result = await this.prisma.$transaction(
      async (tx): Promise<CounterJournalRecovery | typeof SUPERSEDED> => {
        const { publicKeyHex } = await authenticateJournalUploader(
          tx,
          this.access,
          user,
          branchId,
          identity,
        );
        verifySignature(envelope, publicKeyHex);
        await lockEnrollmentJournal(
          tx,
          identity.tenantId,
          identity.enrollmentId,
        );
        const row = await tx.offlineJournalRecovery.findFirst({
          where: {
            tenantId: identity.tenantId,
            branchId,
            id: recoveryId,
            enrollmentId: identity.enrollmentId,
            kind: "counter_restore",
          },
        });
        if (!row) throw new NotFoundException("Journal recovery not found.");
        if (row.status === "recovered") {
          if (journalHash(row.completion) !== journalHash(envelope))
            throw conflict(
              JOURNAL_RECOVERY_ERRORS.invalid,
              "This recovery was completed with another confirmation.",
            );
          return this.counterView(tx, row);
        }
        if (row.status !== "approved")
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.notApproved,
            "This recovery is not approved.",
            { status: row.status },
          );
        if (
          !samePosition(completion.journalHead, serverHeadOf(row)) ||
          !samePosition(completion.setAsideThrough, localHeadOf(row))
        )
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.invalid,
            "The confirmation does not match the approved recovery.",
          );
        if (
          !samePosition(
            await acceptedJournalHead(tx, identity),
            serverHeadOf(row),
          )
        ) {
          await this.supersede(tx, row);
          return SUPERSEDED;
        }
        const done = await tx.offlineJournalRecovery.update({
          where: { id: row.id, tenantId: row.tenantId },
          data: {
            status: "recovered",
            completedAt: new Date(),
            completion: envelope as unknown as Prisma.InputJsonValue,
          },
        });
        await this.audit.log(
          {
            tenantId: identity.tenantId,
            branchId,
            actorUserId: user.userId,
            eventName: "terminal.journal_recovery_completed",
            entityName: "offline_journal_recovery",
            entityId: row.id,
            payload: {
              enrollmentId: identity.enrollmentId,
              journalHead: completion.journalHead,
              setAsideThrough: completion.setAsideThrough,
            },
          },
          tx,
        );
        return this.counterView(tx, done);
      },
      TX,
    );
    // Refused after the supersede commits, so the counter's next status read sees it.
    if (result === SUPERSEDED)
      throw conflict(
        JOURNAL_RECOVERY_ERRORS.stale,
        "The server's journal for this counter changed since approval. Report again.",
      );
    return result;
  }

  // ── back office ────────────────────────────────────────────────────────────

  async list(
    user: RequestUser,
    branchId: string,
  ): Promise<OfflineJournalRecoveriesView> {
    return this.prisma.$transaction(async (tx) => {
      const scope = { tenantId: user.tenantId, branchId };
      const open = await tx.offlineJournalRecovery.findMany({
        where: { ...scope, kind: "counter_restore", status: { in: OPEN } },
        orderBy: { createdAt: "desc" },
      });
      const recent = await tx.offlineJournalRecovery.findMany({
        where: { ...scope, id: { notIn: open.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      const labels = await this.labels(
        tx,
        user.tenantId,
        [...open, ...recent].map((r) => r.terminalId),
      );
      const recoveries = [];
      for (const row of [...open, ...recent]) {
        recoveries.push({
          recoveryId: row.id,
          kind: row.kind,
          status: row.status,
          terminalId: row.terminalId,
          terminalLabel: labels.get(row.terminalId) ?? null,
          enrollmentId: row.enrollmentId,
          createdAt: row.createdAt.getTime(),
          stale: await this.stale(tx, row),
          unmatched:
            row.kind === "counter_restore"
              ? Number(row.localHeadSequence) - Number(row.commonSequence)
              : 0,
        });
      }
      return {
        branchId,
        recoveries,
        offlineCounter: await this.offlineCounter(tx, user.tenantId, branchId),
      };
    }, TX);
  }

  async detail(
    user: RequestUser,
    branchId: string,
    id: string,
  ): Promise<OfflineJournalRecoveryView> {
    return this.prisma.$transaction(
      async (tx) =>
        this.view(tx, await this.find(tx, user.tenantId, branchId, id)),
      TX,
    );
  }

  /** Approve a restored counter's recovery exactly as shown: its server head and unmatched entries. */
  async approve(
    user: RequestUser,
    branchId: string,
    id: string,
    input: {
      reason: string;
      expectedServerHeadSequence: number;
      expectedUnmatched: number;
    },
  ): Promise<OfflineJournalRecoveryView> {
    const reason = input.reason.trim();
    const result = await this.prisma.$transaction(
      async (tx): Promise<OfflineJournalRecoveryView | typeof SUPERSEDED> => {
        const authority = await this.requireAuthority(tx, user, branchId);
        const found = await this.find(tx, user.tenantId, branchId, id);
        await lockEnrollmentJournal(tx, found.tenantId, found.enrollmentId);
        const row = await this.find(tx, user.tenantId, branchId, id);
        if (
          row.kind !== "counter_restore" ||
          row.status !== "awaiting_approval"
        )
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.notApproved,
            "This recovery is not awaiting approval.",
            { status: row.status },
          );
        const unmatched =
          Number(row.localHeadSequence) - Number(row.commonSequence);
        if (
          Number(row.serverHeadSequence) !== input.expectedServerHeadSequence ||
          unmatched !== input.expectedUnmatched
        )
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.stale,
            "This recovery changed since you opened it. Review it again.",
          );
        if (
          !samePosition(await acceptedJournalHead(tx, row), serverHeadOf(row))
        ) {
          await this.supersede(tx, row);
          return SUPERSEDED;
        }
        if ((await this.received(tx, row)) !== unmatched)
          throw conflict(
            JOURNAL_RECOVERY_ERRORS.incomplete,
            "The counter has not uploaded all of its unmatched entries yet.",
          );
        const approved = await tx.offlineJournalRecovery.update({
          where: { id: row.id, tenantId: row.tenantId },
          data: { status: "approved", ...approval(user, authority, reason) },
        });
        await this.audit.log(
          {
            tenantId: user.tenantId,
            branchId,
            actorUserId: user.userId,
            eventName: "terminal.journal_recovery_approved",
            entityName: "offline_journal_recovery",
            entityId: row.id,
            payload: {
              enrollmentId: row.enrollmentId,
              serverHead: serverHeadOf(row),
              commonPrefix: commonOf(row),
              localHead: localHeadOf(row),
              unmatched,
              reason,
              authority: authority.kind,
              delegationId:
                authority.kind === "delegated_manager"
                  ? authority.delegationId
                  : null,
            },
          },
          tx,
        );
        return this.view(tx, approved);
      },
      TX,
    );
    if (result === SUPERSEDED)
      throw conflict(
        JOURNAL_RECOVERY_ERRORS.stale,
        "The server's journal for this counter changed. The counter reports again by itself.",
      );
    return result;
  }

  /**
   * Sign off the branch's offline counter's journal (D11 missing-journal review), once its last
   * issued grant has expired. Supersedes an earlier sign-off for the same counter.
   */
  async signOffMissingJournal(
    user: RequestUser,
    branchId: string,
    input: {
      enrollmentId: string;
      expectedNominationVersion: number;
      expectedServerHeadSequence: number;
      reason: string;
    },
    now = Date.now(),
  ): Promise<OfflineJournalRecoveryView> {
    const reason = input.reason.trim();
    return this.prisma.$transaction(async (tx) => {
      const authority = await this.requireAuthority(tx, user, branchId);
      // The row D11 clearance locks and issuance shares: no grant is issued meanwhile.
      await tx.$queryRaw`SELECT id FROM offline_terminal_nomination
        WHERE tenant_id = ${user.tenantId}::uuid AND branch_id = ${branchId}::uuid FOR UPDATE`;
      const nomination = await tx.offlineTerminalNomination.findUnique({
        where: { tenantId_branchId: { tenantId: user.tenantId, branchId } },
      });
      if (!nomination)
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.noCounter,
          "This branch has no offline counter.",
        );
      if (
        nomination.enrollmentId !== input.enrollmentId ||
        nomination.version !== input.expectedNominationVersion
      )
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.versionChanged,
          "The branch's offline counter changed. Review it again.",
        );
      await lockEnrollmentJournal(tx, user.tenantId, nomination.enrollmentId);
      const cutoff = await offlineAuthorityCutoff(tx, nomination);
      if (!maySignOff(cutoff, now))
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.tooEarly,
          "This counter's last offline permission has not expired yet; it could still be selling offline.",
          { availableAt: signOffAvailableAt(cutoff) },
        );
      const head = await acceptedJournalHead(tx, nomination);
      if (head.sequence !== input.expectedServerHeadSequence)
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.stale,
          "More of this counter's journal arrived. Review it again.",
        );
      await tx.offlineJournalRecovery.updateMany({
        where: {
          tenantId: user.tenantId,
          enrollmentId: nomination.enrollmentId,
          kind: "missing_journal",
          status: "approved",
        },
        data: { status: "superseded", supersededAt: new Date(now) },
      });
      const enrollment = await tx.terminalEnrollment.findFirstOrThrow({
        where: {
          tenantId: user.tenantId,
          branchId,
          id: nomination.enrollmentId,
        },
        select: { terminalId: true, keyId: true },
      });
      const at = new Date(now);
      const row = await tx.offlineJournalRecovery.create({
        data: {
          id: randomUUID(),
          tenantId: user.tenantId,
          branchId,
          terminalId: enrollment.terminalId,
          enrollmentId: nomination.enrollmentId,
          keyId: enrollment.keyId,
          kind: "missing_journal",
          status: "approved",
          serverHeadSequence: BigInt(head.sequence),
          serverHeadHash: head.hash,
          nominationVersion: nomination.version,
          cutoff: cutoff as unknown as Prisma.InputJsonValue,
          createdAt: at,
          createdByUserId: user.userId,
          ...approval(user, authority, reason, at),
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.offline_journal_signed_off",
          entityName: "offline_journal_recovery",
          entityId: row.id,
          payload: {
            enrollmentId: nomination.enrollmentId,
            nominationVersion: nomination.version,
            serverHead: head,
            cutoff,
            reason,
            authority: authority.kind,
            delegationId:
              authority.kind === "delegated_manager"
                ? authority.delegationId
                : null,
          },
        },
        tx,
      );
      return this.view(tx, row);
    }, TX);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async requireAuthority(
    tx: Tx,
    user: RequestUser,
    branchId: string,
  ): Promise<OfflineAssignmentAuthority> {
    try {
      return await this.assignments.authorityOf(tx, user, branchId);
    } catch (error) {
      if (error instanceof ForbiddenException)
        throw new ForbiddenException({
          code: JOURNAL_RECOVERY_ERRORS.notDelegated,
          message:
            "Only an owner, or a manager the owner delegated for this branch's offline counter, can approve this.",
        });
      throw error;
    }
  }

  /** A new report must match the server's chain where it says the two agree. */
  private async checkReport(
    tx: Tx,
    identity: TerminalIdentity,
    report: {
      serverHead: JournalPosition;
      commonPrefix: JournalPosition;
      localHead: JournalPosition;
    },
  ) {
    const head = await acceptedJournalHead(tx, identity);
    if (!samePosition(head, report.serverHead))
      throw conflict(
        JOURNAL_RECOVERY_ERRORS.stale,
        "The server's journal for this counter changed. Report again.",
        { serverHead: head },
      );
    const common = report.commonPrefix;
    if (
      common.sequence > 0 &&
      (await this.acceptedHashAt(tx, identity, common.sequence)) !== common.hash
    )
      throw conflict(
        JOURNAL_RECOVERY_ERRORS.invalid,
        "The server does not have the entry the report says both journals share.",
      );
    // The whole server chain is on this computer: it is behind, not different. Upload instead.
    if (common.sequence === head.sequence)
      throw conflict(
        JOURNAL_RECOVERY_ERRORS.notNeeded,
        "This computer has every accepted entry. It only needs to upload the rest.",
      );
  }

  private async acceptedHashAt(
    tx: Tx,
    identity: Pick<TerminalIdentity, "tenantId" | "enrollmentId">,
    sequence: number,
  ) {
    const receipt = await tx.terminalCommandReceipt.findUnique({
      where: {
        tenantId_enrollmentId_offlineSequence: {
          tenantId: identity.tenantId,
          enrollmentId: identity.enrollmentId,
          offlineSequence: BigInt(sequence),
        },
      },
      select: { requestDigest: true },
    });
    return receipt?.requestDigest ?? null;
  }

  /**
   * The next page of unmatched entries: contiguous from the last one received (a page already
   * received is accepted again unchanged), chaining to the report's local head, and never an
   * accepted entry. Sign-ins are kept as they were signed.
   */
  private async addEvidence(
    tx: Tx,
    row: Recovery,
    unmatched: ReadonlyArray<JournalItem<OfflineJournalCommand>>,
    signIns: ReadonlyArray<JournalItem<OfflineStaffSignIn>>,
  ) {
    const stored = await tx.offlineJournalRecoveryEntry.findMany({
      where: {
        tenantId: row.tenantId,
        recoveryId: row.id,
        recordKind: "command",
      },
      orderBy: { sequence: "asc" },
      select: { sequence: true, recordHash: true },
    });
    const storedAt = new Map(
      stored.map((e) => [Number(e.sequence), e.recordHash]),
    );
    const ordered = [...unmatched].sort(
      (a, b) => a.payload.sequence - b.payload.sequence,
    );
    const fresh = ordered.filter((item) => {
      const known = storedAt.get(item.payload.sequence);
      if (known !== undefined && known !== item.hash)
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.invalid,
          "An unmatched entry does not match what this counter uploaded before.",
        );
      return known === undefined;
    });
    const last = stored.at(-1);
    const from = last
      ? position(last.sequence, last.recordHash)
      : commonOf(row);
    const local = localHeadOf(row);
    if (fresh.length) {
      if (
        !continuesJournalChain(
          from,
          fresh.map((i) => i.payload),
          fresh.map((i) => i.hash),
        )
      )
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.invalid,
          "These entries do not continue this computer's journal from the last one received.",
        );
      const end = fresh.at(-1)!;
      if (
        end.payload.sequence > local.sequence ||
        (end.payload.sequence === local.sequence && end.hash !== local.hash)
      )
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.invalid,
          "These entries go past the journal head the report names.",
        );
      // Chained from the common prefix, only the first can coincide with an accepted entry.
      const first = fresh[0]!;
      if (
        first.payload.sequence === Number(row.commonSequence) + 1 &&
        (await this.acceptedHashAt(tx, row, first.payload.sequence)) ===
          first.hash
      )
        throw conflict(
          JOURNAL_RECOVERY_ERRORS.invalid,
          "That entry was accepted: it is not unmatched.",
        );
    }
    const records = [
      ...fresh.map((i) => ({
        recordKind: "command",
        recordId: i.payload.commandId,
        sequence: BigInt(i.payload.sequence),
        item: i,
      })),
      ...signIns.map((i) => ({
        recordKind: "staff_sign_in",
        recordId: i.payload.staffSignInId,
        sequence: null,
        item: i,
      })),
    ];
    if (records.length)
      await tx.offlineJournalRecoveryEntry.createMany({
        data: records.map((r) => ({
          id: randomUUID(),
          tenantId: row.tenantId,
          branchId: row.branchId,
          recoveryId: row.id,
          recordKind: r.recordKind,
          recordId: r.recordId,
          sequence: r.sequence,
          recordHash: r.item.hash,
          envelope: r.item.envelope as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
  }

  private async received(tx: Tx, row: Recovery): Promise<number> {
    return tx.offlineJournalRecoveryEntry.count({
      where: {
        tenantId: row.tenantId,
        recoveryId: row.id,
        recordKind: "command",
      },
    });
  }

  private async supersede(tx: Tx, row: Recovery): Promise<Recovery> {
    return tx.offlineJournalRecovery.update({
      where: { id: row.id, tenantId: row.tenantId },
      data: { status: "superseded", supersededAt: new Date() },
    });
  }

  private async counterView(
    tx: Tx,
    row: Recovery,
  ): Promise<CounterJournalRecovery> {
    return {
      recoveryId: row.id,
      reportId: row.reportId!,
      status: row.status,
      serverHead: serverHeadOf(row),
      commonPrefix: commonOf(row),
      localHead: localHeadOf(row),
      unmatched: Number(row.localHeadSequence) - Number(row.commonSequence),
      received: await this.received(tx, row),
      approvedAt: row.approvedAt?.getTime() ?? null,
    };
  }

  private async find(
    tx: Tx,
    tenantId: string,
    branchId: string,
    id: string,
  ): Promise<Recovery> {
    const row = await tx.offlineJournalRecovery.findFirst({
      where: { tenantId, branchId, id },
    });
    if (!row) throw new NotFoundException("Journal recovery not found.");
    return row;
  }

  /** Whether an open recovery or a live sign-off no longer matches the journal. */
  private async stale(tx: Tx, row: Recovery): Promise<boolean> {
    if (!OPEN.includes(row.status)) return false;
    const head = await acceptedJournalHead(tx, row);
    if (row.kind === "counter_restore")
      return !samePosition(head, serverHeadOf(row));
    const nomination = await tx.offlineTerminalNomination.findUnique({
      where: {
        tenantId_branchId: { tenantId: row.tenantId, branchId: row.branchId },
      },
    });
    if (!nomination || nomination.enrollmentId !== row.enrollmentId)
      return true;
    const cutoff = await offlineAuthorityCutoff(tx, nomination);
    return !signOffCurrent(
      {
        nominationVersion: row.nominationVersion!,
        head: serverHeadOf(row),
        approvedAt: row.approvedAt!.getTime(),
      },
      { nominationVersion: nomination.version, head, cutoff },
    );
  }

  private async view(
    tx: Tx,
    row: Recovery,
  ): Promise<OfflineJournalRecoveryView> {
    const labels = await this.labels(tx, row.tenantId, [row.terminalId]);
    const head = serverHeadOf(row);
    const approver = row.approvedByUserId
      ? await tx.appUser.findFirst({
          where: { id: row.approvedByUserId, tenantId: row.tenantId },
          select: { fullName: true },
        })
      : null;
    const restore = row.kind === "counter_restore";
    return {
      recoveryId: row.id,
      kind: row.kind,
      status: row.status,
      terminalId: row.terminalId,
      terminalLabel: labels.get(row.terminalId) ?? null,
      enrollmentId: row.enrollmentId,
      createdAt: row.createdAt.getTime(),
      serverHead: {
        ...head,
        acceptedAt: await this.acceptedAt(tx, row, head.sequence),
      },
      localHead: restore ? localHeadOf(row) : null,
      commonPrefix: restore ? commonOf(row) : null,
      restoredEntries: restore ? head.sequence - Number(row.commonSequence) : 0,
      unmatched: restore ? await this.unmatchedSummaries(tx, row) : [],
      refusals: await this.refusals(tx, row, head.sequence),
      nominationVersion: row.nominationVersion,
      cutoff: (row.cutoff as unknown as AuthorityCutoff | null) ?? null,
      approval:
        row.approvedAt &&
        row.approvedByUserId &&
        row.approvalReason &&
        row.approvalAuthority
          ? {
              approvedByUserId: row.approvedByUserId,
              approvedByFullName: approver?.fullName ?? null,
              approvedAt: row.approvedAt.getTime(),
              reason: row.approvalReason,
              authority: row.approvalAuthority as "owner" | "delegated_manager",
            }
          : null,
      completedAt: row.completedAt?.getTime() ?? null,
      supersededAt: row.supersededAt?.getTime() ?? null,
      stale: await this.stale(tx, row),
    };
  }

  /** The unmatched entries, with who made them from the sign-in each cites. */
  private async unmatchedSummaries(
    tx: Tx,
    row: Recovery,
  ): Promise<JournalRecoveryEntrySummary[]> {
    const entries = await tx.offlineJournalRecoveryEntry.findMany({
      where: { tenantId: row.tenantId, recoveryId: row.id },
      orderBy: { sequence: "asc" },
      select: { recordKind: true, envelope: true, recordHash: true },
    });
    const staffBySignIn = new Map<string, string>();
    for (const e of entries.filter((e) => e.recordKind === "staff_sign_in")) {
      const signIn = (e.envelope as unknown as Signed<OfflineStaffSignIn>)
        .payload;
      staffBySignIn.set(signIn.staffSignInId, signIn.session.staffUserId);
    }
    const commands = entries.filter((e) => e.recordKind === "command");
    const payloads = commands.map(
      (e) => (e.envelope as unknown as Signed<OfflineJournalCommand>).payload,
    );
    const missing = payloads
      .map((p) => p.staffSignInId)
      .filter((id) => !staffBySignIn.has(id));
    if (missing.length) {
      const known = await tx.offlineStaffSignIn.findMany({
        where: {
          tenantId: row.tenantId,
          enrollmentId: row.enrollmentId,
          signInId: { in: missing },
        },
        select: { signInId: true, staffUserId: true },
      });
      for (const k of known) staffBySignIn.set(k.signInId, k.staffUserId);
    }
    const userIds = [...new Set(staffBySignIn.values())];
    const users = await tx.appUser.findMany({
      where: { tenantId: row.tenantId, id: { in: userIds } },
      select: { id: true, fullName: true },
    });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return payloads.map((p, i) => {
      const staffUserId = staffBySignIn.get(p.staffSignInId) ?? null;
      return {
        sequence: p.sequence,
        commandId: p.commandId,
        hash: commands[i]!.recordHash,
        kind: p.kind,
        occurredAt: p.occurredAt,
        staffUserId,
        staffFullName: staffUserId ? (names.get(staffUserId) ?? null) : null,
        totalMinor: p.kind === "ordinary_sale" ? p.totalMinor : null,
        lineCount: p.kind === "ordinary_sale" ? p.lines.length : null,
      };
    });
  }

  /** Retained refusals past the accepted head (slice 1's `offline_journal_review`). */
  private async refusals(
    tx: Tx,
    scope: { tenantId: string; enrollmentId: string },
    headSequence: number,
  ): Promise<JournalRecoveryRefusal[]> {
    const rows = await tx.offlineJournalReview.findMany({
      where: {
        tenantId: scope.tenantId,
        enrollmentId: scope.enrollmentId,
        OR: [
          { sequence: { gt: BigInt(headSequence) } },
          { recordKind: "staff_sign_in" },
        ],
      },
      orderBy: { lastReceivedAt: "desc" },
      take: 50,
      select: {
        sequence: true,
        recordKind: true,
        outcome: true,
        errorCode: true,
        lastReceivedAt: true,
      },
    });
    return rows.map((r) => ({
      sequence: r.sequence === null ? null : Number(r.sequence),
      recordKind: r.recordKind as JournalRecoveryRefusal["recordKind"],
      outcome: r.outcome as JournalRecoveryRefusal["outcome"],
      errorCode: r.errorCode,
      lastReceivedAt: r.lastReceivedAt.getTime(),
    }));
  }

  private async acceptedAt(
    tx: Tx,
    scope: { tenantId: string; enrollmentId: string },
    sequence: number,
  ): Promise<number | null> {
    if (sequence === 0) return null;
    const receipt = await tx.terminalCommandReceipt.findUnique({
      where: {
        tenantId_enrollmentId_offlineSequence: {
          tenantId: scope.tenantId,
          enrollmentId: scope.enrollmentId,
          offlineSequence: BigInt(sequence),
        },
      },
      select: { recordedAt: true },
    });
    return receipt?.recordedAt.getTime() ?? null;
  }

  private async labels(
    tx: Tx,
    tenantId: string,
    terminalIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await tx.operationalTerminal.findMany({
      where: { tenantId, id: { in: [...new Set(terminalIds)] } },
      select: { id: true, label: true },
    });
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  /** The branch's offline counter as D11 replacement sees it. */
  private async offlineCounter(
    tx: Tx,
    tenantId: string,
    branchId: string,
  ): Promise<OfflineCounterReplacementView | null> {
    const nomination = await tx.offlineTerminalNomination.findUnique({
      where: { tenantId_branchId: { tenantId, branchId } },
    });
    if (!nomination) return null;
    const cutoff = await offlineAuthorityCutoff(tx, nomination);
    const head = await acceptedJournalHead(tx, nomination);
    const labels = await this.labels(tx, tenantId, [nomination.terminalId]);
    const signOff = await liveSignOff(tx, nomination);
    const current =
      signOff !== null &&
      signOffCurrent(signOff, {
        nominationVersion: nomination.version,
        head,
        cutoff,
      });
    const approver = signOff
      ? await tx.appUser.findFirst({
          where: { id: signOff.approvedByUserId, tenantId },
          select: { fullName: true },
        })
      : null;
    return {
      terminalId: nomination.terminalId,
      terminalLabel: labels.get(nomination.terminalId) ?? null,
      enrollmentId: nomination.enrollmentId,
      nominationVersion: nomination.version,
      revoked: cutoff.kind === "device_disabled",
      cutoff,
      serverHead: {
        ...head,
        acceptedAt: await this.acceptedAt(tx, nomination, head.sequence),
      },
      refusals: await this.refusals(tx, nomination, head.sequence),
      signOffAvailableAt: signOffAvailableAt(cutoff),
      signOff: signOff && {
        recoveryId: signOff.recoveryId,
        approvedAt: signOff.approvedAt,
        approvedByFullName: approver?.fullName ?? null,
        current,
      },
      journalCleared: current,
    };
  }
}

/** The sign-ins entries cite: each entry's own, and an assisted close's manager. */
function citedSignIns(
  commands: ReadonlyArray<OfflineJournalCommand>,
): Set<string> {
  const ids = new Set<string>();
  for (const command of commands) {
    ids.add(command.staffSignInId);
    if (command.kind === "shift_close" && command.assistance)
      ids.add(command.assistance.managerSignInId);
  }
  return ids;
}

function approval(
  user: RequestUser,
  authority: OfflineAssignmentAuthority,
  reason: string,
  at = new Date(),
) {
  return {
    approvedByUserId: user.userId,
    approvedAt: at,
    approvalReason: reason,
    approvalAuthority: authority.kind,
    approvalDelegationId:
      authority.kind === "delegated_manager" ? authority.delegationId : null,
  };
}
