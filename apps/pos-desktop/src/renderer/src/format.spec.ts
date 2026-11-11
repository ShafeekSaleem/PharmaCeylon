import { describe, expect, it } from "@jest/globals";
import { longDayColombo, timeColomboWithSeconds, timeWithSeconds } from "./format";

describe("Colombo tooltip times", () => {
  it("formats in Asia/Colombo even when Jest pins UTC", () => {
    const at = new Date("2026-11-11T09:14:05.000Z");
    expect(timeWithSeconds(at)).toBe("09:14:05");
    expect(timeColomboWithSeconds(at)).toBe("14:44:05");
    expect(longDayColombo(at)).toContain("11 November 2026");
  });
});
