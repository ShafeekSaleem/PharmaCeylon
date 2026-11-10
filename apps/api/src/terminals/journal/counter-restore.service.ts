import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type OfflineCounterRestore } from "@prisma/client";
import {
  counterRestoreClockSkew,
  type CounterStoreRestore,
  type JournalPosition,
  type OfflineCounterRestoresView,
  type OfflineCounterRestoreView,
  type Signed,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../audit/audit.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import {
  acceptedJournalHead,
  latestIssuedGrantVersion,
} from "../offline-authority-issuance";
import {
  OfflineAssignmentService,
  type OfflineAssignmentAuthority,
} from "../offline-assignment.service";
import { verifySignature } from "../terminal-wire";
import {
  parseCounterRestoreStatusRequest,
  parseCounterRestoreUpload,
} from "./counter-restore-wire";
import {
  authenticateJournalUploader,
  lockEnrollmentJournal,
} from "./journal-uploader";
import { journalHash } from "./offline-journal-wire";

type Tx = Prisma.TransactionClient;
type Restore = OfflineCounterRestore;
const TX = { timeout: 20_000 } as const;

export const COUNTER_RESTORE_ERRORS = {
  invalid: "STORE_RESTORE_INVALID",
  notAwaiting: "STORE_RESTORE_NOT_AWAITING",
  notDelegated: "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
} as const;

const position = (sequence: bigint, hash: string | null): JournalPosition => ({
  sequence: Number(sequence),
  hash,
});

/**
 * P5 #51, store backup and restore (decisions of 2026-11-10).
 *
 * A counter that restored its encrypted store from one of its own backups has lost anything it
 * recorded after the backup and never uploaded, and it holds an offline authority pair the
 * server may long since have superseded. The desktop removes that pair, its renewal requests and
 * every PIN verifier at restore, and reports the restore here, device-signed (`report`). Until the
 * owner or a delegated manager (revised D13) acknowledges it in the back office (`acknowledge`),
 * saying how receipts, cash and stock after the backup were checked, the server issues the
 * counter no offline authority (`counterRestoreOpen`). The counter keeps selling online, unless
 * the backup was taken mid-outage (that outage's drain then waits for a fresh pair); its journal
 * reconciles as any other (sync, rebase, D11 recovery when it no longer matches).
 *
 * The record is evidence: the report as signed and what the server held when it arrived, kept
 * forever, changed only by its one acknowledgement.
 */
@Injectable()
export class OfflineCounterRestoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly assignments: OfflineAssignmentService,
  ) {}

  // ── counter ────────────────────────────────────────────────────────────────

  /** The device-signed restore report. Resending the same report returns the same restore. */
  async report(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<CounterStoreRestore> {
    const envelope = parseCounterRestoreUpload(raw);
    const report = envelope.payload;
    const { identity } = report;
    return this.prisma.$transaction(async (tx) => {
      const { publicKeyHex } = await authenticateJournalUploader(
        tx,
        this.access,
        user,
        branchId,
        identity,
      );
      verifySignature(envelope, publicKeyHex);
      // The same lock as journal sync and issuance's head read: the facts recorded below are one view.
      await lockEnrollmentJournal(tx, identity.tenantId, identity.enrollmentId);
      const existing = await this.byRestoreId(tx, identity, report.restoreId);
      if (existing) {
        const stored = existing.envelope as unknown as Signed<unknown>;
        if (journalHash(stored.payload) !== journalHash(report))
          throw new ConflictException({
            code: COUNTER_RESTORE_ERRORS.invalid,
            message: "This restore ID was already used for another report.",
          });
        return this.counterView(tx, existing);
      }
      const serverHead = await acceptedJournalHead(tx, identity);
      const latestGrantVersion = await latestIssuedGrantVersion(tx, identity);
      const lastContactAt = await this.lastContact(
        tx,
        identity,
        new Date(Math.min(report.restoredAt, Date.now())),
      );
      const row = await tx.offlineCounterRestore.create({
        data: {
          id: randomUUID(),
          ...identity,
          restoreId: report.restoreId,
          status: "awaiting_acknowledgement",
          envelope: envelope as unknown as Prisma.InputJsonValue,
          backupId: report.backupId,
          backupTakenAt: new Date(report.backupTakenAt),
          restoredAt: new Date(report.restoredAt),
          journalHeadSequence: BigInt(report.journalHead.sequence),
          journalHeadHash: report.journalHead.hash,
          acceptedSequence: BigInt(report.acceptedWatermark.sequence),
          acceptedHash: report.acceptedWatermark.hash,
          outageActive: report.outageActive,
          removedGrantVersion: report.removedGrantVersion,
          serverHeadSequence: BigInt(serverHead.sequence),
          serverHeadHash: serverHead.hash,
          latestGrantVersion,
          lastContactAt,
          createdByUserId: user.userId,
        },
      });
      await this.audit.log(
        {
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          actorUserId: user.userId,
          eventName: "terminal.store_restore_reported",
          entityName: "offline_counter_restore",
          entityId: row.id,
          payload: {
            enrollmentId: identity.enrollmentId,
            terminalId: identity.terminalId,
            restoreId: report.restoreId,
            backupId: report.backupId,
            backupTakenAt: report.backupTakenAt,
            restoredAt: report.restoredAt,
            journalHead: report.journalHead,
            serverHead,
            outageActive: report.outageActive,
            removedGrantVersion: report.removedGrantVersion,
            latestGrantVersion,
            // Recorded, never refused: both times are the counter's own clock.
            clockSkew: counterRestoreClockSkew({
              backupTakenAt: report.backupTakenAt,
              restoredAt: report.restoredAt,
              reportedAt: row.createdAt.getTime(),
            }),
          },
        },
        tx,
      );
      return this.counterView(tx, row);
    }, TX);
  }

  /** A reported restore as the counter sees it, or null if the server has none by that ID. */
  async status(
    user: RequestUser,
    branchId: string,
    raw: unknown,
  ): Promise<CounterStoreRestore | null> {
    const { identity, restoreId } = parseCounterRestoreStatusRequest(raw);
    return this.prisma.$transaction(async (tx) => {
      await authenticateJournalUploader(
        tx,
        this.access,
        user,
        branchId,
        identity,
      );
      const row = await this.byRestoreId(tx, identity, restoreId);
      return row ? this.counterView(tx, row) : null;
    }, TX);
  }

  // ── back office ────────────────────────────────────────────────────────────

  async list(
    user: RequestUser,
    branchId: string,
  ): Promise<OfflineCounterRestoresView> {
    return this.prisma.$transaction(async (tx) => {
      const scope = { tenantId: user.tenantId, branchId };
      const awaiting = await tx.offlineCounterRestore.findMany({
        where: { ...scope, status: "awaiting_acknowledgement" },
        orderBy: { createdAt: "desc" },
      });
      const recent = await tx.offlineCounterRestore.findMany({
        where: { ...scope, status: { not: "awaiting_acknowledgement" } },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      const rows = [...awaiting, ...recent];
      const labels = await this.labels(
        tx,
        user.tenantId,
        rows.map((r) => r.terminalId),
      );
      const names = await this.names(
        tx,
        user.tenantId,
        rows.flatMap((r) =>
          r.acknowledgedByUserId ? [r.acknowledgedByUserId] : [],
        ),
      );
      return {
        branchId,
        restores: rows.map((row) => view(row, labels, names)),
      };
    }, TX);
  }

  /** Acknowledge a restore: the counter may be issued offline authority again. */
  async acknowledge(
    user: RequestUser,
    branchId: string,
    id: string,
    input: { reason: string },
  ): Promise<OfflineCounterRestoreView> {
    const reason = input.reason.trim();
    return this.prisma.$transaction(async (tx) => {
      const authority = await this.requireAuthority(tx, user, branchId);
      const found = await this.find(tx, user.tenantId, branchId, id);
      await lockEnrollmentJournal(tx, found.tenantId, found.enrollmentId);
      const row = await this.find(tx, user.tenantId, branchId, id);
      if (row.status !== "awaiting_acknowledgement")
        throw new ConflictException({
          code: COUNTER_RESTORE_ERRORS.notAwaiting,
          message: "This restore was already acknowledged.",
          status: row.status,
        });
      const done = await tx.offlineCounterRestore.update({
        where: { id: row.id, tenantId: row.tenantId },
        data: {
          status: "acknowledged",
          acknowledgedByUserId: user.userId,
          acknowledgedAt: new Date(),
          acknowledgementReason: reason,
          acknowledgementAuthority: authority.kind,
          acknowledgementDelegationId:
            authority.kind === "delegated_manager"
              ? authority.delegationId
              : null,
        },
      });
      await this.audit.log(
        {
          tenantId: user.tenantId,
          branchId,
          actorUserId: user.userId,
          eventName: "terminal.store_restore_acknowledged",
          entityName: "offline_counter_restore",
          entityId: row.id,
          payload: {
            enrollmentId: row.enrollmentId,
            restoreId: row.restoreId,
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
      const labels = await this.labels(tx, user.tenantId, [done.terminalId]);
      const names = await this.names(tx, user.tenantId, [user.userId]);
      return view(done, labels, names);
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
          code: COUNTER_RESTORE_ERRORS.notDelegated,
          message:
            "Only an owner, or a manager the owner delegated for this branch's offline counter, can acknowledge this.",
        });
      throw error;
    }
  }

  private byRestoreId(tx: Tx, identity: TerminalIdentity, restoreId: string) {
    return tx.offlineCounterRestore.findUnique({
      where: {
        tenantId_enrollmentId_restoreId: {
          tenantId: identity.tenantId,
          enrollmentId: identity.enrollmentId,
          restoreId,
        },
      },
    });
  }

  private async find(
    tx: Tx,
    tenantId: string,
    branchId: string,
    id: string,
  ): Promise<Restore> {
    const row = await tx.offlineCounterRestore.findUnique({
      where: { tenantId_branchId_id: { tenantId, branchId, id } },
    });
    if (!row) throw new NotFoundException("Counter restore not found");
    return row;
  }

  private async counterView(
    tx: Tx,
    row: Restore,
  ): Promise<CounterStoreRestore> {
    return {
      restoreId: row.restoreId,
      status: row.status,
      acknowledgedAt: row.acknowledgedAt?.getTime() ?? null,
      // Read live: nothing is issued while the restore waits, but one already in flight when the
      // report arrived may have committed since.
      latestGrantVersion: Math.max(
        row.latestGrantVersion,
        await latestIssuedGrantVersion(tx, row),
      ),
    };
  }

  /**
   * The last time the server heard from this counter before it was restored: a signed command or
   * journal entry, a staff session opened on it, or offline authority issued to it.
   */
  private async lastContact(
    tx: Tx,
    identity: TerminalIdentity,
    before: Date,
  ): Promise<Date | null> {
    const scope = {
      tenantId: identity.tenantId,
      enrollmentId: identity.enrollmentId,
    };
    const [receipt, session, snapshot] = await Promise.all([
      tx.terminalCommandReceipt.findFirst({
        where: { ...scope, recordedAt: { lt: before } },
        orderBy: { recordedAt: "desc" },
        select: { recordedAt: true },
      }),
      tx.terminalStaffSession.findFirst({
        where: {
          ...scope,
          branchId: identity.branchId,
          openedAt: { lt: before },
        },
        orderBy: { openedAt: "desc" },
        select: { openedAt: true },
      }),
      tx.offlineStockSnapshot.findFirst({
        where: {
          ...scope,
          branchId: identity.branchId,
          generatedAt: { lt: before },
          issuances: { some: {} },
        },
        orderBy: { generatedAt: "desc" },
        select: { generatedAt: true },
      }),
    ]);
    const times = [
      receipt?.recordedAt,
      session?.openedAt,
      snapshot?.generatedAt,
    ]
      .filter((t): t is Date => t instanceof Date)
      .map((t) => t.getTime());
    return times.length ? new Date(Math.max(...times)) : null;
  }

  private async labels(
    tx: Tx,
    tenantId: string,
    terminalIds: string[],
  ): Promise<Map<string, string>> {
    if (!terminalIds.length) return new Map();
    const rows = await tx.operationalTerminal.findMany({
      where: { tenantId, id: { in: [...new Set(terminalIds)] } },
      select: { id: true, label: true },
    });
    return new Map(rows.map((r) => [r.id, r.label]));
  }

  private async names(
    tx: Tx,
    tenantId: string,
    userIds: string[],
  ): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const rows = await tx.appUser.findMany({
      where: { tenantId, id: { in: [...new Set(userIds)] } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }
}

function view(
  row: Restore,
  labels: ReadonlyMap<string, string>,
  names: ReadonlyMap<string, string>,
): OfflineCounterRestoreView {
  return {
    id: row.id,
    restoreId: row.restoreId,
    status: row.status,
    terminalId: row.terminalId,
    terminalLabel: labels.get(row.terminalId) ?? null,
    enrollmentId: row.enrollmentId,
    reportedAt: row.createdAt.getTime(),
    backupTakenAt: row.backupTakenAt.getTime(),
    restoredAt: row.restoredAt.getTime(),
    journalHead: position(row.journalHeadSequence, row.journalHeadHash),
    serverHead: position(row.serverHeadSequence, row.serverHeadHash),
    outageActive: row.outageActive,
    removedGrantVersion: row.removedGrantVersion,
    latestGrantVersion: row.latestGrantVersion,
    lastContactAt: row.lastContactAt?.getTime() ?? null,
    clockSkew: counterRestoreClockSkew({
      backupTakenAt: row.backupTakenAt.getTime(),
      restoredAt: row.restoredAt.getTime(),
      reportedAt: row.createdAt.getTime(),
    }),
    acknowledgement:
      row.acknowledgedAt &&
      row.acknowledgedByUserId &&
      row.acknowledgementReason
        ? {
            acknowledgedByUserId: row.acknowledgedByUserId,
            acknowledgedByFullName: names.get(row.acknowledgedByUserId) ?? null,
            acknowledgedAt: row.acknowledgedAt.getTime(),
            reason: row.acknowledgementReason,
            authority: row.acknowledgementAuthority as
              | "owner"
              | "delegated_manager",
          }
        : null,
  };
}
