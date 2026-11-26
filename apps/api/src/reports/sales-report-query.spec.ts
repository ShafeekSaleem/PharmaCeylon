import { parseReportDays, parseSalesReportQuery } from "./sales-report-query";

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

describe("parseReportDays", () => {
  it("keeps a whole number of days within the bound and falls back on anything else", () => {
    expect(parseReportDays(undefined)).toBe(30);
    expect(parseReportDays("")).toBe(30);
    expect(parseReportDays("abc")).toBe(30);
    expect(parseReportDays("0")).toBe(30);
    expect(parseReportDays("-5")).toBe(30);
    expect(parseReportDays("7.9")).toBe(7);
    expect(parseReportDays("180")).toBe(180);
    expect(parseReportDays("99999")).toBe(731);
    expect(parseReportDays(undefined, 90)).toBe(90);
  });
});
