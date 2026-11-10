import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { Prisma, type TerminalCommandReceipt } from "@prisma/client";
import {
  classifyCommandReplay,
  offlineSalePolicyError,
  offlineShiftTransition,
  terminalErrorRetryable,
  terminalSigningText,
  type BranchStockSnapshot,
  type CommittedCommandReceipt,
  type OfflineBusinessHoursAcknowledgement,
  type OfflineBusinessHoursEvidence,
  type OfflineGrant,
  type OfflineJournalCommand,
  type OfflineSaleCommand,
  type OfflineShiftCloseCommand,
  type OfflineShiftOpenCommand,
  type OfflineStaffSignIn,
  type OfflineUsage,
  type Signed,
  type StockPostingOutcome,
  type SyncAcknowledgement,
  type SyncResponse,
  type TerminalErrorCode,
  type TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../audit/audit.service";
import { StockService } from "../../inventory/stock/stock.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { OfflineSupportRecords } from "../offline-support-records.service";
import { TillShiftsService } from "../shifts/till-shifts.service";
import { SUPPORT_RECORD_CLOCK_SKEW_MS, type SupportRecordReceipt } from "../support-record-intake";
import { denied, verifySignature } from "../terminal-wire";
import {
  parseCommandEnvelope,
  parseSignInEnvelope,
  parseSyncRequest,
  type JournalItem,
} from "./offline-journal-wire";
import {
  OFFLINE_JOURNAL_OPERATION,
  isReviewedReceipt,
  lockOfflineJournal,
  offlineJournalHead,
  storedCommand,
} from "./journal-chain";
import { commitOfflineSale, resolveSaleLines } from "./offline-sale-commit";
import { localOpenShift, readTillShiftState, replayShiftClose, replayShiftOpen } from "./offline-shift-replay";

type Tx = Prisma.TransactionClient;
type CommandItem = JournalItem<OfflineJournalCommand>;
type SupportAcknowledgement = SyncResponse["supportAcknowledgements"][number];

export { OFFLINE_JOURNAL_OPERATION } from "./journal-chain";
const IDENTITY_KEYS: ReadonlyArray<keyof TerminalIdentity> = ["tenantId", "branchId", "terminalId", "enrollmentId", "keyId"];
const sameIdentity = (a: TerminalIdentity, b: TerminalIdentity) => IDENTITY_KEYS.every((k) => a[k] === b[k]);
const COMMAND_TX = { timeout: 20_000 } as const;

/** Why a command was not accepted, and whether it waits (`held`) or never will be (`rejected`). */
type Refusal = Readonly<{
  status: "held" | "rejected";
  code: TerminalErrorCode;
  message: string;
  /** REPLAY_CONFLICT: what was accepted first under this ID or sequence, or the chain head. */
  originalHash?: string | null;
}>;
const held = (code: TerminalErrorCode, message: string): Refusal => ({ status: "held", code, message });
const rejected = (code: TerminalErrorCode, message: string): Refusal => ({ status: "rejected", code, message });

type Device = { publicKeyHex: string };

/**
 * P5 #51: intake of the nominated counter's offline journal (`SyncRequest` → signed
 * `SyncResponse`). See docs/POS_V1_CONTRACT.md, "Sync, idempotency and errors".
 *
 * Authentication: the uploader is a signed-in user live at the branch with `terminal.execute`
 * (a PIN-opened counter login must be on this enrollment); every sign-in and command must carry
 * a valid Ed25519 signature by the enrollment's pinned key, or the request is refused whole. A
 * revoked enrollment or retired terminal may still upload: exact replays return their original
 * receipts, and anything new is retained as `held` for review. It never writes a business effect.
 *
 * Order: support records, then sign-ins, then commands sorted by sequence, each command in its
 * own transaction under the enrollment's journal lock. A command is accepted only at the current
 * watermark + 1 whose `previousCommandHash` names the accepted head. Its receipt, sale or shift
 * effect, stock posting or discrepancy case, and audit commit together. Processing stops at the
 * first held, rejected or out-of-order command; later commands get no acknowledgement and stay
 * queued on the counter. Nothing the counter sent is deleted: refused content is kept in
 * `offline_journal_review`.
 *
 * Validation is historical: the grant and snapshot this server issued and stored, the cited
 * signed sign-in, the command's own `occurredAt`, and usage recomputed from the accepted journal.
 * Late arrival is not a refusal. Prices and tax come from the signed snapshot, never today's
 * catalog. Shift and sale policies are the shared `offlineShiftTransition` /
 * `offlineSalePolicyError` fixtures.
 */
@Injectable()
export class OfflineJournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly supportRecords: OfflineSupportRecords,
    private readonly shifts: TillShiftsService,
    private readonly config: ConfigService,
  ) {}

  async sync(user: RequestUser, branchId: string, raw: unknown, now: number = Date.now()): Promise<Signed<SyncResponse>> {
    const signer = this.signer();
    const request = parseSyncRequest(raw);
    const signIns = request.staffSignIns.map(parseSignInEnvelope);
    const commands = request.commands.map(parseCommandEnvelope);
    const { identity } = request;
    if (identity.tenantId !== user.tenantId || identity.branchId !== branchId) denied("IDENTITY_MISMATCH");
    for (const item of [...signIns, ...commands])
      if (!sameIdentity(item.payload.identity, identity)) denied("IDENTITY_MISMATCH");
    const device = await this.authenticate(user, branchId, identity, [...signIns, ...commands]);

    const supportAcknowledgements: SupportAcknowledgement[] = [];
    for (const record of request.supportRecords) {
      const receipt = await this.prisma.$transaction((tx) => this.supportRecords.record(tx, user, branchId, record, now), COMMAND_TX);
      supportAcknowledgements.push(supportAcknowledgement(receipt));
    }
    for (const signIn of signIns) await this.retainSignIn(user, identity, signIn);

    const acknowledgements: SyncAcknowledgement[] = [];
    const ordered = [...commands].sort((a, b) => a.payload.sequence - b.payload.sequence);
    for (const item of ordered) {
      const ack = await this.processCommand(user, identity, device, item, now);
      acknowledgements.push(ack);
      if (ack.status === "held" || ack.status === "rejected") break;
    }

    const head = await this.head(this.prisma, identity);
    const payload: SyncResponse = {
      contractVersion: 1,
      identity,
      serverTime: Date.now(),
      supportAcknowledgements,
      acknowledgements,
      committedThroughSequence: head ? Number(head.offlineSequence) : 0,
      committedThroughHash: head?.requestDigest ?? null,
    };
    return {
      algorithm: "Ed25519",
      keyId: signer.keyId,
      payload,
      signature: sign(null, Buffer.from(terminalSigningText("sync_response", payload)), signer.privateKey).toString("base64url"),
    };
  }

  private signer(): { keyId: string; privateKey: KeyObject } {
    const keyId = this.config.get<string>("OFFLINE_AUTHORITY_KEY_ID");
    const keyPem = this.config.get<string>("OFFLINE_AUTHORITY_PRIVATE_KEY");
    if (!keyId || !keyPem) denied("TEMPORARILY_UNAVAILABLE");
    // A PEM in a .env file is often one line with literal "\n" escapes.
    return { keyId, privateKey: createPrivateKey(keyPem.replace(/\\n/g, "\n")) };
  }

  /** The uploader, then the device: every signature against the enrollment's pinned key. */
  private async authenticate(
    user: RequestUser,
    branchId: string,
    identity: TerminalIdentity,
    items: ReadonlyArray<JournalItem<unknown>>,
  ): Promise<Device> {
    return this.prisma.$transaction(async (tx) => {
      const access = await this.access.resolveLive(user, branchId, tx);
      if (!access.has("terminal.execute")) denied("PERMISSION_DENIED");
      if (user.counter) {
        const session = await tx.terminalStaffSession.findFirst({
          where: { tenantId: user.tenantId, branchId, id: user.counter.workSessionId },
          select: { enrollmentId: true },
        });
        // A counter login uploads only its own counter's journal.
        if (session?.enrollmentId !== identity.enrollmentId) denied("IDENTITY_MISMATCH");
      }
      const enrollment = await tx.terminalEnrollment.findFirst({
        where: {
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          id: identity.enrollmentId,
          terminalId: identity.terminalId,
          keyId: identity.keyId,
        },
        select: { publicKeyHex: true },
      });
      if (!enrollment) denied("IDENTITY_MISMATCH");
      for (const item of items) verifySignature(item.envelope, enrollment.publicKeyHex);
      return { publicKeyHex: enrollment.publicKeyHex };
    });
  }

  /** Keep a verified sign-in once. The same ID with other content is retained as a conflict. */
  private async retainSignIn(user: RequestUser, identity: TerminalIdentity, item: JournalItem<OfflineStaffSignIn>) {
    const { payload } = item;
    const key = { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, signInId: payload.staffSignInId };
    await this.prisma.$transaction(async (tx) => {
      await tx.offlineStaffSignIn.createMany({
        data: [{
          tenantId: identity.tenantId,
          branchId: identity.branchId,
          terminalId: identity.terminalId,
          enrollmentId: identity.enrollmentId,
          keyId: identity.keyId,
          signInId: payload.staffSignInId,
          signInHash: item.hash,
          staffUserId: payload.session.staffUserId,
          workSessionId: payload.session.workSessionId,
          grantId: payload.grantId,
          authenticatedAt: new Date(payload.authenticatedAt),
          envelope: item.envelope as unknown as Prisma.InputJsonValue,
          receivedByUserId: user.userId,
        }],
        skipDuplicates: true,
      });
      const stored = await tx.offlineStaffSignIn.findUniqueOrThrow({
        where: { tenantId_enrollmentId_signInId: key },
        select: { signInHash: true },
      });
      if (stored.signInHash !== item.hash)
        await this.retainReview(tx, user, identity, {
          kind: "staff_sign_in",
          recordId: payload.staffSignInId,
          sequence: null,
          hash: item.hash,
          envelope: item.envelope,
          outcome: "conflict",
          code: "REPLAY_CONFLICT",
          originalHash: stored.signInHash,
        });
    }, COMMAND_TX);
  }

  /** One command, in its own transaction, serialized per enrollment. */
  private async processCommand(
    user: RequestUser,
    identity: TerminalIdentity,
    device: Device,
    item: CommandItem,
    now: number,
  ): Promise<SyncAcknowledgement> {
    const { payload: command, hash } = item;
    return this.prisma.$transaction(async (tx) => {
      await lockOfflineJournal(tx, identity);

      // Durable receipts first, before any grant, expiry or revocation rule (contract order). A
      // manager's settlement of a refused entry (slice 4) is a receipt too: the resend that
      // finds it is acknowledged `reviewed`.
      const scope = { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId };
      const prior =
        (await tx.terminalCommandReceipt.findUnique({
          where: { tenantId_enrollmentId_commandId: { ...scope, commandId: command.commandId } },
        })) ??
        (await tx.terminalCommandReceipt.findUnique({
          where: { tenantId_enrollmentId_offlineSequence: { ...scope, offlineSequence: BigInt(command.sequence) } },
        }));
      if (prior) {
        const stored = storedReceipt(prior);
        const replay = stored
          ? classifyCommandReplay(stored, { identity: command.identity, commandId: command.commandId, commandHash: hash, sequence: command.sequence })
          : "conflict";
        if (replay === "duplicate") return acknowledge(stored!, "duplicate");
        return this.refuse(tx, user, identity, item, {
          status: "rejected",
          code: "REPLAY_CONFLICT",
          message: "This journal entry was already accepted with other content.",
          originalHash: prior.requestDigest,
        });
      }

      // A rejection is final for that exact content until a manager settles it (slice 4): the
      // counter resends the entry to learn the outcome, and a resend is never judged again. The
      // answer cannot drift (a clock that has caught up, a shift that has since opened).
      const refused = await tx.offlineJournalReview.findUnique({
        where: {
          tenantId_enrollmentId_recordKind_recordHash: {
            tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, recordKind: "command", recordHash: hash,
          },
        },
        select: { outcome: true, errorCode: true },
      });
      if (refused?.outcome === "rejected")
        return this.refuse(tx, user, identity, item, rejected(
          refused.errorCode as TerminalErrorCode,
          "This journal entry was refused. A manager reviews it in the back office.",
        ));

      const head = await this.head(tx, identity);
      const headSequence = head ? Number(head.offlineSequence) : 0;
      if (command.sequence !== headSequence + 1)
        return this.refuse(tx, user, identity, item, held("SEQUENCE_GAP", `Send journal entry ${headSequence + 1} first.`));
      if (command.previousCommandHash !== (head?.requestDigest ?? null))
        return this.refuse(tx, user, identity, item, {
          status: "rejected",
          code: "REPLAY_CONFLICT",
          message: "This journal entry does not follow the accepted one.",
          originalHash: head?.requestDigest ?? null,
        });

      // Recovery of old evidence, never new writes, from a revoked or retired counter.
      const enrollment = await tx.terminalEnrollment.findFirstOrThrow({
        where: { tenantId: identity.tenantId, id: identity.enrollmentId },
        select: { revokedAt: true, publicKeyHex: true, terminal: { select: { retiredAt: true } } },
      });
      if (enrollment.publicKeyHex !== device.publicKeyHex) denied("IDENTITY_MISMATCH");
      if (enrollment.revokedAt || enrollment.terminal.retiredAt)
        return this.refuse(tx, user, identity, item, held("TERMINAL_REVOKED", "This counter was revoked; its journal is kept for review."));

      // A trusted counter clock does not run ahead of the server or backwards along its journal.
      // An entry a manager settled is not evidence of the clock (it may be the reason it was
      // refused), so the floor is the latest entry accepted on its own.
      const previousAt = head ? await this.clockFloor(tx, identity) : 0;
      if (command.occurredAt > now + SUPPORT_RECORD_CLOCK_SKEW_MS || command.occurredAt < previousAt)
        return this.refuse(tx, user, identity, item, rejected("CLOCK_UNTRUSTED", "The entry's time is not trustworthy."));

      const outcome =
        command.kind === "ordinary_sale"
          ? await this.acceptSale(tx, user, identity, item as JournalItem<OfflineSaleCommand>)
          : await this.acceptShift(tx, user, identity, item as JournalItem<OfflineShiftOpenCommand | OfflineShiftCloseCommand>);
      if ("status" in outcome) return this.refuse(tx, user, identity, item, outcome);

      const committedAt = new Date();
      const receipt = {
        identity,
        commandId: command.commandId,
        commandHash: hash,
        sequence: command.sequence,
        committedAt: committedAt.getTime(),
        ...outcome.resource,
      } as CommittedCommandReceipt;
      await tx.terminalCommandReceipt.create({
        data: {
          ...identity,
          commandId: command.commandId,
          operation: `${OFFLINE_JOURNAL_OPERATION}${command.kind}`,
          requestDigest: hash,
          offlineSequence: BigInt(command.sequence),
          actorUserId: outcome.actorUserId,
          command: item.envelope as unknown as Prisma.InputJsonValue,
          result: receipt as unknown as Prisma.InputJsonValue,
          recordedAt: committedAt,
        },
      });
      return acknowledge(receipt, "committed");
    }, COMMAND_TX);
  }

  private head(client: Tx | PrismaService, identity: TerminalIdentity) {
    return offlineJournalHead(client, identity);
  }

  /** `occurredAt` of the latest entry accepted by intake rather than by a manager's settlement. */
  private async clockFloor(tx: Tx, identity: TerminalIdentity): Promise<number> {
    const page = 20;
    for (let skip = 0; ; skip += page) {
      const rows = await tx.terminalCommandReceipt.findMany({
        where: { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, offlineSequence: { not: null } },
        orderBy: { offlineSequence: "desc" },
        skip,
        take: page,
      });
      for (const row of rows) if (!isReviewedReceipt(row)) return storedCommand(row)?.occurredAt ?? 0;
      if (rows.length < page) return 0;
    }
  }

  private async issuedGrant(tx: Tx, identity: TerminalIdentity, grantId: string): Promise<OfflineGrant | null> {
    const issuance = await tx.offlineAuthorityIssuance.findFirst({
      where: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        enrollmentId: identity.enrollmentId,
        grant: { path: ["payload", "grantId"], equals: grantId },
      },
      select: { grant: true },
    });
    return issuance ? (issuance.grant as unknown as Signed<OfflineGrant>).payload : null;
  }

  private async signIn(tx: Tx, identity: TerminalIdentity, signInId: string): Promise<OfflineStaffSignIn | null> {
    const row = await tx.offlineStaffSignIn.findUnique({
      where: { tenantId_enrollmentId_signInId: { tenantId: identity.tenantId, enrollmentId: identity.enrollmentId, signInId } },
      select: { envelope: true },
    });
    return row ? (row.envelope as unknown as Signed<OfflineStaffSignIn>).payload : null;
  }

  /** The D8 acknowledgement a command cites, with its manager's sign-in, from stored evidence. */
  private async hoursEvidence(
    tx: Tx,
    identity: TerminalIdentity,
    command: OfflineJournalCommand,
  ): Promise<OfflineBusinessHoursEvidence | undefined | Refusal> {
    if (!command.businessHoursAcknowledgementId) return undefined;
    const missing = held("BUSINESS_HOURS_ACK_REQUIRED", "Upload the manager's business-hours acknowledgement first.");
    const row = await tx.businessHoursAcknowledgement.findUnique({
      where: {
        tenantId_enrollmentId_recordId: {
          tenantId: identity.tenantId,
          enrollmentId: identity.enrollmentId,
          recordId: command.businessHoursAcknowledgementId,
        },
      },
      select: { envelope: true },
    });
    if (!row) return missing;
    const acknowledgement = (row.envelope as unknown as Signed<OfflineBusinessHoursAcknowledgement>).payload;
    const managerSignIn = await this.signIn(tx, identity, acknowledgement.managerSignInId);
    return managerSignIn ? { acknowledgement, managerSignIn } : missing;
  }

  private async acceptSale(
    tx: Tx,
    user: RequestUser,
    identity: TerminalIdentity,
    item: JournalItem<OfflineSaleCommand>,
  ): Promise<Refusal | { resource: { commandKind: "ordinary_sale"; saleId: string } & StockPostingOutcome; actorUserId: string }> {
    const command = item.payload;
    const grant = await this.issuedGrant(tx, identity, command.grantId);
    if (!grant) return rejected("GRANT_INVALID", "No such grant was issued to this counter.");
    const snapshotRow = await tx.offlineStockSnapshot.findFirst({
      where: { tenantId: identity.tenantId, branchId: identity.branchId, enrollmentId: identity.enrollmentId, id: command.snapshotId },
      select: { envelope: true },
    });
    if (!snapshotRow) return rejected("SNAPSHOT_INVALID", "No such stock snapshot was issued to this counter.");
    const snapshot = (snapshotRow.envelope as unknown as Signed<BranchStockSnapshot>).payload;
    const signIn = await this.signIn(tx, identity, command.staffSignInId);
    if (!signIn) return held("SESSION_INVALID", "Upload the staff sign-in this sale cites.");
    const hours = await this.hoursEvidence(tx, identity, command);
    if (hours && "status" in hours) return hours;

    // The shift the sale belongs to, share-locked so it cannot close underneath this sale.
    await tx.$queryRaw`SELECT id FROM till_shift WHERE tenant_id = ${identity.tenantId}::uuid
      AND branch_id = ${identity.branchId}::uuid AND id = ${command.session.workSessionId}::uuid FOR SHARE`;
    const shift = await tx.tillShift.findFirst({
      where: { tenantId: identity.tenantId, branchId: identity.branchId, id: command.session.workSessionId, closedAt: null },
    });
    const usage = await this.usage(tx, identity, command);
    const error = offlineSalePolicyError(
      grant, snapshot, command, usage, command.occurredAt, "offline", signIn,
      shift ? localOpenShift(identity, shift) : null, hours,
    );
    if (error) return rejected(error, "The sale does not meet the offline sale policy at the time it was made.");

    const lines = resolveSaleLines(command, snapshot);
    const batches = await tx.batch.findMany({
      where: { tenantId: identity.tenantId, branchId: identity.branchId, id: { in: lines.map((l) => l.batchId) } },
      select: { id: true, productId: true },
    });
    if (lines.some((l) => !batches.some((b) => b.id === l.batchId && b.productId === l.productId)))
      return rejected("SNAPSHOT_MISMATCH", "A snapshot line no longer names a batch at this branch.");

    const sale = await commitOfflineSale(tx, { stock: this.stock, audit: this.audit }, {
      identity, command, commandHash: item.hash, snapshot, lines, uploadedByUserId: user.userId,
    });
    return {
      actorUserId: command.session.staffUserId,
      resource: { commandKind: "ordinary_sale", saleId: sale.saleId, ...sale.outcome },
    };
  }

  /**
   * Stock this counter has already sold offline from the same signed snapshot, recomputed from
   * the accepted journal rather than taken from the counter. Usage carries across outages that
   * share a snapshot, since the snapshot's balance is all the counter was ever given.
   */
  private async usage(tx: Tx, identity: TerminalIdentity, command: OfflineSaleCommand): Promise<OfflineUsage> {
    const receipts = await tx.terminalCommandReceipt.findMany({
      where: {
        tenantId: identity.tenantId,
        enrollmentId: identity.enrollmentId,
        operation: `${OFFLINE_JOURNAL_OPERATION}ordinary_sale`,
        offlineSequence: { not: null },
        command: { path: ["payload", "snapshotId"], equals: command.snapshotId },
      },
      select: { command: true },
    });
    const quantities: Record<string, number> = {};
    for (const receipt of receipts) {
      const sale = (receipt.command as unknown as Signed<OfflineSaleCommand>).payload;
      for (const line of sale.lines) quantities[line.snapshotLineId] = (quantities[line.snapshotLineId] ?? 0) + line.quantity;
    }
    return {
      grantId: command.grantId,
      grantVersion: command.grantVersion,
      snapshotId: command.snapshotId,
      snapshotVersion: command.snapshotVersion,
      offlineSessionId: command.offlineSessionId,
      offlineStartedAt: command.offlineStartedAt,
      quantities,
    };
  }

  private async acceptShift(
    tx: Tx,
    user: RequestUser,
    identity: TerminalIdentity,
    item: JournalItem<OfflineShiftOpenCommand | OfflineShiftCloseCommand>,
  ): Promise<Refusal | { resource: { commandKind: "shift_open" | "shift_close"; workSessionId: string }; actorUserId: string }> {
    const command = item.payload;
    const grant = await this.issuedGrant(tx, identity, command.grantId);
    if (!grant) return rejected("GRANT_INVALID", "No such grant was issued to this counter.");
    const signIn = await this.signIn(tx, identity, command.staffSignInId);
    if (!signIn) return held("SESSION_INVALID", "Upload the staff sign-in this shift entry cites.");
    const hours = await this.hoursEvidence(tx, identity, command);
    if (hours && "status" in hours) return hours;
    const { state, open } = await readTillShiftState(tx, identity, { registerId: grant.registerId, tillId: grant.tillId }, command);
    const result = offlineShiftTransition(grant, command, state, signIn, command.occurredAt, "offline", hours);
    if (result.error) return rejected(result.error, "The shift entry does not fit the till's shifts at the time it was made.");

    if (command.kind === "shift_open") {
      await replayShiftOpen(tx, this.audit, { identity, command, uploadedByUserId: user.userId });
    } else {
      await replayShiftClose(tx, { audit: this.audit, shifts: this.shifts }, {
        identity, command, signIn, shift: open!, uploadedByUserId: user.userId,
      });
    }
    return {
      actorUserId: signIn.session.staffUserId,
      resource: { commandKind: command.kind, workSessionId: command.session.workSessionId },
    };
  }

  /** Keep what was refused, then acknowledge it. The caller's transaction commits the review. */
  private async refuse(
    tx: Tx,
    user: RequestUser,
    identity: TerminalIdentity,
    item: CommandItem,
    refusal: Refusal,
  ): Promise<SyncAcknowledgement> {
    await this.retainReview(tx, user, identity, {
      kind: "command",
      recordId: item.payload.commandId,
      sequence: item.payload.sequence,
      hash: item.hash,
      envelope: item.envelope,
      outcome: refusal.code === "REPLAY_CONFLICT" ? "conflict" : refusal.status,
      code: refusal.code,
      originalHash: refusal.originalHash ?? null,
    });
    return {
      commandId: item.payload.commandId,
      commandHash: item.hash,
      sequence: item.payload.sequence,
      status: refusal.status,
      error: {
        contractVersion: 1,
        code: refusal.code,
        message: refusal.message,
        correlationId: randomUUID(),
        retryable: terminalErrorRetryable(refusal.code),
      },
    };
  }

  private async retainReview(
    tx: Tx,
    user: RequestUser,
    identity: TerminalIdentity,
    review: {
      kind: "command" | "staff_sign_in";
      recordId: string;
      sequence: number | null;
      hash: string;
      envelope: Signed<unknown>;
      outcome: "held" | "rejected" | "conflict";
      code: string;
      originalHash: string | null;
    },
  ) {
    const where = {
      tenantId_enrollmentId_recordKind_recordHash: {
        tenantId: identity.tenantId,
        enrollmentId: identity.enrollmentId,
        recordKind: review.kind,
        recordHash: review.hash,
      },
    };
    const existing = await tx.offlineJournalReview.findUnique({ where, select: { id: true } });
    if (existing) {
      await tx.offlineJournalReview.update({
        where: { id: existing.id, tenantId: identity.tenantId },
        data: { attempts: { increment: 1 }, lastReceivedAt: new Date(), errorCode: review.code },
      });
      return;
    }
    const row = await tx.offlineJournalReview.create({
      data: {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        recordKind: review.kind,
        recordId: review.recordId,
        sequence: review.sequence === null ? null : BigInt(review.sequence),
        recordHash: review.hash,
        outcome: review.outcome,
        errorCode: review.code,
        originalRecordHash: review.originalHash,
        envelope: review.envelope as unknown as Prisma.InputJsonValue,
        receivedByUserId: user.userId,
      },
    });
    await this.audit.log(
      {
        tenantId: identity.tenantId,
        branchId: identity.branchId,
        actorUserId: user.userId,
        eventName: "terminal.offline_journal_retained",
        entityName: "offline_journal_review",
        entityId: row.id,
        payload: {
          recordKind: review.kind,
          recordId: review.recordId,
          sequence: review.sequence,
          recordHash: review.hash,
          outcome: review.outcome,
          errorCode: review.code,
          originalRecordHash: review.originalHash,
          enrollmentId: identity.enrollmentId,
        },
      },
      tx,
    );
  }
}

