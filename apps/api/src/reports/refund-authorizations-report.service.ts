import { Injectable } from "@nestjs/common";
import { GoodsReturnStatus, GoodsReturnType, SaleRefundRequestStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { toMinor } from "../terminals/shifts/till-shift-math";
import {
  buildRefundAuthorizationsReport,
  type RefundAuthorizationsReportResponse,
  type RefundInput,
} from "./refund-authorizations-report";
import { SalesReportScopeService } from "./sales-report-scope.service";

/**
 * Loads the customer refunds completed in the report window (each is a completed customer
 * `GoodsReturn`), the refund request behind each one if there was one, and the requests still open
 * or cancelled in the window. Scoped by tenant and the report's branches.
 */
@Injectable()
export class RefundAuthorizationsReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SalesReportScopeService,
  ) {}

  async report(tenantId: string, branchId: string | null, days: number): Promise<RefundAuthorizationsReportResponse> {
    const window = await this.scope.reportWindow(tenantId, branchId, days);
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
      select: { id: true, name: true },
    });
    const meta = { days, timeZone: window.timeZone, since: window.since, before: window.before };
    const branchIds = branches.map((b) => b.id);
    if (!branchIds.length) return buildRefundAuthorizationsReport([], { open: [], cancelled: [] }, meta);
    const inWindow = { gte: window.since, lt: window.before };

    const [returns, open, cancelled] = await Promise.all([
      this.prisma.goodsReturn.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          type: GoodsReturnType.customer,
          status: GoodsReturnStatus.completed,
          saleId: { not: null },
          createdAt: inWindow,
        },
        select: {
          id: true,
          returnNumber: true,
          branchId: true,
          createdAt: true,
          amount: true,
          reasonCode: true,
          requestedBy: true,
          approvedBy: true,
          processedBy: true,
          sale: { select: { id: true, invoiceNo: true } },
          shift: { select: { id: true, shiftNumber: true, counter: { select: { label: true } } } },
        },
      }),
      this.prisma.saleRefundRequest.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          status: { in: [SaleRefundRequestStatus.prepared, SaleRefundRequestStatus.approved] },
        },
        select: { amount: true },
      }),
      this.prisma.saleRefundRequest.findMany({
        where: { tenantId, branchId: { in: branchIds }, status: SaleRefundRequestStatus.cancelled, cancelledAt: inWindow },
        select: { amount: true },
      }),
    ]);
    const requestTotals = {
      open: open.map((r) => ({ amountMinor: toMinor(r.amount) })),
      cancelled: cancelled.map((r) => ({ amountMinor: toMinor(r.amount) })),
    };
    if (!returns.length) return buildRefundAuthorizationsReport([], requestTotals, meta);

    const requests = await this.prisma.saleRefundRequest.findMany({
      where: { tenantId, branchId: { in: branchIds }, goodsReturnId: { in: returns.map((r) => r.id) } },
      select: { id: true, requestNumber: true, requestedAt: true, approvedAt: true, goodsReturnId: true },
    });
    const requestByReturn = new Map(requests.map((r) => [r.goodsReturnId!, r]));
    const people = await this.names(
      tenantId,
      returns.flatMap((r) => [r.requestedBy, r.approvedBy, r.processedBy].filter((id): id is string => !!id)),
    );
    const person = (id: string) => ({ id, name: people.get(id) ?? "Unknown" });
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    const inputs: RefundInput[] = returns.map((r) => {
      const request = requestByReturn.get(r.id);
      return {
        goodsReturnId: r.id,
        returnNumber: r.returnNumber,
        branchId: r.branchId,
        branchName: branchName.get(r.branchId) ?? "",
        createdAt: r.createdAt,
        amountMinor: toMinor(r.amount),
        reasonCode: r.reasonCode,
        sale: r.sale,
        requestedBy: person(r.requestedBy),
        approvedBy: r.approvedBy ? person(r.approvedBy) : null,
        executedBy: r.processedBy ? person(r.processedBy) : null,
        shift: r.shift ? { id: r.shift.id, shiftNumber: r.shift.shiftNumber, counterLabel: r.shift.counter.label } : null,
        request: request
          ? { id: request.id, requestNumber: request.requestNumber, requestedAt: request.requestedAt, approvedAt: request.approvedAt }
          : null,
      };
    });
    return buildRefundAuthorizationsReport(inputs, requestTotals, meta);
  }

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    // tenant-scope: verified-parent — the membership filter scopes the accounts to this tenant.
    const rows = await this.prisma.appUser.findMany({
      where: { id: { in: unique }, tenantMemberships: { some: { tenantId } } },
      select: { id: true, fullName: true },
    });
    return new Map(rows.map((r) => [r.id, r.fullName]));
  }
}
