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
  StocktakeCondition,
  StocktakeCountStatus,
  StocktakeScope,
  StocktakeStatus,
  StocktakeVarianceReason,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { nextDocumentNumber } from "../common/document-sequence.util";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreateStocktakeDto } from "./dto/create-stocktake.dto";
import { UpsertStocktakeLinesDto } from "./dto/upsert-stocktake-lines.dto";
import {
  AddStocktakeLinesDto,
  RemoveStocktakeLinesDto,
  RequestRecountDto,
  ReviewStocktakeLinesDto,
  UpdateStocktakeDto,
} from "./dto/update-stocktake.dto";

const WRITE_ROLES = new Set<RoleName>([
  RoleName.owner,
  RoleName.manager,
  RoleName.inventory_clerk,
]);
const REVIEW_ROLES = new Set<RoleName>([RoleName.owner, RoleName.manager]);
const BLIND_RESTRICTED_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.draft,
  StocktakeStatus.scheduled,
  StocktakeStatus.counting,
  StocktakeStatus.submitted,
  StocktakeStatus.under_review,
  StocktakeStatus.approved,
];
const HEADER_EDITABLE_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.draft,
  StocktakeStatus.scheduled,
  StocktakeStatus.counting,
  StocktakeStatus.submitted,
];
const PRE_REVIEW_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.draft,
  StocktakeStatus.scheduled,
  StocktakeStatus.counting,
];
const STARTABLE_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.draft,
  StocktakeStatus.scheduled,
];
const REVIEWABLE_LINE_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.under_review,
  StocktakeStatus.approved,
];
const CANCELLABLE_STATUSES: StocktakeStatus[] = [
  StocktakeStatus.draft,
  StocktakeStatus.scheduled,
  StocktakeStatus.counting,
  StocktakeStatus.submitted,
  StocktakeStatus.under_review,
];

