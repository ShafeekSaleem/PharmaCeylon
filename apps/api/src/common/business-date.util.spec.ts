import {
  businessDateKey,
  businessToday,
  daysBetween,
  safeTimeZone,
  startOfBusinessDay,
} from "./business-date.util";

describe("business dates", () => {
  it("rolls over to the next day at Colombo midnight, not UTC midnight", () => {
    // 18:29 UTC is 23:59 in Colombo; 18:31 UTC is already the next day there.
    expect(businessDateKey("Asia/Colombo", new Date("2026-09-15T18:29:00Z"))).toBe("2026-09-15");
    expect(businessDateKey("Asia/Colombo", new Date("2026-09-15T18:31:00Z"))).toBe("2026-09-16");
  });

  it("makes a batch expiring today count as expired from the pharmacy's midnight", () => {
    const expiresOn = new Date("2026-09-15T00:00:00Z"); // @db.Date value
    const justAfterColomboMidnight = new Date("2026-09-15T18:31:00Z");
    expect(expiresOn < businessToday("Asia/Colombo", justAfterColomboMidnight)).toBe(true);
    const justBefore = new Date("2026-09-15T18:29:00Z");
    expect(expiresOn < businessToday("Asia/Colombo", justBefore)).toBe(false);
  });

  it("falls back to Colombo when a tenant's timezone is not valid", () => {
    expect(safeTimeZone("Not/AZone")).toBe("Asia/Colombo");
    expect(safeTimeZone(null)).toBe("Asia/Colombo");
    expect(safeTimeZone("Europe/London")).toBe("Europe/London");
  });

  it("finds the instant a local day starts, for filtering timestamps", () => {
    expect(startOfBusinessDay("Asia/Colombo", "2026-09-16").toISOString()).toBe(
      "2026-09-15T18:30:00.000Z",
    );
  });

  it("counts whole days between calendar dates", () => {
    expect(daysBetween(new Date("2026-09-15T00:00:00Z"), new Date("2026-09-10T00:00:00Z"))).toBe(-5);
  });
});