/** The stored offline receipt, or null for a receipt that is not an offline journal entry. */
function storedReceipt(receipt: TerminalCommandReceipt): CommittedCommandReceipt | null {
  if (receipt.offlineSequence === null || !receipt.operation.startsWith(OFFLINE_JOURNAL_OPERATION)) return null;
  return receipt.result as unknown as CommittedCommandReceipt;
}

export function acknowledge(receipt: CommittedCommandReceipt, status: "committed" | "duplicate"): SyncAcknowledgement {
  const base = { commandId: receipt.commandId, commandHash: receipt.commandHash, sequence: receipt.sequence };
  // Settled by a manager (slice 4): `reviewed` however often it is resent, with exactly the
  // fields of its outcome (the response is signed as canonical JSON).
  if ("review" in receipt) {
    const review = {
      settlementId: receipt.review.settlementId,
      refusalCode: receipt.review.refusalCode,
      settledAt: receipt.review.settledAt,
    };
    const head = { ...base, status: "reviewed" as const, committedAt: receipt.committedAt, review };
    if (receipt.decision === "not_honoured")
      return { ...head, commandKind: receipt.commandKind, decision: "not_honoured" };
    if (receipt.commandKind === "ordinary_sale") {
      const posting =
        receipt.stockPosting === "posted"
          ? { stockPosting: "posted" as const, reconciliationCaseId: null }
          : { stockPosting: "pending_reconciliation" as const, reconciliationCaseId: receipt.reconciliationCaseId };
      return { ...head, commandKind: "ordinary_sale", decision: "recorded", saleId: receipt.saleId, ...posting };
    }
    return { ...head, commandKind: receipt.commandKind, decision: "recorded", workSessionId: receipt.workSessionId };
  }
  if (receipt.commandKind === "ordinary_sale") {
    const posting =
      receipt.stockPosting === "posted"
        ? { stockPosting: "posted" as const, reconciliationCaseId: null }
        : { stockPosting: "pending_reconciliation" as const, reconciliationCaseId: receipt.reconciliationCaseId };
    return { ...base, commandKind: "ordinary_sale", status, saleId: receipt.saleId, committedAt: receipt.committedAt, ...posting };
  }
  return { ...base, commandKind: receipt.commandKind, status, workSessionId: receipt.workSessionId, committedAt: receipt.committedAt };
}

function supportAcknowledgement(receipt: SupportRecordReceipt): SupportAcknowledgement {
  const base = { recordId: receipt.recordId, recordHash: receipt.recordHash };
  const error = (code: TerminalErrorCode, message: string) => ({
    contractVersion: 1 as const,
    code,
    message,
    correlationId: randomUUID(),
    retryable: terminalErrorRetryable(code),
  });
  if (receipt.status === "conflict")
    return { ...base, status: "held", error: error("REPLAY_CONFLICT", "This record ID already holds other content.") };
  if (receipt.status === "accepted") return { ...base, status: receipt.replayed ? "duplicate" : "accepted" };
  // Stored durably; it is still `held` (or was rejected) on verification against P3/P5 evidence.
  return {
    ...base,
    status: "held",
    error: error("RECONCILIATION_REQUIRED", `Kept for review (${receipt.heldReason ?? receipt.status}).`),
  };
}
