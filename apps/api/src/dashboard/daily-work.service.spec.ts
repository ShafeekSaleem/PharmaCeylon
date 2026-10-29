import { DesktopPosRollout, Prisma } from "@prisma/client";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { DailyWorkService } from "./daily-work.service";

const tenantId = "00000000-0000-4000-8000-000000000001";
const branchId = "00000000-0000-4000-8000-000000000002";
const user = { userId: "00000000-0000-4000-8000-000000000003", tenantId } as RequestUser;
const HOUR = 3_600_000;

function setup(
  rollout: "not_live" | "live" | "fallback",
  permissions: string[] = [
    "purchasing.view",
    "purchasing.approve",
    "purchasing.receive",
    "inventory.view",
    "inventory.write_off",
    "inventory.quarantine",
    "stocktakes.use",
    "stocktakes.review",
    "sales.pos_use",
    "products.import",
  ],
) {
  const now = Date.now();
  const prisma = {
    branch: {
      findFirst: jest.fn().mockResolvedValue({
        name: "Colombo 03",
        timezone: "Asia/Colombo",
        desktopPosRollout:
          rollout === "not_live" ? DesktopPosRollout.not_live : DesktopPosRollout.live,
        desktopPosLiveAt: rollout === "not_live" ? null : new Date(now - 24 * HOUR),
        posFallbackStartedAt: rollout === "fallback" ? new Date(now - HOUR) : null,
        posFallbackEndsAt: rollout === "fallback" ? new Date(now + HOUR) : null,
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([
      { items: [], total: 0, counts: { all: 0, mine: 0, approvals: 0, overdue: 0, counter: 0 }, categories: {} },
    ]),
  };
  const access = {
    resolve: jest.fn().mockResolvedValue({
      has: (key: string) => permissions.includes(key),
      canSelfApprove: false,
    }),
  };
  const service = new DailyWorkService(prisma as never, access as never);
  const sql = () => prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
  return { prisma, service, sql };
}

describe("DailyWorkService", () => {
  it("keeps today's web behaviour at a not-live branch", async () => {
    const { service, sql } = setup("not_live");
    const result = await service.get(user, branchId, { filter: "all", page: 1 });
    expect(result.counterLive).toBe(false);
    expect(sql().sql).not.toContain("kind IN");
    expect(sql().sql).toContain("'web' AS place");
    // Held bills still belong to the web POS here.
    expect(sql().sql).toContain("FROM held_sale h");
  });

  it("routes physical steps to the counter at a live branch and drops web-POS held bills", async () => {
    const { service, sql } = setup("live");
    const result = await service.get(user, branchId, { filter: "all", page: 1 });
    expect(result.counterLive).toBe(true);
    expect(sql().sql).toContain("kind IN");
    expect(sql().values).toEqual(
      expect.arrayContaining([
        "stocktake.post",
        "held_adjustment.post",
        "held_delivery.post",
        "import_stock.post",
      ]),
    );
    expect(sql().values).not.toContain("held_adjustment.approve");
    expect(sql().sql).not.toContain("FROM held_sale h");
  });

  it("keeps held bills during a fallback, while posts stay at the counter", async () => {
    const { service, sql } = setup("fallback");
    await service.get(user, branchId, { filter: "all", page: 1 });
    expect(sql().sql).toContain("FROM held_sale h");
    expect(sql().values).toContain("stocktake.post");
  });

  it("lists staged opening stock only for people who may import, scoped to tenant and branch", async () => {
    const allowed = setup("live");
    await allowed.service.get(user, branchId, { filter: "all", page: 1 });
    expect(allowed.sql().sql).toContain("FROM product_import i");
    expect(allowed.sql().values).toEqual(expect.arrayContaining([tenantId, branchId]));

    const denied = setup("live", ["inventory.view", "inventory.quarantine"]);
    await denied.service.get(user, branchId, { filter: "all", page: 1 });
    expect(denied.sql().sql).not.toContain("FROM product_import i");
  });

  it("filters to counter work and to requested kinds", async () => {
    const { service, sql } = setup("live");
    await service.get(
      user,
      branchId,
      { filter: "counter", page: 1 },
      { pageSize: 25, kinds: ["stocktake.post"] },
    );
    expect(sql().sql).toContain("place = 'counter'");
    expect(sql().values).toContain(25);
    expect(sql().values).toContain("stocktake.post");
  });

  it("returns an empty queue with the counter count when the caller sees no sources", async () => {
    const { prisma, service } = setup("live", []);
    const result = await service.get(user, branchId, { filter: "all", page: 1 });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(result.counts.counter).toBe(0);
    expect(result.counterLive).toBe(true);
  });
});
