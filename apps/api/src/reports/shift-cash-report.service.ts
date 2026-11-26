import { Injectable } from "@nestjs/common";
import { PaymentMethod, SaleStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { toMinor } from "../terminals/shifts/till-shift-math";
import { SalesReportScopeService } from "./sales-report-scope.service";
import {
  buildShiftCashReport,
  type ShiftCashFilters,
  type ShiftCashInput,
  type ShiftCashReportResponse,
} from "./shift-cash-report";

/** Sums keyed by shift id from a Prisma `groupBy`. */
function sumByShift<T extends { shiftId: string | null }>(rows: T[], pick: (row: T) => number): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) if (row.shiftId) out.set(row.shiftId, (out.get(row.shiftId) ?? 0) + pick(row));
  return out;
}

/**
 * Loads the till shifts opened in the report window and the drawer sums behind each one, with
 * the same rules as the counter's X report (`TillShiftsService.parts`): cash payments on the
 * shift (refunds are its negative payments), change given on its sales, and drawer movements;
 * voided sales are left out. Everything is filtered by tenant and the report's branch scope.
 */
@Injectable()
export class ShiftCashReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: SalesReportScopeService,
  ) {}

  async report(
    tenantId: string,
    branchId: string | null,
    days: number,
    filters: ShiftCashFilters = {},
  ): Promise<ShiftCashReportResponse> {
    const window = await this.scope.reportWindow(tenantId, branchId, days);
    const branches = await this.prisma.branch.findMany({
      where: { tenantId, ...(branchId ? { id: branchId } : { isActive: true }) },
      select: { id: true, name: true },
    });
    const branchName = new Map(branches.map((b) => [b.id, b.name]));
    const meta = { days, timeZone: window.timeZone, since: window.since, before: window.before, filters };
    if (!branches.length) return buildShiftCashReport([], meta);

    const shifts = await this.prisma.tillShift.findMany({
      where: {
        tenantId,
        branchId: { in: branches.map((b) => b.id) },
        openedAt: { gte: window.since, lt: window.before },
      },
      include: { counter: { select: { label: true } } },
    });
    if (!shifts.length) return buildShiftCashReport([], meta);

    const shiftIds = shifts.map((s) => s.id);
    const notVoided = { status: { not: SaleStatus.voided } };
    const [cashIn, cashOut, sales, movements, terminals, people] = await Promise.all([
      this.prisma.salePayment.groupBy({
        by: ["shiftId"],
        where: { tenantId, shiftId: { in: shiftIds }, method: PaymentMethod.cash, amount: { gt: 0 }, sale: notVoided },
        _sum: { amount: true },
      }),
      this.prisma.salePayment.groupBy({
        by: ["shiftId"],
        where: { tenantId, shiftId: { in: shiftIds }, method: PaymentMethod.cash, amount: { lt: 0 }, sale: notVoided },
        _sum: { amount: true },
      }),
      this.prisma.sale.groupBy({
        by: ["shiftId"],
        where: { tenantId, shiftId: { in: shiftIds }, ...notVoided },
        _sum: { changeDue: true, grandTotal: true },
        _count: { _all: true },
      }),
      this.prisma.tillCashMovement.groupBy({
        by: ["shiftId", "direction"],
        where: { tenantId, shiftId: { in: shiftIds } },
        _sum: { amountMinor: true },
      }),
      this.prisma.operationalTerminal.findMany({
        where: { tenantId, id: { in: [...new Set(shifts.map((s) => s.terminalId))] } },
        select: { id: true, label: true },
      }),
      this.names(
        tenantId,
        shifts.flatMap((s) => [s.staffUserId, s.closedByUserId].filter((id): id is string => !!id)),
      ),
    ]);

    const taken = sumByShift(cashIn, (r) => toMinor(r._sum.amount));
    const refunded = sumByShift(cashOut, (r) => -toMinor(r._sum.amount));
    const changeGiven = sumByShift(sales, (r) => toMinor(r._sum.changeDue));
    const salesTotal = sumByShift(sales, (r) => toMinor(r._sum.grandTotal));
    const saleCount = sumByShift(sales, (r) => r._count._all);
    const paidOut = sumByShift(
      movements.filter((m) => m.direction === "out"),
      (r) => r._sum.amountMinor ?? 0,
    );
    const paidIn = sumByShift(
      movements.filter((m) => m.direction === "in"),
      (r) => r._sum.amountMinor ?? 0,
    );
    const terminalLabel = new Map(terminals.map((t) => [t.id, t.label]));
    const person = (id: string) => ({ id, name: people.get(id) ?? "Unknown" });

    const inputs: ShiftCashInput[] = shifts.map((s) => ({
      id: s.id,
      shiftNumber: s.shiftNumber,
      branchId: s.branchId,
      branchName: branchName.get(s.branchId) ?? "",
      registerId: s.registerId,
      counterLabel: s.counter.label,
      terminalId: s.terminalId,
      terminalLabel: terminalLabel.get(s.terminalId) ?? null,
      staff: person(s.staffUserId),
      openedAt: s.openedAt,
      closedAt: s.closedAt,
      openingCashMinor: s.openingCashMinor,
      closingCashCountMinor: s.closingCashCountMinor,
      expectedCashMinor: s.expectedCashMinor,
      counterExpectedCashMinor: s.counterExpectedCashMinor,
      varianceMinor: s.varianceMinor,
      closeKind: s.closeKind,
      closedBy: s.closedByUserId ? person(s.closedByUserId) : null,
      assistanceReason: s.assistanceReason,
      varianceNote: s.varianceNote,
      openedOffline: s.openCommandId !== null,
      closedOffline: s.closedSignInId !== null,
      cashTakenMinor: taken.get(s.id) ?? 0,
      changeGivenMinor: changeGiven.get(s.id) ?? 0,
      cashRefundsMinor: refunded.get(s.id) ?? 0,
      cashPaidOutMinor: paidOut.get(s.id) ?? 0,
      cashPaidInMinor: paidIn.get(s.id) ?? 0,
      saleCount: saleCount.get(s.id) ?? 0,
      salesTotalMinor: salesTotal.get(s.id) ?? 0,
    }));
    return buildShiftCashReport(inputs, meta);
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
