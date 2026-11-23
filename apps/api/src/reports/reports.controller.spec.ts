import { parseSalesReportQuery } from "./sales-report-query";

/** Matches how `ReportsController` passes sales routes through `parseSalesReportQuery`. */
describe("ReportsController sales report query wiring", () => {
  it("uses reportGroupBy for dimensional breakdown on sales routes", () => {
    const parsed = parseSalesReportQuery({
      reportGroupBy: "channel",
      terminalId: "00000000-0000-4000-8000-000000000001",
    });
    expect(parsed.groupBy).toBe("channel");
    expect(parsed.filters.terminalId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("does not treat category groupBy as reportGroupBy", () => {
    expect(parseSalesReportQuery({ groupBy: "commercial", reportGroupBy: "terminal" }).groupBy).toBe("terminal");
    expect(parseSalesReportQuery({ groupBy: "terminal" }).groupBy).toBeUndefined();
  });
});