import { renderXReportHtml } from "./x-report-html";

const summary = {
  openingCashMinor: 500_000,
  cashTakenMinor: 3_000_000,
  changeGivenMinor: 42_000,
  cashRefundsMinor: 118_000,
  cashPaidOutMinor: 855_000,
  cashPaidInMinor: 0,
  expectedCashMinor: 2_485_000,
  saleCount: 3,
  salesTotalMinor: 4_000_000,
  firstSaleAt: null,
  lastSaleAt: null,
  takingsByMethod: [{ method: "cash", saleCount: 3, takenMinor: 2_958_000, refundedMinor: 118_000 }],
  takingsByHour: [{ hour: "2026-11-04T14", saleCount: 3, totalMinor: 4_000_000 }],
  refunds: [],
  cashMovements: [],
};
const input = {
  branchName: "Kollupitiya",
  counterLabel: "Counter 2",
  shiftNumber: "S-0412",
  staffName: "Sachini <b>R</b>",
  openedAt: "2026-11-04T02:32:00.000Z",
  printedAt: new Date("2026-11-04T09:02:00.000Z"),
  printedBy: "Sachini R",
  summary,
  current: true,
};

describe("the X report", () => {
  it("prints the shift's takings and expected cash, and says the shift stays open", () => {
    const html = renderXReportHtml(input);
    expect(html).toContain("X REPORT — SHIFT STILL OPEN");
    expect(html).toContain("S-0412");
    expect(html).toContain("Cash (3)");
    expect(html).toContain("29,580.00");
    expect(html).toContain("Expected in drawer</td><td>24,850.00");
    expect(html).toContain("14:00 (3)");
    expect(html).not.toContain("<b>R</b>");
    expect(html).not.toContain("NOT YET SYNCED");
  });

  it("says when the figures are the counter's last copy", () => {
    expect(renderXReportHtml({ ...input, current: false })).toContain("NOT YET SYNCED");
  });
});
