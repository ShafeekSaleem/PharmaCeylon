import { randomUUID } from "node:crypto";
import { PaymentMethod, Prisma, SaleStatus } from "@prisma/client";
import { SalesReportScopeService } from "../../src/reports/sales-report-scope.service";
import { ShiftCashReportService } from "../../src/reports/shift-cash-report.service";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/**
 * W10 #72: the shift and cash reconciliation report reads real till shifts, sales, payments and
 * drawer movements, scoped to the tenant and branch, with the X report's cash rules.
 */
const prisma = createPrisma();
const report = new ShiftCashReportService(prisma as never, new SalesReportScopeService(prisma as never));

let fx: TenantFixture;
let other: TenantFixture;
let counterId: string;
let closedShiftId: string;
let assistedShiftId: string;
let openShiftId: string;
let otherBranchShiftId: string;
let oldShiftId: string;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function counter(tenantId: string, branchId: string, label: string) {
  const row = await prisma.terminalCounter.create({ data: { tenantId, branchId, label } });
  const terminal = await prisma.operationalTerminal.create({
    data: { tenantId, branchId, label: `${label} PC`, registerId: row.id, tillId: row.tillId },
  });
  return { id: row.id, tillId: row.tillId, terminalId: terminal.id };
}

type ShiftSpec = {
  tenantId: string;
  branchId: string;
  counter: { id: string; tillId: string; terminalId: string };
  staffUserId: string;
  openedAt: Date;
  openingCashMinor: number;
  close?: {
    at: Date;
    countedMinor: number;
    expectedMinor: number;
    counterExpectedMinor?: number;
    byUserId?: string;
    reason?: string;
    note?: string;
  };
};

async function shift(spec: ShiftSpec): Promise<string> {
  const id = randomUUID();
  const assisted = spec.close?.byUserId && spec.close.byUserId !== spec.staffUserId;
  await prisma.tillShift.create({
    data: {
      id,
      tenantId: spec.tenantId,
      branchId: spec.branchId,
      shiftNumber: `S-R${id.slice(0, 8)}`,
      registerId: spec.counter.id,
      tillId: spec.counter.tillId,
      terminalId: spec.counter.terminalId,
      enrollmentId: randomUUID(),
      staffUserId: spec.staffUserId,
      openedStaffSessionId: randomUUID(),
      openedAt: spec.openedAt,
      openingCashMinor: spec.openingCashMinor,
      openingCount: [],
      ...(spec.close
        ? {
            closedAt: spec.close.at,
            closingCashCountMinor: spec.close.countedMinor,
            closingCount: [],
            expectedCashMinor: spec.close.expectedMinor,
            counterExpectedCashMinor: spec.close.counterExpectedMinor ?? null,
            varianceMinor: spec.close.countedMinor - spec.close.expectedMinor,
            closedByUserId: spec.close.byUserId ?? spec.staffUserId,
            closedStaffSessionId: randomUUID(),
            closeCommandId: randomUUID(),
            closeKind: assisted ? "assisted" : "self",
            assistanceReason: assisted ? spec.close.reason ?? "Cashier left" : null,
            varianceNote: spec.close.note ?? null,
          }
        : {}),
    },
  });
  return id;
}

async function cashSale(
  tenantId: string,
  branchId: string,
  shiftId: string,
  soldBy: string,
  rupees: { total: string; tendered: string; change: string },
  status: SaleStatus = SaleStatus.posted,
) {
  const sale = await prisma.sale.create({
    data: {
      tenantId,
      branchId,
      shiftId,
      invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      subtotal: new Prisma.Decimal(rupees.total),
      grandTotal: new Prisma.Decimal(rupees.total),
      changeDue: new Prisma.Decimal(rupees.change),
      soldBy,
      status,
    },
  });
  await prisma.salePayment.create({
    data: { tenantId, saleId: sale.id, shiftId, method: PaymentMethod.cash, amount: new Prisma.Decimal(rupees.tendered) },
  });
  return sale.id;
}

