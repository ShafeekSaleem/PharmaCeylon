import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  PaymentMethod,
  Prisma,
  SaleRefundRequestStatus,
  type SaleRefundRequest,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { meetsApprovalThreshold } from "../common/approval-threshold.util";
import { nextTenantDocumentNumber } from "../common/document-sequence.util";
import { IDEMPOTENCY_SCOPE } from "../common/idempotency.constants";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../common/idempotency.util";
import { StockService } from "../inventory/stock/stock.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessService } from "../security/access.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../security/management-approvals.service";
import { saleRefundApprovalReview } from "../security/sale-refund-approval-material";
import type { CommandProvenance } from "../terminals/command-provenance";
import { denied } from "../terminals/terminal-wire";
import type { RefundDisposition } from "./dto/refund-sale.dto";
import type {
  ApproveSaleRefundDto,
  ExecuteSaleRefundDto,
  ListSaleRefundRequestsQueryDto,
  PrepareSaleRefundDto,
} from "./dto/refund-request.dto";
import { refundReason, SalesService, type RefundPlan } from "./sales.service";

type Tx = Prisma.TransactionClient;
/** One prepared line, priced at what the customer paid (stored as text, LKR). */
type StoredRefundLine = {
  productId: string;
  batchId: string;
  qty: number;
  unitPrice: string;
  disposition: RefundDisposition;
};
const OPEN: SaleRefundRequestStatus[] = [SaleRefundRequestStatus.prepared, SaleRefundRequestStatus.approved];

const storedLines = (row: Pick<SaleRefundRequest, "lines">) => row.lines as unknown as StoredRefundLine[];
const toStored = (plan: RefundPlan): StoredRefundLine[] =>
  plan.requested.map((line) => ({
    productId: line.productId,
    batchId: line.batchId,
    qty: line.qty,
    unitPrice: line.unitPrice.toFixed(2),
    disposition: line.disposition,
  }));

/**
 * Remote refunds (D10, W4 Phase D): a manager prepares a refund from the sale — lines, amount,
 * original-sale limits — and, over the tenant's threshold, someone who approves returns
 * authorizes the exact content. Neither moves stock or money. The refund is executed at the
 * counter as a separate post (`executeInTransaction`), which the browser route and the signed
 * terminal command share, through the same lock/plan/apply steps as a till refund. A request
 * executes once: retries replay, and a distinct second attempt finds it executed.
 */
