import type { BranchHours, DayHours } from "@pharmaceylon/shared";
import { evaluateOperatingHours } from "./operating-hours";
import { OperatingHoursEvidence, OPERATIONS_WITHOUT_SELLING_HOURS } from "./operating-hours.evidence";
import { MandatoryOperationEvidence } from "../security/mandatory-operation-evidence";

const COLOMBO = "Asia/Colombo"; // UTC+05:30, no DST
const nineToSix: DayHours = { mode: "hours", ranges: [{ opens: "09:00", closes: "18:00" }] };
const closed: DayHours = { mode: "closed" };
function hours(overrides: Partial<BranchHours> = {}): BranchHours {
  return {
    schemaVersion: 1,
    weekly: { mon: nineToSix, tue: nineToSix, wed: nineToSix, thu: nineToSix, fri: nineToSix, sat: nineToSix, sun: closed },
    exceptions: [],
    mandatory: null,
    ...overrides,
  };
}
/** Colombo local wall time → instant. 2026-10-26 is a Monday. */
const at = (local: string) => new Date(`${local}:00+05:30`);
const verdict = (h: unknown, when: string, extensions: { startsAt: Date; endsAt: Date }[] = [], tz = COLOMBO) =>
  evaluateOperatingHours({ hours: h, timeZone: tz, extensions }, at(when));

describe("evaluateOperatingHours", () => {
  it("is open inside the routine weekly range and closed outside it", () => {
    expect(verdict(hours(), "2026-10-26T09:00")).toEqual({ kind: "open", via: "routine" });
    expect(verdict(hours(), "2026-10-26T17:59")).toEqual({ kind: "open", via: "routine" });
    expect(verdict(hours(), "2026-10-26T18:00")).toEqual({ kind: "closed" });
    expect(verdict(hours(), "2026-10-26T08:59")).toEqual({ kind: "closed" });
    expect(verdict(hours(), "2026-11-01T12:00")).toEqual({ kind: "closed" }); // Sunday
  });

  it("uses the branch timezone, not the server's", () => {
    // 12:00 UTC is 17:30 in Colombo (open) but 21:00 in Tokyo (closed).
    const noonUtc = new Date("2026-10-26T12:00:00Z");
    expect(evaluateOperatingHours({ hours: hours(), timeZone: COLOMBO, extensions: [] }, noonUtc).kind).toBe("open");
    expect(evaluateOperatingHours({ hours: hours(), timeZone: "Asia/Tokyo", extensions: [] }, noonUtc).kind).toBe("closed");
  });

  it("lets an overnight range run into the next morning, even past a dated exception", () => {
    const late: DayHours = { mode: "hours", ranges: [{ opens: "20:00", closes: "02:00" }] };
    const h = hours({
      weekly: { ...hours().weekly, mon: late },
      exceptions: [{ date: "2026-10-27", label: "Closed Tuesday", hours: closed, source: "owner", holidayKey: null }],
    });
    expect(verdict(h, "2026-10-27T01:30").kind).toBe("open");
    expect(verdict(h, "2026-10-27T02:00").kind).toBe("closed");
  });

  it("applies confirmed holiday exceptions instead of the weekly hours", () => {
    const h = hours({
      exceptions: [
        { date: "2026-10-26", label: "Poya", hours: closed, source: "holiday_suggestion", holidayKey: "lk:2026-10-26" },
        { date: "2026-11-01", label: "Sunday opening", hours: nineToSix, source: "owner", holidayKey: null },
      ],
    });
    expect(verdict(h, "2026-10-26T12:00")).toEqual({ kind: "closed" });
    expect(verdict(h, "2026-11-01T12:00")).toEqual({ kind: "open", via: "routine" });
  });

  it("counts an unrevoked business extension as open time", () => {
    const extension = { startsAt: at("2026-10-26T18:00"), endsAt: at("2026-10-26T21:00") };
    expect(verdict(hours(), "2026-10-26T19:00", [extension])).toEqual({ kind: "open", via: "extension" });
    expect(verdict(hours(), "2026-10-26T21:00", [extension])).toEqual({ kind: "closed" });
  });

  it("treats mandatory limits as a hard ceiling that extensions and exceptions cannot widen", () => {
    const h = hours({
      mandatory: [{ day: "mon", opens: "08:00", closes: "20:00" }],
      exceptions: [{ date: "2026-10-26", label: "Late", hours: { mode: "open_24h" }, source: "owner", holidayKey: null }],
    });
    const extension = { startsAt: at("2026-10-26T20:00"), endsAt: at("2026-10-26T23:00") };
    expect(verdict(h, "2026-10-26T19:59", [extension]).kind).toBe("open");
    expect(verdict(h, "2026-10-26T21:00", [extension])).toEqual({ kind: "outside_mandatory" });
    expect(verdict(h, "2026-10-27T12:00")).toEqual({ kind: "outside_mandatory" }); // no Tuesday window
  });

  it("treats an empty mandatory list as no selling at all", () => {
    expect(verdict(hours({ mandatory: [] }), "2026-10-26T12:00")).toEqual({ kind: "outside_mandatory" });
  });

  it("is unknown — never open — when hours are unset, malformed or the timezone is unusable", () => {
    expect(verdict(null, "2026-10-26T12:00")).toEqual({ kind: "unknown", reason: "hours_unset" });
    expect(verdict({ schemaVersion: 1, weekly: {} }, "2026-10-26T12:00")).toEqual({ kind: "unknown", reason: "hours_invalid" });
    expect(verdict(hours(), "2026-10-26T12:00", [], "Mars/Olympus")).toEqual({ kind: "unknown", reason: "timezone_invalid" });
  });
});

