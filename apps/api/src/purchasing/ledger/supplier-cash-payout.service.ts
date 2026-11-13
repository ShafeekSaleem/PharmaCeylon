import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma, SupplierCashPayoutStatus, SupplierPaymentMethod, type SupplierCashPayout } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../audit/audit.service";
import { IDEMPOTENCY_SCOPE } from "../../common/idempotency.constants";
import { nextTenantDocumentNumber } from "../../common/document-sequence.util";
import { dec } from "./supplier-ledger.math";
import { isPrismaUniqueFieldError, normalizeIdempotencyKey } from "../../common/idempotency.util";
import { PrismaService } from "../../prisma/prisma.service";
import { AccessService } from "../../security/access.service";
import type { RequestUser } from "../../security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../security/management-approvals.service";
import type { CommandProvenance } from "../../terminals/command-provenance";
import { TillShiftsService } from "../../terminals/shifts/till-shifts.service";
import { denied } from "../../terminals/terminal-wire";
import type {
  ApproveSupplierCashPayoutDto,
  ListSupplierCashPayoutsQueryDto,
  PrepareSupplierCashPayoutDto,
} from "./supplier-cash-payout.dto";
import {
  storedAllocations,
  supplierCashPayoutApprovalReview,
  supplierCashPayoutMaterial,
} from "./supplier-cash-payout-approval-material";
import { SupplierLedgerService } from "./supplier-ledger.service";

type Tx = Prisma.TransactionClient;
const OPEN: SupplierCashPayoutStatus[] = [
  SupplierCashPayoutStatus.prepared,
  SupplierCashPayoutStatus.approved,
];

/**
 * Supplier cash payouts (P6 #174, revised D10): approved on the web, paid from the open shift's
 * drawer at the counter. Preparation and approval move no money; execution posts the ledger
 * payment and a till cash movement in one transaction.
 */