const STOCKTAKE_INCLUDE = {
  counter: { select: { id: true, fullName: true } },
  reviewer: { select: { id: true, fullName: true } },
  approver: { select: { id: true, fullName: true } },
  poster: { select: { id: true, fullName: true } },
  completer: { select: { id: true, fullName: true } },
  assignments: {
    include: {
      user: { select: { id: true, fullName: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
  snapshotLines: true,
  postings: {
    include: { lines: true },
    orderBy: { postedAt: "asc" as const },
  },
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
      countEntries: {
        include: { counter: { select: { id: true, fullName: true } } },
        orderBy: { countedAt: "asc" as const },
      },
    },
  },
} as const;

type StocktakeRow = Prisma.StocktakeGetPayload<{
  include: typeof STOCKTAKE_INCLUDE;
}>;

type RoleFlags = {
  canWrite: boolean;
  canReview: boolean;
  canApprove: boolean;
  canPost: boolean;
  canViewExpected: boolean;
};

type MovementRef = {
  id: string;
  movementType: StockMovementType;
  referenceType: string;
  referenceId: string;
  qtyDelta: number;
  reason: string | null;
  occurredAt: string;
};

type MovementSummary = {
  delta: number;
  refs: MovementRef[];
};

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

function toIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function roleFlags(roles: RoleName[]): RoleFlags {
  const canWrite = roles.some((role) => WRITE_ROLES.has(role));
  const canReview = roles.some((role) => REVIEW_ROLES.has(role));
  return {
    canWrite,
    canReview,
    canApprove: canReview,
    canPost: canReview,
    canViewExpected: canReview,
  };
}

@Injectable()
export class StocktakesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private assertReviewer(roles: RoleName[]) {
    if (!roles.some((role) => REVIEW_ROLES.has(role))) {
      throw new ForbiddenException("Only owner or manager may review this stocktake");
    }
  }

  private isBlindRestricted(stocktake: Pick<StocktakeRow, "blindCount" | "status">, flags: RoleFlags) {
    if (!stocktake.blindCount) return false;
    if (!BLIND_RESTRICTED_STATUSES.includes(stocktake.status)) return false;
    // Supervisors may see expected only after review starts — not while counting.
    if (flags.canViewExpected) {
      return (
        stocktake.status === StocktakeStatus.draft ||
        stocktake.status === StocktakeStatus.scheduled ||
        stocktake.status === StocktakeStatus.counting ||
        stocktake.status === StocktakeStatus.submitted
      );
    }
    return true;
  }

  private assertLineEditable(status: StocktakeStatus) {
    if (status !== StocktakeStatus.counting) {
      throw new BadRequestException("Counts can only be edited while the stocktake is counting");
    }
  }

  private assertHeaderEditable(status: StocktakeStatus) {
    if (!HEADER_EDITABLE_STATUSES.includes(status)) {
      throw new BadRequestException(`Stocktake cannot be updated in status ${status}`);
    }
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
      for (const group of grouped) {
        if (group.batchId) qtyMap.set(group.batchId, group._sum.qtyDelta ?? 0);
      }
    }

    let seed = batches.map((b) => ({
      id: b.id,
      productId: b.productId,
      systemQty: qtyMap.get(b.id) ?? 0,
      expiryDate: b.expiryDate,
    }));

    if (dto.batchIds?.length) {
      return seed.map(({ id, productId, systemQty }) => ({ id, productId, systemQty }));
    }

    if (scope === StocktakeScope.zero_stock) {
      seed = seed.filter((b) => b.systemQty === 0);
    } else if (scope === StocktakeScope.near_expiry) {
      seed = seed.filter((b) => b.systemQty !== 0 || b.expiryDate < today);
    } else if (scope !== StocktakeScope.quarantined) {
      seed = seed.filter((b) => b.systemQty !== 0);
    }

    return seed.map(({ id, productId, systemQty }) => ({ id, productId, systemQty }));
  }

  private async validateUsers(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userIds: string[],
  ): Promise<string[]> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) return [];
    const users = await tx.appUser.findMany({
      where: { tenantId, id: { in: unique } },
      select: { id: true },
    });
    if (users.length !== unique.length) {
      throw new BadRequestException("One or more assigned users are invalid");
    }
    return unique;
  }

  private async syncAssignments(
    tx: Prisma.TransactionClient,
    tenantId: string,
    stocktakeId: string,
    counterIds: string[],
    areaLabel?: string | null,
  ) {
    const unique = await this.validateUsers(tx, tenantId, counterIds);
    const existing = await tx.stocktakeAssignment.findMany({
      where: { stocktakeId },
      select: { id: true, userId: true },
    });
    const existingSet = new Set(existing.map((item) => item.userId));
    const desiredSet = new Set(unique);

    const removeIds = existing.filter((item) => !desiredSet.has(item.userId)).map((item) => item.id);
    if (removeIds.length > 0) {
      await tx.stocktakeAssignment.deleteMany({ where: { id: { in: removeIds } } });
    }

    const addIds = unique.filter((userId) => !existingSet.has(userId));
    if (addIds.length > 0) {
      await tx.stocktakeAssignment.createMany({
        data: addIds.map((userId) => ({
          tenantId,
          stocktakeId,
          userId,
          areaLabel: areaLabel?.trim() || null,
        })),
      });
    }

    if (areaLabel !== undefined) {
      await tx.stocktakeAssignment.updateMany({
        where: { stocktakeId },
        data: { areaLabel: areaLabel?.trim() || null },
      });
    }
  }

  private async loadOneRow(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.stocktake.findFirst({
      where: { id, tenantId, branchId },
      include: STOCKTAKE_INCLUDE,
    });
    if (!row) throw new NotFoundException("Stocktake not found");
    return row;
  }

  private async movementMapForRow(row: StocktakeRow): Promise<Map<string, MovementSummary>> {
    const snapshotAt = row.snapshotAt ?? row.frozenAt;
    const result = new Map<string, MovementSummary>();
    if (!snapshotAt || row.lines.length === 0) return result;

    const batchIds = [...new Set(row.lines.map((line) => line.batchId))];
    const entries = await this.prisma.stockLedger.findMany({
      where: {
        tenantId: row.tenantId,
        branchId: row.branchId,
        batchId: { in: batchIds },
        occurredAt: { gt: snapshotAt },
        movementType: {
          notIn: [StockMovementType.stocktake_in, StockMovementType.stocktake_out],
        },
      },
      select: {
        id: true,
        batchId: true,
        movementType: true,
        referenceType: true,
        referenceId: true,
        qtyDelta: true,
        reason: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: "asc" },
    });

    for (const entry of entries) {
      if (!entry.batchId) continue;
      const current = result.get(entry.batchId) ?? { delta: 0, refs: [] };
      current.delta += entry.qtyDelta;
      current.refs.push({
        id: entry.id,
        movementType: entry.movementType,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        qtyDelta: entry.qtyDelta,
        reason: entry.reason ?? null,
        occurredAt: entry.occurredAt.toISOString(),
      });
      result.set(entry.batchId, current);
    }
    return result;
  }

  private async loadActivity(tenantId: string, branchId: string, stocktakeId: string) {
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        tenantId,
        branchId,
        entityName: "stocktake",
        entityId: stocktakeId,
      },
      select: {
        id: true,
        eventName: true,
        createdAt: true,
        payload: true,
        actor: { select: { id: true, fullName: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((row) => ({
      id: row.id,
      eventName: row.eventName,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor,
      payload: row.payload,
    }));
  }

  private summarize(
    row: StocktakeRow,
    flags: RoleFlags,
    movementMap: Map<string, MovementSummary>,
  ) {
    const blindRestricted = this.isBlindRestricted(row, flags);
    let countedLineCount = 0;
    let varianceLineCount = 0;
    let varianceUnitsIn = 0;
    let varianceUnitsOut = 0;
    let varianceValueApprox = 0;
    let totalSnapshotQty = 0;
    let totalCountedQty = 0;

    for (const line of row.lines) {
      const snapshotQty =
        row.snapshotLines.find((snapshot) => snapshot.lineId === line.id)?.snapshotQty ?? line.systemQty;
      totalSnapshotQty += snapshotQty;
      if (line.countedQty != null) {
        countedLineCount += 1;
        totalCountedQty += line.countedQty;
      }
      if (blindRestricted) continue;
      const movementDelta = movementMap.get(line.batchId)?.delta ?? 0;
      const expectedAtReview = snapshotQty + movementDelta;
      const adjustedVariance =
        line.countedQty == null ? null : line.countedQty - expectedAtReview;
      if (!adjustedVariance) continue;
      varianceLineCount += 1;
      if (adjustedVariance > 0) varianceUnitsIn += adjustedVariance;
      else varianceUnitsOut += Math.abs(adjustedVariance);
      varianceValueApprox += adjustedVariance * Number(line.batch.costPrice);
    }

    return {
      lineCount: row.lines.length,
      countedLineCount,
      uncountedLineCount: row.lines.length - countedLineCount,
      progressPct:
        row.lines.length === 0 ? 0 : Math.min(100, Math.round((countedLineCount / row.lines.length) * 100)),
      totalSnapshotQty: blindRestricted ? null : totalSnapshotQty,
      totalCountedQty,
      varianceLineCount: blindRestricted ? null : varianceLineCount,
      varianceUnitsIn: blindRestricted ? null : varianceUnitsIn,
      varianceUnitsOut: blindRestricted ? null : varianceUnitsOut,
      varianceUnitsNet: blindRestricted ? null : varianceUnitsIn - varianceUnitsOut,
      varianceValueApprox: blindRestricted
        ? null
        : Math.round(varianceValueApprox * 100) / 100,
    };
  }

  private async mapRow(row: StocktakeRow, flags: RoleFlags, withActivity = false) {
    const movementMap = await this.movementMapForRow(row);
    const summary = this.summarize(row, flags, movementMap);
    const blindRestricted = this.isBlindRestricted(row, flags);
    const snapshotByLineId = new Map(row.snapshotLines.map((item) => [item.lineId, item]));

    const lines = [...row.lines]
      .sort((a, b) => {
        const byName = a.product.name.localeCompare(b.product.name);
        if (byName !== 0) return byName;
        return a.batch.batchNo.localeCompare(b.batch.batchNo);
      })
      .map((line) => {
        const snapshotQty = snapshotByLineId.get(line.id)?.snapshotQty ?? line.systemQty;
        const movementSummary = movementMap.get(line.batchId) ?? { delta: 0, refs: [] };
        const expectedAtReview = snapshotQty + movementSummary.delta;
        const adjustedVariance =
          line.countedQty == null ? null : line.countedQty - expectedAtReview;

        return {
          id: line.id,
          productId: line.productId,
          batchId: line.batchId,
          systemQty: blindRestricted ? null : snapshotQty,
          snapshotQty: blindRestricted ? null : snapshotQty,
          countedQty: line.countedQty,
          varianceQty: blindRestricted ? null : adjustedVariance,
          adjustedVariance: blindRestricted ? null : adjustedVariance,
          movementDeltaSinceSnapshot: blindRestricted ? null : movementSummary.delta,
          expectedAtReview: blindRestricted ? null : expectedAtReview,
          countStatus: line.status,
          condition: line.condition,
          note: line.note,
          reviewReason: blindRestricted ? null : line.reviewReason,
          reviewResolution: blindRestricted ? null : line.reviewResolution,
          reviewNote: blindRestricted ? null : line.reviewNote,
          countedAt: toIso(line.countedAt),
          reviewedAt: toIso(line.reviewedAt),
          approvedAt: toIso(line.approvedAt),
          postedAt: toIso(line.postedAt),
          product: line.product,
          batch: {
            id: line.batch.id,
            batchNo: line.batch.batchNo,
            expiryDate: line.batch.expiryDate.toISOString(),
            isQuarantined: line.batch.isQuarantined,
            costPrice: Number(line.batch.costPrice),
          },
          movementRefs: blindRestricted ? [] : movementSummary.refs,
          countEntries: line.countEntries.map((entry) => ({
            id: entry.id,
            countedQty: entry.countedQty,
            condition: entry.condition,
            note: entry.note,
            isRecount: entry.isRecount,
            countedAt: entry.countedAt.toISOString(),
            counter: entry.counter,
          })),
        };
      });

    return {
      id: row.id,
      stocktakeNumber: row.stocktakeNumber,
      status: row.status,
      scope: row.scope,
      movementMode: row.movementMode,
      blindCount: row.blindCount,
      frozenAt: toIso(row.frozenAt),
      snapshotAt: toIso(row.snapshotAt),
      scheduledFor: toIso(row.scheduledFor),
      expectedCompletionAt: toIso(row.expectedCompletionAt),
      nearExpiryDays: row.nearExpiryDays,
      title: row.title,
      areaLabel: row.areaLabel,
      notes: row.notes,
      countedBy: row.countedBy,
      reviewerId: row.reviewerId,
      approvedBy: row.approvedBy,
      postedBy: row.postedBy,
      completedBy: row.completedBy,
      startedAt: toIso(row.startedAt),
      submittedAt: toIso(row.submittedAt),
      reviewStartedAt: toIso(row.reviewStartedAt),
      approvedAt: toIso(row.approvedAt),
      postedAt: toIso(row.postedAt),
      completedAt: toIso(row.completedAt),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      counter: row.counter,
      reviewer: row.reviewer,
      approver: row.approver,
      poster: row.poster,
      completer: row.completer,
      assignments: row.assignments.map((assignment) => ({
        id: assignment.id,
        areaLabel: assignment.areaLabel,
        user: assignment.user,
      })),
      lines,
      postings: row.postings.map((posting) => ({
        id: posting.id,
        postedBy: posting.postedBy,
        postedAt: posting.postedAt.toISOString(),
        note: posting.note,
        lines: posting.lines.map((line) => ({
          id: line.id,
          lineId: line.lineId,
          qtyDelta: line.qtyDelta,
          movementType: line.movementType,
          ledgerReferenceId: line.ledgerReferenceId,
          reason: line.reason,
        })),
      })),
      ...summary,
      activity: withActivity ? await this.loadActivity(row.tenantId, row.branchId, row.id) : undefined,
      permissions: flags,
    };
  }

  async list(tenantId: string, branchId: string, roles: RoleName[]) {
    const rows = await this.prisma.stocktake.findMany({
      where: { tenantId, branchId },
      include: STOCKTAKE_INCLUDE,
      orderBy: [{ scheduledFor: "asc" }, { createdAt: "desc" }],
    });
    const flags = roleFlags(roles);
    return Promise.all(rows.map((row) => this.mapRow(row, flags)));
  }

  async getOne(tenantId: string, branchId: string, id: string, roles: RoleName[]) {
    const row = await this.loadOneRow(tenantId, branchId, id);
    return this.mapRow(row, roleFlags(roles), true);
  }

  async create(tenantId: string, branchId: string, userId: string, dto: CreateStocktakeDto, roles: RoleName[]) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to create stocktakes");
    }

    const seedLines = dto.seedLines !== false;
    const scope = dto.scope ?? StocktakeScope.full;
    const blindCount = dto.blindCount === true;
    const nearExpiryDays = scope === StocktakeScope.near_expiry ? (dto.nearExpiryDays ?? 90) : null;
    const scheduledFor = dto.scheduledFor ? new Date(dto.scheduledFor) : null;
    const expectedCompletionAt = dto.expectedCompletionAt ? new Date(dto.expectedCompletionAt) : null;
    if (scheduledFor && expectedCompletionAt && expectedCompletionAt < scheduledFor) {
      throw new BadRequestException("Expected completion must be after scheduled time");
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const stocktakeNumber = await nextDocumentNumber(tx, tenantId, branchId, "stocktake", "ST-");
      const stocktake = await tx.stocktake.create({
        data: {
          tenantId,
          branchId,
          stocktakeNumber,
          status: scheduledFor ? StocktakeStatus.scheduled : StocktakeStatus.draft,
          scope,
          blindCount,
          movementMode: dto.movementMode ?? "continue_and_reconcile",
          nearExpiryDays,
          title: dto.title?.trim() || null,
          areaLabel: dto.areaLabel?.trim() || null,
          notes: dto.notes?.trim() || null,
          countedBy: userId,
          reviewerId: dto.reviewerId ?? null,
          scheduledFor,
          expectedCompletionAt,
        },
      });

      const counterIds = dto.counterIds?.length ? dto.counterIds : [userId];
      await this.syncAssignments(tx, tenantId, stocktake.id, counterIds, dto.areaLabel);

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
        scheduledFor: scheduledFor?.toISOString() ?? null,
      },
    });

    return this.getOne(tenantId, branchId, created.id, roles);
  }

  async updateHeader(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpdateStocktakeDto,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to update stocktakes");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    this.assertHeaderEditable(row.status);

    await this.prisma.$transaction(async (tx) => {
      await tx.stocktake.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title?.trim() || null } : {}),
          ...(dto.areaLabel !== undefined ? { areaLabel: dto.areaLabel?.trim() || null } : {}),
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          ...(dto.scheduledFor !== undefined
            ? { scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : null }
            : {}),
          ...(dto.expectedCompletionAt !== undefined
            ? {
                expectedCompletionAt: dto.expectedCompletionAt
                  ? new Date(dto.expectedCompletionAt)
                  : null,
              }
            : {}),
          ...(dto.reviewerId !== undefined ? { reviewerId: dto.reviewerId || null } : {}),
        },
      });
      if (dto.counterIds) {
        await this.syncAssignments(tx, tenantId, id, dto.counterIds, dto.areaLabel);
      } else if (dto.areaLabel !== undefined) {
        await tx.stocktakeAssignment.updateMany({
          where: { stocktakeId: id },
          data: { areaLabel: dto.areaLabel?.trim() || null },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.updated",
      entityName: "stocktake",
      entityId: id,
      payload: { fields: Object.keys(dto) },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async addLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: AddStocktakeLinesDto,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to add stocktake lines");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (!PRE_REVIEW_STATUSES.includes(row.status)) {
      throw new BadRequestException("Lines can only be added before review");
    }

    const existing = new Set(row.lines.map((line) => line.batchId));
    const uniqueIds = [...new Set(dto.batchIds)].filter((batchId) => !existing.has(batchId));
    if (uniqueIds.length === 0) {
      return this.getOne(tenantId, branchId, id, roles);
    }

    await this.prisma.$transaction(async (tx) => {
      const batches = await tx.batch.findMany({
        where: { tenantId, branchId, id: { in: uniqueIds } },
        select: { id: true, productId: true },
      });
      if (batches.length !== uniqueIds.length) {
        throw new BadRequestException("One or more batches are invalid for this branch");
      }

      for (const batch of batches) {
        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, batch.id);
        const line = await tx.stocktakeLine.create({
          data: {
            tenantId,
            stocktakeId: id,
            productId: batch.productId,
            batchId: batch.id,
            systemQty,
          },
        });
        if (row.snapshotAt) {
          await tx.stocktakeSnapshotLine.create({
            data: {
              tenantId,
              stocktakeId: id,
              lineId: line.id,
              productId: batch.productId,
              batchId: batch.id,
              snapshotQty: systemQty,
            },
          });
        }
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

    return this.getOne(tenantId, branchId, id, roles);
  }

  async removeLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: RemoveStocktakeLinesDto,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to remove stocktake lines");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (!PRE_REVIEW_STATUSES.includes(row.status)) {
      throw new BadRequestException("Lines can only be removed before review");
    }

    await this.prisma.stocktakeLine.deleteMany({
      where: { stocktakeId: id, tenantId, batchId: { in: dto.batchIds } },
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

    return this.getOne(tenantId, branchId, id, roles);
  }

  async upsertLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: UpsertStocktakeLinesDto,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to count stocktake lines");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    this.assertLineEditable(row.status);

    const lineByBatchId = new Map(row.lines.map((line) => [line.batchId, line]));
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      for (const input of dto.lines) {
        const existing = lineByBatchId.get(input.batchId);
        if (!existing) {
          throw new BadRequestException(`Batch ${input.batchId} is not part of this stocktake`);
        }
        const priorEntries = await tx.stocktakeCountEntry.count({
          where: { lineId: existing.id },
        });
        await tx.stocktakeLine.update({
          where: { id: existing.id },
          data: {
            countedQty: input.countedQty,
            varianceQty: input.countedQty - existing.systemQty,
            condition: input.condition ?? StocktakeCondition.saleable,
            note: input.note?.trim() || null,
            countedAt: now,
            status:
              existing.status === StocktakeCountStatus.recount_requested || priorEntries > 0
                ? StocktakeCountStatus.recounted
                : StocktakeCountStatus.counted,
          },
        });
        await tx.stocktakeCountEntry.create({
          data: {
            tenantId,
            stocktakeId: id,
            lineId: existing.id,
            countedQty: input.countedQty,
            condition: input.condition ?? StocktakeCondition.saleable,
            note: input.note?.trim() || null,
            countedBy: userId,
            countedAt: now,
            isRecount:
              existing.status === StocktakeCountStatus.recount_requested || priorEntries > 0,
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.counts_saved",
      entityName: "stocktake",
      entityId: id,
      payload: { lineCount: dto.lines.length },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async schedule(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to schedule stocktakes");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.draft) {
      throw new BadRequestException("Only draft stocktakes can be scheduled");
    }
    if (!row.scheduledFor) {
      throw new BadRequestException("Set a scheduled time before scheduling the stocktake");
    }

    await this.prisma.stocktake.update({
      where: { id },
      data: { status: StocktakeStatus.scheduled },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.scheduled",
      entityName: "stocktake",
      entityId: id,
      payload: { scheduledFor: row.scheduledFor?.toISOString() ?? null },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async start(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to start stocktakes");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (!STARTABLE_STATUSES.includes(row.status)) {
      throw new BadRequestException("Only draft or scheduled stocktakes can be started");
    }
    if (row.lines.length === 0) {
      throw new BadRequestException("Add at least one line before starting");
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const line of row.lines) {
        const systemQty = await qtyForBatchTx(tx, tenantId, branchId, line.batchId);
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            systemQty,
            varianceQty: line.countedQty == null ? null : line.countedQty - systemQty,
            status: line.countedQty == null ? StocktakeCountStatus.pending : StocktakeCountStatus.counted,
          },
        });

        const existingSnapshot = await tx.stocktakeSnapshotLine.findUnique({
          where: { lineId: line.id },
          select: { id: true },
        });
        if (!existingSnapshot) {
          await tx.stocktakeSnapshotLine.create({
            data: {
              tenantId,
              stocktakeId: id,
              lineId: line.id,
              productId: line.productId,
              batchId: line.batchId,
              snapshotQty: systemQty,
            },
          });
        }
      }

      await tx.stocktake.update({
        where: { id },
        data: {
          status: StocktakeStatus.counting,
          frozenAt: now,
          snapshotAt: row.snapshotAt ?? now,
          startedAt: row.startedAt ?? now,
        },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.started",
      entityName: "stocktake",
      entityId: id,
      payload: { snapshotAt: now.toISOString() },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async submit(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    if (!roleFlags(roles).canWrite) {
      throw new ForbiddenException("You do not have permission to submit stocktakes");
    }
    const row = await this.loadOneRow(tenantId, branchId, id);
    this.assertLineEditable(row.status);
    if (row.lines.some((line) => line.countedQty == null)) {
      throw new BadRequestException("Count all lines before submitting");
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.stocktake.update({
        where: { id },
        data: { status: StocktakeStatus.submitted, submittedAt: now },
      });
      await tx.stocktakeLine.updateMany({
        where: { stocktakeId: id, countedQty: { not: null } },
        data: { status: StocktakeCountStatus.submitted },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.submitted",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async startReview(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.submitted) {
      throw new BadRequestException("Only submitted stocktakes can enter review");
    }
    const now = new Date();
    await this.prisma.stocktake.update({
      where: { id },
      data: {
        status: StocktakeStatus.under_review,
        reviewStartedAt: now,
        reviewerId: row.reviewerId ?? userId,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.review_started",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async reviewLines(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: ReviewStocktakeLinesDto,
    roles: RoleName[],
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (!REVIEWABLE_LINE_STATUSES.includes(row.status)) {
      throw new BadRequestException("Review details can only be edited during review or approval");
    }

    const existing = new Map(row.lines.map((line) => [line.id, line]));
    await this.prisma.$transaction(async (tx) => {
      for (const input of dto.lines) {
        const line = existing.get(input.lineId);
        if (!line) throw new BadRequestException("Invalid stocktake line");
        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            reviewReason: input.reviewReason ?? null,
            reviewResolution: input.reviewResolution?.trim() || null,
            reviewNote: input.reviewNote?.trim() || null,
            reviewedBy: userId,
            reviewedAt: new Date(),
            status: StocktakeCountStatus.reviewed,
          },
        });
      }
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.lines_reviewed",
      entityName: "stocktake",
      entityId: id,
      payload: { lineCount: dto.lines.length },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async requestRecount(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    dto: RequestRecountDto,
    roles: RoleName[],
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.under_review) {
      throw new BadRequestException("Recounts can only be requested during review");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.stocktake.update({
        where: { id },
        data: { status: StocktakeStatus.counting },
      });
      await tx.stocktakeLine.updateMany({
        where: { id: { in: dto.lineIds }, stocktakeId: id },
        data: {
          countedQty: null,
          countedAt: null,
          status: StocktakeCountStatus.recount_requested,
          reviewNote: dto.note?.trim() || null,
        },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.recount_requested",
      entityName: "stocktake",
      entityId: id,
      payload: { lineIds: dto.lineIds, note: dto.note?.trim() || null },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async approve(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.under_review) {
      throw new BadRequestException("Only stocktakes under review can be approved");
    }

    const movementMap = await this.movementMapForRow(row);
    const snapshotByLineId = new Map(row.snapshotLines.map((snapshot) => [snapshot.lineId, snapshot.snapshotQty]));
    const missingReview = row.lines.filter((line) => {
      const expected = (snapshotByLineId.get(line.id) ?? line.systemQty) + (movementMap.get(line.batchId)?.delta ?? 0);
      const variance = line.countedQty == null ? null : line.countedQty - expected;
      return variance !== null && variance !== 0 && (!line.reviewReason || !line.reviewResolution?.trim());
    });
    if (missingReview.length > 0) {
      throw new BadRequestException(
        `Cannot approve yet: ${missingReview.length} variance line(s) still need both a reason (why the difference exists) and a resolution (what action to take). Matched lines with 0 variance do not need review.`,
      );
    }

    const recountPending = row.lines.filter(
      (line) => line.status === StocktakeCountStatus.recount_requested,
    );
    if (recountPending.length > 0) {
      throw new BadRequestException(
        `Cannot approve while ${recountPending.length} line(s) are awaiting recount`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.stocktake.update({
        where: { id },
        data: {
          status: StocktakeStatus.approved,
          approvedBy: userId,
          approvedAt: now,
        },
      });
      await tx.stocktakeLine.updateMany({
        where: { stocktakeId: id },
        data: {
          approvedBy: userId,
          approvedAt: now,
          status: StocktakeCountStatus.approved,
        },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.approved",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async post(
    tenantId: string,
    branchId: string,
    userId: string,
    id: string,
    roles: RoleName[],
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.approved) {
      throw new BadRequestException("Only approved stocktakes can be posted");
    }

    const movementMap = await this.movementMapForRow(row);
    const snapshotByLineId = new Map(row.snapshotLines.map((snapshot) => [snapshot.lineId, snapshot.snapshotQty]));
    const now = new Date();
    const postingId = randomUUID();
    let adjustments = 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.stocktakePosting.create({
        data: {
          id: postingId,
          tenantId,
          stocktakeId: id,
          postedBy: userId,
          postedAt: now,
          note: "Supervisor-approved stocktake posting",
        },
      });

      for (const line of row.lines) {
        const snapshotQty = snapshotByLineId.get(line.id) ?? line.systemQty;
        const expected = snapshotQty + (movementMap.get(line.batchId)?.delta ?? 0);
        const adjustedVariance = line.countedQty == null ? 0 : line.countedQty - expected;

        await tx.stocktakeLine.update({
          where: { id: line.id },
          data: {
            varianceQty: adjustedVariance,
            postedAt: now,
            status: StocktakeCountStatus.posted,
          },
        });

        if (adjustedVariance === 0) continue;
        adjustments += 1;
        await tx.stockLedger.create({
          data: {
            tenantId,
            branchId,
            productId: line.productId,
            batchId: line.batchId,
            movementType:
              adjustedVariance > 0
                ? StockMovementType.stocktake_in
                : StockMovementType.stocktake_out,
            qtyDelta: adjustedVariance,
            referenceType: "stocktake",
            referenceId: id,
            reason: line.reviewResolution?.trim() || line.note?.trim() || `Stocktake ${row.stocktakeNumber}`,
            createdBy: userId,
          },
        });
        await tx.stocktakePostingLine.create({
          data: {
            tenantId,
            postingId,
            lineId: line.id,
            qtyDelta: adjustedVariance,
            movementType:
              adjustedVariance > 0
                ? StockMovementType.stocktake_in
                : StockMovementType.stocktake_out,
            ledgerReferenceId: id,
            reason: line.reviewResolution?.trim() || line.note?.trim() || null,
            createdBy: userId,
          },
        });
      }

      await tx.stocktake.update({
        where: { id },
        data: {
          status: StocktakeStatus.posted,
          postedBy: userId,
          postedAt: now,
        },
      });
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.posted",
      entityName: "stocktake",
      entityId: id,
      payload: { adjustments },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async complete(
    tenantId: string,
    branchId: string,
    userId: string,
    roles: RoleName[],
    id: string,
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (row.status !== StocktakeStatus.posted) {
      throw new BadRequestException("Only posted stocktakes can be completed");
    }
    const now = new Date();
    await this.prisma.stocktake.update({
      where: { id },
      data: {
        status: StocktakeStatus.completed,
        completedBy: userId,
        completedAt: now,
      },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.completed",
      entityName: "stocktake",
      entityId: id,
    });

    return this.getOne(tenantId, branchId, id, roles);
  }

  async cancel(
    tenantId: string,
    branchId: string,
    userId: string,
    roles: RoleName[],
    id: string,
  ) {
    this.assertReviewer(roles);
    const row = await this.loadOneRow(tenantId, branchId, id);
    if (!CANCELLABLE_STATUSES.includes(row.status)) {
      throw new BadRequestException("Only open stocktakes can be cancelled");
    }

    await this.prisma.stocktake.update({
      where: { id },
      data: { status: StocktakeStatus.cancelled },
    });

    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: userId,
      eventName: "stocktake.cancelled",
      entityName: "stocktake",
      entityId: id,
      payload: { previousStatus: row.status },
    });

    return this.getOne(tenantId, branchId, id, roles);
  }
}
