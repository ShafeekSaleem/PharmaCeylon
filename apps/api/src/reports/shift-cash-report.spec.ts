import { buildShiftCashReport, shiftCashRow, type ShiftCashInput } from "./shift-cash-report";

const amara = { id: "u-amara", name: "Amara" };
const nimal = { id: "u-nimal", name: "Nimal" };
const manager = { id: "u-mgr", name: "Manager" };

function shift(overrides: Partial<ShiftCashInput>): ShiftCashInput {
  return {
    id: "s-1",
    shiftNumber: "S-0001",
    branchId: "b-1",
    branchName: "Colombo",
    registerId: "r-1",
    counterLabel: "Counter 1",
    terminalId: "t-1",
    terminalLabel: "Front PC",
    staff: amara,
    openedAt: new Date("2026-11-20T03:00:00.000Z"),
    closedAt: new Date("2026-11-20T11:00:00.000Z"),
    openingCashMinor: 500_000,
    closingCashCountMinor: 1_150_000,
    expectedCashMinor: 1_200_000,
    counterExpectedCashMinor: null,
    varianceMinor: -50_000,
    closeKind: "self",
    closedBy: amara,
    assistanceReason: null,
    varianceNote: "Short one 500 note",
    openedOffline: false,
    closedOffline: false,
    cashTakenMinor: 900_000,
    changeGivenMinor: 100_000,
    cashRefundsMinor: 50_000,
    cashPaidOutMinor: 50_000,
    cashPaidInMinor: 0,
    saleCount: 12,
    salesTotalMinor: 1_400_000,
    ...overrides,
  };
}

const meta = {
  days: 30,
  timeZone: "Asia/Colombo",
  since: new Date("2026-10-28T18:30:00.000Z"),
  before: new Date("2026-11-27T18:30:00.000Z"),
  filters: {},
};

describe("shiftCashRow", () => {
  it("keeps the recorded expected cash and variance of a closed shift", () => {
    // The parts add up to 12,000.00, but 12,100.00 was recorded at close: the stored figure wins.
    const row = shiftCashRow(shift({ expectedCashMinor: 1_210_000, varianceMinor: -60_000 }));
    expect(row.status).toBe("closed");
    expect(row.expectedCashMinor).toBe(1_210_000);
    expect(row.countedCashMinor).toBe(1_150_000);
    expect(row.varianceMinor).toBe(-60_000);
  });

  it("computes a live expected cash for an open shift and leaves count and variance empty", () => {
    const row = shiftCashRow(
      shift({ closedAt: null, closingCashCountMinor: null, expectedCashMinor: null, varianceMinor: null, closeKind: null, closedBy: null }),
    );
    expect(row.status).toBe("open");
    // 5,000 + 9,000 − 1,000 − 500 − 500 + 0
    expect(row.expectedCashMinor).toBe(1_200_000);
    expect(row.countedCashMinor).toBeNull();
    expect(row.varianceMinor).toBeNull();
    expect(row.counterDifferenceMinor).toBeNull();
  });

  it("shows where the counter's expected figure differed from the server's", () => {
    expect(shiftCashRow(shift({ counterExpectedCashMinor: 1_205_000 })).counterDifferenceMinor).toBe(5_000);
    expect(shiftCashRow(shift({ counterExpectedCashMinor: 1_200_000 })).counterDifferenceMinor).toBe(0);
  });
});

describe("buildShiftCashReport", () => {
  const inputs = [
    shift({ id: "s-1", shiftNumber: "S-0001" }),
    shift({
      id: "s-2",
      shiftNumber: "S-0002",
      staff: nimal,
      registerId: "r-2",
      counterLabel: "Counter 2",
      openedAt: new Date("2026-11-21T03:00:00.000Z"),
      closedAt: new Date("2026-11-21T11:00:00.000Z"),
      closingCashCountMinor: 1_210_000,
      varianceMinor: 10_000,
      closeKind: "assisted",
      closedBy: manager,
      assistanceReason: "Went home sick",
      openedOffline: true,
      counterExpectedCashMinor: 1_190_000,
    }),
    shift({
      id: "s-3",
      shiftNumber: "S-0003",
      openedAt: new Date("2026-11-22T03:00:00.000Z"),
      closedAt: null,
      closingCashCountMinor: null,
      expectedCashMinor: null,
      varianceMinor: null,
      closeKind: null,
      closedBy: null,
      varianceNote: null,
    }),
  ];

  it("totals closed drawers and splits shortages from overages", () => {
    const report = buildShiftCashReport(inputs, meta);
    expect(report.kpis).toMatchObject({
      shifts: 3,
      closedShifts: 2,
      openShifts: 1,
      shiftsWithVariance: 2,
      assistedCloses: 1,
      shortMinor: 50_000,
      overMinor: 10_000,
      netVarianceMinor: -40_000,
      expectedCashMinor: 2_400_000,
      countedCashMinor: 2_360_000,
      offlineShifts: 1,
      counterDisagreements: 1,
    });
    // Cash taken is gross like each row, with change as its own total, across every shift in the
    // window, open ones included.
    expect(report.kpis.cashTakenMinor).toBe(3 * 900_000);
    expect(report.kpis.changeGivenMinor).toBe(3 * 100_000);
  });

  it("lists newest first and rolls up by staff and by counter, worst shortage first", () => {
    const report = buildShiftCashReport(inputs, meta);
    expect(report.shifts.map((s) => s.shiftNumber)).toEqual(["S-0003", "S-0002", "S-0001"]);
    expect(report.byStaff.map((s) => [s.name, s.shifts, s.shortMinor, s.overMinor])).toEqual([
      ["Amara", 2, 50_000, 0],
      ["Nimal", 1, 0, 10_000],
    ]);
    // The assisted close counts against the drawer's owner, not the manager who closed it.
    expect(report.byStaff.find((s) => s.staffUserId === nimal.id)?.assistedCloses).toBe(1);
    expect(report.byCounter.map((c) => [c.label, c.shifts])).toEqual([
      ["Counter 1", 2],
      ["Counter 2", 1],
    ]);
  });

  it("filters by counter and staff but offers every choice in the window", () => {
    const report = buildShiftCashReport(inputs, { ...meta, filters: { staffUserId: nimal.id } });
    expect(report.shifts.map((s) => s.shiftId)).toEqual(["s-2"]);
    expect(report.kpis.shifts).toBe(1);
    expect(report.options.staff.map((s) => s.name)).toEqual(["Amara", "Nimal"]);
    expect(report.options.registers.map((r) => r.label)).toEqual(["Counter 1", "Counter 2"]);

    const none = buildShiftCashReport(inputs, { ...meta, filters: { registerId: "r-unknown" } });
    expect(none.shifts).toEqual([]);
    expect(none.kpis.shifts).toBe(0);
  });

  it("returns an empty report with no shifts", () => {
    const report = buildShiftCashReport([], meta);
    expect(report.shifts).toEqual([]);
    expect(report.byStaff).toEqual([]);
    expect(report.kpis.shortMinor).toBe(0);
    expect(report.since).toBe(meta.since.toISOString());
  });
});
