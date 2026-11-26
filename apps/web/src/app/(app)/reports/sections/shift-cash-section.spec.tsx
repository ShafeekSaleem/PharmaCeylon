import { render, screen, waitFor } from "@testing-library/react";
import type { ShiftCashReportResponse, ShiftCashRow } from "../lib/types";
import { DrawerBreakdown, ShiftCashSection, signedMoney } from "./shift-cash-section";
import { fetchShiftCashReport } from "../lib/fetchers";

jest.mock("../lib/fetchers", () => ({ fetchShiftCashReport: jest.fn() }));

const ZONE = "Asia/Colombo";

const row = (over: Partial<ShiftCashRow> = {}): ShiftCashRow => ({
  shiftId: "s1",
  shiftNumber: "S-0412",
  branchId: "b1",
  branchName: "Kandy",
  registerId: "r1",
  counterLabel: "Counter 1",
  terminalId: "t1",
  terminalLabel: "FRONT-PC",
  staff: { id: "u1", name: "Amara" },
  status: "closed",
  openedAt: "2026-11-25T03:00:00.000Z",
  closedAt: "2026-11-25T11:00:00.000Z",
  openingCashMinor: 500_000,
  cashTakenMinor: 200_000,
  changeGivenMinor: 100_000,
  cashRefundsMinor: 20_000,
  cashPaidOutMinor: 30_000,
  cashPaidInMinor: 0,
  expectedCashMinor: 550_000,
  countedCashMinor: 540_000,
  varianceMinor: -10_000,
  counterExpectedCashMinor: null,
  counterDifferenceMinor: null,
  saleCount: 1,
  salesTotalMinor: 100_000,
  closeKind: "self",
  closedBy: { id: "u1", name: "Amara" },
  assistanceReason: null,
  varianceNote: "Short 100",
  openedOffline: false,
  closedOffline: false,
  ...over,
});

const totals = { shifts: 2, closedShifts: 2, openShifts: 0, shiftsWithVariance: 2, assistedCloses: 1, shortMinor: 10_000, overMinor: 5_000, netVarianceMinor: -5_000 };

const response = (shifts: ShiftCashRow[]): ShiftCashReportResponse => ({
  days: 7,
  timeZone: ZONE,
  since: "2026-11-19T18:30:00.000Z",
  before: "2026-11-26T18:30:00.000Z",
  filters: {},
  kpis: {
    ...totals,
    expectedCashMinor: 650_000,
    countedCashMinor: 645_000,
    cashTakenMinor: 100_000,
    cashRefundsMinor: 20_000,
    cashPaidOutMinor: 30_000,
    cashPaidInMinor: 0,
    offlineShifts: 1,
    counterDisagreements: 0,
  },
  byStaff: [{ ...totals, staffUserId: "u1", name: "Amara" }],
  byCounter: [{ ...totals, registerId: "r1", label: "Counter 1", branchId: "b1", branchName: "Kandy" }],
  shifts,
  options: { registers: [{ id: "r1", label: "Counter 1", branchName: "Kandy" }], staff: [{ id: "u1", name: "Amara" }] },
});

describe("signedMoney", () => {
  it("signs shortages and overages", () => {
    expect(signedMoney(-10_000)).toMatch(/^−LKR 100\.00$/);
    expect(signedMoney(5_000)).toMatch(/^\+LKR 50\.00$/);
    expect(signedMoney(0)).toBe("LKR 0.00");
    expect(signedMoney(null)).toBe("—");
  });
});

describe("DrawerBreakdown", () => {
  it("adds the drawer up line by line to the counted difference", () => {
    render(<DrawerBreakdown shift={row()} timeZone={ZONE} />);
    expect(screen.getByText("Opening float").nextSibling).toHaveTextContent("+ LKR 5,000.00");
    expect(screen.getByText("Change given").nextSibling).toHaveTextContent("− LKR 1,000.00");
    expect(screen.getByText("Expected").nextSibling).toHaveTextContent("LKR 5,500.00");
    expect(screen.getByText("Counted").nextSibling).toHaveTextContent("LKR 5,400.00");
    expect(screen.getByText("Difference").nextSibling).toHaveTextContent("−LKR 100.00");
    expect(screen.getByText("Note: Short 100")).toBeInTheDocument();
  });

  it("says who closed an absent cashier's shift and that it came from an offline counter", () => {
    render(
      <DrawerBreakdown
        shift={row({ closeKind: "assisted", closedBy: { id: "m1", name: "Nimal" }, assistanceReason: "Went home sick", closedOffline: true, counterExpectedCashMinor: 555_000, counterDifferenceMinor: 5_000 })}
        timeZone={ZONE}
      />,
    );
    expect(screen.getByText(/Closed by Nimal for Amara: Went home sick/)).toBeInTheDocument();
    expect(screen.getByText(/Closed on the counter while it was offline/)).toBeInTheDocument();
    expect(screen.getByText(/The counter expected LKR 5,550\.00/)).toBeInTheDocument();
  });

  it("shows a live expected figure and no count for an open shift", () => {
    render(<DrawerBreakdown shift={row({ status: "open", closedAt: null, countedCashMinor: null, varianceMinor: null })} timeZone={ZONE} />);
    expect(screen.getByText("Expected now")).toBeInTheDocument();
    expect(screen.queryByText("Counted")).not.toBeInTheDocument();
  });
});

describe("ShiftCashSection", () => {
  it("loads the report, shows the totals and hands the shifts to CSV export", async () => {
    (fetchShiftCashReport as jest.Mock).mockResolvedValue(
      response([row(), row({ shiftId: "s2", shiftNumber: "S-0413", closeKind: "assisted", varianceMinor: 5_000, openedOffline: true })]),
    );
    const onExportData = jest.fn();
    render(<ShiftCashSection scope="branch" isOwner={false} days={7} onExportData={onExportData} />);

    expect(await screen.findByText("LKR 6,450.00")).toBeInTheDocument();
    expect(screen.getByText("Expected LKR 6,500.00")).toBeInTheDocument();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(fetchShiftCashReport).toHaveBeenCalledWith(7, "branch", false, { registerId: undefined, staffUserId: undefined });

    await waitFor(() => expect(onExportData).toHaveBeenLastCalledWith(expect.objectContaining({ filename: "shift-cash-7d.csv" })));
    const payload = onExportData.mock.calls.at(-1)![0];
    expect(payload.rows).toHaveLength(2);
    expect(payload.headers).toContain("Difference");
    expect(payload.rows[0][payload.headers.indexOf("Difference")]).toBe("-100.00");
    expect(payload.rows[1][payload.headers.indexOf("Offline")]).toBe("Yes");
  });
});
