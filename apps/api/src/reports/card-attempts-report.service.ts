import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  buildCardAttemptsReport,
  type CardAttemptEvent,
  type CardAttemptState,
  type CardAttemptsReportResponse,
} from "./card-attempts-report";
import { SalesReportScopeService } from "./sales-report-scope.service";

const CARD_STATES: ReadonlySet<string> = new Set(["prepared", "uncertain", "approved", "declined", "linked_to_sale", "not_used"]);

type SignedNotUsed = { settlement?: unknown; reversalReference?: unknown; reason?: unknown };

/** The `not_used` fields the counter signed; the record's own columns do not keep them. */
function notUsedFields(envelope: unknown): Pick<CardAttemptEvent, "settlement" | "reversalReference" | "reason"> {
  const payload = (envelope as { payload?: SignedNotUsed } | null)?.payload ?? {};
  const settlement = payload.settlement === "reversed_on_machine" || payload.settlement === "refund_owed" ? payload.settlement : null;
  return {
    settlement,
    reversalReference: typeof payload.reversalReference === "string" ? payload.reversalReference : null,
    reason: typeof payload.reason === "string" ? payload.reason : null,
  };
}

/**
 * Loads the external card attempts with an event recorded in the report window, every event of
 * those attempts (so one that began just before the window still reads to its end), and the card
 * money of offline sales a manager did not honour. Scoped by tenant and the report's branches.
 */
@Injectable()
export class CardAttemptsReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SalesReportScopeService,
  ) {}

  async report(tenantId: string, branchId: string | null, days: number): Promise<CardAttemptsReportResponse> {
    const window = await this.scope.reportWindow(tenantId, branchId, days);
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
      select: { id: true, name: true },
    });
    const meta = { days, timeZone: window.timeZone, since: window.since, before: window.before };
    const branchIds = branches.map((b) => b.id);
    const emptyCtx = { branchName: () => "", terminal: () => ({ label: null, counterLabel: null }), staff: () => null, sale: () => null };
    if (!branchIds.length) return buildCardAttemptsReport([], emptyCtx, [], meta);

    const inWindow = { gte: window.since, lt: window.before };
    const [touched, collected] = await Promise.all([
      this.prisma.offlineSupportRecord.findMany({
        where: { tenantId, branchId: { in: branchIds }, kind: "external_card_attempt", recordedAt: inWindow, attemptId: { not: null } },
        select: { attemptId: true },
        distinct: ["attemptId"],
      }),
      this.prisma.offlineCollectedPayment.findMany({
        where: { tenantId, branchId: { in: branchIds }, collectedAt: inWindow },
        select: { amountMinor: true },
      }),
    ]);
    const collectedNotSold = collected.map((c) => ({ amountMinor: Number(c.amountMinor) }));
    const attemptIds = touched.map((t) => t.attemptId!).filter(Boolean);
    if (!attemptIds.length) return buildCardAttemptsReport([], emptyCtx, collectedNotSold, meta);

    const rows = await this.prisma.offlineSupportRecord.findMany({
      where: { tenantId, branchId: { in: branchIds }, kind: "external_card_attempt", attemptId: { in: attemptIds } },
      select: {
        attemptId: true,
        recordId: true,
        branchId: true,
        terminalId: true,
        workSessionId: true,
        cardState: true,
        amountMinor: true,
        providerReference: true,
        approvalCode: true,
        approvedAt: true,
        saleCommandId: true,
        recordedAt: true,
        status: true,
        heldReason: true,
        envelope: true,
      },
    });
    const events: CardAttemptEvent[] = rows
      .filter((r) => r.cardState && CARD_STATES.has(r.cardState))
      .map((r) => ({
        attemptId: r.attemptId!,
        recordId: r.recordId,
        branchId: r.branchId,
        terminalId: r.terminalId,
        workSessionId: r.workSessionId,
        state: r.cardState as CardAttemptState,
        amountMinor: Number(r.amountMinor ?? 0n),
        providerReference: r.providerReference,
        approvalCode: r.approvalCode,
        approvedAt: r.approvedAt,
        saleCommandId: r.saleCommandId,
        recordedAt: r.recordedAt,
        status: r.status === "accepted" || r.status === "rejected" ? r.status : "held",
        heldReason: r.heldReason,
        ...(r.cardState === "not_used" ? notUsedFields(r.envelope) : { settlement: null, reversalReference: null, reason: null }),
      }));

    const terminalIds = [...new Set(events.map((e) => e.terminalId))];
    const sessionIds = [...new Set(events.map((e) => e.workSessionId))];
    const commandIds = [...new Set(events.map((e) => e.saleCommandId).filter((id): id is string => !!id))];
    const [terminals, onlineSessions, offlineSignIns, sales] = await Promise.all([
      this.prisma.operationalTerminal.findMany({
        where: { tenantId, branchId: { in: branchIds }, id: { in: terminalIds } },
        select: { id: true, label: true, counter: { select: { label: true } } },
      }),
      this.prisma.terminalStaffSession.findMany({
        where: { tenantId, branchId: { in: branchIds }, id: { in: sessionIds } },
        select: { id: true, staffUserId: true },
      }),
      this.prisma.offlineStaffSignIn.findMany({
        where: { tenantId, branchId: { in: branchIds }, workSessionId: { in: sessionIds } },
        select: { workSessionId: true, staffUserId: true },
      }),
      commandIds.length
        ? this.prisma.sale.findMany({
            where: { tenantId, branchId: { in: branchIds }, offlineCommandId: { in: commandIds } },
            select: { id: true, invoiceNo: true, offlineCommandId: true },
          })
        : Promise.resolve([]),
    ]);
    const staffBySession = new Map<string, string>();
    for (const s of offlineSignIns) staffBySession.set(s.workSessionId, s.staffUserId);
    for (const s of onlineSessions) staffBySession.set(s.id, s.staffUserId);
    const people = await this.names(tenantId, [...staffBySession.values()]);
    const terminalById = new Map(terminals.map((t) => [t.id, { label: t.label, counterLabel: t.counter?.label ?? null }]));
    const saleByCommand = new Map(sales.map((s) => [s.offlineCommandId!, { id: s.id, invoiceNo: s.invoiceNo }]));
    const branchName = new Map(branches.map((b) => [b.id, b.name]));

    return buildCardAttemptsReport(
      events,
      {
        branchName: (id) => branchName.get(id) ?? "",
        terminal: (id) => terminalById.get(id) ?? { label: null, counterLabel: null },
        staff: (sessionId) => {
          const userId = staffBySession.get(sessionId);
          return userId ? { id: userId, name: people.get(userId) ?? "Unknown" } : null;
        },
        sale: (commandId) => saleByCommand.get(commandId) ?? null,
      },
      collectedNotSold,
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
