import { parseSalesReportQuery } from "./sales-report-query";

describe("parseSalesReportQuery", () => {
  it("parses dimension filters and reportGroupBy", () => {
    const parsed = parseSalesReportQuery({
      terminalId: "t1",
      shiftId: "s1",
      channel: "offline",
      offlineSyncState: "accepted",
      reportGroupBy: "terminal",
    });
    expect(parsed).toEqual({
      filters: {
        terminalId: "t1",
        shiftId: "s1",
        channel: "offline",
        offlineSyncState: "accepted",
      },
      groupBy: "terminal",
    });
  });

  it("ignores category groupBy — only reportGroupBy sets the dimensional breakdown", () => {
    expect(parseSalesReportQuery({ groupBy: "terminal" }).groupBy).toBeUndefined();
    expect(parseSalesReportQuery({ groupBy: "commercial", reportGroupBy: "shift" }).groupBy).toBe("shift");
  });

  it("rejects unknown channel", () => {
    expect(() => parseSalesReportQuery({ channel: "bogus" })).toThrow(/channel/);
  });
});