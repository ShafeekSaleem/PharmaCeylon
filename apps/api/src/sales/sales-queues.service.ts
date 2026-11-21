import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { OfflineJournalCommand, OfflineSaleCommand } from "@pharmaceylon/shared";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { SUPPORT_HELD_REASONS } from "../terminals/journal/support-evidence";
import {
  incidentNotesWhere,
  paymentRecoveryWhere,
} from "../terminals/support-queue-predicates";
import type {
  ListCollectedMoneyQueryDto,
  ListIncidentNotesQueryDto,
  ListPaymentRecoveryQueryDto,
} from "./dto/sales-queues-query.dto";

const DEFAULT_PAGE = 1;
const DEFAULT_SIZE = 25;
const MAX_SIZE = 100;
/** Matches `SupportEvidenceReconciler.listHeld` — oldest held rows beyond this are not listed. */
const PAYMENT_RECOVERY_ROW_CAP = 500;

function receiptNumberOf(command: OfflineJournalCommand): string | null {
  if (command.kind !== "ordinary_sale") return null;
  const n = (command as OfflineSaleCommand).receiptNumber;
  return typeof n === "string" ? n : null;
}

@Injectable()
export class SalesQueuesService {
  constructor(private readonly prisma: PrismaService) {}

  private page(query: { page?: number; pageSize?: number }) {
    const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_SIZE, 1), MAX_SIZE);
    const page = Math.max(query.page ?? DEFAULT_PAGE, 1);
    return { page, pageSize, skip: (page - 1) * pageSize };
  }

  private async terminalLabels(tenantId: string, branchId: string, terminalIds: string[]) {
    if (!terminalIds.length) return new Map<string, string>();
    const rows = await this.prisma.operationalTerminal.findMany({
      where: { tenantId, branchId, id: { in: terminalIds } },
      select: { id: true, label: true, registerId: true },
    });
    const regIds = rows.map((r) => r.registerId).filter((id): id is string => Boolean(id));
    const counters = regIds.length
      ? await this.prisma.terminalCounter.findMany({
          where: { tenantId, branchId, id: { in: regIds } },
          select: { id: true, label: true },
        })
      : [];
    const counterById = new Map(counters.map((c) => [c.id, c.label]));
    return new Map(
      rows.map((r) => [
        r.id,
        JSON.stringify({
          terminalLabel: r.label,
          registerLabel: r.registerId ? (counterById.get(r.registerId) ?? null) : null,
        }),
      ]),
    );
  }

  private labelPack(
    map: Map<string, string>,
    terminalId: string,
  ): { terminalLabel: string; registerLabel: string | null } {
    const raw = map.get(terminalId);
    if (!raw) return { terminalLabel: "Unknown counter", registerLabel: null };
    return JSON.parse(raw) as { terminalLabel: string; registerLabel: string | null };
  }

  async incidentNotes(
    user: RequestUser,
    branchId: string,
    query: ListIncidentNotesQueryDto,
  ) {
    const { page, pageSize, skip } = this.page(query);
    const noteStatus = query.status === "held" ? "held" : "accepted";
    const where = incidentNotesWhere(user.tenantId, branchId, noteStatus);
    const order = query.sort === "recordedAt" ? { recordedAt: "desc" as const } : { receivedAt: "desc" as const };
    const search = query.q?.trim()
      ? {
          OR: [
            { description: { contains: query.q.trim(), mode: "insensitive" as const } },
            { incidentCategory: { contains: query.q.trim(), mode: "insensitive" as const } },
          ],
        }
      : {};
    const fullWhere = { ...where, ...search };

    const [rows, total] = await Promise.all([
      this.prisma.offlineSupportRecord.findMany({
        where: fullWhere,
        orderBy: order,
        skip,
        take: pageSize,
        select: {
          id: true,
          recordId: true,
          terminalId: true,
          status: true,
          heldReason: true,
          incidentCategory: true,
          description: true,
          recordedAt: true,
          receivedAt: true,
          recordedByUserId: true,
          saleCommandId: true,
        },
      }),
      this.prisma.offlineSupportRecord.count({ where: fullWhere }),
    ]);
    const terminalIds = [...new Set(rows.map((r) => r.terminalId))];
    const labels = await this.terminalLabels(user.tenantId, branchId, terminalIds);
    const userIds = [...new Set(rows.map((r) => r.recordedByUserId).filter(Boolean))] as string[];
    const commandIds = [...new Set(rows.map((r) => r.saleCommandId).filter(Boolean))] as string[];
    const [people, sales] = await Promise.all([
      userIds.length
        ? this.prisma.appUser.findMany({
            where: { tenantId: user.tenantId, id: { in: userIds } },
            select: { id: true, fullName: true },
          })
        : [],
      commandIds.length
        ? this.prisma.sale.findMany({
            where: {
              tenantId: user.tenantId,
              branchId,
              offlineCommandId: { in: commandIds },
            },
            select: { id: true, invoiceNo: true, offlineCommandId: true },
          })
        : [],
    ]);
    const peopleById = new Map(people.map((p) => [p.id, p.fullName]));
    const saleByCommand = new Map<string, (typeof sales)[number]>();
    for (const sale of sales) {
      if (sale.offlineCommandId) saleByCommand.set(sale.offlineCommandId, sale);
    }
    const now = new Date().toISOString();
    return {
      items: rows.map((row) => {
        const { terminalLabel, registerLabel } = this.labelPack(labels, row.terminalId);
        const sale = row.saleCommandId ? saleByCommand.get(row.saleCommandId) ?? null : null;
        return {
          id: row.id,
          recordId: row.recordId,
          branchId,
          terminalId: row.terminalId,
          terminalLabel,
          registerLabel,
          status: row.status,
          heldReason: row.heldReason,
          incidentCategory: row.incidentCategory ?? "",
          description: row.description ?? "",
          recordedAt: row.recordedAt.toISOString(),
          receivedAt: row.receivedAt.toISOString(),
          recordedBy: row.recordedByUserId
            ? {
                id: row.recordedByUserId,
                fullName: peopleById.get(row.recordedByUserId) ?? "Unknown",
              }
            : null,
          sale: sale ? { id: sale.id, invoiceNo: sale.invoiceNo } : null,
          offlineCommandId: row.saleCommandId,
          href: sale ? `/sales/history/${sale.id}` : null,
        };
      }),
      total,
      page,
      pageSize,
      asOf: now,
    };
  }

  async paymentRecovery(
    user: RequestUser,
    branchId: string,
    query: ListPaymentRecoveryQueryDto,
  ) {
    const { page, pageSize, skip } = this.page(query);
    const where = paymentRecoveryWhere(user.tenantId, branchId, query.heldReason);
    const order = query.sort === "recordedAt" ? { recordedAt: "desc" as const } : { receivedAt: "desc" as const };

    const rows = await this.prisma.offlineSupportRecord.findMany({
      where,
      orderBy: order,
      take: PAYMENT_RECOVERY_ROW_CAP,
      select: {
        attemptId: true,
        terminalId: true,
        heldReason: true,
        amountMinor: true,
        providerReference: true,
        approvalCode: true,
        cardState: true,
        recordedAt: true,
        receivedAt: true,
        saleCommandId: true,
      },
    });
    const byAttempt = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (!row.attemptId) continue;
      const prev = byAttempt.get(row.attemptId);
      if (!prev || row.receivedAt > prev.receivedAt) byAttempt.set(row.attemptId, row);
    }
    const sortField = query.sort === "recordedAt" ? "recordedAt" : "receivedAt";
    const attempts = [...byAttempt.values()].sort(
      (a, b) => b[sortField].getTime() - a[sortField].getTime(),
    );
    const total = attempts.length;
    const pageRows = attempts.slice(skip, skip + pageSize);
    const terminalIds = [...new Set(pageRows.map((r) => r.terminalId))];
    const labels = await this.terminalLabels(user.tenantId, branchId, terminalIds);
    const commandIds = [...new Set(pageRows.map((r) => r.saleCommandId).filter(Boolean))] as string[];
    const sales = commandIds.length
      ? await this.prisma.sale.findMany({
          where: {
            tenantId: user.tenantId,
            branchId,
            offlineCommandId: { in: commandIds },
          },
          select: { id: true, invoiceNo: true, offlineCommandId: true },
        })
      : [];
    const saleByCommand = new Map<string, (typeof sales)[number]>();
    for (const sale of sales) {
      if (sale.offlineCommandId) saleByCommand.set(sale.offlineCommandId, sale);
    }
    const now = new Date().toISOString();
    return {
      items: pageRows.map((row) => {
        const { terminalLabel } = this.labelPack(labels, row.terminalId);
        const reason = row.heldReason ?? "";
        const sale = row.saleCommandId ? saleByCommand.get(row.saleCommandId) ?? null : null;
        return {
          attemptId: row.attemptId,
          branchId,
          terminalId: row.terminalId,
          terminalLabel,
          heldReason: reason,
          explanation:
            (SUPPORT_HELD_REASONS as Record<string, string>)[reason] ?? "Kept for review.",
          amountMinor: row.amountMinor != null ? Number(row.amountMinor) : null,
          providerReference: row.providerReference,
          approvalCode: row.approvalCode,
          cardState: row.cardState,
          recordedAt: row.recordedAt.toISOString(),
          receivedAt: row.receivedAt.toISOString(),
          sale: sale ? { id: sale.id, invoiceNo: sale.invoiceNo } : null,
          offlineCommandId: row.saleCommandId,
          clearsOnUpload: false,
        };
      }),
      total,
      page,
      pageSize,
      asOf: now,
    };
  }

  async collectedMoney(
    user: RequestUser,
    branchId: string,
    query: ListCollectedMoneyQueryDto,
  ) {
    const { page, pageSize, skip } = this.page(query);
    const where: Prisma.OfflineCollectedPaymentWhereInput = {
      tenantId: user.tenantId,
      branchId,
      ...(query.shiftId ? { shiftId: query.shiftId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.offlineCollectedPayment.findMany({
        where,
        orderBy: { collectedAt: "desc" },
        skip,
        take: pageSize,
        include: {
          settlement: {
            select: {
              id: true,
              reviewId: true,
              commandId: true,
            },
          },
          shift: { select: { shiftNumber: true } },
        },
      }),
      this.prisma.offlineCollectedPayment.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.staffUserId))];
    const reviewIds = [...new Set(rows.map((r) => r.settlement.reviewId))];
    const [people, reviews] = await Promise.all([
      this.prisma.appUser.findMany({
        where: { tenantId: user.tenantId, id: { in: userIds } },
        select: { id: true, fullName: true },
      }),
      this.prisma.offlineJournalReview.findMany({
        where: { tenantId: user.tenantId, branchId, id: { in: reviewIds } },
        select: { id: true, envelope: true },
      }),
    ]);
    const peopleById = new Map(people.map((p) => [p.id, p.fullName]));
    const receiptByReview = new Map<string, string | null>();
    for (const review of reviews) {
      const command = (review.envelope as { payload?: OfflineJournalCommand })?.payload;
      receiptByReview.set(review.id, command ? receiptNumberOf(command) : null);
    }
    const now = new Date().toISOString();
    return {
      items: rows.map((row) => ({
        id: row.id,
        branchId: row.branchId,
        amountMinor: Number(row.amountMinor),
        method: row.method,
        providerReference: row.providerReference,
        approvalCode: row.approvalCode,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        collectedAt: row.collectedAt.toISOString(),
        shiftId: row.shiftId,
        shiftNumber: row.shift?.shiftNumber ?? null,
        staffUserId: row.staffUserId,
        staffName: peopleById.get(row.staffUserId) ?? "Unknown",
        settlementId: row.settlementId,
        journalReviewId: row.settlement.reviewId,
        offlineCommandId: row.commandId,
        receiptNumber: receiptByReview.get(row.settlement.reviewId) ?? null,
        status: "unresolved" as const,
      })),
      total,
      page,
      pageSize,
      asOf: now,
    };
  }

}