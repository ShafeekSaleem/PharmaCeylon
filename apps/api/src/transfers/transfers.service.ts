import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  RoleName,
  StockMovementType,
  TransferStatus,
} from "@prisma/client";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
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

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private isOwnerOrManager(roles: RoleName[]): boolean {
    return roles.includes(RoleName.owner) || roles.includes(RoleName.manager);
  }

  private dateOnly(iso: string | null | undefined): Date | null {
    if (!iso?.trim()) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException("Invalid expectedOn date");
    }
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
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
      },
      _sum: { qtyDelta: true },
    });

    const movementByTransfer = new Map<
      string,
      { dispatchedQty: number; receivedQty: number }
    >();
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
      const movement = movementByTransfer.get(row.id) ?? {
        dispatchedQty: 0,
        receivedQty: 0,
      };
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
    userId: string,
    rolesAtFromBranch: RoleName[],
    dto: CreateTransferDto,
  ) {
    if (dto.toBranchId === fromBranchId) {
      throw new BadRequestException("Destination branch must differ from origin");
    }
    const toBranch = await this.prisma.branch.findFirst({
      where: { id: dto.toBranchId, tenantId, isActive: true },
    });
    if (!toBranch) throw new NotFoundException("Destination branch not found");

    for (const line of dto.items) {
      if (!line.batchId) {
        throw new BadRequestException("batchId is required for each transfer line");
      }
      const batch = await this.prisma.batch.findFirst({
        where: { id: line.batchId, tenantId, branchId: fromBranchId, productId: line.productId },
      });
      if (!batch) throw new BadRequestException("Invalid batch on transfer line");

      const agg = await this.prisma.stockLedger.aggregate({
        where: { tenantId, branchId: fromBranchId, batchId: line.batchId },
        _sum: { qtyDelta: true },
      });
      const available = agg._sum.qtyDelta ?? 0;
      if (available < line.qty) {
        throw new BadRequestException(
          `Insufficient stock on batch for product line (need ${line.qty}, have ${available})`,
        );
      }
    }

    /** Owner/manager at the source branch skip pending approval. */
    const autoApprove = this.isOwnerOrManager(rolesAtFromBranch);
    const status = autoApprove ? TransferStatus.approved : TransferStatus.requested;

    const transfer = await this.prisma.transfer.create({
      data: {
        tenantId,
        fromBranchId,
        toBranchId: dto.toBranchId,
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

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: autoApprove ? "transfer.created_and_approved" : "transfer.created",
      entityName: "transfer",
      entityId: transfer.id,
      payload: { status, autoApprove },
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
    userId: string,
    transferId: string,
    rolesAtBranch: RoleName[],
  ) {
    if (!this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to approve transfer");
    }

    const claimed = await this.prisma.transfer.updateMany({
      where: {
        id: transferId,
        tenantId,
        fromBranchId,
        status: TransferStatus.requested,
      },
      data: { status: TransferStatus.approved, approvedBy: userId },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        "Transfer is not awaiting approval at this source branch",
      );
    }

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: "transfer.approved",
      entityName: "transfer",
      entityId: transferId,
    });

    return this.getOne(tenantId, fromBranchId, transferId);
  }

  async reject(
    tenantId: string,
    fromBranchId: string,
    userId: string,
    transferId: string,
    rolesAtBranch: RoleName[],
  ) {
    if (!this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to reject transfer");
    }

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
    userId: string,
    transferId: string,
    rolesAtBranch: RoleName[],
  ) {
    const t = await this.prisma.transfer.findFirst({
      where: { id: transferId, tenantId, fromBranchId },
      include: TRANSFER_LIST_INCLUDE,
    });
    if (!t) throw new NotFoundException("Transfer not found");

    if (
      t.status !== TransferStatus.requested &&
      t.status !== TransferStatus.approved
    ) {
      throw new BadRequestException(
        "Only pending or approved (not yet shipped) transfers can be cancelled",
      );
    }

    const isRequester = t.requestedBy === userId;
    if (!isRequester && !this.isOwnerOrManager(rolesAtBranch)) {
      throw new ForbiddenException("Insufficient role to cancel transfer");
    }

    const claimed = await this.prisma.transfer.updateMany({
      where: {
        id: transferId,
        tenantId,
        fromBranchId,
        status: { in: [TransferStatus.requested, TransferStatus.approved] },
      },
      data: { status: TransferStatus.cancelled },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Transfer can no longer be cancelled");
    }

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: "transfer.cancelled",
      entityName: "transfer",
      entityId: transferId,
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
          throw new BadRequestException(
            "Idempotency-Key already used for a different transfer",
          );
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

        for (const line of t.items) {
          if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");
          const agg = await tx.stockLedger.aggregate({
            where: { tenantId, branchId: fromBranchId, batchId: line.batchId },
            _sum: { qtyDelta: true },
          });
          const available = agg._sum.qtyDelta ?? 0;
          if (available < line.qty) {
            throw new BadRequestException(`Insufficient stock to ship line ${line.id}`);
          }

          await tx.stockLedger.create({
            data: {
              tenantId,
              branchId: fromBranchId,
              productId: line.productId,
              batchId: line.batchId,
              movementType: StockMovementType.transfer_out,
              qtyDelta: -line.qty,
              referenceType: "transfer",
              referenceId: t.id,
              createdBy: userId,
            },
          });
        }

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
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, fromBranchId, transferId);
      }
      throw e;
    }

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: "transfer.shipped",
      entityName: "transfer",
      entityId: transferId,
    });

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
          throw new BadRequestException(
            "Idempotency-Key already used for a different transfer",
          );
        }
        return this.getOne(tenantId, toBranchId, transferId);
      }
    }

    const receivePlan = new Map<string, number>();
    if (dto.lines?.length) {
      for (const line of dto.lines) {
        receivePlan.set(line.transferItemId, (receivePlan.get(line.transferItemId) ?? 0) + line.qty);
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const t = await tx.transfer.findFirst({
          where: {
            id: transferId,
            tenantId,
            toBranchId,
            status: {
              in: [TransferStatus.in_transit, TransferStatus.partially_received],
            },
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

        let anyReceived = false;

        for (const [itemId, qtyToReceive] of receivePlan) {
          if (qtyToReceive <= 0) continue;

          const line = await tx.transferItem.findFirst({
            where: { id: itemId, transferId: t.id, tenantId },
          });
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
            where: { id: line.id, receivedQty: line.receivedQty },
            data: { receivedQty: line.receivedQty + qtyToReceive },
          });
          if (bumped.count !== 1) {
            throw new BadRequestException("Receive conflict — refresh and try again");
          }
          anyReceived = true;

          const sourceBatch = await tx.batch.findFirst({
            where: { id: line.batchId, tenantId, branchId: t.fromBranchId },
          });
          if (!sourceBatch) throw new BadRequestException("Source batch missing");

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
              },
            });
          }

          await tx.stockLedger.create({
            data: {
              tenantId,
              branchId: toBranchId,
              productId: line.productId,
              batchId: destBatch.id,
              movementType: StockMovementType.transfer_in,
              qtyDelta: qtyToReceive,
              referenceType: "transfer",
              referenceId: t.id,
              createdBy: userId,
            },
          });
        }

        if (!anyReceived) {
          throw new BadRequestException("Nothing left to receive on this transfer");
        }

        const refreshed = await tx.transferItem.findMany({
          where: { transferId: t.id, tenantId },
        });
        const fullyReceived = refreshed.every((i) => i.receivedQty >= i.qty);

        const statusClaimed = await tx.transfer.updateMany({
          where: {
            id: t.id,
            status: {
              in: [TransferStatus.in_transit, TransferStatus.partially_received],
            },
          },
          data: {
            status: fullyReceived
              ? TransferStatus.received
              : TransferStatus.partially_received,
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
      });
    } catch (e) {
      if (idemKey && isPrismaUniqueFieldError(e, "idempotency")) {
        return this.getOne(tenantId, toBranchId, transferId);
      }
      throw e;
    }

    await this.audit.log({
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
    });

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