describe("OperatingHoursEvidence", () => {
  const command = (overrides: Record<string, unknown> = {}) =>
    ({
      operation: "POST /api/v1/sales/checkout",
      identity: { tenantId: "t", branchId: "b", terminalId: "x", enrollmentId: "e", keyId: "k" },
      operatingHoursExceptionId: null,
      ...overrides,
    }) as never;
  function tx(branch: { operatingHours: unknown; timezone: string } | null, extensions: unknown[] = []) {
    return {
      branch: { findFirst: jest.fn(async () => branch) },
      branchHoursExtension: { findMany: jest.fn(async () => extensions) },
    } as never;
  }
  const provider = new OperatingHoursEvidence();
  const code = (promise: Promise<unknown>) =>
    promise.then(() => "allowed", (e: { response?: { code?: string } }) => e.response?.code);

  it("allows selling-hours operations inside routine hours", async () => {
    await expect(code(provider.assertForCommand(tx({ operatingHours: hours(), timezone: COLOMBO }), command(), at("2026-10-26T10:00")))).resolves.toBe("allowed");
  });

  it("maps closed, mandatory and unknown hours to distinct refusals", async () => {
    const run = (h: unknown, when: string) => code(provider.assertForCommand(tx({ operatingHours: h, timezone: COLOMBO }), command(), at(when)));
    await expect(run(hours(), "2026-10-26T20:00")).resolves.toBe("BUSINESS_HOURS_ACK_REQUIRED");
    await expect(run(hours({ mandatory: [] }), "2026-10-26T10:00")).resolves.toBe("OUTSIDE_OPERATING_HOURS");
    await expect(run(null, "2026-10-26T10:00")).resolves.toBe("TEMPORARILY_UNAVAILABLE");
    await expect(code(provider.assertForCommand(tx(null), command(), at("2026-10-26T10:00")))).resolves.toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("never accepts a per-command hours exception online", async () => {
    await expect(code(provider.assertForCommand(tx({ operatingHours: hours(), timezone: COLOMBO }),
      command({ operatingHoursExceptionId: "0f1d5c8e-6a43-4c55-9a3c-2b4d8f7e9a10" }), at("2026-10-26T10:00")))).resolves.toBe("INVALID_COMMAND");
  });

  it("treats transfer dispatch and receipt as back-room stock work, outside selling hours", async () => {
    for (const operation of ["POST /api/v1/transfers/:id/ship", "POST /api/v1/transfers/:id/receive"]) {
      expect(OPERATIONS_WITHOUT_SELLING_HOURS.has(operation)).toBe(true);
      await expect(code(provider.assertForCommand(tx({ operatingHours: hours(), timezone: COLOMBO }),
        command({ operation }), at("2026-10-26T23:00")))).resolves.toBe("allowed");
    }
  });

  it("treats prepared-delivery receiving and supplier-return dispatch as back-room stock work", async () => {
    for (const operation of ["POST /api/v1/purchasing/prepared-receipts/:id/post", "POST /api/v1/returns/:id/complete"]) {
      expect(OPERATIONS_WITHOUT_SELLING_HOURS.has(operation)).toBe(true);
      await expect(code(provider.assertForCommand(tx({ operatingHours: hours(), timezone: COLOMBO }),
        command({ operation }), at("2026-10-26T23:00")))).resolves.toBe("allowed");
    }
  });

  it("still hours-checks a signed operation nobody reviewed as back-room work", async () => {
    expect(OPERATIONS_WITHOUT_SELLING_HOURS.has("POST /api/v1/sales/checkout")).toBe(false);
    await expect(code(provider.assertForCommand(tx({ operatingHours: hours(), timezone: COLOMBO }),
      command({ operation: "POST /api/v1/sales/checkout" }), at("2026-10-26T23:00")))).resolves.toBe("BUSINESS_HOURS_ACK_REQUIRED");
  });

  it("does not hours-restrict the reviewed back-room stock operations, even with unset hours", async () => {
    for (const operation of OPERATIONS_WITHOUT_SELLING_HOURS) {
      const t = tx(null);
      await expect(code(provider.assertForCommand(t, command({ operation }), at("2026-10-26T23:00")))).resolves.toBe("allowed");
    }
  });
});

describe("MandatoryOperationEvidence.hours", () => {
  it("still fails closed when no provider is installed", async () => {
    await expect(new MandatoryOperationEvidence().hours({} as never, {} as never)).rejects.toMatchObject({
      response: { code: "TEMPORARILY_UNAVAILABLE" },
    });
  });

  it("delegates to the installed branch-hours provider", async () => {
    const provider = { assertForCommand: jest.fn(async () => undefined) };
    await new MandatoryOperationEvidence(provider as never).hours("tx" as never, "cmd" as never);
    expect(provider.assertForCommand).toHaveBeenCalledWith("tx", "cmd");
  });
});
