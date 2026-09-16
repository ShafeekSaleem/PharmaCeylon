import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, StockMovementType, TransferStatus } from "@prisma/client";
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
import { assertMayApprove, type ActorAccess } from "../security/access.service";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ReceiveTransferDto } from "./dto/receive-transfer.dto";

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

function stockLines(lines: TransferLineForStock[]) {
  return lines.map((line) => {
    if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");
    return { productId: line.productId, batchId: line.batchId, qty: line.qty, sourceLineId: line.id };
  });
}

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stock: StockService,
  ) {}

  private dateOnly(iso: string | null | undefined): Date | null {
    if (!iso?.trim()) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException("Invalid expectedOn date");
    }
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  /**
   * Hold stock for an approved transfer. A reservation, not a ledger movement: the units are
   * still on the shelf (and in a stocktake's count) until the transfer actually ships.
   */
  private async reserve(
    tx: Prisma.TransactionClient,
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
    rows: Array<{
      id: string;
      status: TransferStatus;
      items: Array<{ qty: number; receivedQty: number }>;
      [key: string]: unknown;
    }>,
  ) {
    if (rows.length === 0) return [];

    const transferIds = rows.map((row) => row.id);
    const ledger = await this.prisma.stockLedger.groupBy({
      by: ["referenceId", "movementType"],
      where: {
        tenantId,
        referenceType: "transfer",
        referenceId: { in: transferIds },
        movementType: { in: [StockMovementType.transfer_out, StockMovementType.transfer_in] },
      },
      _sum: { qtyDelta: true },
    });

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

      return {
        ...row,
        totalQty,
        dispatchedQty: movement.dispatchedQty,
        receivedQty,
        receivedPercent,
      };
    });
  }

  async create(
    tenantId: string,
    fromBranchId: string,
    access: ActorAccess,
    dto: CreateTransferDto,
  ) {
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
    //   Rules → self-approval), in which case it is approved on creation and recorded as theirs.
    // OFF: the tenant has said transfers need no approval step at all, so any holder of
    //   `transfers.manage` creates one already approved.
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { approvalRequiredForBranchTransfers: true },
    });
    const approvalRequired = settings?.approvalRequiredForBranchTransfers ?? true;
    const autoApprove =
      !approvalRequired || (access.has("transfers.approve") && access.canSelfApprove);
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

      const created = await tx.transfer.create({
        data: {
          tenantId,
          fromBranchId,
          toBranchId: dto.toBranchId,
          transferNumber,
          status,
          notes: dto.notes?.trim() || null,
          expectedOn: this.dateOnly(dto.expectedOn ?? null),
          requestedBy: userId,
          approvedBy: autoApprove ? userId : null,
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
        include: TRANSFER_LIST_INCLUDE,
      });

      if (autoApprove) {
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
          payload: { status, autoApprove, transferNumber: created.transferNumber },
        },
        tx,
      );

      return created;
    });

    const [enriched] = await this.enrichRows(tenantId, [transfer]);
    return enriched;
  }

  async getOne(tenantId: string, branchId: string, transferId: string) {
    const t = await this.prisma.transfer.findFirst({
      where: {
        id: transferId,
        tenantId,
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
      },
      include: TRANSFER_LIST_INCLUDE,
    });
    if (!t) throw new NotFoundException("Transfer not found");
    const [enriched] = await this.enrichRows(tenantId, [t]);
    return enriched;
  }

  async approve(
    tenantId: string,
    fromBranchId: string,
    access: ActorAccess,
    transferId: string,
  ) {
    const userId = access.userId;
    await this.prisma.$transaction(async (tx) => {
      const pending = await tx.transfer.findFirst({
        where: { id: transferId, tenantId, fromBranchId },
        select: { requestedBy: true },
      });
      if (!pending) throw new NotFoundException("Transfer not found");
      assertMayApprove(access, [pending.requestedBy], "transfer");

      const claimed = await tx.transfer.updateMany({
        where: {
          id: transferId,
          tenantId,
          fromBranchId,
          status: TransferStatus.requested,
        },
        data: { status: TransferStatus.approved, approvedBy: userId },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException("Transfer is not awaiting approval at this source branch");
      }

      const t = await tx.transfer.findFirst({
        where: { id: transferId, tenantId },
        include: { items: true },
      });
      if (!t) throw new NotFoundException("Transfer not found");

      await this.reserve(tx, {
        tenantId,
        branchId: fromBranchId,
        userId,
        transferId: t.id,
        lines: t.items,
      });

      await this.audit.log(
        {
          tenantId,
          branchId: fromBranchId,
          actorUserId: userId,
          eventName: "transfer.approved",
          entityName: "transfer",
          entityId: transferId,
          payload: { selfApproved: pending.requestedBy === userId },
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

  async ship(
    tenantId: string,
    fromBranchId: string,
    userId: string,
    transferId: string,
    idempotencyKeyRaw?: string,
  ) {
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
        const claimed = await tx.transfer.updateMany({
          where: {
            id: transferId,
            tenantId,
            fromBranchId,
            status: TransferStatus.approved,
          },
          data: { status: TransferStatus.in_transit },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException(
            "Transfer must be approved at this source branch before shipping",
          );
        }

        const t = await tx.transfer.findFirst({
          where: { id: transferId, tenantId },
          include: { items: true },
        });
        if (!t) throw new NotFoundException("Transfer not found");

        // The promise becomes the movement: the reservation is consumed and the same units
        // leave the branch, in one transaction.
        await this.stock.consumeReservations(tx, tenantId, TRANSFER_RESERVATION_SOURCE, t.id);
        await this.stock.issue(
          tx,
          {
            tenantId,
            branchId: fromBranchId,
            userId,
            referenceType: "transfer",
            referenceId: t.id,
          },
          stockLines(t.items).map((line) => ({
            productId: line.productId,
            batchId: line.batchId,
            qty: line.qty,
            movementType: StockMovementType.transfer_out,
            from: "sellable" as const,
          })),
        );

        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.transferShip,
              idempotencyKey: idemKey,
              resourceId: t.id,
            },
          });
        }

        await this.audit.log(
          {
            tenantId,
            branchId: fromBranchId,
            actorUserId: userId,
            eventName: "transfer.shipped",
            entityName: "transfer",
            entityId: transferId,
          },
          tx,
        );
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, fromBranchId, transferId);
      }
      throw e;
    }

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  async receive(
    tenantId: string,
    toBranchId: string,
    userId: string,
    transferId: string,
    dto: ReceiveTransferDto = {},
    idempotencyKeyRaw?: string,
  ) {
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

    const receivePlan = new Map<string, number>();
    if (dto.lines?.length) {
      for (const line of dto.lines) {
        receivePlan.set(
          line.transferItemId,
          (receivePlan.get(line.transferItemId) ?? 0) + line.qty,
        );
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const t = await tx.transfer.findFirst({
          where: {
            id: transferId,
            tenantId,
            toBranchId,
            status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
          },
          include: { items: true },
        });
        if (!t) {
          throw new BadRequestException(
            "Transfer is not awaiting receipt at this destination branch",
          );
        }

        if (receivePlan.size === 0) {
          for (const item of t.items) {
            const remaining = item.qty - item.receivedQty;
            if (remaining > 0) receivePlan.set(item.id, remaining);
          }
        }

        if (receivePlan.size === 0) {
          throw new BadRequestException("Nothing left to receive on this transfer");
        }

        const arrivals: Array<{ productId: string; batchId: string; qty: number }> = [];

        for (const [itemId, qtyToReceive] of receivePlan) {
          if (qtyToReceive <= 0) continue;

          const line = t.items.find((item) => item.id === itemId);
          if (!line) {
            throw new BadRequestException(`Unknown transfer line ${itemId}`);
          }
          if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");

          const remaining = line.qty - line.receivedQty;
          if (qtyToReceive > remaining) {
            throw new BadRequestException(
              `Cannot receive ${qtyToReceive} on line ${itemId}; only ${remaining} remaining`,
            );
          }

          const bumped = await tx.transferItem.updateMany({
            where: { id: line.id, tenantId, receivedQty: line.receivedQty },
            data: { receivedQty: line.receivedQty + qtyToReceive },
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
          arrivals.push({ productId: line.productId, batchId: destBatch.id, qty: qtyToReceive });
        }

        if (arrivals.length === 0) {
          throw new BadRequestException("Nothing left to receive on this transfer");
        }

        await this.stock.receive(
          tx,
          {
            tenantId,
            branchId: toBranchId,
            userId,
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

        const statusClaimed = await tx.transfer.updateMany({
          where: {
            id: t.id,
            tenantId,
            toBranchId,
            status: { in: [TransferStatus.in_transit, TransferStatus.partially_received] },
          },
          data: {
            status: fullyReceived ? TransferStatus.received : TransferStatus.partially_received,
            receivedBy: userId,
          },
        });
        if (statusClaimed.count !== 1) {
          throw new BadRequestException("Transfer receipt conflict — refresh and try again");
        }

        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId,
              scope: IDEMPOTENCY_SCOPE.transferReceive,
              idempotencyKey: idemKey,
              resourceId: t.id,
            },
          });
        }

        await this.audit.log(
          {
            tenantId,
            branchId: toBranchId,
            actorUserId: userId,
            eventName: "transfer.received",
            entityName: "transfer",
            entityId: transferId,
            payload: {
              lines: [...receivePlan.entries()].map(([transferItemId, qty]) => ({
                transferItemId,
                qty,
              })),
            },
          },
          tx,
        );
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, toBranchId, transferId);
      }
      throw e;
    }

    return this.getOne(tenantId, toBranchId, transferId);
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

    return this.enrichRows(tenantId, rows);
  }
}
