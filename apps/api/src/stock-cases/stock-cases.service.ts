import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  OfflineStockDiscrepancyStatus,
  OfflineStockResolutionStatus,
  Prisma,
  SaleStockPosting,
  StockMovementType,
  StocktakeStatus,
  type OfflineStockResolution,
} from "@prisma/client";
import type { OfflineStockResolutionKind, SignedOperationResult } from "@pharmaceylon/shared";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { InsufficientStockException, StockService, type IssueLine } from "../inventory/stock/stock.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import {
  lockOfflineStockCase,
  lockOfflineStockResolution,
  offlineStockResolutionDigest,
  offlineStockResolutionFacts,
  offlineStockResolutionFactsFor,
} from "../security/offline-stock-resolution-approval-material";
import type { CommandProvenance } from "../terminals/command-provenance";
import { countsAfterSale } from "../inventory/stock/counts-after-sale";
import { denied } from "../terminals/terminal-wire";
import {
  allocateMovementLinks,
  checkCounts,
  correctionBuckets,
  countCorrection,
  normalizeLinks,
  parseKind,
  timelineDigest,
  type SettlementLink,
  type TimelineEntry,
} from "./stock-case-plan";

type Tx = Prisma.TransactionClient;
type ExecuteResult = SignedOperationResult["POST /api/v1/offline-stock-cases/resolutions/:id/execute"];
type BatchResult = ExecuteResult["batches"][number];

export const REVIEW_PERMISSION = "inventory.resolve_stock_cases";
export const EXECUTE_PERMISSION = "inventory.manage";
const ACTION = "offline_stock_resolution.execute" as const;
const OPEN_PLAN: OfflineStockResolutionStatus[] = [OfflineStockResolutionStatus.prepared, OfflineStockResolutionStatus.approved];
/** Ledger reference of a count's correction. */
const RESOLUTION_REFERENCE = "offline_stock_resolution";
/**
 * Write-offs and corrections that took units off a batch: what a movement link may name. Never
 * another case's count correction: it keeps every open case's pending units on the batch, so it
 * took none of them off.
 */
const LINKABLE_MOVEMENTS: StockMovementType[] = [StockMovementType.adjustment_out];
const POSTED_STOCKTAKE: StocktakeStatus[] = [StocktakeStatus.posted, StocktakeStatus.completed];
/** Ledger rows shown per batch on review (the latest ones); settlement digests read them all. */
const TIMELINE_LIMIT = 300;
const MOVEMENT_CANDIDATE_LIMIT = 200;

export type PrepareResolutionInput = { kind: unknown; links?: unknown; note?: string | null };
export type ApproveResolutionInput = { approvalId: string; expectedVersion: number; expectedDigest: string };

/**
 * P5 #51 slice 2 (approved D1, revised D10): manager review and resolution of the offline stock
 * discrepancy cases slice 1 opens. Review, plan preparation and exact approval are remote and move
 * nothing; execution (`executeInTransaction`) is only reached through the signed counter command.
 * Lock order everywhere: case, plan, batch rows (StockService), approval evidence.
 */
