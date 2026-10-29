import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, StockMovementType, TransferStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { nextTenantDocumentNumber } from "../common/document-sequence.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import {
  isPrismaUniqueFieldError,
  normalizeIdempotencyKey,
} from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { StockService } from "../inventory/stock/stock.service";
import { TRANSFER_RESERVATION_SOURCE } from "../inventory/stock/stock-reasons";
import { AccessService, type ActorAccess } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import { transferApprovalReview } from "../security/transfer-approval-material";
import type { CommandProvenance } from "../terminals/command-provenance";
import { denied } from "../terminals/terminal-wire";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ApproveTransferDto, DispatchTransferDto } from "./dto/approve-transfer.dto";
import { ReceiveTransferDto } from "./dto/receive-transfer.dto";

type Tx = Prisma.TransactionClient;

const TRANSFER_LIST_INCLUDE = {
  items: {
    include: {
      product: { select: { id: true, sku: true, name: true } },
      batch: { select: { id: true, batchNo: true } },
    },
  },
  fromBranch: { select: { id: true, code: true, name: true } },
  toBranch: { select: { id: true, code: true, name: true } },
  requester: { select: { id: true, fullName: true } },
  approver: { select: { id: true, fullName: true } },
  receiver: { select: { id: true, fullName: true } },
} as const;

type TransferLineForStock = {
  id: string;
  productId: string;
  batchId: string | null;
  qty: number;
};

/** A counted receipt line. `receivedQtyBefore` pins what the counter saw already received, so
 * a distinct second command for the same arrival is refused instead of receiving twice.
 */
export type TransferReceiptLine = {
  transferItemId: string;
  qty: number;
  receivedQtyBefore?: number;
};

function stockLines(lines: TransferLineForStock[]) {
  return lines.map((line) => {
    if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");
    return { productId: line.productId, batchId: line.batchId, qty: line.qty, sourceLineId: line.id };
  });
}

