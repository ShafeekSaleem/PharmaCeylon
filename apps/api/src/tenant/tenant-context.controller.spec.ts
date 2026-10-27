import { DesktopPosRollout, RoleName } from "@prisma/client";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { TenantController } from "./tenant.controller";

describe("GET /tenant/context", () => {
  it("returns each branch with its desktop POS rollout state", async () => {
    jest.useFakeTimers({ now: new Date("2026-10-27T10:00:00Z") });
    const findMany = jest.fn().mockResolvedValue([
      {
        id: "b-1",
        code: "CMB",
        name: "Colombo",
        city: null,
        desktopPosRollout: DesktopPosRollout.not_live,
        desktopPosLiveAt: null,
        posFallbackStartedAt: null,
        posFallbackEndsAt: null,
      },
      {
        id: "b-2",
        code: "KDY",
        name: "Kandy",
        city: "Kandy",
        desktopPosRollout: DesktopPosRollout.live,
        desktopPosLiveAt: new Date("2026-10-01T00:00:00Z"),
        posFallbackStartedAt: new Date("2026-10-27T09:00:00Z"),
        posFallbackEndsAt: new Date("2026-10-27T15:00:00Z"),
      },
    ]);
    const controller = new TenantController(
      { branch: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const user: RequestUser = {
      userId: "u-1",
      tenantId: "t-1",
      email: "u@example.com",
      fullName: "U",
      authMethod: "cookie",
      branchRoles: [
        { branchId: "b-1", role: RoleName.cashier },
        { branchId: "b-2", role: RoleName.manager },
      ],
    };

    const context = await controller.getContext(user);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t-1", isActive: true, id: { in: ["b-1", "b-2"] } },
      }),
    );
    expect(context.branchRoles.map((entry) => entry.branch)).toEqual([
      {
        id: "b-1",
        code: "CMB",
        name: "Colombo",
        city: null,
        posRollout: { state: "not_live", liveSince: null, fallback: null },
      },
      {
        id: "b-2",
        code: "KDY",
        name: "Kandy",
        city: "Kandy",
        posRollout: {
          state: "fallback",
          liveSince: "2026-10-01T00:00:00.000Z",
          fallback: { startedAt: "2026-10-27T09:00:00.000Z", endsAt: "2026-10-27T15:00:00.000Z" },
        },
      },
    ]);
    jest.useRealTimers();
  });
});