@Injectable()
export class RefundRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
    private readonly sales: SalesService,
    private readonly stock: StockService,
  ) {}

  async prepare(user: RequestUser, branchId: string, saleId: string, dto: PrepareSaleRefundDto) {
    const tenantId = user.tenantId;
    const reason = refundReason(dto);
    const id = await this.prisma.$transaction(async (tx) => {
      const sale = await this.sales.lockSaleForRefund(tx, tenantId, branchId, saleId);
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("sales.refund")) throw new ForbiddenException("Your role can't refund sales");
      this.assertControlledAuthority(actor, sale);
      // The sale row is locked, so this check and the insert serialize per sale.
      const open = await tx.saleRefundRequest.findFirst({
        where: { tenantId, branchId, saleId, status: { in: OPEN } },
        select: { requestNumber: true },
      });
      if (open) {
        throw new ConflictException(
          `Refund ${open.requestNumber} is already waiting for this sale. Cancel it to prepare another.`,
        );
      }
      const plan = await this.sales.planRefund(tx, tenantId, branchId, sale, dto.items);
      if (dto.refundAmount != null && dto.refundAmount.trim() !== "") {
        if (!new Prisma.Decimal(dto.refundAmount).eq(plan.refundTotal)) {
          throw new BadRequestException(
            `Refund amount must equal ${plan.refundTotal.toFixed(2)} for the selected lines`,
          );
        }
      }
      const threshold = await this.sales.refundApprovalThreshold(tx, tenantId);
      const approvalRequired = meetsApprovalThreshold(plan.refundTotal, threshold);
      const requestNumber = await nextTenantDocumentNumber(tx, tenantId, "sale_refund_request", "RFR-");
      let created: SaleRefundRequest;
      try {
        created = await tx.saleRefundRequest.create({
          data: {
            id: randomUUID(),
            tenantId,
            branchId,
            saleId,
            requestNumber,
            lines: toStored(plan) as unknown as Prisma.InputJsonArray,
            amount: plan.refundTotal,
            refundMethod: dto.refundMethod ?? null,
            reasonCode: dto.reasonCode ?? null,
            reason,
            approvalRequired,
            requestedBy: user.userId,
          },
        });
      } catch (error) {
        if (isPrismaUniqueFieldError(error, "sale")) {
          throw new ConflictException("A refund is already waiting for this sale. Cancel it to prepare another.");
        }
        throw error;
      }
      await this.audit.log({
        tenantId, branchId, actorUserId: user.userId, eventName: "sale.refund_prepared",
        entityName: "sale_refund_request", entityId: created.id,
        payload: { saleId, requestNumber, amount: plan.refundTotal.toFixed(2), approvalRequired,
          refundMethod: created.refundMethod, reasonCode: created.reasonCode },
      }, tx);

      // Over the threshold, a preparer whose role may approve its own requests approves the
      // exact content they just prepared, recorded as theirs — as at the till.
      if (approvalRequired && actor.has("returns.approve") && actor.canSelfApprove) {
        const review = saleRefundApprovalReview(created);
        await this.approveInTransaction(tx, user, branchId, created.id, { approvalId: randomUUID(), ...review });
      }
      return created.id;
    });
    return this.getOne(tenantId, branchId, id);
  }

  async approve(user: RequestUser, branchId: string, id: string, dto: ApproveSaleRefundDto) {
    await this.prisma.$transaction((tx) => this.approveInTransaction(tx, user, branchId, id, dto));
    return this.getOne(user.tenantId, branchId, id);
  }

  /** Exact approval of the prepared content. Never refunds anything. */
  private async approveInTransaction(tx: Tx, user: RequestUser, branchId: string, id: string, dto: ApproveSaleRefundDto) {
    const row = await this.lock(tx, user.tenantId, branchId, id);
    if (!OPEN.includes(row.status)) throw new BadRequestException("This refund is no longer waiting for approval");
    // Live approve permission, self-approval and the displayed version/digest are checked here.
    const evidence = await this.approvals.issue(tx, user, branchId, "sale_refund.execute", id, {
      ...dto, reason: "Reviewed refund lines and amount", expiresAt: null,
    });
    if (row.executionApprovalId === evidence.approvalId) return;
    await tx.saleRefundRequest.update({
      where: { id, tenantId: user.tenantId, branchId },
      data: {
        status: SaleRefundRequestStatus.approved,
        approvedBy: user.userId,
        approvedAt: new Date(),
        executionApprovalId: evidence.approvalId,
      },
    });
    await this.audit.log({
      tenantId: user.tenantId, branchId, actorUserId: user.userId, eventName: "sale.refund_approved",
      entityName: "sale_refund_request", entityId: id,
      payload: { saleId: row.saleId, approvalId: evidence.approvalId, amount: row.amount.toFixed(2),
        requestedByUserId: row.requestedBy, approvedByUserId: user.userId,
        selfApproved: row.requestedBy === user.userId },
    }, tx);
  }

  async cancel(user: RequestUser, branchId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      if (!OPEN.includes(row.status)) throw new BadRequestException("Only a refund still waiting can be cancelled");
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (row.requestedBy !== user.userId && !actor.has("returns.approve")) {
        throw new ForbiddenException("Only the person who prepared this refund, or an approver, can cancel it");
      }
      await tx.saleRefundRequest.update({
        where: { id, tenantId: user.tenantId, branchId },
        data: { status: SaleRefundRequestStatus.cancelled, cancelledBy: user.userId, cancelledAt: new Date() },
      });
      await this.audit.log({
        tenantId: user.tenantId, branchId, actorUserId: user.userId, eventName: "sale.refund_cancelled",
        entityName: "sale_refund_request", entityId: id, payload: { saleId: row.saleId },
      }, tx);
    });
    return this.getOne(user.tenantId, branchId, id);
  }

  /** Browser execution: the same core as the signed counter command, keyed by Idempotency-Key. */
  async execute(user: RequestUser, branchId: string, id: string, dto: ExecuteSaleRefundDto, idempotencyKeyRaw?: string) {
    const tenantId = user.tenantId;
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const prior = await this.prisma.idempotencyRecord.findUnique({
        where: { tenantId_userId_scope_idempotencyKey: {
          tenantId, userId: user.userId, scope: IDEMPOTENCY_SCOPE.saleRefundExecute, idempotencyKey: idemKey,
        } },
      });
      if (prior) {
        if (prior.resourceId !== id) throw new BadRequestException("Idempotency-Key already used for a different refund");
        return this.getOne(tenantId, branchId, id);
      }
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.executeInTransaction(tx, user, branchId, id, { approvalId: dto.approvalId ?? null });
        if (idemKey) {
          await tx.idempotencyRecord.create({ data: {
            tenantId, userId: user.userId, scope: IDEMPOTENCY_SCOPE.saleRefundExecute, idempotencyKey: idemKey, resourceId: id,
          } });
        }
      });
    } catch (error) {
      if (idemKey && isPrismaUniqueFieldError(error, "idempotency")) return this.getOne(tenantId, branchId, id);
      throw error;
    }
    return this.getOne(tenantId, branchId, id);
  }

  /**
   * Whether this request executes with no approval: prepared under the threshold and still under
   * it. One already executed without approval stays waived, so a later distinct command reaches
   * the domain and reports `already_applied` instead of asking for an approval.
   */
  async executionApprovalWaived(tx: Tx, tenantId: string, branchId: string, id: string) {
    const row = await tx.saleRefundRequest.findFirst({
      where: { tenantId, branchId, id },
      select: { status: true, approvalRequired: true, executionApprovalId: true, amount: true },
    });
    if (!row || row.executionApprovalId) return false;
    if (row.status === SaleRefundRequestStatus.executed) return true;
    if (row.status !== SaleRefundRequestStatus.prepared) return false;
    return !(await this.needsApproval(tx, tenantId, row));
  }

  /** Whether executing this request pays cash out of the drawer (for classification). */
  async cashMovement(tx: Tx, tenantId: string, branchId: string, id: string) {
    const row = await tx.saleRefundRequest.findFirst({ where: { tenantId, branchId, id } });
    if (!row) throw new NotFoundException("Refund request not found");
    if (row.refundMethod) return row.refundMethod === PaymentMethod.cash;
    const sale = await tx.sale.findFirst({
      where: { tenantId, branchId, id: row.saleId },
      include: { payments: { select: { method: true, amount: true } } },
    });
    if (!sale) throw new NotFoundException("Sale not found");
    return this.sales.refundSplit(sale, row.amount, null).some((part) => part.method === PaymentMethod.cash);
  }

  /**
   * Execution core, in the caller's READ COMMITTED transaction. Lock order: sale, then request
   * (approval resolution relocks the request). `approvalId` pins the approval the counter saw
   * (null where none applies); `command` is verified provenance for the success audit.
   */
  async executeInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    id: string,
    input: { approvalId: string | null },
    command?: CommandProvenance,
  ) {
    const tenantId = user.tenantId;
    const binding = await tx.saleRefundRequest.findFirst({ where: { tenantId, branchId, id }, select: { saleId: true } });
    if (!binding) throw new NotFoundException("Refund request not found");
    const sale = await this.sales.lockSaleForRefund(tx, tenantId, branchId, binding.saleId);
    const row = await this.lock(tx, tenantId, branchId, id);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has("sales.refund")) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Your role can't refund sales" });
    }
    if ((row.executionApprovalId ?? null) !== input.approvalId) {
      throw new ConflictException("Approval changed; refresh and review before refunding");
    }
    if (row.status === SaleRefundRequestStatus.executed) {
      return { changed: false, row, goodsReturnId: row.goodsReturnId!, refundedTo: [] as Array<{ method: PaymentMethod; amount: string }> };
    }
    if (!OPEN.includes(row.status)) throw new BadRequestException("This refund was cancelled");
    if (!row.executionApprovalId && (await this.needsApproval(tx, tenantId, row))) denied("APPROVAL_REQUIRED");
    this.assertControlledAuthority(actor, sale);

    // The original-sale limit, re-checked under the sale lock: what was prepared must still be
    // returnable at the same price, or nothing happens.
    const lines = storedLines(row);
    const plan = await this.sales.planRefund(tx, tenantId, branchId, sale, lines);
    if (!plan.refundTotal.eq(row.amount) ||
        plan.requested.some((line, i) => line.unitPrice.toFixed(2) !== lines[i]!.unitPrice)) {
      throw new ConflictException("This sale changed since the refund was prepared; prepare it again");
    }
    // Lock stock before the final approval check, including after a lock wait.
    await this.stock.lockBatches(tx, tenantId, lines.map((line) => line.batchId));
    const evidence = row.executionApprovalId
      ? await this.approvals.requireForExecution(tx, user, branchId, "sale_refund.execute", id, row.executionApprovalId)
      : null;

    const applied = await this.sales.applyRefund(tx, {
      tenantId,
      branchId,
      executorUserId: user.userId,
      requestedBy: row.requestedBy,
      // Under the threshold nobody approved it: record no approver, and the audit says waived.
      approvedBy: evidence?.approvedByUserId ?? null,
      sale,
      plan,
      reason: row.reason,
      reasonCode: row.reasonCode,
      refundMethod: row.refundMethod,
      refundRequest: { id, approvalId: evidence?.approvalId ?? null, command },
    });
    const executed = await tx.saleRefundRequest.update({
      where: { id, tenantId, branchId },
      data: {
        status: SaleRefundRequestStatus.executed,
        executedBy: user.userId,
        executedAt: new Date(),
        goodsReturnId: applied.goodsReturnId,
      },
    });
    return {
      changed: true,
      row: executed,
      goodsReturnId: applied.goodsReturnId,
      refundedTo: applied.refundSplit.map((part) => ({ method: part.method, amount: part.amount.toFixed(2) })),
    };
  }

  async list(tenantId: string, branchId: string, query: ListSaleRefundRequestsQueryDto) {
    const rows = await this.prisma.saleRefundRequest.findMany({
      where: { tenantId, branchId, ...(query.saleId ? { saleId: query.saleId } : {}),
        ...(query.status ? { status: query.status } : {}) },
      orderBy: { requestedAt: "desc" },
      take: 200,
    });
    return this.view(tenantId, branchId, rows);
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.saleRefundRequest.findFirst({ where: { tenantId, branchId, id } });
    if (!row) throw new NotFoundException("Refund request not found");
    const [viewed] = await this.view(tenantId, branchId, [row]);
    return viewed!;
  }

  private async view(tenantId: string, branchId: string, rows: SaleRefundRequest[]) {
    if (!rows.length) return [];
    const userIds = [...new Set(rows.flatMap((row) => [row.requestedBy, row.approvedBy, row.executedBy, row.cancelledBy])
      .filter((value): value is string => !!value))];
    const [people, sales, threshold, evidence] = await Promise.all([
      this.prisma.appUser.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, fullName: true } }),
      this.prisma.sale.findMany({ where: { tenantId, branchId, id: { in: rows.map((row) => row.saleId) } },
        select: { id: true, invoiceNo: true } }),
      this.sales.refundApprovalThreshold(this.prisma, tenantId),
      this.prisma.managementApproval.findMany({
        where: { tenantId, id: { in: rows.map((row) => row.executionApprovalId).filter((v): v is string => !!v) } },
        select: { id: true, revokedAt: true },
      }),
    ]);
    const person = (userId: string | null) => (userId ? people.find((p) => p.id === userId) ?? null : null);
    const revoked = new Set(evidence.filter((e) => e.revokedAt).map((e) => e.id));
    return rows.map((row) => {
      const open = OPEN.includes(row.status);
      const needsApproval = row.approvalRequired || meetsApprovalThreshold(row.amount, threshold);
      return {
        id: row.id,
        requestNumber: row.requestNumber,
        saleId: row.saleId,
        invoiceNo: sales.find((s) => s.id === row.saleId)?.invoiceNo ?? null,
        status: row.status,
        lines: storedLines(row),
        amount: row.amount.toFixed(2),
        refundMethod: row.refundMethod,
        reasonCode: row.reasonCode,
        reason: row.reason,
        approvalRequired: needsApproval,
        executionApprovalId: row.executionApprovalId,
        approvalRevoked: row.executionApprovalId ? revoked.has(row.executionApprovalId) : false,
        // Waiting at the counter: nothing more is needed before someone there refunds it.
        readyAtCounter: open && (row.executionApprovalId ? !revoked.has(row.executionApprovalId) : !needsApproval),
        approvalReview: open ? saleRefundApprovalReview(row) : null,
        approvalVersion: row.approvalVersion,
        requester: person(row.requestedBy),
        requestedAt: row.requestedAt.toISOString(),
        approver: person(row.approvedBy),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        executor: person(row.executedBy),
        executedAt: row.executedAt?.toISOString() ?? null,
        goodsReturnId: row.goodsReturnId,
        cancelledBy: person(row.cancelledBy),
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
      };
    });
  }

  private async needsApproval(tx: Tx, tenantId: string, row: Pick<SaleRefundRequest, "approvalRequired" | "amount">) {
    // Prepared over the threshold, or the tenant has since lowered it below this amount.
    return row.approvalRequired || meetsApprovalThreshold(row.amount, await this.sales.refundApprovalThreshold(tx, tenantId));
  }

  private assertControlledAuthority(actor: { has(key: string): boolean }, sale: Parameters<SalesService["needsControlledRefundGate"]>[0]) {
    if (this.sales.needsControlledRefundGate(sale) && !actor.has("sales.approve_controlled")) {
      throw new ForbiddenException(
        "A sale with controlled or prescription items is refunded by someone who can approve controlled sales",
      );
    }
  }

  private async lock(tx: Tx, tenantId: string, branchId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM sale_refund_request WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    const row = await tx.saleRefundRequest.findFirst({ where: { tenantId, branchId, id } });
    if (!row) throw new NotFoundException("Refund request not found");
    return row;
  }
}