const DISPATCHED: TransferStatus[] = [
  TransferStatus.in_transit,
  TransferStatus.partially_received,
  TransferStatus.received,
];

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
  ) {}

  private dateOnly(iso: string | null | undefined): Date | null {
    if (!iso?.trim()) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException("Invalid expectedOn date");
    }
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  private async approvalRequired(client: Tx | PrismaService, tenantId: string) {
    const settings = await client.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredForBranchTransfers: true },
    });
    return settings?.approvalRequiredForBranchTransfers ?? true;
  }

  /**
   * Hold stock for an approved transfer. A reservation, not a ledger movement: the units are
   * still on the shelf (and in a stocktake's count) until the transfer actually ships.
   */
  private async reserve(
    tx: Tx,
    params: {
      tenantId: string;
      branchId: string;
      userId: string;
      transferId: string;
      lines: TransferLineForStock[];
    },
  ) {
    const batchIds = params.lines.map((line) => line.batchId).filter((id): id is string => !!id);
    const held = await tx.batch.findMany({
      where: { tenantId: params.tenantId, id: { in: batchIds }, isQuarantined: true },
      select: { batchNo: true },
    });
    if (held.length > 0) {
      throw new BadRequestException(
        `Batch ${held[0]!.batchNo} is quarantined and cannot be transferred`,
      );
    }
    await this.stock.reserve(
      tx,
      {
        tenantId: params.tenantId,
        branchId: params.branchId,
        userId: params.userId,
        sourceType: TRANSFER_RESERVATION_SOURCE,
        sourceId: params.transferId,
      },
      stockLines(params.lines),
    );
  }

  private async enrichRows(
    tenantId: string,
    viewerBranchId: string,
    rows: Array<{
      id: string;
      status: TransferStatus;
      fromBranchId: string;
      toBranchId: string;
      expectedOn: Date | null;
      approvalVersion: number;
      executionApprovalId: string | null;
      dispatchedBy: string | null;
      items: Array<{ id: string; productId: string; batchId: string | null; qty: number; receivedQty: number }>;
      [key: string]: unknown;
    }>,
  ) {
    if (rows.length === 0) return [];

    const transferIds = rows.map((row) => row.id);
    const approvalIds = rows.map((row) => row.executionApprovalId).filter((id): id is string => !!id);
    const [ledger, approvalRequired, dispatchers, evidence] = await Promise.all([
      this.prisma.stockLedger.groupBy({
        by: ["referenceId", "movementType"],
        where: {
          tenantId,
          referenceType: "transfer",
          referenceId: { in: transferIds },
          movementType: { in: [StockMovementType.transfer_out, StockMovementType.transfer_in] },
        },
        _sum: { qtyDelta: true },
      }),
      this.approvalRequired(this.prisma, tenantId),
      this.prisma.appUser.findMany({
        where: {
          tenantId,
          id: { in: rows.map((row) => row.dispatchedBy).filter((id): id is string => !!id) },
        },
        select: { id: true, fullName: true },
      }),
      this.prisma.managementApproval.findMany({
        where: { tenantId, id: { in: approvalIds } },
        select: { id: true, documentVersion: true, revokedAt: true },
      }),
    ]);
    const evidenceById = new Map(evidence.map((row) => [row.id, row]));
    const dispatcherById = new Map(dispatchers.map((user) => [user.id, user]));

    const movementByTransfer = new Map<string, { dispatchedQty: number; receivedQty: number }>();
    for (const entry of ledger) {
      const current = movementByTransfer.get(entry.referenceId) ?? {
        dispatchedQty: 0,
        receivedQty: 0,
      };
      const qty = entry._sum.qtyDelta ?? 0;
      if (entry.movementType === StockMovementType.transfer_out) {
        current.dispatchedQty += Math.abs(qty);
      } else if (entry.movementType === StockMovementType.transfer_in) {
        current.receivedQty += Math.max(0, qty);
      }
      movementByTransfer.set(entry.referenceId, current);
    }

    return rows.map((row) => {
      const totalQty = row.items.reduce((sum, item) => sum + item.qty, 0);
      const itemReceivedQty = row.items.reduce((sum, item) => sum + item.receivedQty, 0);
      const movement = movementByTransfer.get(row.id) ?? { dispatchedQty: 0, receivedQty: 0 };
      let receivedQty = Math.max(itemReceivedQty, movement.receivedQty);
      if (row.status === TransferStatus.received && receivedQty === 0 && totalQty > 0) {
        receivedQty = totalQty;
      }
      const receivedPercent =
        totalQty > 0 ? Math.min(100, Math.round((receivedQty / totalQty) * 100)) : 0;
      const awaitingDecision =
        row.status === TransferStatus.requested ||
        (row.status === TransferStatus.approved && !row.executionApprovalId);
      const approvalWaived =
        row.status === TransferStatus.approved && !row.executionApprovalId && !approvalRequired;

      return {
        ...row,
        totalQty,
        dispatchedQty: movement.dispatchedQty,
        receivedQty,
        // Left the source but not yet booked in at the destination.
        inTransitQty: Math.max(0, movement.dispatchedQty - movement.receivedQty),
        receivedPercent,
        dispatcher: row.dispatchedBy ? (dispatcherById.get(row.dispatchedBy) ?? null) : null,
        approvalWaived,
        // The material version the pinned approval covers; behind approvalVersion means stale.
        approvedVersion: row.executionApprovalId
          ? (evidenceById.get(row.executionApprovalId)?.documentVersion ?? null)
          : null,
        approvalRevoked: row.executionApprovalId
          ? Boolean(evidenceById.get(row.executionApprovalId)?.revokedAt)
          : false,
        // The exact content an approver confirms at the source branch.
        approvalReview:
          viewerBranchId === row.fromBranchId && (awaitingDecision || row.status === TransferStatus.approved)
            ? transferApprovalReview(row.approvalVersion, row, row.items)
            : null,
      };
    });
  }

  async create(user: RequestUser, fromBranchId: string, access: ActorAccess, dto: CreateTransferDto) {
    const tenantId = user.tenantId;
    const userId = access.userId;
    if (dto.toBranchId === fromBranchId) {
      throw new BadRequestException("Destination branch must differ from origin");
    }
    const toBranch = await this.prisma.branch.findFirst({
      where: { id: dto.toBranchId, tenantId, isActive: true },
    });
    if (!toBranch) throw new NotFoundException("Destination branch not found");

    // Settings → Approval Rules, "Require approval for branch transfers".
    // ON (the default): the transfer waits for someone holding `transfers.approve` — unless the
    //   requester holds it too and their role may approve its own requests (Settings → Approval
    //   Rules → self-approval), in which case it is approved on creation and recorded as theirs,
    //   with exact approval evidence for the content they just submitted.
    // OFF: the tenant has said transfers need no approval step at all, so any holder of
    //   `transfers.manage` creates one already approved; dispatch then carries no approval.
    const approvalRequired = await this.approvalRequired(this.prisma, tenantId);
    const selfApproves =
      approvalRequired && access.has("transfers.approve") && access.canSelfApprove;
    const autoApprove = !approvalRequired || selfApproves;
    const status = autoApprove ? TransferStatus.approved : TransferStatus.requested;

    const transfer = await this.prisma.$transaction(async (tx) => {
      for (const line of dto.items) {
        if (!line.batchId) {
          throw new BadRequestException("batchId is required for each transfer line");
        }
      }
      const batchIds = dto.items.map((line) => line.batchId!);
      const batches = await tx.batch.findMany({
        where: { tenantId, branchId: fromBranchId, id: { in: batchIds } },
        select: { id: true, productId: true, batchNo: true, isQuarantined: true },
      });
      const batchById = new Map(batches.map((b) => [b.id, b]));
      const requested = new Map<string, number>();
      for (const line of dto.items) {
        const batch = batchById.get(line.batchId!);
        if (!batch || batch.productId !== line.productId) {
          throw new BadRequestException("Invalid batch on transfer line");
        }
        if (batch.isQuarantined) {
          throw new BadRequestException(
            `Batch ${batch.batchNo} is quarantined and cannot be transferred`,
          );
        }
        requested.set(batch.id, (requested.get(batch.id) ?? 0) + line.qty);
      }
      const balances = await this.stock.balances(tx, tenantId, batchIds);
      for (const [batchId, qty] of requested) {
        const available = balances.get(batchId)?.available ?? 0;
        if (available < qty) {
          throw new BadRequestException(
            `Only ${Math.max(0, available)} available on batch ${batchById.get(batchId)!.batchNo} (${qty} requested)`,
          );
        }
      }

      const transferNumber = await nextTenantDocumentNumber(tx, tenantId, "transfer", "TR-");

      // Created as requested; approval (and its reservation) follows as its own step below.
      const created = await tx.transfer.create({
        data: {
          tenantId,
          fromBranchId,
          toBranchId: dto.toBranchId,
          transferNumber,
          status: TransferStatus.requested,
          notes: dto.notes?.trim() || null,
          expectedOn: this.dateOnly(dto.expectedOn ?? null),
          requestedBy: userId,
          items: {
            create: dto.items.map((l) => ({
              tenantId,
              productId: l.productId,
              batchId: l.batchId ?? null,
              qty: l.qty,
              receivedQty: 0,
            })),
          },
        },
        include: { items: true },
      });

      let approvalId: string | null = null;
      if (selfApproves) {
        const doc = await this.approvals.preview(tx, user, fromBranchId, "transfer.ship", created.id);
        const evidence = await this.approvals.issue(tx, user, fromBranchId, "transfer.ship", created.id, {
          approvalId: randomUUID(),
          expectedVersion: doc.identity.documentVersion,
          expectedDigest: doc.identity.documentDigest,
          reason: "Requested and approved by the same authorized user",
          expiresAt: null,
        });
        approvalId = evidence.approvalId;
      }
      if (autoApprove) {
        await tx.transfer.update({
          where: { id: created.id, tenantId },
          data: {
            status: TransferStatus.approved,
            approvedBy: userId,
            approvedAt: new Date(),
            executionApprovalId: approvalId,
          },
        });
        await this.reserve(tx, {
          tenantId,
          branchId: fromBranchId,
          userId,
          transferId: created.id,
          lines: created.items,
        });
      }

      await this.audit.log(
        {
          tenantId,
          branchId: fromBranchId,
          actorUserId: userId,
          eventName: autoApprove ? "transfer.created_and_approved" : "transfer.created",
          entityName: "transfer",
          entityId: created.id,
          payload: {
            status,
            autoApprove,
            approvalWaived: autoApprove && !selfApproves,
            approvalId,
            transferNumber: created.transferNumber,
          },
        },
        tx,
      );

      return tx.transfer.findFirstOrThrow({
        where: { id: created.id, tenantId },
        include: TRANSFER_LIST_INCLUDE,
      });
    });

    const [enriched] = await this.enrichRows(tenantId, fromBranchId, [transfer]);
    return enriched;
  }

  async getOne(tenantId: string, branchId: string, transferId: string, client: Tx | PrismaService = this.prisma) {
    const t = await client.transfer.findFirst({
      where: {
        id: transferId,
        tenantId,
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
      },
      include: TRANSFER_LIST_INCLUDE,
    });
    if (!t) throw new NotFoundException("Transfer not found");
    const [enriched] = await this.enrichRows(tenantId, branchId, [t]);
    return enriched;
  }

  /**
   * Approval authorizes the exact displayed content at the source branch and reserves the stock.
   * It never moves stock on hand: dispatch at the source counter is a separate post.
   * Re-approving an approved transfer (evidence revoked, or approved before exact approvals or
   * under a waived policy) issues fresh evidence without reserving twice.
   */
  async approve(user: RequestUser, fromBranchId: string, transferId: string, dto: ApproveTransferDto) {
    const tenantId = user.tenantId;
    await this.prisma.$transaction(async (tx) => {
      await this.lockAtSource(tx, tenantId, fromBranchId, transferId);
      const pending = await tx.transfer.findFirst({
        where: { id: transferId, tenantId, fromBranchId },
        include: { items: true },
      });
      if (!pending) throw new NotFoundException("Transfer not found");
      if (pending.status !== TransferStatus.requested && pending.status !== TransferStatus.approved) {
        throw new BadRequestException("Transfer is not awaiting approval at this source branch");
      }
      // Self-approval, live permission and the displayed version/digest are checked here.
      const evidence = await this.approvals.issue(tx, user, fromBranchId, "transfer.ship", transferId, {
        ...dto,
        reason: "Reviewed transfer lines and destination",
        expiresAt: null,
      });
      if (pending.executionApprovalId === evidence.approvalId) return;

      await tx.transfer.update({
        where: { id: transferId, tenantId },
        data: {
          status: TransferStatus.approved,
          approvedBy: user.userId,
          approvedAt: new Date(),
          executionApprovalId: evidence.approvalId,
        },
      });
      if (pending.status === TransferStatus.requested) {
        await this.reserve(tx, {
          tenantId,
          branchId: fromBranchId,
          userId: user.userId,
          transferId,
          lines: pending.items,
        });
      }

      await this.audit.log(
        {
          tenantId,
          branchId: fromBranchId,
          actorUserId: user.userId,
          eventName: "transfer.approved",
          entityName: "transfer",
          entityId: transferId,
          payload: {
            selfApproved: pending.requestedBy === user.userId,
            approvalId: evidence.approvalId,
            documentVersion: evidence.document.documentVersion,
            documentDigest: evidence.document.documentDigest,
            requestedByUserId: pending.requestedBy,
            approvedByUserId: user.userId,
            reapproved: pending.status === TransferStatus.approved,
          },
        },
        tx,
      );
    });

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  async reject(tenantId: string, fromBranchId: string, userId: string, transferId: string) {
    const claimed = await this.prisma.transfer.updateMany({
      where: {
        id: transferId,
        tenantId,
        fromBranchId,
        status: TransferStatus.requested,
      },
      data: { status: TransferStatus.rejected, approvedBy: userId },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Only pending transfers at this source branch can be rejected");
    }

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: "transfer.rejected",
      entityName: "transfer",
      entityId: transferId,
    });

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  async cancel(
    tenantId: string,
    fromBranchId: string,
    access: ActorAccess,
    transferId: string,
  ) {
    const userId = access.userId;
    const t = await this.prisma.transfer.findFirst({
      where: { id: transferId, tenantId, fromBranchId },
      select: { status: true, requestedBy: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");

    if (t.status !== TransferStatus.requested && t.status !== TransferStatus.approved) {
      throw new BadRequestException(
        "Only pending or approved (not yet shipped) transfers can be cancelled",
      );
    }

    const isRequester = t.requestedBy === userId;
    if (!isRequester && !access.has("transfers.approve")) {
      throw new ForbiddenException(
        "Only the person who requested this transfer, or an approver, can cancel it",
      );
    }

    const priorStatus = t.status;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.transfer.updateMany({
        where: { id: transferId, tenantId, fromBranchId, status: priorStatus },
        data: { status: TransferStatus.cancelled },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException("Transfer can no longer be cancelled");
      }

      if (priorStatus === TransferStatus.approved) {
        await this.stock.releaseReservations(tx, tenantId, TRANSFER_RESERVATION_SOURCE, transferId);
      }

      await this.audit.log(
        {
          tenantId,
          branchId: fromBranchId,
          actorUserId: userId,
          eventName: "transfer.cancelled",
          entityName: "transfer",
          entityId: transferId,
        },
        tx,
      );
    });

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  /** Browser dispatch: the same core as the signed counter command, keyed by Idempotency-Key. */
  async ship(
    user: RequestUser,
    fromBranchId: string,
    transferId: string,
    dto: DispatchTransferDto,
    idempotencyKeyRaw?: string,
  ) {
    const tenantId = user.tenantId;
    const userId = user.userId;
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const row = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.transferShip,
            idempotencyKey: idemKey,
          },
        },
      });
      if (row) {
        if (row.resourceId !== transferId) {
          throw new BadRequestException("Idempotency-Key already used for a different transfer");
        }
        return this.getOne(tenantId, fromBranchId, transferId);
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.dispatchInTransaction(tx, user, fromBranchId, transferId, {
          approvalId: dto.approvalId ?? null,
        });
        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.transferShip,
              idempotencyKey: idemKey,
              resourceId: transferId,
            },
          });
        }
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, fromBranchId, transferId);
      }
      throw e;
    }

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  /**
   * Whether dispatch of this transfer carries no approval: approved with no evidence while the
   * tenant does not require transfer approval. Read on the caller's transaction.
   */
  async dispatchApprovalWaived(tx: Tx, tenantId: string, fromBranchId: string, transferId: string) {
    const t = await tx.transfer.findFirst({
      where: { id: transferId, tenantId, fromBranchId },
      select: { status: true, executionApprovalId: true },
    });
    if (!t || t.executionApprovalId || t.status !== TransferStatus.approved) return false;
    return !(await this.approvalRequired(tx, tenantId));
  }

  /**
   * Dispatch core shared by the browser route and the signed source-counter command, in the
   * caller's READ COMMITTED transaction. `approvalId` pins the approval the dispatcher saw (null
   * only where approval is waived); `command` is verified provenance copied into the success
   * audit. The reservation becomes the movement: units leave the source and are in transit.
   */
  async dispatchInTransaction(
    tx: Tx,
    user: RequestUser,
    fromBranchId: string,
    transferId: string,
    input: { approvalId: string | null },
    command?: CommandProvenance,
  ) {
    const tenantId = user.tenantId;
    await this.lockAtSource(tx, tenantId, fromBranchId, transferId);
    const t = await tx.transfer.findFirst({
      where: { id: transferId, tenantId, fromBranchId },
      include: { items: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");
    const actor = await this.access.resolveLive(user, fromBranchId, tx);
    if (!actor.has("transfers.manage")) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "You can't dispatch transfers at this branch" });
    }
    if ((t.executionApprovalId ?? null) !== input.approvalId) {
      throw new ConflictException("Approval changed; refresh and review before dispatching");
    }
    if (DISPATCHED.includes(t.status) && t.dispatchedAt) {
      return { actor, changed: false, approvalId: t.executionApprovalId, dispatchedQty: 0 };
    }
    if (t.status !== TransferStatus.approved) {
      throw new BadRequestException(
        "Transfer must be approved at this source branch before shipping",
      );
    }
    if (!t.executionApprovalId && (await this.approvalRequired(tx, tenantId))) {
      // Approved before exact approvals, or approval turned back on: no evidence is assumed.
      denied("APPROVAL_REQUIRED");
    }

    const lines = stockLines(t.items);
    // Lock stock before the final authority/approval checks, including after a lock wait.
    await this.stock.lockBatches(tx, tenantId, lines.map((line) => line.batchId));
    const evidence = t.executionApprovalId
      ? await this.approvals.requireForExecution(
          tx,
          user,
          fromBranchId,
          "transfer.ship",
          transferId,
          t.executionApprovalId,
        )
      : null;

    await this.stock.consumeReservations(tx, tenantId, TRANSFER_RESERVATION_SOURCE, t.id);
    await this.stock.issue(
      tx,
      {
        tenantId,
        branchId: fromBranchId,
        userId: user.userId,
        referenceType: "transfer",
        referenceId: t.id,
      },
      lines.map((line) => ({
        productId: line.productId,
        batchId: line.batchId,
        qty: line.qty,
        movementType: StockMovementType.transfer_out,
        from: "sellable" as const,
      })),
    );

    const claimed = await tx.transfer.updateMany({
      where: { id: transferId, tenantId, fromBranchId, status: TransferStatus.approved },
      data: { status: TransferStatus.in_transit, dispatchedBy: user.userId, dispatchedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictException("Transfer dispatch conflict — refresh and try again");
    }

    const dispatchedQty = lines.reduce((sum, line) => sum + line.qty, 0);
    await this.audit.log(
      {
        tenantId,
        branchId: fromBranchId,
        actorUserId: user.userId,
        eventName: "transfer.shipped",
        entityName: "transfer",
        entityId: transferId,
        payload: {
          approvalId: evidence?.approvalId ?? null,
          approvalWaived: !evidence,
          documentVersion: evidence?.document.documentVersion ?? t.approvalVersion,
          requestedByUserId: t.requestedBy,
          approvedByUserId: evidence?.approvedByUserId ?? t.approvedBy,
          executedByUserId: user.userId,
          toBranchId: t.toBranchId,
          dispatchedQty,
          ...(command ? { command } : {}),
        },
      },
      tx,
    );
    return { actor, changed: true, approvalId: evidence?.approvalId ?? null, dispatchedQty };
  }

  async receive(
    user: RequestUser,
    toBranchId: string,
    transferId: string,
    dto: ReceiveTransferDto = {},
    idempotencyKeyRaw?: string,
  ) {
    const tenantId = user.tenantId;
    const userId = user.userId;
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const row = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId,
            scope: IDEMPOTENCY_SCOPE.transferReceive,
            idempotencyKey: idemKey,
          },
        },
      });
      if (row) {
        if (row.resourceId !== transferId) {
          throw new BadRequestException("Idempotency-Key already used for a different transfer");
        }
        return this.getOne(tenantId, toBranchId, transferId);
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await this.receiveInTransaction(tx, user, toBranchId, transferId, {
          dispatchApprovalId: dto.dispatchApprovalId,
          lines: dto.lines?.length ? dto.lines : null,
        });
        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.transferReceive,
              idempotencyKey: idemKey,
              resourceId: transferId,
            },
          });
        }
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, toBranchId, transferId);
      }
      throw e;
    }

    return this.getOne(tenantId, toBranchId, transferId);
  }

  /**
   * Receipt core shared by the browser route and the signed destination-counter command. Locks
   * the transfer through its destination branch and requires live `transfers.manage` there, so a
   * source terminal or source-only staff cannot book stock into the destination. `lines: null`
   * receives everything still in transit (browser only; a signed command counts each line).
   * `dispatchApprovalId` (when given) pins the dispatch the counter is receiving.
   */
  async receiveInTransaction(
    tx: Tx,
    user: RequestUser,
    toBranchId: string,
    transferId: string,
    input: { dispatchApprovalId?: string | null; lines: TransferReceiptLine[] | null },
    command?: CommandProvenance,
  ) {
    const tenantId = user.tenantId;
    await tx.$queryRaw`SELECT id FROM transfer WHERE tenant_id = ${tenantId}::uuid AND to_branch_id = ${toBranchId}::uuid AND id = ${transferId}::uuid FOR UPDATE`;
    const t = await tx.transfer.findFirst({
      where: { id: transferId, tenantId, toBranchId },
      include: { items: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");
    const actor = await this.access.resolveLive(user, toBranchId, tx);
    if (!actor.has("transfers.manage")) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "You can't receive transfers at this branch" });
    }
    if (input.dispatchApprovalId !== undefined && (t.executionApprovalId ?? null) !== input.dispatchApprovalId) {
      throw new ConflictException("This is not the dispatch you are receiving; refresh and try again");
    }
    if (t.status !== TransferStatus.in_transit && t.status !== TransferStatus.partially_received) {
      throw new BadRequestException(
        "Transfer is not awaiting receipt at this destination branch",
      );
    }

    const receivePlan = new Map<string, { qty: number; receivedQtyBefore?: number }>();
    if (input.lines) {
      for (const line of input.lines) {
        const prior = receivePlan.get(line.transferItemId);
        if (prior && line.receivedQtyBefore !== undefined) {
          throw new BadRequestException("Count each transfer line once");
        }
        receivePlan.set(line.transferItemId, {
          qty: (prior?.qty ?? 0) + line.qty,
          receivedQtyBefore: line.receivedQtyBefore,
        });
      }
    } else {
      for (const item of t.items) {
        const remaining = item.qty - item.receivedQty;
        if (remaining > 0) receivePlan.set(item.id, { qty: remaining });
      }
    }
    if (receivePlan.size === 0) {
      throw new BadRequestException("Nothing left to receive on this transfer");
    }

    const arrivals: Array<{ productId: string; batchId: string; qty: number }> = [];
    for (const [itemId, plan] of receivePlan) {
      if (plan.qty <= 0) continue;
      const line = t.items.find((item) => item.id === itemId);
      if (!line) {
        throw new BadRequestException(`Unknown transfer line ${itemId}`);
      }
      if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");
      if (plan.receivedQtyBefore !== undefined && plan.receivedQtyBefore !== line.receivedQty) {
        throw new ConflictException("Part of this transfer was received since you counted it; refresh and count again");
      }

      const remaining = line.qty - line.receivedQty;
      if (plan.qty > remaining) {
        throw new BadRequestException(
          `Cannot receive ${plan.qty} on line ${itemId}; only ${remaining} remaining`,
        );
      }

      const bumped = await tx.transferItem.updateMany({
        where: { id: line.id, tenantId, receivedQty: line.receivedQty },
        data: { receivedQty: line.receivedQty + plan.qty },
      });
      if (bumped.count !== 1) {
        throw new BadRequestException("Receive conflict — refresh and try again");
      }

      const sourceBatch = await tx.batch.findFirst({
        where: { id: line.batchId, tenantId, branchId: t.fromBranchId },
      });
      if (!sourceBatch) throw new BadRequestException("Source batch missing");
      if (sourceBatch.needsExpiryReview)
        throw new BadRequestException(
          "Confirm the source batch expiry before receiving this transfer",
        );

      /** Reuse destination batch with the same batch number (FEFO / recall continuity). */
      let destBatch = await tx.batch.findFirst({
        where: {
          tenantId,
          branchId: toBranchId,
          productId: line.productId,
          batchNo: sourceBatch.batchNo,
        },
      });
      if (!destBatch) {
        destBatch = await tx.batch.create({
          data: {
            tenantId,
            branchId: toBranchId,
            productId: line.productId,
            batchNo: sourceBatch.batchNo,
            expiryDate: sourceBatch.expiryDate,
            costPrice: sourceBatch.costPrice,
            sellingPrice: sourceBatch.sellingPrice,
            supplierId: sourceBatch.supplierId,
          },
        });
      }
      arrivals.push({ productId: line.productId, batchId: destBatch.id, qty: plan.qty });
    }

    if (arrivals.length === 0) {
      throw new BadRequestException("Nothing left to receive on this transfer");
    }

    await this.stock.receive(
      tx,
      {
        tenantId,
        branchId: toBranchId,
        userId: user.userId,
        referenceType: "transfer",
        referenceId: t.id,
      },
      arrivals.map((arrival) => ({
        ...arrival,
        movementType: StockMovementType.transfer_in,
      })),
    );

    const refreshed = await tx.transferItem.findMany({
      where: { transferId: t.id, tenantId },
    });
    const fullyReceived = refreshed.every((i) => i.receivedQty >= i.qty);
    const nextStatus = fullyReceived ? TransferStatus.received : TransferStatus.partially_received;

    const statusClaimed = await tx.transfer.updateMany({
      where: {
        id: t.id,
        tenantId,
        toBranchId,
        status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
      },
      data: { status: nextStatus, receivedBy: user.userId, receivedAt: new Date() },
    });
    if (statusClaimed.count !== 1) {
      throw new BadRequestException("Transfer receipt conflict — refresh and try again");
    }

    const receivedQty = arrivals.reduce((sum, arrival) => sum + arrival.qty, 0);
    const lines = [...receivePlan.entries()].map(([transferItemId, plan]) => ({
      transferItemId,
      qty: plan.qty,
    }));
    await this.audit.log(
      {
        tenantId,
        branchId: toBranchId,
        actorUserId: user.userId,
        eventName: "transfer.received",
        entityName: "transfer",
        entityId: transferId,
        payload: {
          lines,
          fromBranchId: t.fromBranchId,
          dispatchApprovalId: t.executionApprovalId,
          dispatchedByUserId: t.dispatchedBy,
          executedByUserId: user.userId,
          status: nextStatus,
          ...(command ? { command } : {}),
        },
      },
      tx,
    );
    return { actor, status: nextStatus, receivedQty, lines };
  }

  /** Source-branch row lock; the approval document resolver takes the same lock. */
  private async lockAtSource(tx: Tx, tenantId: string, fromBranchId: string, transferId: string) {
    await tx.$queryRaw`SELECT id FROM transfer WHERE tenant_id = ${tenantId}::uuid AND from_branch_id = ${fromBranchId}::uuid AND id = ${transferId}::uuid FOR UPDATE`;
  }

  async list(tenantId: string, branchId: string) {
    const rows = await this.prisma.transfer.findMany({
      where: {
        tenantId,
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
      },
      orderBy: { createdAt: "desc" },
      include: TRANSFER_LIST_INCLUDE,
    });

    return this.enrichRows(tenantId, branchId, rows);
  }
}
