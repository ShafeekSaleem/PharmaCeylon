import { Injectable } from "@nestjs/common";
import { OfflineStockDiscrepancyStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { SalesReportScopeService } from "./sales-report-scope.service";
import {
  buildStockDiscrepancyReport,
  type DiscrepancyCaseInput,
  type StockDiscrepancyReportResponse,
} from "./stock-discrepancy-report";

/**
 * Loads the offline stock discrepancy cases opened in the window, still open, or resolved in the
 * window, with their lines, resolutions, settlements and the batch blocks they still hold. Scoped
 * by tenant and the report's branches.
 */
/** Mapped by name, so a status added to the enum fails to compile here instead of reading as resolved. */
const CASE_STATUS: Record<OfflineStockDiscrepancyStatus, "open" | "resolved"> = {
  [OfflineStockDiscrepancyStatus.open]: "open",
  [OfflineStockDiscrepancyStatus.resolved]: "resolved",
};

@Injectable()
export class StockDiscrepancyReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SalesReportScopeService,
  ) {}

  async report(tenantId: string, branchId: string | null, days: number, asOf = new Date()): Promise<StockDiscrepancyReportResponse> {
    const window = await this.scope.reportWindow(tenantId, branchId, days);
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
      select: { id: true, name: true },
    });
    const meta = { days, timeZone: window.timeZone, since: window.since, before: window.before, asOf };
    const branchIds = branches.map((b) => b.id);
    if (!branchIds.length) return buildStockDiscrepancyReport([], meta);
    const inWindow = { gte: window.since, lt: window.before };

    const cases = await this.prisma.offlineStockDiscrepancy.findMany({
      where: {
        tenantId,
        branchId: { in: branchIds },
        OR: [{ openedAt: inWindow }, { status: OfflineStockDiscrepancyStatus.open }, { resolvedAt: inWindow }],
      },
      select: {
        id: true,
        branchId: true,
        terminalId: true,
        status: true,
        openedAt: true,
        resolvedAt: true,
        sale: { select: { id: true, invoiceNo: true, soldAt: true, soldBy: true } },
        lines: {
          select: {
            productId: true,
            batchId: true,
            soldQuantity: true,
            availableQuantityAtSync: true,
            shortfallQuantity: true,
            reason: true,
            batch: { select: { batchNo: true } },
          },
        },
        blocks: { where: { releasedAt: null }, select: { id: true } },
        resolutions: {
          select: {
            id: true,
            kind: true,
            status: true,
            requestedBy: true,
            requestedAt: true,
            approvedBy: true,
            executedBy: true,
            executedAt: true,
          },
        },
        settlements: { select: { method: true, postedQuantity: true, correctionQuantity: true } },
      },
    });
    if (!cases.length) return buildStockDiscrepancyReport([], meta);

    const productIds = [...new Set(cases.flatMap((c) => c.lines.map((l) => l.productId)))];
    const [products, terminals, people] = await Promise.all([
      this.prisma.product.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true, name: true } }),
      this.prisma.operationalTerminal.findMany({
        where: { tenantId, branchId: { in: branchIds }, id: { in: [...new Set(cases.map((c) => c.terminalId))] } },
        select: { id: true, label: true, counter: { select: { label: true } } },
      }),
      this.names(
        tenantId,
        cases.flatMap((c) => [
          c.sale.soldBy,
          ...c.resolutions.flatMap((r) => [r.requestedBy, r.approvedBy, r.executedBy]),
        ]).filter((id): id is string => !!id),
      ),
    ]);
    const productName = new Map(products.map((p) => [p.id, p.name]));
    const terminalById = new Map(terminals.map((t) => [t.id, { label: t.label, counterLabel: t.counter?.label ?? null }]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const person = (id: string) => ({ id, name: people.get(id) ?? "Unknown" });
    const maybe = (id: string | null) => (id ? person(id) : null);

    const inputs: DiscrepancyCaseInput[] = cases.map((c) => {
      const terminal = terminalById.get(c.terminalId) ?? { label: null, counterLabel: null };
      return {
        id: c.id,
        branchId: c.branchId,
        branchName: branchName.get(c.branchId) ?? "",
        terminalId: c.terminalId,
        terminalLabel: terminal.label,
        counterLabel: terminal.counterLabel,
        status: CASE_STATUS[c.status],
        openedAt: c.openedAt,
        resolvedAt: c.resolvedAt,
        sale: { id: c.sale.id, invoiceNo: c.sale.invoiceNo, soldAt: c.sale.soldAt, seller: maybe(c.sale.soldBy) },
        lines: c.lines.map((l) => ({
          productId: l.productId,
          productName: productName.get(l.productId) ?? "Unknown product",
          batchId: l.batchId,
          batchNo: l.batch.batchNo,
          soldQuantity: l.soldQuantity,
          availableQuantityAtSync: l.availableQuantityAtSync,
          shortfallQuantity: l.shortfallQuantity,
          reason: l.reason,
        })),
        blockedBatches: c.blocks.length,
        resolutions: c.resolutions.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          requestedBy: person(r.requestedBy),
          requestedAt: r.requestedAt,
          approvedBy: maybe(r.approvedBy),
          executedBy: maybe(r.executedBy),
          executedAt: r.executedAt,
        })),
        settlements: c.settlements,
      };
    });
    return buildStockDiscrepancyReport(inputs, meta);
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
