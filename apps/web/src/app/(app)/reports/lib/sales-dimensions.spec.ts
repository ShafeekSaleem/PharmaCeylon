import { dimensionsActive, dimensionsQs } from "./sales-dimensions";

describe("sales dimensions", () => {
  it("adds only the set dimensions to the query", () => {
    expect(dimensionsQs(undefined)).toBe("");
    expect(dimensionsQs({})).toBe("");
    expect(dimensionsQs({ registerId: "r1", channel: "offline", offlineSyncState: "held" })).toBe(
      "&registerId=r1&channel=offline&offlineSyncState=held",
    );
    expect(dimensionsQs({ shiftId: "s 1" })).toBe("&shiftId=s+1");
  });

  it("knows when a report is narrowed", () => {
    expect(dimensionsActive(undefined)).toBe(false);
    expect(dimensionsActive({})).toBe(false);
    expect(dimensionsActive({ channel: "fallback" })).toBe(true);
  });
});