beforeAll(async () => {
  fx = await createTenant(prisma, "shift-cash");
  other = await createTenant(prisma, "shift-cash-other");
  const main = await counter(fx.tenantId, fx.mainBranchId, "Counter 1");
  counterId = main.id;
  const galle = await counter(fx.tenantId, fx.otherBranchId, "Galle 1");
  const foreign = await counter(other.tenantId, other.mainBranchId, "Foreign 1");

  // Clerk's shift: 5,000 float, one 1,000 sale paid with 2,000 (1,000 change), one cash refund of
  // 200, a 300 supplier payout, and a voided sale that must not count. Expected 5,500, counted 5,400.
  closedShiftId = await shift({
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    counter: main,
    staffUserId: fx.clerkId,
    openedAt: hoursAgo(10),
    openingCashMinor: 500_000,
    close: { at: hoursAgo(6), countedMinor: 540_000, expectedMinor: 550_000, counterExpectedMinor: 550_000, note: "Short 100" },
  });
  const saleId = await cashSale(fx.tenantId, fx.mainBranchId, closedShiftId, fx.clerkId, {
    total: "1000.00",
    tendered: "2000.00",
    change: "1000.00",
  });
  await prisma.salePayment.create({
    data: { tenantId: fx.tenantId, saleId, shiftId: closedShiftId, method: PaymentMethod.cash, amount: new Prisma.Decimal("-200.00") },
  });
  await cashSale(
    fx.tenantId,
    fx.mainBranchId,
    closedShiftId,
    fx.clerkId,
    { total: "700.00", tendered: "700.00", change: "0.00" },
    SaleStatus.voided,
  );
  await prisma.tillCashMovement.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      shiftId: closedShiftId,
      direction: "out",
      amountMinor: 30_000,
      reason: "Supplier payout",
      recordedBy: fx.clerkId,
    },
  });

  // The manager closed the owner's absent shift; 50 over.
  assistedShiftId = await shift({
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    counter: main,
    staffUserId: fx.ownerId,
    openedAt: hoursAgo(5),
    openingCashMinor: 100_000,
    close: { at: hoursAgo(3), countedMinor: 105_000, expectedMinor: 100_000, byUserId: fx.managerId, reason: "Went home" },
  });

  // Still open: 1,000 float and a 250 cash sale, so 1,250 expected live.
  openShiftId = await shift({
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    counter: main,
    staffUserId: fx.clerkId,
    openedAt: hoursAgo(2),
    openingCashMinor: 100_000,
  });
  await cashSale(fx.tenantId, fx.mainBranchId, openShiftId, fx.clerkId, { total: "250.00", tendered: "250.00", change: "0.00" });

  otherBranchShiftId = await shift({
    tenantId: fx.tenantId,
    branchId: fx.otherBranchId,
    counter: galle,
    staffUserId: fx.managerId,
    openedAt: hoursAgo(4),
    openingCashMinor: 0,
  });

  // Opened long before the window.
  oldShiftId = await shift({
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    counter: main,
    staffUserId: fx.clerkId,
    openedAt: hoursAgo(24 * 20),
    openingCashMinor: 0,
    close: { at: hoursAgo(24 * 20 - 1), countedMinor: 0, expectedMinor: 0 },
  });

  await shift({
    tenantId: other.tenantId,
    branchId: other.mainBranchId,
    counter: foreign,
    staffUserId: other.clerkId,
    openedAt: hoursAgo(3),
    openingCashMinor: 999_900,
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("shift cash report", () => {
  it("adds up each drawer the way the counter's X report does", async () => {
    const res = await report.report(fx.tenantId, fx.mainBranchId, 7);
    const closed = res.shifts.find((s) => s.shiftId === closedShiftId)!;
    expect(closed).toMatchObject({
      status: "closed",
      counterLabel: "Counter 1",
      terminalLabel: "Counter 1 PC",
      openingCashMinor: 500_000,
      cashTakenMinor: 200_000,
      changeGivenMinor: 100_000,
      cashRefundsMinor: 20_000,
      cashPaidOutMinor: 30_000,
      cashPaidInMinor: 0,
      expectedCashMinor: 550_000,
      countedCashMinor: 540_000,
      varianceMinor: -10_000,
      counterDifferenceMinor: 0,
      saleCount: 1,
      salesTotalMinor: 100_000,
      varianceNote: "Short 100",
    });
    expect(closed.staff.id).toBe(fx.clerkId);
    // Opening + taken − change − refunds − paid out is the recorded expected figure.
    expect(
      closed.openingCashMinor + closed.cashTakenMinor - closed.changeGivenMinor - closed.cashRefundsMinor - closed.cashPaidOutMinor,
    ).toBe(closed.expectedCashMinor);

    const open = res.shifts.find((s) => s.shiftId === openShiftId)!;
    expect(open).toMatchObject({ status: "open", expectedCashMinor: 125_000, countedCashMinor: null, varianceMinor: null });

    const assisted = res.shifts.find((s) => s.shiftId === assistedShiftId)!;
    expect(assisted).toMatchObject({ closeKind: "assisted", assistanceReason: "Went home", varianceMinor: 5_000 });
    expect(assisted.staff.id).toBe(fx.ownerId);
    expect(assisted.closedBy?.id).toBe(fx.managerId);
  });

  it("keeps to the branch, the tenant and the window", async () => {
    const res = await report.report(fx.tenantId, fx.mainBranchId, 7);
    const ids = res.shifts.map((s) => s.shiftId);
    expect(ids).toEqual([openShiftId, assistedShiftId, closedShiftId]);
    expect(ids).not.toContain(otherBranchShiftId);
    expect(ids).not.toContain(oldShiftId);
    expect(res.kpis).toMatchObject({
      shifts: 3,
      closedShifts: 2,
      openShifts: 1,
      shortMinor: 10_000,
      overMinor: 5_000,
      netVarianceMinor: -5_000,
      assistedCloses: 1,
    });

    const tenantWide = await report.report(fx.tenantId, null, 7);
    expect(tenantWide.shifts.map((s) => s.shiftId)).toContain(otherBranchShiftId);
    expect(tenantWide.shifts.every((s) => s.branchId === fx.mainBranchId || s.branchId === fx.otherBranchId)).toBe(true);

    const wider = await report.report(fx.tenantId, fx.mainBranchId, 30);
    expect(wider.shifts.map((s) => s.shiftId)).toContain(oldShiftId);
  });

  it("filters by counter and by staff member", async () => {
    const byStaff = await report.report(fx.tenantId, fx.mainBranchId, 7, { staffUserId: fx.ownerId });
    expect(byStaff.shifts.map((s) => s.shiftId)).toEqual([assistedShiftId]);
    expect(byStaff.options.staff.map((s) => s.id).sort()).toEqual([fx.clerkId, fx.ownerId].sort());

    const byCounter = await report.report(fx.tenantId, fx.mainBranchId, 7, { registerId: counterId });
    expect(byCounter.shifts).toHaveLength(3);
    expect(byCounter.byCounter).toEqual([expect.objectContaining({ registerId: counterId, shifts: 3 })]);
  });

  it("shows nothing from another tenant's branch id", async () => {
    const res = await report.report(fx.tenantId, other.mainBranchId, 7);
    expect(res.shifts).toEqual([]);
  });
});
