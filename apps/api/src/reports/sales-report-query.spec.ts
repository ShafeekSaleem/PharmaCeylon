import { parseSalesReportQuery } from "./sales-report-query";

describe("parseSalesReportQuery", () => {
  it("parses dimension filters and groupBy", () => {
    const parsed = parseSalesReportQuery({
      terminalId: "t1",
      shiftId: "s1",
      channel: "offline",
      offlineSyncState: "accepted",
      groupBy: "terminal",
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

  it("rejects unknown channel", () => {
    expect(() => parseSalesReportQuery({ channel: "bogus" })).toThrow(/channel/);
  });
});