@Injectable()
export class StockCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
    private readonly stock: StockService,
  ) {}

  // ── Review (read-only) ──────────────────────────────────────────────────────────────────────

  async list(tenantId: string, branchId: string, status?: string) {
    if (status !== undefined && status !== "open" && status !== "resolved")
      throw new BadRequestException("status is open or resolved");
    const cases = await this.prisma.offlineStockDiscrepancy.findMany({
      where: { tenantId, branchId, ...(status ? { status: status as OfflineStockDiscrepancyStatus } : {}) },
      include: {
        lines: { orderBy: { batchId: "asc" } },
        resolutions: { where: { tenantId }, orderBy: { requestedAt: "desc" } },
        sale: { select: { invoiceNo: true, soldAt: true, grandTotal: true, soldBy: true } },
      },
      orderBy: { openedAt: "desc" },
      take: 200,
    });
    const names = await this.names(tenantId, cases.map((c) => c.sale.soldBy));
    const terminals = await this.terminalLabels(tenantId, branchId, cases.map((c) => c.terminalId));
    return cases.map((c) => {
      const plan = c.resolutions.find((r) => OPEN_PLAN.includes(r.status) || r.status === "executed") ?? null;
      return {
        id: c.id,
        status: c.status,
        openedAt: c.openedAt.toISOString(),
        resolvedAt: c.resolvedAt?.toISOString() ?? null,
        saleId: c.saleId,
        invoiceNo: c.sale.invoiceNo,
        soldAt: c.sale.soldAt.toISOString(),
        grandTotal: c.sale.grandTotal.toFixed(2),
        soldBy: names.get(c.sale.soldBy) ?? null,
        counter: terminals.get(c.terminalId) ?? null,
        batchCount: c.lines.length,
        pendingUnits: c.lines.reduce((sum, line) => sum + line.soldQuantity, 0),
        shortfallUnits: c.lines.reduce((sum, line) => sum + line.shortfallQuantity, 0),
        plan: plan ? { id: plan.id, kind: plan.kind, status: plan.status } : null,
      };
    });
  }

  /**
   * Everything a manager needs to decide: the offline sale with its receipt and payments, who sold
   * it on which counter and when it synced, each batch's pending quantity (this case's and other
   * open cases'), the batch's ledger since the snapshot (online sales, transfers, stocktakes,
   * quarantine, adjustments), stocktake counts and reservations, settlements that could already
   * account for the units, and the plans with their approval evidence.
   */
  async detail(tenantId: string, branchId: string, caseId: string) {
    const found = await this.prisma.offlineStockDiscrepancy.findFirst({
      where: { tenantId, branchId, id: caseId },
      include: {
        lines: { orderBy: { batchId: "asc" } },
        blocks: { orderBy: { batchId: "asc" } },
        resolutions: { where: { tenantId }, orderBy: { requestedAt: "desc" } },
        settlements: { where: { tenantId }, include: { links: true }, orderBy: { batchId: "asc" } },
        sale: {
          include: {
            items: { include: { product: { select: { name: true, sku: true } }, batch: { select: { batchNo: true } } } },
            payments: { orderBy: { createdAt: "asc" } },
          },
        },
      },
    });
    if (!found) throw new NotFoundException("Stock case not found");
    const sale = found.sale;
    const batchIds = found.lines.map((line) => line.batchId);
    const [snapshot, receipt, signIn, batches, balances, otherLines, terminal] = await Promise.all([
      this.prisma.offlineStockSnapshot.findFirst({
        where: { tenantId, branchId, id: found.snapshotId },
        select: { generatedAt: true, version: true },
      }),
      this.prisma.terminalCommandReceipt.findFirst({
        where: { tenantId, enrollmentId: found.enrollmentId, commandId: found.commandId },
        select: { id: true, recordedAt: true, actorUserId: true, offlineSequence: true, requestDigest: true, command: true },
      }),
      sale.workSessionId
        ? this.prisma.offlineStaffSignIn.findFirst({
            where: { tenantId, enrollmentId: found.enrollmentId, signInId: sale.workSessionId },
            select: { signInId: true, staffUserId: true, authenticatedAt: true, receivedAt: true },
          })
        : null,
      this.prisma.batch.findMany({
        where: { tenantId, branchId, id: { in: batchIds } },
        select: { id: true, batchNo: true, expiryDate: true, product: { select: { id: true, name: true, sku: true } } },
      }),
      this.prisma.batchStock.findMany({
        where: { tenantId, branchId, batchId: { in: batchIds } },
        select: { batchId: true, onHandQty: true, quarantinedQty: true, reservedQty: true },
      }),
      this.prisma.offlineStockDiscrepancyLine.findMany({
        where: { tenantId, branchId, batchId: { in: batchIds }, caseId: { not: caseId }, case: { tenantId, status: "open" } },
        select: { batchId: true, caseId: true, soldQuantity: true, case: { select: { openedAt: true, sale: { select: { invoiceNo: true } } } } },
      }),
      this.terminalLabels(tenantId, branchId, [found.terminalId]),
    ]);
    const since = snapshot?.generatedAt ?? found.openedAt;
    const [timeline, stocktakes, reservations, capacities, blockRows, plans] = await Promise.all([
      this.timeline(this.prisma, tenantId, branchId, batchIds, since, TIMELINE_LIMIT),
      this.prisma.stocktakeLine.findMany({
        where: {
          tenantId, batchId: { in: batchIds }, stocktake: { tenantId, branchId },
          // Counts taken since the snapshot, and any count of the batch after the sale: the
          // latter is what a stocktake link may name, however long ago the stocktake started.
          OR: [{ countedAt: { gt: sale.soldAt } }, { stocktake: { OR: [{ snapshotAt: { gte: since } }, { createdAt: { gte: since } }] } }],
        },
        select: {
          id: true, batchId: true, systemQty: true, countedQty: true, varianceQty: true, countedAt: true, postedAt: true,
          stocktake: { select: { id: true, stocktakeNumber: true, status: true, snapshotAt: true, countedBy: true } },
        },
      }),
      this.prisma.stockReservation.findMany({
        where: { tenantId, branchId, batchId: { in: batchIds }, status: "active" },
        select: { batchId: true, qty: true, sourceType: true, sourceId: true, createdAt: true },
      }),
      this.movementCapacities(this.prisma, tenantId, branchId, batchIds, sale.soldAt),
      this.prisma.batchSaleBlock.findMany({
        where: { tenantId, branchId, batchId: { in: batchIds }, releasedAt: null },
        select: { batchId: true },
      }),
      this.plansView(tenantId, branchId, found.status, found.resolutions),
    ]);
    const [references, people] = await Promise.all([
      this.referenceLabels(tenantId, branchId, timeline.rows),
      this.names(tenantId, [
        sale.soldBy, receipt?.actorUserId, signIn?.staffUserId,
        ...timeline.rows.map((e) => e.createdBy),
        ...stocktakes.map((s) => s.stocktake.countedBy),
        ...found.settlements.map((s) => s.countedBy),
      ]),
    ]);
    const person = (id: string | null | undefined) => (id ? { id, name: people.get(id) ?? null } : null);
    const balanceOf = new Map(balances.map((b) => [b.batchId, b]));
    const batchOf = new Map(batches.map((b) => [b.id, b]));
    const openBlocks = new Set(blockRows.map((b) => b.batchId));

    return {
      id: found.id,
      status: found.status,
      openedAt: found.openedAt.toISOString(),
      resolvedAt: found.resolvedAt?.toISOString() ?? null,
      snapshot: { id: found.snapshotId, version: found.snapshotVersion, generatedAt: snapshot?.generatedAt.toISOString() ?? null },
      // The count, time and actor evidence of the offline sale itself.
      offline: {
        commandId: found.commandId,
        counter: terminal.get(found.terminalId) ?? null,
        terminalId: found.terminalId,
        enrollmentId: found.enrollmentId,
        sequence: receipt?.offlineSequence != null ? Number(receipt.offlineSequence) : null,
        commandDigest: receipt?.requestDigest ?? null,
        occurredAt: sale.soldAt.toISOString(),
        signIn: signIn
          ? { signInId: signIn.signInId, staff: person(signIn.staffUserId), authenticatedAt: signIn.authenticatedAt.toISOString() }
          : null,
        syncedAt: receipt?.recordedAt.toISOString() ?? found.openedAt.toISOString(),
        uploadedBy: person(receipt?.actorUserId),
      },
      sale: {
        id: sale.id,
        invoiceNo: sale.invoiceNo,
        status: sale.status,
        stockPosting: sale.stockPosting,
        soldAt: sale.soldAt.toISOString(),
        soldBy: person(sale.soldBy),
        shiftId: sale.shiftId,
        subtotal: sale.subtotal.toFixed(2),
        taxTotal: sale.taxTotal.toFixed(2),
        grandTotal: sale.grandTotal.toFixed(2),
        amountPaid: sale.amountPaid.toFixed(2),
        changeDue: sale.changeDue.toFixed(2),
        items: sale.items.map((item) => ({
          productId: item.productId, productName: item.product.name, sku: item.product.sku, batchId: item.batchId,
          batchNo: item.batch.batchNo, qty: item.qty, unitPrice: item.unitPrice.toFixed(2),
          taxAmount: item.taxAmount.toFixed(2), lineTotal: item.lineTotal.toFixed(2),
        })),
        payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount.toFixed(2), reference: p.reference })),
      },
      batches: found.lines.map((line) => {
        const batch = batchOf.get(line.batchId);
        const balance = balanceOf.get(line.batchId);
        const others = otherLines.filter((o) => o.batchId === line.batchId);
        const onHand = balance?.onHandQty ?? 0;
        const quarantined = balance?.quarantinedQty ?? 0;
        const reserved = balance?.reservedQty ?? 0;
        const entries = timeline.rows.filter((e) => e.batchId === line.batchId);
        const truncated = timeline.truncated.has(line.batchId);
        return {
          batchId: line.batchId,
          batchNo: batch?.batchNo ?? null,
          expiryDate: batch?.expiryDate.toISOString().slice(0, 10) ?? null,
          productId: line.productId,
          productName: batch?.product.name ?? null,
          sku: batch?.product.sku ?? null,
          reason: line.reason,
          soldQuantity: line.soldQuantity,
          availableQuantityAtSync: line.availableQuantityAtSync,
          shortfallQuantity: line.shortfallQuantity,
          // Pending: units already gone from the shelf that central stock has not posted.
          pending: {
            thisCase: found.status === "open" ? line.soldQuantity : 0,
            otherOpenCases: others.map((o) => ({
              caseId: o.caseId, invoiceNo: o.case.sale.invoiceNo, soldQuantity: o.soldQuantity, openedAt: o.case.openedAt.toISOString(),
            })),
            total: (found.status === "open" ? line.soldQuantity : 0) + others.reduce((sum, o) => sum + o.soldQuantity, 0),
          },
          stock: { onHand, quarantined, reserved, available: onHand - quarantined - reserved },
          blocked: openBlocks.has(line.batchId),
          heldByThisCase: found.blocks.some((b) => b.batchId === line.batchId && b.releasedAt === null),
          // Only the latest TIMELINE_LIMIT rows are shown; a digest of part of the ledger means nothing.
          timelineTruncated: truncated,
          timelineDigest: truncated ? null : timelineDigest(line.batchId, entries.map(toTimelineEntry)),
          timeline: entries.map((e) => ({
            id: e.id,
            occurredAt: e.occurredAt.toISOString(),
            movementType: e.movementType,
            bucket: e.bucket,
            qtyDelta: e.qtyDelta,
            referenceType: e.referenceType,
            referenceId: e.referenceId,
            reference: references.get(`${e.referenceType}:${e.referenceId}`) ?? null,
            reason: e.reason,
            actor: person(e.createdBy),
          })),
          stocktakes: stocktakes
            .filter((s) => s.batchId === line.batchId)
            .map((s) => ({
              stocktakeId: s.stocktake.id, stocktakeNumber: s.stocktake.stocktakeNumber, status: s.stocktake.status,
              lineId: s.id, systemQty: s.systemQty, countedQty: s.countedQty, varianceQty: s.varianceQty,
              countedAt: s.countedAt?.toISOString() ?? null, postedAt: s.postedAt?.toISOString() ?? null,
              countedBy: person(s.stocktake.countedBy),
              // A posted count taken after the offline sale already reflects its units.
              settlesThisSale: !!(s.postedAt && s.countedAt && s.countedAt > sale.soldAt && POSTED_STOCKTAKE.includes(s.stocktake.status)),
            })),
          reservations: reservations
            .filter((r) => r.batchId === line.batchId)
            .map((r) => ({ qty: r.qty, sourceType: r.sourceType, sourceId: r.sourceId, createdAt: r.createdAt.toISOString() })),
          movementCandidates: capacities
            .filter((c) => c.batchId === line.batchId && c.remaining > 0)
            .map((c) => ({ ledgerEntryId: c.ledgerEntryId, occurredAt: c.occurredAt.toISOString(), qty: c.qty, remaining: c.remaining, reason: c.reason })),
        };
      }),
      plans,
      settlements: found.settlements.map((s) => ({
        batchId: s.batchId,
        method: s.method,
        soldQuantity: s.soldQuantity,
        onHandBefore: s.onHandBefore,
        pendingOnBatch: s.pendingOnBatch,
        countedQuantity: s.countedQuantity,
        countedAt: s.countedAt?.toISOString() ?? null,
        countedBy: person(s.countedBy),
        correctionQuantity: s.correctionQuantity,
        postedQuantity: s.postedQuantity,
        linkedStocktakeId: s.linkedStocktakeId,
        linkedMovements: s.links.map((l) => ({ ledgerEntryId: l.ledgerEntryId, quantity: l.quantity })),
        stockTimelineDigest: s.stockTimelineDigest,
        approvalId: s.approvalId,
        executionCommandId: s.executionCommandId,
      })),
    };
  }

  /** The case's plans with their approval evidence, and what to approve for the open one. */
  private async plansView(tenantId: string, branchId: string, caseStatus: string, resolutions: readonly OfflineStockResolution[]) {
    const approvalIds = resolutions.map((r) => r.executionApprovalId).filter((id): id is string => !!id);
    const openPlan = resolutions.find((r) => OPEN_PLAN.includes(r.status)) ?? null;
    const [approvalRows, facts, people] = await Promise.all([
      this.prisma.managementApproval.findMany({
        where: { tenantId, branchId, id: { in: approvalIds } },
        select: { id: true, documentVersion: true, documentDigest: true, revokedAt: true },
      }),
      openPlan && caseStatus === "open" ? offlineStockResolutionFacts(this.prisma, openPlan) : null,
      this.names(tenantId, resolutions.flatMap((r) => [r.requestedBy, r.approvedBy, r.executedBy, r.cancelledBy])),
    ]);
    const currentDigest = facts ? offlineStockResolutionDigest(facts.material) : null;
    const person = (id: string | null | undefined) => (id ? { id, name: people.get(id) ?? null } : null);
    return resolutions.map((r) => {
      const evidence = approvalRows.find((a) => a.id === r.executionApprovalId) ?? null;
      const isOpen = OPEN_PLAN.includes(r.status);
      const approvalState = !evidence
        ? "none"
        : evidence.revokedAt
          ? "revoked"
          : isOpen && currentDigest !== null && (evidence.documentDigest !== currentDigest || evidence.documentVersion !== r.approvalVersion)
            ? "changed"
            : "matches";
      return {
        id: r.id,
        kind: r.kind,
        links: r.links,
        note: r.note,
        status: r.status,
        approvalVersion: r.approvalVersion,
        executionApprovalId: r.executionApprovalId,
        approvalState,
        // Approve exactly what is shown: the current version and digest.
        approvalReview: isOpen && currentDigest ? { expectedVersion: r.approvalVersion, expectedDigest: currentDigest } : null,
        readyAtCounter: r.status === "approved" && approvalState === "matches",
        requester: person(r.requestedBy),
        requestedAt: r.requestedAt.toISOString(),
        approver: person(r.approvedBy),
        approvedAt: r.approvedAt?.toISOString() ?? null,
        executor: person(r.executedBy),
        executedAt: r.executedAt?.toISOString() ?? null,
        executionCommandId: r.executionCommandId,
        result: r.result,
        cancelledBy: person(r.cancelledBy),
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
      };
    });
  }

  // ── Plan and approval (remote; nothing moves) ───────────────────────────────────────────────

  async prepare(user: RequestUser, branchId: string, caseId: string, input: PrepareResolutionInput) {
    const tenantId = user.tenantId;
    const kind = parseKind(input.kind);
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null;
    const id = await this.prisma.$transaction(async (tx) => {
      await lockOfflineStockCase(tx, tenantId, branchId, caseId);
      const found = await this.readCase(tx, tenantId, branchId, caseId);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(REVIEW_PERMISSION)) throw new ForbiddenException("Your role can't resolve offline stock cases");
      if (found.status !== "open") throw new ConflictException("This case is already resolved");
      const open = await tx.offlineStockResolution.findFirst({
        where: { tenantId, branchId, caseId, status: { in: OPEN_PLAN } },
        select: { id: true },
      });
      if (open) throw new ConflictException("A plan is already waiting for this case. Cancel it to prepare another.");
      const lines = await tx.offlineStockDiscrepancyLine.findMany({ where: { tenantId, branchId, caseId } });
      const links = normalizeLinks(kind, input.links, lines.map((line) => line.batchId));
      const sale = await tx.sale.findFirstOrThrow({ where: { tenantId, branchId, id: found.saleId }, select: { soldAt: true } });
      if (links.length) await this.checkLinks(tx, tenantId, branchId, links, lines, sale.soldAt);
      if (kind === "post_now") await this.refuseIfCountedAfterSale(tx, tenantId, branchId, lines.map((line) => line.batchId), sale.soldAt, found.openedAt);
      const row = await tx.offlineStockResolution.create({
        data: {
          id: randomUUID(), tenantId, branchId, caseId, kind,
          links: links as unknown as Prisma.InputJsonArray, note, requestedBy: user.userId,
        },
      });
      await this.audit.log({
        tenantId, branchId, actorUserId: user.userId, eventName: "offline_stock_resolution.prepared",
        entityName: "offline_stock_resolution", entityId: row.id,
        payload: { caseId, saleId: found.saleId, kind, links: links as unknown as Prisma.InputJsonArray, note },
      }, tx);
      // As with refunds: a preparer whose role may approve its own requests approves the exact
      // content they just prepared, recorded as theirs.
      if (actor.canSelfApprove) {
        const facts = (await offlineStockResolutionFacts(tx, row))!;
        await this.approveInTransaction(tx, user, branchId, row.id, {
          approvalId: randomUUID(), expectedVersion: row.approvalVersion,
          expectedDigest: offlineStockResolutionDigest(facts.material),
        });
      }
      return row.id;
    });
    return this.planView(tenantId, branchId, id);
  }

  async approve(user: RequestUser, branchId: string, resolutionId: string, input: ApproveResolutionInput) {
    await this.prisma.$transaction((tx) => this.approveInTransaction(tx, user, branchId, resolutionId, input));
    return this.planView(user.tenantId, branchId, resolutionId);
  }

  /** Exact approval of the plan as it reads now (case, plan and other open cases). Moves nothing. */
  private async approveInTransaction(tx: Tx, user: RequestUser, branchId: string, resolutionId: string, input: ApproveResolutionInput) {
    // Live approve permission, self-approval and the displayed version/digest are checked here,
    // after the case and plan locks.
    const evidence = await this.approvals.issue(tx, user, branchId, ACTION, resolutionId, {
      ...input, reason: "Reviewed the offline stock case and its resolution plan", expiresAt: null,
    });
    const row = await tx.offlineStockResolution.findFirstOrThrow({ where: { tenantId: user.tenantId, branchId, id: resolutionId } });
    if (row.executionApprovalId === evidence.approvalId) return;
    await tx.offlineStockResolution.update({
      where: { id: resolutionId, tenantId: user.tenantId, branchId },
      data: { status: OfflineStockResolutionStatus.approved, approvedBy: evidence.approvedByUserId, approvedAt: new Date(), executionApprovalId: evidence.approvalId },
    });
    await this.audit.log({
      tenantId: user.tenantId, branchId, actorUserId: evidence.approvedByUserId, eventName: "offline_stock_resolution.approved",
      entityName: "offline_stock_resolution", entityId: resolutionId,
      payload: {
        caseId: row.caseId, kind: row.kind, approvalId: evidence.approvalId, documentDigest: evidence.document.documentDigest,
        requestedByUserId: row.requestedBy, approvedByUserId: evidence.approvedByUserId,
        selfApproved: row.requestedBy === evidence.approvedByUserId,
      },
    }, tx);
  }

  async cancel(user: RequestUser, branchId: string, resolutionId: string) {
    const tenantId = user.tenantId;
    await this.prisma.$transaction(async (tx) => {
      if (!(await lockOfflineStockResolution(tx, tenantId, branchId, resolutionId)))
        throw new NotFoundException("Resolution plan not found");
      const row = await this.readPlan(tx, tenantId, branchId, resolutionId);
      if (!OPEN_PLAN.includes(row.status)) throw new BadRequestException("Only a plan still waiting can be cancelled");
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has(REVIEW_PERMISSION)) throw new ForbiddenException("Your role can't resolve offline stock cases");
      await tx.offlineStockResolution.update({
        where: { id: resolutionId, tenantId, branchId },
        data: { status: OfflineStockResolutionStatus.cancelled, cancelledBy: user.userId, cancelledAt: new Date() },
      });
      await this.audit.log({
        tenantId, branchId, actorUserId: user.userId, eventName: "offline_stock_resolution.cancelled",
        entityName: "offline_stock_resolution", entityId: resolutionId, payload: { caseId: row.caseId },
      }, tx);
    });
    return this.planView(tenantId, branchId, resolutionId);
  }

  async planView(tenantId: string, branchId: string, resolutionId: string) {
    const row = await this.prisma.offlineStockResolution.findFirst({
      where: { tenantId, branchId, id: resolutionId },
      include: { case: { select: { status: true } } },
    });
    if (!row) throw new NotFoundException("Resolution plan not found");
    const [plan] = await this.plansView(tenantId, branchId, row.case.status, [row]);
    return plan!;
  }

  /**
   * Approved plans waiting at this branch's counter, with what the counter needs to do them: the
   * batches to count (product, batch number, expiry — never the system quantity, so a count is
   * blind), who asked and who approved. A plan whose approval no longer matches is listed too, so
   * the counter can show why it is refused.
   */
  async readyAtCounter(tenantId: string, branchId: string) {
    const rows = await this.prisma.offlineStockResolution.findMany({
      where: { tenantId, branchId, status: OfflineStockResolutionStatus.approved, case: { tenantId, status: "open" } },
      include: {
        case: {
          include: {
            lines: { orderBy: { batchId: "asc" } },
            sale: { select: { invoiceNo: true, soldAt: true } },
          },
        },
      },
      orderBy: { approvedAt: "desc" },
    });
    if (!rows.length) return [];
    const batchIds = [...new Set(rows.flatMap((r) => r.case.lines.map((l) => l.batchId)))];
    const [batches, approvalRows, people, factsByPlan] = await Promise.all([
      this.prisma.batch.findMany({
        where: { tenantId, branchId, id: { in: batchIds } },
        select: { id: true, batchNo: true, expiryDate: true, product: { select: { name: true, sku: true } } },
      }),
      this.prisma.managementApproval.findMany({
        where: { tenantId, branchId, id: { in: rows.map((r) => r.executionApprovalId!).filter(Boolean) } },
        select: { id: true, documentVersion: true, documentDigest: true, revokedAt: true, approvedAt: true, approvedByUserId: true },
      }),
      this.names(tenantId, rows.flatMap((r) => [r.requestedBy, r.approvedBy])),
      offlineStockResolutionFactsFor(this.prisma, rows),
    ]);
    const out = [];
    for (const row of rows) {
      const facts = factsByPlan.get(row.id);
      if (!facts) continue;
      const evidence = approvalRows.find((a) => a.id === row.executionApprovalId);
      const digest = offlineStockResolutionDigest(facts.material);
      const state = !evidence ? "revoked" : evidence.revokedAt ? "revoked"
        : evidence.documentDigest === digest && evidence.documentVersion === row.approvalVersion ? "matches" : "changed";
      out.push({
        resolutionId: row.id,
        caseId: row.caseId,
        invoiceNo: row.case.sale.invoiceNo,
        soldAt: row.case.sale.soldAt.toISOString(),
        kind: row.kind,
        note: row.note,
        links: row.links as unknown as SettlementLink[],
        approvalEvidenceId: row.executionApprovalId,
        approvalVersion: row.approvalVersion,
        approvalState: state,
        requestedBy: people.get(row.requestedBy) ?? null,
        requestedAt: row.requestedAt.toISOString(),
        approvedBy: row.approvedBy ? people.get(row.approvedBy) ?? null : null,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        // What changed when the approval no longer matches: another case now holds a batch.
        otherOpenCases: facts.otherOpenCases.length,
        lines: row.case.lines.map((line) => {
          const batch = batches.find((b) => b.id === line.batchId);
          return {
            batchId: line.batchId,
            productName: batch?.product.name ?? "",
            sku: batch?.product.sku ?? null,
            batchNo: batch?.batchNo ?? "",
            expiryDate: batch?.expiryDate.toISOString().slice(0, 10) ?? null,
            soldQuantity: line.soldQuantity,
          };
        }),
      });
    }
    return out;
  }

  // ── Execution at the counter (signed command only) ──────────────────────────────────────────

  /**
   * In the executor's READ COMMITTED transaction, after it verified the signed command and the
   * exact approval: posts or links the sale's stock once, records a settlement per batch, sets
   * the sale to posted, closes the case and releases its own batch blocks, and audits requester,
   * approver and executor separately. A batch another open case holds stays blocked.
   */
  async executeInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    resolutionId: string,
    input: { approvalId: string; counts: ReadonlyArray<Readonly<{ batchId: string; countedQty: number }>> },
    command?: CommandProvenance,
  ): Promise<ExecuteResult> {
    const tenantId = user.tenantId;
    const binding = await lockOfflineStockResolution(tx, tenantId, branchId, resolutionId);
    if (!binding) throw new NotFoundException("Resolution plan not found");
    const found = await this.readCase(tx, tenantId, branchId, binding.caseId);
    const plan = await this.readPlan(tx, tenantId, branchId, resolutionId);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has(EXECUTE_PERMISSION))
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Your role can't correct stock at this counter" });
    if (plan.executionApprovalId !== input.approvalId)
      throw new ConflictException("Approval changed; refresh and review before resolving");
    // An executed plan is final: a retry of the same command is answered from its receipt before
    // this runs, and any other command is refused here (as the executor's approval check does).
    if (plan.status !== OfflineStockResolutionStatus.approved) denied("APPROVAL_INVALID");
    if (found.status !== "open") denied("APPROVAL_INVALID");

    const lines = await tx.offlineStockDiscrepancyLine.findMany({ where: { tenantId, branchId, caseId: found.id }, orderBy: { batchId: "asc" } });
    const batchIds = lines.map((line) => line.batchId);
    const kind = plan.kind as OfflineStockResolutionKind;
    const counts = checkCounts(kind, input.counts, batchIds);
    const sale = await tx.sale.findFirstOrThrow({
      where: { tenantId, branchId, id: found.saleId },
      include: { items: { select: { productId: true, batchId: true, qty: true } } },
    });
    if (sale.stockPosting !== SaleStockPosting.pending_reconciliation) denied("APPROVAL_INVALID");

    // Lock the case's batches, then re-check the exact approval: a sync opening another case on
    // one of these batches needs the same locks, so the approved content cannot move after this.
    await this.stock.lockBatches(tx, tenantId, batchIds);
    const evidence = await this.approvals.requireForExecution(tx, user, branchId, ACTION, resolutionId, input.approvalId);

    const balances = await this.stock.balances(tx, tenantId, batchIds);
    const pendingRows = await tx.offlineStockDiscrepancyLine.findMany({
      where: { tenantId, branchId, batchId: { in: batchIds }, case: { tenantId, status: "open" } },
      select: { batchId: true, caseId: true, soldQuantity: true },
    });
    const pendingOn = (batchId: string) => pendingRows.filter((p) => p.batchId === batchId).reduce((sum, p) => sum + p.soldQuantity, 0);
    const heldElsewhere = new Set(pendingRows.filter((p) => p.caseId !== found.id).map((p) => p.batchId));
    const snapshot = await tx.offlineStockSnapshot.findFirst({ where: { tenantId, branchId, id: found.snapshotId }, select: { generatedAt: true } });
    // Every row since the snapshot: the settlement's digest covers the whole ledger it settles.
    const { rows: timeline } = await this.timeline(tx, tenantId, branchId, batchIds, snapshot?.generatedAt ?? found.openedAt);
    const now = new Date();
    const links = plan.links as unknown as SettlementLink[];
    const linkAllocations = kind === "link_existing_settlement"
      ? await this.checkLinks(tx, tenantId, branchId, links, lines, sale.soldAt)
      : new Map<string, Array<{ ledgerEntryId: string; quantity: number }>>();
    // Under the batch locks: a stocktake posted since approval may have taken the units off already.
    if (kind === "post_now") await this.refuseIfCountedAfterSale(tx, tenantId, branchId, batchIds, sale.soldAt, found.openedAt);

    const saleCtx = { tenantId, branchId, userId: sale.soldBy, referenceType: "sale", referenceId: sale.id, occurredAt: sale.soldAt };
    const correctionCtx = { tenantId, branchId, userId: user.userId, referenceType: RESOLUTION_REFERENCE, referenceId: resolutionId, occurredAt: now };
    const batchResults: BatchResult[] = [];
    const settlements: Prisma.OfflineStockSettlementCreateManyInput[] = [];
    try {
      if (kind === "count_and_correct") {
        const gains = [];
        const losses: IssueLine[] = [];
        for (const line of lines) {
          const balance = balances.get(line.batchId);
          const onHandBefore = balance?.onHand ?? 0;
          const countedQty = counts.get(line.batchId)!;
          const { target, correctionQty } = countCorrection({ countedQty, pendingOnBatch: pendingOn(line.batchId), onHandBefore });
          const reason = `Counted ${countedQty} at the counter for offline sale ${sale.invoiceNo}`;
          // The count includes held units: held units it leaves no room for come off quarantine,
          // and the sale's own units are sellable when it posts.
          const { sellableDelta, quarantineDelta } = correctionBuckets({
            target, onHand: onHandBefore, quarantined: balance?.quarantined ?? 0, soldQuantity: line.soldQuantity,
          });
          const movement = { productId: line.productId, batchId: line.batchId, reason };
          if (sellableDelta > 0) gains.push({ ...movement, qty: sellableDelta, movementType: StockMovementType.adjustment_in });
          if (sellableDelta < 0) losses.push({ ...movement, qty: -sellableDelta, movementType: StockMovementType.adjustment_out, from: "sellable" });
          if (quarantineDelta < 0) losses.push({ ...movement, qty: -quarantineDelta, movementType: StockMovementType.adjustment_out, from: "quarantine" });
          settlements.push(this.settlement(found, plan, line, {
            method: "counted", onHandBefore, pendingOnBatch: pendingOn(line.batchId), countedQuantity: countedQty, countedAt: now,
            countedBy: user.userId, correctionQuantity: correctionQty, postedQuantity: line.soldQuantity,
          }, timeline, evidence.approvalId, command));
          batchResults.push({ batchId: line.batchId, method: "counted", soldQty: line.soldQuantity, countedQty, correctionQty, postedQty: line.soldQuantity, stillBlocked: heldElsewhere.has(line.batchId) });
        }
        await this.stock.receive(tx, correctionCtx, gains);
        await this.stock.issue(tx, correctionCtx, losses);
      }
      if (kind === "post_now" || kind === "count_and_correct") {
        await this.stock.issue(tx, saleCtx, sale.items.map((item) => ({
          productId: item.productId, batchId: item.batchId, qty: item.qty, movementType: StockMovementType.sale_out, from: "sellable" as const,
        })));
      }
    } catch (error) {
      if (error instanceof InsufficientStockException)
        throw new ConflictException({
          code: "STOCK_NOT_COVERED",
          message: kind === "post_now"
            ? "Stock no longer covers this sale. Count the batches instead, or resolve the case another way."
            : "After the count, units reserved for transfers leave too little to post this sale. Cancel or ship those transfers first.",
        });
      throw error;
    }
    if (kind === "post_now") {
      for (const line of lines) {
        settlements.push(this.settlement(found, plan, line, {
          method: "posted", onHandBefore: balances.get(line.batchId)?.onHand ?? 0, pendingOnBatch: pendingOn(line.batchId),
          postedQuantity: line.soldQuantity,
        }, timeline, evidence.approvalId, command));
        batchResults.push({ batchId: line.batchId, method: "posted", soldQty: line.soldQuantity, countedQty: null, correctionQty: 0, postedQty: line.soldQuantity, stillBlocked: heldElsewhere.has(line.batchId) });
      }
    }
    const linkRows: Prisma.OfflineStockSettlementLinkCreateManyInput[] = [];
    if (kind === "link_existing_settlement") {
      for (const line of lines) {
        const link = links.find((l) => l.batchId === line.batchId)!;
        const stocktakeLine = link.source === "stocktake"
          ? await tx.stocktakeLine.findFirstOrThrow({ where: { tenantId, stocktakeId: link.stocktakeId, batchId: line.batchId }, select: { id: true } })
          : null;
        const row = this.settlement(found, plan, line, {
          method: "linked", onHandBefore: balances.get(line.batchId)?.onHand ?? 0, pendingOnBatch: pendingOn(line.batchId), postedQuantity: 0,
          linkedStocktakeId: link.source === "stocktake" ? link.stocktakeId : null, linkedStocktakeLineId: stocktakeLine?.id ?? null,
        }, timeline, evidence.approvalId, command);
        settlements.push(row);
        for (const allocation of linkAllocations.get(line.batchId) ?? [])
          linkRows.push({ id: randomUUID(), tenantId, branchId, settlementId: row.id as string, batchId: line.batchId, ...allocation });
        batchResults.push({ batchId: line.batchId, method: "linked", soldQty: line.soldQuantity, countedQty: null, correctionQty: 0, postedQty: 0, stillBlocked: heldElsewhere.has(line.batchId) });
      }
    }

    await tx.offlineStockSettlement.createMany({ data: settlements });
    if (linkRows.length) await tx.offlineStockSettlementLink.createMany({ data: linkRows });
    const posted = await tx.sale.updateMany({
      where: { tenantId, branchId, id: sale.id, stockPosting: SaleStockPosting.pending_reconciliation },
      data: { stockPosting: SaleStockPosting.posted },
    });
    if (posted.count !== 1) throw new ConflictException("This sale's stock was already posted");
    await tx.offlineStockDiscrepancy.update({
      where: { id: found.id, tenantId, branchId },
      data: { status: OfflineStockDiscrepancyStatus.resolved, resolvedAt: now },
    });
    // This case's own blocks only: another open case on the same batch keeps its block.
    await tx.batchSaleBlock.updateMany({
      where: { tenantId, branchId, caseId: found.id, releasedAt: null },
      data: { releasedAt: now },
    });
    const result: ExecuteResult = {
      type: "offline_stock_case.resolved",
      resolutionId,
      caseId: found.id,
      saleId: sale.id,
      approvalId: evidence.approvalId,
      kind,
      effect: "applied",
      batches: batchResults,
    };
    await tx.offlineStockResolution.update({
      where: { id: resolutionId, tenantId, branchId },
      data: {
        status: OfflineStockResolutionStatus.executed, executedBy: user.userId, executedAt: now,
        executionCommandId: command?.commandId ?? null, result: result as unknown as Prisma.InputJsonObject,
      },
    });
    await this.audit.log({
      tenantId, branchId, actorUserId: user.userId, eventName: "offline_stock_discrepancy.resolved",
      entityName: "offline_stock_discrepancy", entityId: found.id,
      payload: {
        resolutionId, saleId: sale.id, invoiceNo: sale.invoiceNo, kind, approvalId: evidence.approvalId,
        documentDigest: evidence.document.documentDigest,
        requestedByUserId: evidence.document.requestedByUserId, approvedByUserId: evidence.approvedByUserId,
        executedByUserId: user.userId,
        batches: batchResults as unknown as Prisma.InputJsonArray,
        ...(command ? { command } : {}),
      },
    }, tx);
    return result;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────

  private settlement(
    found: { id: string; tenantId: string; branchId: string },
    plan: OfflineStockResolution,
    line: { batchId: string; productId: string; soldQuantity: number },
    fields: Partial<Prisma.OfflineStockSettlementCreateManyInput> & Pick<Prisma.OfflineStockSettlementCreateManyInput, "method" | "onHandBefore" | "pendingOnBatch" | "postedQuantity">,
    timeline: TimelineRow[],
    approvalId: string,
    command: CommandProvenance | undefined,
  ): Prisma.OfflineStockSettlementCreateManyInput {
    return {
      id: randomUUID(),
      tenantId: found.tenantId,
      branchId: found.branchId,
      caseId: found.id,
      resolutionId: plan.id,
      batchId: line.batchId,
      productId: line.productId,
      soldQuantity: line.soldQuantity,
      stockTimelineDigest: timelineDigest(line.batchId, timeline.filter((e) => e.batchId === line.batchId).map(toTimelineEntry)),
      approvalId,
      executionCommandId: command?.commandId ?? null,
      ...fields,
    };
  }

  /**
   * Every link must already have accounted for its batch's sold units: a posted stocktake whose
   * count of the batch was taken after the offline sale (the count already reflects the units),
   * or write-off / correction movements on the batch after the sale with enough unclaimed units.
   * Returns the movement allocations to record. Read under the batch locks at execution.
   */
  private async checkLinks(
    tx: Tx,
    tenantId: string,
    branchId: string,
    links: readonly SettlementLink[],
    lines: ReadonlyArray<{ batchId: string; soldQuantity: number }>,
    soldAt: Date,
  ) {
    const allocations = new Map<string, Array<{ ledgerEntryId: string; quantity: number }>>();
    for (const link of links) {
      const line = lines.find((l) => l.batchId === link.batchId);
      if (!line) throw new ConflictException("A link names a batch that is not in this case");
      if (link.source === "stocktake") {
        const counted = await tx.stocktakeLine.findFirst({
          where: { tenantId, stocktakeId: link.stocktakeId, batchId: link.batchId, stocktake: { tenantId, branchId, status: { in: POSTED_STOCKTAKE } } },
          select: { countedAt: true, postedAt: true },
        });
        if (!counted?.postedAt || !counted.countedAt)
          throw new ConflictException({ code: "SETTLEMENT_NOT_LINKABLE", message: "That stocktake did not post a count of this batch" });
        if (counted.countedAt <= soldAt)
          throw new ConflictException({ code: "SETTLEMENT_NOT_LINKABLE", message: "That stocktake counted the batch before the offline sale, so its count does not include the sold units" });
        continue;
      }
      const capacities = await this.movementCapacities(tx, tenantId, branchId, [link.batchId], soldAt, link.ledgerEntryIds);
      const ordered = link.ledgerEntryIds.map((id) => capacities.find((c) => c.ledgerEntryId === id));
      if (ordered.some((c) => !c))
        throw new ConflictException({ code: "SETTLEMENT_NOT_LINKABLE", message: "A linked movement is not a write-off or correction of this batch after the offline sale" });
      const allocation = allocateMovementLinks(line.soldQuantity, ordered.map((c) => ({ ledgerEntryId: c!.ledgerEntryId, remaining: c!.remaining })));
      if (!allocation)
        throw new ConflictException({ code: "SETTLEMENT_NOT_LINKABLE", message: "The linked movements do not account for every sold unit (some are already linked to another case)" });
      allocations.set(link.batchId, allocation);
    }
    return allocations;
  }

  /**
   * Post a sale's units only if nothing counted one of its batches after the sale and so already
   * took them off (`countsAfterSale`): a posted stocktake, or another case's count made before
   * this case opened. Posting would deduct them twice.
   */
  private async refuseIfCountedAfterSale(tx: Tx, tenantId: string, branchId: string, batchIds: string[], soldAt: Date, caseOpenedAt: Date) {
    const [counted] = await countsAfterSale(tx, { tenantId, branchId }, batchIds, soldAt, caseOpenedAt);
    if (!counted) return;
    throw new ConflictException({
      code: "SETTLEMENT_ALREADY_COUNTED",
      message: counted.source === "stocktake"
        ? `Stocktake ${counted.stocktakeNumber} counted a batch of this sale after it was made, so its units are already off. Link that stocktake or count the batches instead.`
        : "Another offline stock case counted a batch of this sale after it was made, so its units are already off. Count the batches instead.",
    });
  }

  /**
   * Write-off / correction movements on the batches after the sale, with their unclaimed units,
   * latest first. Another case's count correction is never one (see LINKABLE_MOVEMENTS).
   */
  private async movementCapacities(db: Tx, tenantId: string, branchId: string, batchIds: string[], after: Date, ids?: readonly string[]) {
    const rows = await db.stockLedger.findMany({
      where: {
        tenantId, branchId, batchId: { in: batchIds }, movementType: { in: LINKABLE_MOVEMENTS }, qtyDelta: { lt: 0 },
        referenceType: { not: RESOLUTION_REFERENCE },
        occurredAt: { gt: after }, ...(ids ? { id: { in: [...ids] } } : {}),
      },
      select: { id: true, batchId: true, qtyDelta: true, occurredAt: true, reason: true },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: MOVEMENT_CANDIDATE_LIMIT,
    });
    if (!rows.length) return [];
    const claimed = await db.offlineStockSettlementLink.groupBy({
      by: ["ledgerEntryId"],
      where: { tenantId, ledgerEntryId: { in: rows.map((r) => r.id) } },
      _sum: { quantity: true },
    });
    return rows.map((row) => {
      const used = claimed.find((c) => c.ledgerEntryId === row.id)?._sum.quantity ?? 0;
      return { ledgerEntryId: row.id, batchId: row.batchId!, qty: -row.qtyDelta, remaining: -row.qtyDelta - used, occurredAt: row.occurredAt, reason: row.reason };
    });
  }

  /**
   * Each batch's ledger since `since`, oldest first. With `limitPerBatch`, only each batch's
   * latest rows, and which batches had more (`truncated`); without, every row.
   */
  private async timeline(
    db: Tx,
    tenantId: string,
    branchId: string,
    batchIds: string[],
    since: Date,
    limitPerBatch?: number,
  ): Promise<{ rows: TimelineRow[]; truncated: Set<string> }> {
    const select = {
      id: true, batchId: true, occurredAt: true, movementType: true, bucket: true, qtyDelta: true,
      referenceType: true, referenceId: true, reason: true, createdBy: true,
    } as const;
    const truncated = new Set<string>();
    if (limitPerBatch === undefined) {
      const rows = await db.stockLedger.findMany({
        where: { tenantId, branchId, batchId: { in: batchIds }, occurredAt: { gte: since } },
        select,
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      });
      return { rows, truncated };
    }
    const perBatch = await Promise.all(batchIds.map((batchId) => db.stockLedger.findMany({
      where: { tenantId, branchId, batchId, occurredAt: { gte: since } },
      select,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limitPerBatch + 1,
    })));
    const rows = perBatch.flatMap((list, i) => {
      if (list.length > limitPerBatch) truncated.add(batchIds[i]!);
      return list.slice(0, limitPerBatch).reverse();
    });
    return { rows, truncated };
  }

  /** Invoice numbers, stocktake and transfer numbers for the references a timeline shows. */
  private async referenceLabels(tenantId: string, branchId: string, timeline: TimelineRow[]) {
    const ids = (type: string) => [...new Set(timeline.filter((e) => e.referenceType === type).map((e) => e.referenceId))];
    const [sales, stocktakes, transfers] = await Promise.all([
      this.prisma.sale.findMany({ where: { tenantId, branchId, id: { in: ids("sale") } }, select: { id: true, invoiceNo: true, offlineCommandId: true } }),
      this.prisma.stocktake.findMany({ where: { tenantId, branchId, id: { in: ids("stocktake") } }, select: { id: true, stocktakeNumber: true } }),
      this.prisma.transfer.findMany({ where: { tenantId, id: { in: ids("transfer") } }, select: { id: true, transferNumber: true } }),
    ]);
    const labels = new Map<string, string>();
    for (const s of sales) labels.set(`sale:${s.id}`, `${s.invoiceNo}${s.offlineCommandId ? " (offline)" : ""}`);
    for (const s of stocktakes) labels.set(`stocktake:${s.id}`, s.stocktakeNumber);
    for (const t of transfers) labels.set(`transfer:${t.id}`, t.transferNumber);
    return labels;
  }

  /** Read after lockOfflineStockCase / lockOfflineStockResolution. */
  private async readCase(tx: Tx, tenantId: string, branchId: string, caseId: string) {
    const found = await tx.offlineStockDiscrepancy.findFirst({ where: { tenantId, branchId, id: caseId } });
    if (!found) throw new NotFoundException("Stock case not found");
    return found;
  }

  private async readPlan(tx: Tx, tenantId: string, branchId: string, resolutionId: string) {
    const row = await tx.offlineStockResolution.findFirst({ where: { tenantId, branchId, id: resolutionId } });
    if (!row) throw new NotFoundException("Resolution plan not found");
    return row;
  }

  private async names(tenantId: string, ids: ReadonlyArray<string | null | undefined>) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (!wanted.length) return new Map<string, string>();
    const users = await this.prisma.appUser.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true, fullName: true } });
    return new Map(users.map((u) => [u.id, u.fullName]));
  }

  private async terminalLabels(tenantId: string, branchId: string, ids: string[]) {
    const rows = await this.prisma.operationalTerminal.findMany({
      where: { tenantId, branchId, id: { in: [...new Set(ids)] } },
      select: { id: true, label: true, counter: { select: { label: true } } },
    });
    return new Map(rows.map((r) => [r.id, r.counter?.label ?? r.label]));
  }
}

type TimelineRow = {
  id: string; batchId: string | null; occurredAt: Date; movementType: StockMovementType; bucket: string; qtyDelta: number;
  referenceType: string; referenceId: string; reason: string | null; createdBy: string | null;
};
const toTimelineEntry = (e: TimelineRow): TimelineEntry => ({
  id: e.id,
  occurredAt: e.occurredAt.toISOString(),
  movementType: e.movementType,
  bucket: e.bucket,
  qtyDelta: e.qtyDelta,
  referenceType: e.referenceType,
  referenceId: e.referenceId,
});
