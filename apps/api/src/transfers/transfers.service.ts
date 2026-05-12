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
import { randomUUID } from "node:crypto";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreateTransferDto } from "./dto/create-transfer.dto";

@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(
    tenantId: string,
    fromBranchId: string,
    userId: string,
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
    }

    const transfer = await this.prisma.transfer.create({
      data: {
        tenantId,
        fromBranchId,
        toBranchId: dto.toBranchId,
        status: TransferStatus.requested,
        requestedBy: userId,
        items: {
          create: dto.items.map((l) => ({
            tenantId,
            productId: l.productId,
            batchId: l.batchId ?? null,
            qty: l.qty,
          })),
        },
      },
      include: { items: { include: { product: true } } },
    });

    await this.audit.log({
      tenantId,
      branchId: fromBranchId,
      actorUserId: userId,
      eventName: "transfer.created",
      entityName: "transfer",
      entityId: transfer.id,
    });

    return transfer;
  }

  async approve(tenantId: string, userId: string, transferId: string, roles: RoleName[]) {
    const allowed =
      roles.includes(RoleName.owner) ||
      roles.includes(RoleName.manager);
    if (!allowed) throw new ForbiddenException("Insufficient role to approve transfer");

    const t = await this.prisma.transfer.findFirst({
      where: { id: transferId, tenantId },
      include: { items: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");
    if (t.status !== TransferStatus.requested) {
      throw new BadRequestException("Transfer is not awaiting approval");
    }

    const updated = await this.prisma.transfer.update({
      where: { id: transferId },
      data: { status: TransferStatus.approved, approvedBy: userId },
    });

    await this.audit.log({
      tenantId,
      branchId: t.fromBranchId,
      actorUserId: userId,
      eventName: "transfer.approved",
      entityName: "transfer",
      entityId: transferId,
    });

    return updated;
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
        return this.prisma.transfer.findFirst({
          where: { id: transferId },
          include: { items: true },
        });
      }
    }

    const t = await this.prisma.transfer.findFirst({
      where: { id: transferId, tenantId, fromBranchId },
      include: { items: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");
    if (t.status !== TransferStatus.approved) {
      throw new BadRequestException("Transfer must be approved before shipping");
    }

    try {
      await this.prisma.$transaction(async (tx) => {
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

        await tx.transfer.update({
          where: { id: t.id },
          data: { status: TransferStatus.in_transit },
        });

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
        return this.prisma.transfer.findFirst({
          where: { id: transferId },
          include: { items: true },
        });
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

    return this.prisma.transfer.findFirst({ where: { id: transferId }, include: { items: true } });
  }

  async receive(
    tenantId: string,
    toBranchId: string,
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
        return this.prisma.transfer.findFirst({
          where: { id: transferId },
          include: { items: true },
        });
      }
    }

    const t = await this.prisma.transfer.findFirst({
      where: { id: transferId, tenantId, toBranchId },
      include: { items: true },
    });
    if (!t) throw new NotFoundException("Transfer not found");
    if (t.status !== TransferStatus.in_transit) {
      throw new BadRequestException("Transfer is not in transit");
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        for (const line of t.items) {
          if (!line.batchId) throw new BadRequestException("Missing batch on transfer line");
          const sourceBatch = await tx.batch.findFirst({
            where: { id: line.batchId, tenantId, branchId: t.fromBranchId },
          });
          if (!sourceBatch) throw new BadRequestException("Source batch missing");

          const destBatch = await tx.batch.create({
            data: {
              tenantId,
              branchId: toBranchId,
              productId: line.productId,
              batchNo: `${sourceBatch.batchNo}-TR-${randomUUID().slice(0, 8)}`,
              expiryDate: sourceBatch.expiryDate,
              costPrice: sourceBatch.costPrice,
              sellingPrice: sourceBatch.sellingPrice,
            },
          });

          await tx.stockLedger.create({
            data: {
              tenantId,
              branchId: toBranchId,
              productId: line.productId,
              batchId: destBatch.id,
              movementType: StockMovementType.transfer_in,
              qtyDelta: line.qty,
              referenceType: "transfer",
              referenceId: t.id,
              createdBy: userId,
            },
          });
        }

        await tx.transfer.update({
          where: { id: t.id },
          data: { status: TransferStatus.received, receivedBy: userId },
        });

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
        return this.prisma.transfer.findFirst({
          where: { id: transferId },
          include: { items: true },
        });
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
    });

    return this.prisma.transfer.findFirst({ where: { id: transferId }, include: { items: true } });
  }

  async list(tenantId: string, branchId: string) {
    return this.prisma.transfer.findMany({
      where: {
        tenantId,
        OR: [{ fromBranchId: branchId }, { toBranchId: branchId }],
      },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });
  }
}
