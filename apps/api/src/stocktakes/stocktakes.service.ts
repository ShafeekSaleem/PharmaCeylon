import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  Prisma,
  RoleName,
  StockMovementType,
  StocktakeScope,
  StocktakeStatus,
} from "@prisma/client";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CreateStocktakeDto } from "./dto/create-stocktake.dto";
import { UpsertStocktakeLinesDto } from "./dto/upsert-stocktake-lines.dto";
import {
  AddStocktakeLinesDto,
  RemoveStocktakeLinesDto,
  UpdateStocktakeDto,
} from "./dto/update-stocktake.dto";

const INCLUDE = {
  counter: { select: { id: true, fullName: true } },
  completer: { select: { id: true, fullName: true } },
  lines: {
    include: {
      product: { select: { id: true, sku: true, name: true } },
      batch: {
        select: {
          id: true,
          batchNo: true,
          expiryDate: true,
          isQuarantined: true,
          costPrice: true,
        },
      },
    },
  },
} as const;

type StocktakeWithRelations = Prisma.StocktakeGetPayload<{
  include: typeof INCLUDE;
}>;

async function qtyForBatchTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchId: string,
  batchId: string,
): Promise<number> {
  const agg = await tx.stockLedger.aggregate({
    where: { tenantId, branchId, batchId },
    _sum: { qtyDelta: true },
  });
  return agg._sum.qtyDelta ?? 0;
}

function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

