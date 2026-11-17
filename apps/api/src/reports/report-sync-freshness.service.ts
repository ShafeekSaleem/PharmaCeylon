import { Injectable } from "@nestjs/common";
import { SaleStockPosting } from "@prisma/client";
import type { ReportSyncFreshness } from "@pharmaceylon/shared";
import { safeTimeZone } from "../common/business-date.util";
import { PrismaService } from "../prisma/prisma.service";
import {
  journalStatusQuery,
  journalSyncViews,
  type JournalStatusRow,
} from "../terminals/journal/counter-journal-status";
import { reportSyncFreshness, type FreshnessInput } from "./report-sync-freshness";

/**
 * P5 #51 item 11: the freshness caveat beside the sales and stock reports. Same read as the
 * Counters page's journal status (one statement per branch), plus a count of in-range sales whose
 * stock is pending. Nothing here feeds a report figure.
 */
@Injectable()
export class ReportSyncFreshnessService {
  constructor(private readonly prisma: PrismaService) {}

  async freshness(tenantId: string, branchId: string | null, days = 30): Promise<ReportSyncFreshness> {
    const asOf = new Date();
    const since = new Date(asOf);
    since.setDate(since.getDate() - days);
    return this.prisma.$transaction(async (tx) => {
      const branches = await tx.branch.findMany({
        where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
        orderBy: { name: "asc" },
        select: { id: true, name: true, timezone: true },
      });
      const pending = await tx.sale.groupBy({
        by: ["branchId"],
        where: {
          tenantId,
          branchId: { in: branches.map((b) => b.id) },
          soldAt: { gte: since },
          stockPosting: SaleStockPosting.pending_reconciliation,
        },
        _count: { _all: true },
      });
      const inputs: FreshnessInput[] = [];
      for (const branch of branches) {
        const rows = await tx.$queryRaw<JournalStatusRow[]>(journalStatusQuery(tenantId, branch.id));
        inputs.push({
          branchId: branch.id,
          branchName: branch.name,
          timezone: safeTimeZone(branch.timezone),
          pendingStockSales: pending.find((p) => p.branchId === branch.id)?._count._all ?? 0,
          views: journalSyncViews(rows),
        });
      }
      return reportSyncFreshness(days, asOf, inputs);
    });
  }
}
