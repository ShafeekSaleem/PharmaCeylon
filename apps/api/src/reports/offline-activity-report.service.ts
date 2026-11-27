import { Injectable } from "@nestjs/common";
import { SaleStockPosting } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OFFLINE_JOURNAL_OPERATION } from "../terminals/journal/journal-chain";
import { buildOfflineActivityReport, type OfflineActivityReportResponse, type OfflineEntry } from "./offline-activity-report";
import { SalesReportScopeService } from "./sales-report-scope.service";

/** The signed fields every offline journal command carries, read off its stored envelope. */
type SignedEntry = {
  commandId: string;
  kind: string;
  offlineSessionId: string;
  offlineStartedAt: number;
  occurredAt: number;
  staffSignInId: string;
  totalMinor?: number;
};

function signedEntry(envelope: unknown): SignedEntry | null {
  const p = (envelope as { payload?: Partial<SignedEntry> } | null)?.payload;
  if (
    !p ||
    typeof p.commandId !== "string" ||
    typeof p.kind !== "string" ||
    typeof p.offlineSessionId !== "string" ||
    typeof p.offlineStartedAt !== "number" ||
    typeof p.occurredAt !== "number" ||
    typeof p.staffSignInId !== "string"
  )
    return null;
  return p as SignedEntry;
}

/**
 * Loads the offline journal entries that reached the server since the window opened: accepted
 * ones from `terminal_command_receipt` (including those a manager settled), and ones still held or
 * rejected from `offline_journal_review` that no receipt has replaced. The report then keeps the
 * outages that started in the window. Scoped by tenant and the report's branches.
 */
@Injectable()
export class OfflineActivityReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SalesReportScopeService,
  ) {}

  async report(tenantId: string, branchId: string | null, days: number): Promise<OfflineActivityReportResponse> {
    const window = await this.scope.reportWindow(tenantId, branchId, days);
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
      select: { id: true, name: true },
    });
    const meta = { days, timeZone: window.timeZone, since: window.since, before: window.before };
    const branchIds = branches.map((b) => b.id);
    const emptyCtx = { branchName: () => "", terminal: () => ({ label: null, counterLabel: null }), person: () => "" };
    if (!branchIds.length) return buildOfflineActivityReport([], emptyCtx, meta);

    // Nothing from an outage that started in the window can arrive before the window opened.
    const [receipts, reviews] = await Promise.all([
      this.prisma.terminalCommandReceipt.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          offlineSequence: { not: null },
          operation: { startsWith: OFFLINE_JOURNAL_OPERATION },
          recordedAt: { gte: window.since },
        },
        select: { branchId: true, terminalId: true, commandId: true, command: true, recordedAt: true },
      }),
      this.prisma.offlineJournalReview.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          recordKind: "command",
          outcome: { in: ["held", "rejected"] },
          lastReceivedAt: { gte: window.since },
        },
        select: { branchId: true, terminalId: true, recordId: true, envelope: true, outcome: true, firstReceivedAt: true },
      }),
    ]);

    type Draft = Omit<OfflineEntry, "staffUserId" | "saleRecorded" | "stockPending"> & { staffSignInId: string };
    const drafts: Draft[] = [];
    const accepted = new Set<string>();
    for (const r of receipts) {
      const p = signedEntry(r.command);
      if (!p) continue;
      accepted.add(r.commandId);
      drafts.push({
        commandId: r.commandId,
        branchId: r.branchId,
        terminalId: r.terminalId,
        offlineSessionId: p.offlineSessionId,
        offlineStartedAt: new Date(p.offlineStartedAt),
        occurredAt: new Date(p.occurredAt),
        kind: p.kind,
        totalMinor: p.kind === "ordinary_sale" && typeof p.totalMinor === "number" ? p.totalMinor : 0,
        syncedAt: r.recordedAt,
        receivedAt: r.recordedAt,
        review: null,
        staffSignInId: p.staffSignInId,
      } as Draft);
    }
    for (const r of reviews) {
      const p = signedEntry(r.envelope);
      // A held entry later accepted keeps its review row; the receipt is the one that counts.
      if (!p || accepted.has(p.commandId)) continue;
      accepted.add(p.commandId);
      drafts.push({
        commandId: p.commandId,
        branchId: r.branchId,
        terminalId: r.terminalId,
        offlineSessionId: p.offlineSessionId,
        offlineStartedAt: new Date(p.offlineStartedAt),
        occurredAt: new Date(p.occurredAt),
        kind: p.kind,
        totalMinor: p.kind === "ordinary_sale" && typeof p.totalMinor === "number" ? p.totalMinor : 0,
        syncedAt: null,
        receivedAt: r.firstReceivedAt,
        review: r.outcome === "rejected" ? "rejected" : "held",
        staffSignInId: p.staffSignInId,
      } as Draft);
    }
    const inWindow = drafts.filter((d) => d.offlineStartedAt >= window.since && d.offlineStartedAt < window.before);
    if (!inWindow.length) return buildOfflineActivityReport([], emptyCtx, meta);

    const saleCommandIds = inWindow.filter((d) => d.kind === "ordinary_sale" && d.review === null).map((d) => d.commandId);
    const [sales, signIns, terminals] = await Promise.all([
      saleCommandIds.length
        ? this.prisma.sale.findMany({
            where: { tenantId, branchId: { in: branchIds }, offlineCommandId: { in: saleCommandIds } },
            select: { offlineCommandId: true, stockPosting: true },
          })
        : Promise.resolve([]),
      this.prisma.offlineStaffSignIn.findMany({
        where: { tenantId, branchId: { in: branchIds }, signInId: { in: [...new Set(inWindow.map((d) => d.staffSignInId))] } },
        select: { signInId: true, staffUserId: true },
      }),
      this.prisma.operationalTerminal.findMany({
        where: { tenantId, branchId: { in: branchIds }, id: { in: [...new Set(inWindow.map((d) => d.terminalId))] } },
        select: { id: true, label: true, counter: { select: { label: true } } },
      }),
    ]);
    const saleByCommand = new Map(sales.map((s) => [s.offlineCommandId!, s.stockPosting]));
    const staffBySignIn = new Map(signIns.map((s) => [s.signInId, s.staffUserId]));
    const people = await this.names(tenantId, [...staffBySignIn.values()]);
    const terminalById = new Map(terminals.map((t) => [t.id, { label: t.label, counterLabel: t.counter?.label ?? null }]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    const entries: OfflineEntry[] = inWindow.map(({ staffSignInId, ...d }) => {
      const posting = saleByCommand.get(d.commandId);
      return {
        ...d,
        staffUserId: staffBySignIn.get(staffSignInId) ?? null,
        saleRecorded: posting !== undefined,
        stockPending: posting === SaleStockPosting.pending_reconciliation,
      };
    });
    return buildOfflineActivityReport(
      entries,
      {
        branchName: (id) => branchName.get(id) ?? "",
        terminal: (id) => terminalById.get(id) ?? { label: null, counterLabel: null },
        person: (id) => people.get(id) ?? "Unknown",
      },
      meta,
    );
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