@Injectable()
export class StocktakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private isOwnerOrManager(roles: RoleName[]): boolean {
    return roles.includes(RoleName.owner) || roles.includes(RoleName.manager);
  }

  private assertEditable(status: StocktakeStatus) {
    if (status !== StocktakeStatus.draft && status !== StocktakeStatus.in_progress) {
      throw new BadRequestException(`Stocktake cannot be edited in status ${status}`);
    }
  }

  private summarize(lines: StocktakeWithRelations["lines"]) {
    let totalSystemQty = 0;
    let totalCountedQty = 0;
    let countedLineCount = 0;
    let varianceLineCount = 0;
    let varianceUnitsIn = 0;
    let varianceUnitsOut = 0;
    let varianceValue = 0;

    for (const line of lines) {
      totalSystemQty += line.systemQty;
      if (line.countedQty != null) {
        countedLineCount += 1;
        totalCountedQty += line.countedQty;
        const variance = line.varianceQty ?? line.countedQty - line.systemQty;
        if (variance !== 0) {
          varianceLineCount += 1;
          if (variance > 0) varianceUnitsIn += variance;
          else varianceUnitsOut += Math.abs(variance);
          const cost = Number(line.batch.costPrice);
          if (Number.isFinite(cost)) varianceValue += variance * cost;
        }
      }
    }

    return {
      lineCount: lines.length,
      countedLineCount,
      uncountedLineCount: lines.length - countedLineCount,
      varianceLineCount,
      totalSystemQty,
      totalCountedQty,
      varianceUnitsIn,
      varianceUnitsOut,
      varianceUnitsNet: varianceUnitsIn - varianceUnitsOut,
      varianceValueApprox: Math.round(varianceValue * 100) / 100,
      progressPct:
        lines.length === 0
          ? 0
          : Math.min(100, Math.round((countedLineCount / lines.length) * 100)),
    };
  }

  private mapRow(row: StocktakeWithRelations) {
    const lines = [...row.lines].sort((a, b) => {
      const byName = a.product.name.localeCompare(b.product.name);
      if (byName !== 0) return byName;
      return a.batch.batchNo.localeCompare(b.batch.batchNo);
    });

    const summary = this.summarize(lines);

    return {
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      frozenAt: row.frozenAt?.toISOString() ?? null,
      lines: lines.map((line) => ({
        id: line.id,
        productId: line.productId,
        batchId: line.batchId,
        systemQty: line.systemQty,
        countedQty: line.countedQty,
        varianceQty: line.varianceQty,
        note: line.note,
        countedAt: line.countedAt?.toISOString() ?? null,
        product: line.product,
        batch: {
          id: line.batch.id,
          batchNo: line.batch.batchNo,
          expiryDate: line.batch.expiryDate.toISOString(),
          isQuarantined: line.batch.isQuarantined,
          costPrice: Number(line.batch.costPrice),
        },
      })),
      ...summary,
    };
  }

  private async resolveSeedBatches(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    dto: CreateStocktakeDto,
  ): Promise<Array<{ id: string; productId: string; systemQty: number }>> {
    const scope = dto.scope ?? StocktakeScope.full;
    const nearDays = dto.nearExpiryDays ?? 90;
    const today = utcToday();
    const nearCutoff = new Date(today);
    nearCutoff.setUTCDate(nearCutoff.getUTCDate() + nearDays);

    const where: Prisma.BatchWhereInput = { tenantId, branchId };
    if (dto.batchIds?.length) {
      where.id = { in: dto.batchIds };
    } else if (scope === StocktakeScope.quarantined) {
      where.isQuarantined = true;
    } else if (scope === StocktakeScope.near_expiry) {
      where.expiryDate = { lte: nearCutoff };
    }

    if (scope === StocktakeScope.custom && !dto.batchIds?.length) {
      throw new BadRequestException("Custom scope requires batchIds");
    }

    const batches = await tx.batch.findMany({
      where,
      select: { id: true, productId: true, expiryDate: true },
    });

    const batchIds = batches.map((b) => b.id);
    const qtyMap = new Map<string, number>();
    if (batchIds.length > 0) {
      const grouped = await tx.stockLedger.groupBy({
        by: ["batchId"],
        where: { tenantId, branchId, batchId: { in: batchIds } },
        _sum: { qtyDelta: true },
      });
      for (const g of grouped) {
        if (g.batchId) qtyMap.set(g.batchId, g._sum.qtyDelta ?? 0);
      }
    }

    let seed = batches.map((b) => ({
      id: b.id,
      productId: b.productId,
      systemQty: qtyMap.get(b.id) ?? 0,
      expiryDate: b.expiryDate,
    }));

    if (dto.batchIds?.length) {
      // explicit list — keep all selected
    } else if (scope === StocktakeScope.zero_stock) {
      seed = seed.filter((b) => b.systemQty === 0);
    } else if (scope === StocktakeScope.near_expiry) {
      seed = seed.filter((b) => b.systemQty !== 0 || b.expiryDate < today);
    } else if (scope === StocktakeScope.quarantined) {
      // keep all quarantined
    } else {
      seed = seed.filter((b) => b.systemQty !== 0);
    }

    return seed.map(({ id, productId, systemQty }) => ({ id, productId, systemQty }));
  }

  async list(tenantId: string, branchId: string) {
    const rows = await this.prisma.stocktake.findMany({
      where: { tenantId, branchId },
      include: INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((row) => this.mapRow(row));
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: INCLUDE,
    });
    if (!row) throw new NotFoundException("Stocktake not found");
    return this.mapRow(row);
  }

  async create(
    tenantId: string,
    branchId: string,
    userId: string,
    dto: CreateStocktakeDto,
  ) {
    const seedLines = dto.seedLines !== false;
    const scope = dto.scope ?? StocktakeScope.full;
    const blindCount = dto.blindCount === true;
    const nearExpiryDays =
      scope === StocktakeScope.near_expiry ? (dto.nearExpiryDays ?? 90) : null;

    const created = await this.prisma.$transaction(async (tx) => {
      const stocktakeNumber = await nextDocumentNumber(
        tx,
        tenantId,
        branchId,
        "stocktake",
        "ST-",
      );

      const stocktake = await tx.stocktake.create({
        data: {
          tenantId,
          branchId,
          stocktakeNumber,
          status: StocktakeStatus.draft,
          scope,
          blindCount,
          nearExpiryDays,
          notes: dto.notes?.trim() || null,
          countedBy: userId,
        },
      });

      if (seedLines) {
        const seed = await this.resolveSeedBatches(tx, tenantId, branchId, dto);
        if (seed.length > 0) {
          await tx.stocktakeLine.createMany({
            data: seed.map((line) => ({
              tenantId,
              stocktakeId: stocktake.id,
              productId: line.productId,
              batchId: line.id,
              systemQty: line.systemQty,
            })),
          });
        }
      }

      return stocktake;
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.created",
      entityName: "stocktake",
      entityId: created.id,
      payload: {
        stocktakeNumber: created.stocktakeNumber,
        scope,
        blindCount,
        seedLines,
      },
    });

    return this.getOne(tenantId, branchId, created.id);
  }

  async updateHeader(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpdateStocktakeDto,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    await this.prisma.stocktake.update({
      where: { id },
      data: {
        ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.updated",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }

  async upsertLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpsertStocktakeLinesDto,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    const existingByBatch = new Map(stocktake.lines.map((l) => [l.batchId, l]));
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const input of dto.lines) {
        const existing = existingByBatch.get(input.batchId);
        if (existing) {
          await tx.stocktakeLine.update({
            where: { id: existing.id },
            data: {
              countedQty: input.countedQty,
              varianceQty: input.countedQty - existing.systemQty,
              countedAt: now,
              ...(input.note !== undefined
                ? { note: input.note?.trim() || null }
                : {}),
            },
          });
          continue;
        }

        const batch = await tx.batch.findFirst({
          where: { id: input.batchId, tenantId, branchId },
          select: { id: true, productId: true },
        });
        if (!batch) {
          throw new BadRequestException(`Batch ${input.batchId} not found at this branch`);
        }

        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, batch.id);
        await tx.stocktakeLine.create({
          data: {
            tenantId,
            stocktakeId: stocktake.id,
            productId: batch.productId,
            batchId: batch.id,
            systemQty,
            countedQty: input.countedQty,
            varianceQty: input.countedQty - systemQty,
            countedAt: now,
            note: input.note?.trim() || null,
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.lines_updated",
      entityName: "stocktake",
      entityId: id,
      payload: { lineCount: dto.lines.length },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async addLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: AddStocktakeLinesDto,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    const existing = new Set(stocktake.lines.map((l) => l.batchId));
    const uniqueIds = [...new Set(dto.batchIds)].filter((bid) => !existing.has(bid));
    if (uniqueIds.length === 0) {
      return this.getOne(tenantId, branchId, id);
    }

    await this.prisma.$transaction(async (tx) => {
      const batches = await tx.batch.findMany({
        where: { id: { in: uniqueIds }, tenantId, branchId },
        select: { id: true, productId: true },
      });
      if (batches.length !== uniqueIds.length) {
        throw new BadRequestException("One or more batches are invalid for this branch");
      }
      for (const batch of batches) {
        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, batch.id);
        await tx.stocktakeLine.create({
          data: {
            tenantId,
            stocktakeId: stocktake.id,
            productId: batch.productId,
            batchId: batch.id,
            systemQty,
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.lines_added",
      entityName: "stocktake",
      entityId: id,
      payload: { added: uniqueIds.length },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async removeLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: RemoveStocktakeLinesDto,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    await this.prisma.stocktakeLine.deleteMany({
      where: {
        stocktakeId: id,
        tenantId,
        batchId: { in: dto.batchIds },
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.lines_removed",
      entityName: "stocktake",
      entityId: id,
      payload: { removed: dto.batchIds.length },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async refreshSystemQty(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const line of stocktake.lines) {
        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, line.batchId);
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            systemQty,
            varianceQty:
              line.countedQty != null ? line.countedQty - systemQty : null,
          },
        });
      }
      await tx.stocktake.update({
        where: { id },
        data: { frozenAt: now },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.system_qty_refreshed",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id);
  }

  async matchUncounted(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
  ) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    this.assertEditable(stocktake.status);

    const now = new Date();
    const uncounted = stocktake.lines.filter((l) => l.countedQty == null);
    if (uncounted.length === 0) {
      return this.getOne(tenantId, branchId, id);
    }

    await this.prisma.$transaction(async (tx) => {
      for (const line of uncounted) {
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            countedQty: line.systemQty,
            varianceQty: 0,
            countedAt: now,
            note: line.note ?? "Matched to system (bulk)",
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.matched_uncounted",
      entityName: "stocktake",
      entityId: id,
      payload: { matched: uncounted.length },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async start(tenantId: string, branchId: string, userId: string, id: string) {
    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    if (stocktake.status !== StocktakeStatus.draft) {
      throw new BadRequestException("Only draft stocktakes can be started");
    }
    if (stocktake.lines.length === 0) {
      throw new BadRequestException("Add at least one line before starting");
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const line of stocktake.lines) {
        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, line.batchId);
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            systemQty,
            varianceQty:
              line.countedQty != null ? line.countedQty - systemQty : null,
          },
        });
      }

      const claimed = await tx.stocktake.updateMany({
        where: { id, tenantId, branchId, status: StocktakeStatus.draft },
        data: { status: StocktakeStatus.in_progress, frozenAt: now },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException("Stocktake can no longer be started");
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.started",
      entityName: "stocktake",
      entityId: id,
      payload: {
        stocktakeNumber: stocktake.stocktakeNumber,
        frozenAt: now.toISOString(),
      },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async complete(
    tenantId: string,
    branchId: string,
    userId: string,
    roles: RoleName[],
    id: string,
  ) {
    if (!this.isOwnerOrManager(roles)) {
      throw new ForbiddenException("Only owner or manager may complete a stocktake");
    }

    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: { lines: true },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    if (
      stocktake.status !== StocktakeStatus.in_progress &&
      stocktake.status !== StocktakeStatus.draft
    ) {
      throw new BadRequestException("Only draft or in-progress stocktakes can be completed");
    }
    if (stocktake.lines.length === 0) {
      throw new BadRequestException("Stocktake has no lines to complete");
    }

    const uncounted = stocktake.lines.filter((l) => l.countedQty == null);
    if (uncounted.length > 0) {
      throw new BadRequestException(
        `Count all lines before completing (${uncounted.length} uncounted). Use “Match uncounted” to accept system qty for the rest.`,
      );
    }

    const missingNotes = stocktake.lines.filter((l) => {
      const variance = l.varianceQty ?? l.countedQty! - l.systemQty;
      return variance !== 0 && !l.note?.trim();
    });
    if (missingNotes.length > 0) {
      throw new BadRequestException(
        `Add a reason note on ${missingNotes.length} variance line(s) before completing`,
      );
    }

    const now = new Date();
    let adjustments = 0;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.stocktake.updateMany({
        where: {
          id,
          tenantId,
          branchId,
          status: { in: [StocktakeStatus.draft, StocktakeStatus.in_progress] },
        },
        data: {
          status: StocktakeStatus.completed,
          completedBy: userId,
          completedAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException("Stocktake can no longer be completed");
      }

      for (const line of stocktake.lines) {
        const counted = line.countedQty!;
        const variance = counted - line.systemQty;
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: { varianceQty: variance },
        });

        if (variance === 0) continue;

        adjustments += 1;
        await tx.stockLedger.create({
          data: {
            tenantId,
            branchId,
            productId: line.productId,
            batchId: line.batchId,
            movementType:
              variance > 0
                ? StockMovementType.stocktake_in
                : StockMovementType.stocktake_out,
            qtyDelta: variance,
            referenceType: "stocktake",
            referenceId: stocktake.id,
            reason: line.note?.trim() || `Stocktake ${stocktake.stocktakeNumber}`,
            createdBy: userId,
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.completed",
      entityName: "stocktake",
      entityId: id,
      payload: {
        stocktakeNumber: stocktake.stocktakeNumber,
        countedLines: stocktake.lines.length,
        adjustments,
      },
    });

    return this.getOne(tenantId, branchId, id);
  }

  async cancel(
    tenantId: string,
    branchId: string,
    userId: string,
    roles: RoleName[],
    id: string,
  ) {
    if (!this.isOwnerOrManager(roles)) {
      throw new ForbiddenException("Only owner or manager may cancel a stocktake");
    }

    const stocktake = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
    });
    if (!stocktake) throw new NotFoundException("Stocktake not found");
    if (
      stocktake.status !== StocktakeStatus.draft &&
      stocktake.status !== StocktakeStatus.in_progress
    ) {
      throw new BadRequestException("Only draft or in-progress stocktakes can be cancelled");
    }

    const claimed = await this.prisma.stocktake.updateMany({
      where: {
        id,
        tenantId,
        branchId,
        status: { in: [StocktakeStatus.draft, StocktakeStatus.in_progress] },
      },
      data: { status: StocktakeStatus.cancelled },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("Stocktake can no longer be cancelled");
    }

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.cancelled",
      entityName: "stocktake",
      entityId: id,
      payload: {
        stocktakeNumber: stocktake.stocktakeNumber,
        previousStatus: stocktake.status,
      },
    });

    return this.getOne(tenantId, branchId, id);
  }
}
