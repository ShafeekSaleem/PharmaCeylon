import { DesktopPosRollout } from "@prisma/client";
import { channelWhere, fallbackSoldAtOr, fallbackWindowsFromAudit } from "./sale-fallback-windows.util";

describe("fallbackWindowsFromAudit", () => {
  it("replays started, extended and ended into one window", () => {
    const branchId = "branch-a";
    const windows = fallbackWindowsFromAudit([
      {
        branchId,
        eventName: "branch.pos_fallback_started",
        payload: { endsAt: "2026-10-10T18:00:00.000Z" },
        createdAt: new Date("2026-10-10T10:00:00.000Z"),
      },
      {
        branchId,
        eventName: "branch.pos_fallback_extended",
        payload: { endsAt: "2026-10-10T20:00:00.000Z" },
        createdAt: new Date("2026-10-10T11:00:00.000Z"),
      },
      {
        branchId,
        eventName: "branch.pos_fallback_ended",
        payload: {},
        createdAt: new Date("2026-10-10T19:00:00.000Z"),
      },
    ]);
    expect(windows.get(branchId)).toEqual([
      { startedAt: new Date("2026-10-10T10:00:00.000Z"), endsAt: new Date("2026-10-10T19:00:00.000Z") },
    ]);
  });
});

describe("channelWhere", () => {
  const branch = {
    id: "branch-a",
    desktopPosRollout: DesktopPosRollout.live,
    desktopPosLiveAt: new Date("2026-06-01T00:00:00.000Z"),
    posFallbackStartedAt: new Date("2026-10-10T10:00:00.000Z"),
    posFallbackEndsAt: new Date("2026-10-10T18:00:00.000Z"),
  };

  it("filters desktop_online and offline", () => {
    expect(channelWhere("desktop_online", [branch], new Map())).toMatchObject({
      terminalId: { not: null },
      offlineCommandId: null,
    });
    expect(channelWhere("offline", [branch], new Map())).toMatchObject({
      offlineCommandId: { not: null },
    });
  });

  it("filters fallback by soldAt windows", () => {
    const where = channelWhere("fallback", [branch], new Map());
    expect(where.AND).toBeDefined();
    expect(fallbackSoldAtOr([branch], new Map())).toEqual([
      expect.objectContaining({
        branchId: "branch-a",
        soldAt: { gte: branch.posFallbackStartedAt, lt: branch.posFallbackEndsAt },
      }),
    ]);
  });

  it("web_legacy excludes fallback windows", () => {
    const where = channelWhere("web_legacy", [branch], new Map());
    expect(where.AND).toEqual(
      expect.arrayContaining([{ terminalId: null, offlineCommandId: null }, expect.objectContaining({ NOT: expect.any(Object) })]),
    );
  });
});