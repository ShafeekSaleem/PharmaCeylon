import { Injectable } from "@nestjs/common";
import { OfflineJournalSettlementDecision, OfflineJournalSettlementStatus, SaleStockPosting } from "@prisma/client";
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

/**
 * `entry` when every signed field reads; `outage` when only the outage it belongs to does (it is
 * still counted there, as unreadable); `null` when not even that does.
 */
type Parsed =
  | { entry: SignedEntry }
  | { outage: { offlineSessionId: string; offlineStartedAt: number; commandId: string | null; occurredAt: number | null } }
  | null;

function parseEntry(envelope: unknown): Parsed {
  const p = (envelope as { payload?: Partial<SignedEntry> } | null)?.payload;
  if (!p || typeof p.offlineSessionId !== "string" || typeof p.offlineStartedAt !== "number") return null;
  if (
    typeof p.commandId === "string" &&
    typeof p.kind === "string" &&
    typeof p.occurredAt === "number" &&
    typeof p.staffSignInId === "string"
  )
    return { entry: p as SignedEntry };
  return {
    outage: {
      offlineSessionId: p.offlineSessionId,
      offlineStartedAt: p.offlineStartedAt,
      commandId: typeof p.commandId === "string" ? p.commandId : null,
      occurredAt: typeof p.occurredAt === "number" ? p.occurredAt : null,
    },
  };
}

