import { DesktopPosRollout } from "@prisma/client";
import { deriveSaleChannel } from "@pharmaceylon/shared";
import { channelWhere, fallbackWindowsFromAudit } from "./sale-fallback-windows.util";

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

  it("closes an expired open window before a new start", () => {
    const branchId = "branch-a";
    const windows = fallbackWindowsFromAudit([
      {
        branchId,
        eventName: "branch.pos_fallback_started",
        payload: { endsAt: "2026-10-10T12:00:00.000Z" },
        createdAt: new Date("2026-10-10T08:00:00.000Z"),
      },
      {
        branchId,
        eventName: "branch.pos_fallback_started",
        payload: { endsAt: "2026-10-12T18:00:00.000Z" },
        createdAt: new Date("2026-10-12T10:00:00.000Z"),
      },
    ]);
    expect(windows.get(branchId)).toEqual([
      { startedAt: new Date("2026-10-10T08:00:00.000Z"), endsAt: new Date("2026-10-10T12:00:00.000Z") },
      { startedAt: new Date("2026-10-12T10:00:00.000Z"), endsAt: new Date("2026-10-12T18:00:00.000Z") },
    ]);
  });
});

describe("channelWhere", () => {
  const liveAt = new Date("2026-06-01T00:00:00.000Z");
  const branch = {
    id: "branch-a",
    desktopPosRollout: DesktopPosRollout.live,
    desktopPosLiveAt: liveAt,
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

  it("agrees with deriveSaleChannel for pre-go-live fallback audit windows", () => {
    const historical = new Map([
      [
        "branch-a",
        [{ startedAt: new Date("2026-05-01T00:00:00.000Z"), endsAt: new Date("2026-05-02T00:00:00.000Z") }],
      ],
    ]);
    const soldAt = new Date("2026-05-01T12:00:00.000Z");
    const label = deriveSaleChannel({ terminalId: null, offlineCommandId: null, soldAt }, branch, historical.get("branch-a")!);
    const fallbackWhere = channelWhere("fallback", [branch], historical);
    const legacyWhere = channelWhere("web_legacy", [branch], historical);
    expect(label).toBe("web_legacy");
    expect(fallbackWhere.AND).toEqual(
      expect.arrayContaining([{ terminalId: null, offlineCommandId: null }]),
    );
    expect(legacyWhere.AND).toEqual(expect.arrayContaining([{ terminalId: null, offlineCommandId: null }, expect.any(Object)]));
  });
});