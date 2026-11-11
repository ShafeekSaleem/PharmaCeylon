import { afterEach, describe, expect, it } from "@jest/globals";
import { longDayColombo, timeColomboWithSeconds, timeWithSeconds } from "./format";

describe("Colombo tooltip times", () => {
  const prevTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = prevTz;
  });

  it("formats server-checked wall clock in Asia/Colombo (Jest default TZ=UTC)", () => {
    const at = new Date("2026-11-11T09:14:05.000Z");
    expect(timeWithSeconds(at)).toBe("09:14:05");
    expect(timeColomboWithSeconds(at)).toBe("14:44:05");
    expect(longDayColombo(at)).toContain("11 November 2026");
  });

  it("uses an explicit Asia/Colombo zone for tooltips, not the status-bar local clock", () => {
    const at = new Date("2026-11-11T09:14:05.000Z");
    expect(timeWithSeconds(at)).toBe("09:14:05");
    expect(timeColomboWithSeconds(at)).toBe("14:44:05");
    expect(timeWithSeconds(at)).not.toBe(timeColomboWithSeconds(at));
  });
});