/**
 * Loads the offline journal entries of outages that started in the window: accepted ones from
 * `terminal_command_receipt` (including those a manager settled), and ones still held or rejected
 * from `offline_journal_review` that no receipt has replaced. Entries whose envelope cannot be
 * read are counted, never dropped. Scoped by tenant and the report's branches.
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

    const startedInWindow = (ms: number) => ms >= window.since.getTime() && ms < window.before.getTime();
    // Nothing from an outage that started in the window can arrive before the window opened, and
    // the signed start narrows the receipts in the database rather than after loading them.
    // Accepted receipts passed intake's schema check, so they always carry a numeric start.
    const [receipts, reviews] = await Promise.all([
      this.prisma.terminalCommandReceipt.findMany({
        where: {
          tenantId,
          branchId: { in: branchIds },
          offlineSequence: { not: null },
          operation: { startsWith: OFFLINE_JOURNAL_OPERATION },
          recordedAt: { gte: window.since },
          command: { path: ["payload", "offlineStartedAt"], gte: window.since.getTime(), lt: window.before.getTime() },
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
        select: { branchId: true, terminalId: true, recordId: true, envelope: true, outcome: true, firstReceivedAt: true, lastReceivedAt: true },
      }),
    ]);

    type Draft = Omit<OfflineEntry, "staffUserId" | "saleRecorded" | "stockPending" | "notHonoured"> & { staffSignInId: string | null };
    const drafts: Draft[] = [];
    const accepted = new Set<string>();
    let unplacedEntries = 0;
    for (const r of receipts) {
      const parsed = parseEntry(r.command);
      accepted.add(r.commandId);
      if (!parsed) continue; // the JSON filter already required a start; nothing else is placeable
      const p = "entry" in parsed ? parsed.entry : null;
      const o = "entry" in parsed ? parsed.entry : parsed.outage;
      drafts.push({
        commandId: r.commandId,
        branchId: r.branchId,
        terminalId: r.terminalId,
        offlineSessionId: o.offlineSessionId,
        offlineStartedAt: new Date(o.offlineStartedAt),
        occurredAt: new Date(o.occurredAt ?? o.offlineStartedAt),
        kind: p?.kind ?? "unreadable",
        totalMinor: p?.kind === "ordinary_sale" && typeof p.totalMinor === "number" ? p.totalMinor : 0,
        syncedAt: r.recordedAt,
        receivedAt: r.recordedAt,
        review: null,
        unreadable: !p,
        staffSignInId: p?.staffSignInId ?? null,
      });
    }
    for (const r of reviews) {
      const parsed = parseEntry(r.envelope);
      const commandId = parsed ? ("entry" in parsed ? parsed.entry.commandId : parsed.outage.commandId) : null;
      // A held entry later accepted keeps its review row; the receipt is the one that counts.
      if (commandId && accepted.has(commandId)) continue;
      if (!parsed) {
        // It cannot be placed in an outage, so it is counted by when it arrived.
        if (r.lastReceivedAt < window.before) unplacedEntries += 1;
        continue;
      }
      const p = "entry" in parsed ? parsed.entry : null;
      const o = "entry" in parsed ? parsed.entry : parsed.outage;
      if (!startedInWindow(o.offlineStartedAt)) continue;
      if (commandId) accepted.add(commandId);
      drafts.push({
        commandId: commandId ?? r.recordId,
        branchId: r.branchId,
        terminalId: r.terminalId,
        offlineSessionId: o.offlineSessionId,
        offlineStartedAt: new Date(o.offlineStartedAt),
        occurredAt: new Date(o.occurredAt ?? o.offlineStartedAt),
        kind: p?.kind ?? "unreadable",
        totalMinor: p?.kind === "ordinary_sale" && typeof p.totalMinor === "number" ? p.totalMinor : 0,
        syncedAt: null,
        receivedAt: r.firstReceivedAt,
        review: r.outcome === "rejected" ? "rejected" : "held",
        unreadable: !p,
        staffSignInId: p?.staffSignInId ?? null,
      });
    }
    const inWindow = drafts.filter((d) => startedInWindow(d.offlineStartedAt.getTime()));
    if (!inWindow.length) return buildOfflineActivityReport([], emptyCtx, meta, unplacedEntries);

    const saleCommandIds = inWindow.filter((d) => d.kind === "ordinary_sale" && d.review === null).map((d) => d.commandId);
    const signInIds = [...new Set(inWindow.map((d) => d.staffSignInId).filter((id): id is string => !!id))];
    const [sales, notHonoured, signIns, terminals] = await Promise.all([
      saleCommandIds.length
        ? this.prisma.sale.findMany({
            where: { tenantId, branchId: { in: branchIds }, offlineCommandId: { in: saleCommandIds } },
            select: { offlineCommandId: true, stockPosting: true },
          })
        : Promise.resolve([]),
      // A sale entry with no sale is "not honoured" only when a manager settled it that way.
      saleCommandIds.length
        ? this.prisma.offlineJournalSettlement.findMany({
            where: {
              tenantId,
              branchId: { in: branchIds },
              commandId: { in: saleCommandIds },
              status: OfflineJournalSettlementStatus.settled,
              decision: OfflineJournalSettlementDecision.not_honoured,
            },
            select: { commandId: true },
          })
        : Promise.resolve([]),
      signInIds.length
        ? this.prisma.offlineStaffSignIn.findMany({
            where: { tenantId, branchId: { in: branchIds }, signInId: { in: signInIds } },
            select: { signInId: true, staffUserId: true },
          })
        : Promise.resolve([]),
      this.prisma.operationalTerminal.findMany({
        where: { tenantId, branchId: { in: branchIds }, id: { in: [...new Set(inWindow.map((d) => d.terminalId))] } },
        select: { id: true, label: true, counter: { select: { label: true } } },
      }),
    ]);
    const saleByCommand = new Map(sales.map((s) => [s.offlineCommandId!, s.stockPosting]));
    const notHonouredIds = new Set(notHonoured.map((s) => s.commandId));
    const staffBySignIn = new Map(signIns.map((s) => [s.signInId, s.staffUserId]));
    const people = await this.names(tenantId, [...staffBySignIn.values()]);
    const terminalById = new Map(terminals.map((t) => [t.id, { label: t.label, counterLabel: t.counter?.label ?? null }]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    const entries: OfflineEntry[] = inWindow.map(({ staffSignInId, ...d }) => {
      const posting = saleByCommand.get(d.commandId);
      return {
        ...d,
        staffUserId: staffSignInId ? (staffBySignIn.get(staffSignInId) ?? null) : null,
        saleRecorded: posting !== undefined,
        notHonoured: notHonouredIds.has(d.commandId),
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
      unplacedEntries,
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