@Injectable()
export class SupplierCashPayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly approvals: ManagementApprovalsService,
    private readonly ledger: SupplierLedgerService,
    private readonly shifts: TillShiftsService,
  ) {}

  async prepare(user: RequestUser, branchId: string, dto: PrepareSupplierCashPayoutDto) {
    const tenantId = user.tenantId;
    const amount = dec(dto.amount).toDecimalPlaces(2);
    if (amount.lte(0)) throw new BadRequestException("Enter the amount to pay out");
    const paidOn = new Date(dto.paidOn);
    const allocations = (dto.allocations ?? []).map((part) => ({
      invoiceId: part.invoiceId,
      amount: dec(part.amount).toDecimalPlaces(2).toFixed(2),
    }));
    const id = await this.prisma.$transaction(async (tx) => {
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (!actor.has("suppliers.pay")) throw new ForbiddenException("Your role can't authorize supplier payments");
      const open = await tx.supplierCashPayout.findFirst({
        where: {
          tenantId,
          branchId,
          supplierId: dto.supplierId,
          status: { in: OPEN },
        },
        select: { payoutNumber: true },
      });
      if (open) {
        throw new ConflictException(
          `Payout ${open.payoutNumber} is already waiting for this supplier. Cancel it to prepare another.`,
        );
      }
      // Validate allocations against outstanding invoices without writing a payment.
      await this.ledger.placeAllocations(tx, tenantId, dto.supplierId, amount, dto.allocations);
      const payoutNumber = await nextTenantDocumentNumber(tx, tenantId, "supplier_cash_payout", "SCP-");
      const created = await tx.supplierCashPayout.create({
        data: {
          id: randomUUID(),
          tenantId,
          branchId,
          supplierId: dto.supplierId,
          payoutNumber,
          amount,
          paidOn,
          reference: dto.reference?.trim() || null,
          notes: dto.notes?.trim() || null,
          allocations: allocations as unknown as Prisma.InputJsonArray,
          purchaseOrderId: dto.purchaseOrderId ?? null,
          requestedBy: user.userId,
        },
      });
      await this.audit.log({
        tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "supplier_cash_payout.prepared",
        entityName: "supplier_cash_payout",
        entityId: created.id,
        payload: {
          payoutNumber,
          supplierId: dto.supplierId,
          amount: amount.toFixed(2),
          purchaseOrderId: dto.purchaseOrderId ?? null,
        },
      }, tx);
      if (actor.has("suppliers.pay") && actor.canSelfApprove) {
        const review = supplierCashPayoutApprovalReview(created);
        await this.approveInTransaction(tx, user, branchId, created.id, {
          approvalId: randomUUID(),
          ...review,
        });
      }
      return created.id;
    });
    return this.getOne(tenantId, branchId, id);
  }

  async approve(user: RequestUser, branchId: string, id: string, dto: ApproveSupplierCashPayoutDto) {
    await this.prisma.$transaction(async (tx) => {
      await this.approveInTransaction(tx, user, branchId, id, dto);
    });
    return this.getOne(user.tenantId, branchId, id);
  }

  private async approveInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    id: string,
    dto: ApproveSupplierCashPayoutDto,
  ) {
    const row = await this.lock(tx, user.tenantId, branchId, id);
    if (!OPEN.includes(row.status)) throw new BadRequestException("This payout is no longer waiting for approval");
    const evidence = await this.approvals.issue(
      tx,
      user,
      branchId,
      "supplier_cash_payout.execute",
      id,
      { ...dto, reason: "Reviewed supplier cash payout", expiresAt: null },
    );
    if (row.executionApprovalId === evidence.approvalId) return;
    const approvedBy = evidence.approvedByUserId;
    await tx.supplierCashPayout.update({
      where: { id, tenantId: user.tenantId, branchId },
      data: {
        status: SupplierCashPayoutStatus.approved,
        approvedBy,
        approvedAt: new Date(),
        executionApprovalId: evidence.approvalId,
      },
    });
    await this.audit.log({
      tenantId: user.tenantId,
      branchId,
      actorUserId: approvedBy,
      eventName: "supplier_cash_payout.approved",
      entityName: "supplier_cash_payout",
      entityId: id,
      payload: {
        supplierId: row.supplierId,
        approvalId: evidence.approvalId,
        amount: row.amount.toFixed(2),
        requestedByUserId: row.requestedBy,
        approvedByUserId: approvedBy,
        selfApproved: row.requestedBy === approvedBy,
      },
    }, tx);
  }

  async cancel(user: RequestUser, branchId: string, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const row = await this.lock(tx, user.tenantId, branchId, id);
      if (!OPEN.includes(row.status)) throw new BadRequestException("Only a payout still waiting can be cancelled");
      const actor = await this.access.resolveLive(user, branchId, tx);
      if (row.requestedBy !== user.userId && !actor.has("suppliers.pay")) {
        throw new ForbiddenException("Only the person who prepared this payout, or a payer, can cancel it");
      }
      await tx.supplierCashPayout.update({
        where: { id, tenantId: user.tenantId, branchId },
        data: {
          status: SupplierCashPayoutStatus.cancelled,
          cancelledBy: user.userId,
          cancelledAt: new Date(),
        },
      });
      await this.audit.log({
        tenantId: user.tenantId,
        branchId,
        actorUserId: user.userId,
        eventName: "supplier_cash_payout.cancelled",
        entityName: "supplier_cash_payout",
        entityId: id,
        payload: { supplierId: row.supplierId },
      }, tx);
    });
    return this.getOne(user.tenantId, branchId, id);
  }

  /** Browser route body; execution is signed-command only (TERMINAL_REQUIRED here). */
  async execute(
    user: RequestUser,
    branchId: string,
    id: string,
    dto: { approvalId?: string | null },
    idempotencyKeyRaw?: string,
  ) {
    const tenantId = user.tenantId;
    const idemKey = normalizeIdempotencyKey(idempotencyKeyRaw);
    if (idemKey) {
      const prior = await this.prisma.idempotencyRecord.findUnique({
        where: {
          tenantId_userId_scope_idempotencyKey: {
            tenantId,
            userId: user.userId,
            scope: IDEMPOTENCY_SCOPE.supplierCashPayoutExecute,
            idempotencyKey: idemKey,
          },
        },
      });
      if (prior) {
        if (prior.resourceId !== id) throw new BadRequestException("Idempotency-Key already used for a different payout");
        return this.getOne(tenantId, branchId, id);
      }
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.executeInTransaction(tx, user, branchId, id, {
          approvalId: dto.approvalId ?? null,
        });
        if (idemKey) {
          await tx.idempotencyRecord.create({
            data: {
              tenantId,
              userId: user.userId,
              scope: IDEMPOTENCY_SCOPE.supplierCashPayoutExecute,
              idempotencyKey: idemKey,
              resourceId: id,
            },
          });
        }
      });
    } catch (error) {
      if (idemKey && isPrismaUniqueFieldError(error, "idempotency")) return this.getOne(tenantId, branchId, id);
      throw error;
    }
    return this.getOne(tenantId, branchId, id);
  }

  async executeInTransaction(
    tx: Tx,
    user: RequestUser,
    branchId: string,
    id: string,
    input: { approvalId: string | null; command?: CommandProvenance },
  ) {
    const tenantId = user.tenantId;
    const row = await this.lock(tx, tenantId, branchId, id);
    const actor = await this.access.resolveLive(user, branchId, tx);
    if (!actor.has("suppliers.pay")) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Your role can't pay suppliers" });
    }
    if ((row.executionApprovalId ?? null) !== input.approvalId) {
      throw new ConflictException({ code: "APPROVAL_STALE", message: "Approval changed; refresh and review before paying out" });
    }
    if (row.status === SupplierCashPayoutStatus.executed) {
      return { changed: false, row, paymentId: row.supplierPaymentId! };
    }
    if (row.status !== SupplierCashPayoutStatus.approved) throw new BadRequestException("This payout is not approved yet");
    if (!row.executionApprovalId) denied("APPROVAL_REQUIRED");

    const evidence = await this.approvals.requireForExecution(
      tx,
      user,
      branchId,
      "supplier_cash_payout.execute",
      id,
      row.executionApprovalId,
    );

    if (!input.command?.tillId) throw new BadRequestException("Counter payout requires an enrolled till");
    const amountMinor = Math.round(Number(row.amount) * 100);
    const tillAt = { tenantId, branchId, tillId: input.command.tillId, userId: user.userId };
    await this.shifts.requireDrawerCashOut(tx, tillAt, amountMinor);
    const paymentId = await this.ledger.recordPaymentInTransaction(
      tx,
      tenantId,
      branchId,
      user.userId,
      {
        supplierId: row.supplierId,
        paidOn: row.paidOn.toISOString().slice(0, 10),
        amount: row.amount.toFixed(2),
        method: SupplierPaymentMethod.cash,
        reference: row.reference ?? undefined,
        notes: row.notes ?? undefined,
        allocations: storedAllocations(row).map((part) => ({
          invoiceId: part.invoiceId,
          amount: part.amount,
        })),
      },
    );
    const poRef = row.purchaseOrderId
      ? await tx.purchaseOrder.findFirst({ where: { tenantId, id: row.purchaseOrderId }, select: { poNumber: true } })
      : null;
    const reason = poRef
      ? `Supplier payout · ${poRef.poNumber}`
      : `Supplier payout · ${row.payoutNumber}`;
    await this.shifts.recordCashMovement(tx, {
      tenantId,
      branchId,
      tillId: input.command.tillId,
      userId: user.userId,
      direction: "out",
      amountMinor,
      reason,
      referenceType: "supplier_payment",
      referenceId: paymentId,
    });
    const executed = await tx.supplierCashPayout.update({
      where: { id, tenantId, branchId },
      data: {
        status: SupplierCashPayoutStatus.executed,
        executedBy: user.userId,
        executedAt: new Date(),
        supplierPaymentId: paymentId,
      },
    });
    await this.audit.log({
      tenantId,
      branchId,
      actorUserId: user.userId,
      eventName: "supplier_cash_payout.executed",
      entityName: "supplier_cash_payout",
      entityId: id,
      payload: {
        supplierId: row.supplierId,
        paymentId,
        approvalId: evidence.approvalId,
        amount: row.amount.toFixed(2),
        requestedByUserId: row.requestedBy,
        approvedByUserId: evidence.approvedByUserId,
        ...(input.command
          ? {
              commandId: input.command.commandId,
              terminalId: input.command.terminalId,
              workSessionId: input.command.workSessionId,
            }
          : {}),
      },
    }, tx);
    return { changed: true, row: executed, paymentId };
  }

  async list(tenantId: string, branchId: string, query: ListSupplierCashPayoutsQueryDto) {
    const ready = query.readyAtCounter === "true" || query.readyAtCounter === "1";
    const rows = await this.prisma.supplierCashPayout.findMany({
      where: {
        tenantId,
        branchId,
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.status ? { status: query.status } : ready ? { status: SupplierCashPayoutStatus.approved } : {}),
      },
      orderBy: { requestedAt: "desc" },
      take: 200,
    });
    const viewed = await this.view(tenantId, branchId, rows);
  return ready ? viewed.filter((row) => row.readyAtCounter) : viewed;
  }

  async getOne(tenantId: string, branchId: string, id: string) {
    const row = await this.prisma.supplierCashPayout.findFirst({ where: { tenantId, branchId, id } });
    if (!row) throw new NotFoundException("Supplier cash payout not found");
    const [viewed] = await this.view(tenantId, branchId, [row]);
    return viewed!;
  }

  private async view(tenantId: string, branchId: string, rows: SupplierCashPayout[]) {
    if (!rows.length) return [];
    const supplierIds = [...new Set(rows.map((r) => r.supplierId))];
    const poIds = rows.map((r) => r.purchaseOrderId).filter((id): id is string => !!id);
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.executedBy, r.cancelledBy])
      .filter((v): v is string => !!v))];
    const [suppliers, orders, people, evidence] = await Promise.all([
      this.prisma.supplier.findMany({ where: { tenantId, id: { in: supplierIds } }, select: { id: true, code: true, name: true } }),
      poIds.length
        ? this.prisma.purchaseOrder.findMany({ where: { tenantId, id: { in: poIds } }, select: { id: true, poNumber: true } })
        : Promise.resolve([] as { id: string; poNumber: string }[]),
      this.prisma.appUser.findMany({ where: { tenantId, id: { in: userIds } }, select: { id: true, fullName: true } }),
      this.prisma.managementApproval.findMany({
        where: {
          tenantId,
          branchId,
          id: { in: rows.map((r) => r.executionApprovalId).filter((v): v is string => !!v) },
        },
        select: { id: true, revokedAt: true },
      }),
    ]);
    const person = (id: string | null) => (id ? people.find((p) => p.id === id) ?? null : null);
    const revoked = new Set(evidence.filter((e) => e.revokedAt).map((e) => e.id));
    return rows.map((row) => {
      const supplier = suppliers.find((s) => s.id === row.supplierId);
      const po = row.purchaseOrderId ? orders.find((o) => o.id === row.purchaseOrderId) : null;
      const open = OPEN.includes(row.status);
      const approvalOk = row.executionApprovalId ? !revoked.has(row.executionApprovalId) : false;
      return {
        id: row.id,
        payoutNumber: row.payoutNumber,
        status: row.status,
        supplier: supplier ? { id: supplier.id, code: supplier.code, name: supplier.name } : null,
        purchaseOrder: po ? { id: po.id, poNumber: po.poNumber } : null,
        amount: row.amount.toFixed(2),
        paidOn: row.paidOn.toISOString().slice(0, 10),
        reference: row.reference,
        notes: row.notes,
        allocations: storedAllocations(row),
        executionApprovalId: row.executionApprovalId,
        approvalRevoked: row.executionApprovalId ? revoked.has(row.executionApprovalId) : false,
        readyAtCounter: open && row.status === SupplierCashPayoutStatus.approved && approvalOk,
        approvalReview: open ? supplierCashPayoutApprovalReview(row) : null,
        approvalVersion: row.approvalVersion,
        requester: person(row.requestedBy),
        requestedAt: row.requestedAt.toISOString(),
        approver: person(row.approvedBy),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        executor: person(row.executedBy),
        executedAt: row.executedAt?.toISOString() ?? null,
        supplierPaymentId: row.supplierPaymentId,
        cancelledBy: person(row.cancelledBy),
        cancelledAt: row.cancelledAt?.toISOString() ?? null,
      };
    });
  }

  private async lock(tx: Tx, tenantId: string, branchId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM supplier_cash_payout WHERE tenant_id = ${tenantId}::uuid AND branch_id = ${branchId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    const row = await tx.supplierCashPayout.findFirst({ where: { tenantId, branchId, id } });
    if (!row) throw new NotFoundException("Supplier cash payout not found");
    return row;
  }
}
