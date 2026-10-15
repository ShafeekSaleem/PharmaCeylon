import { AnalyticsService } from "../analytics/analytics.service";

describe("dashboard pulse business dates", () => {
  afterEach(() => jest.useRealTimers());

  it("uses Colombo's new day while the UTC server is still on the previous date", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-15T20:00:00Z"));
    const aggregate = jest
      .fn()
      .mockResolvedValue({ _sum: { grandTotal: 10 }, _count: { _all: 1 } });
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }),
      },
      sale: {
        aggregate,
        findMany: jest
          .fn()
          .mockResolvedValue([
            { soldAt: new Date("2026-10-15T19:00:00Z"), grandTotal: 10 },
          ]),
      },
      salePayment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new AnalyticsService(prisma as never, {} as never);
    const result = await service.salesPulse("tenant", 7, "today");
    expect(aggregate.mock.calls[0][0].where.soldAt).toEqual({
      gte: new Date("2026-10-15T18:30:00Z"),
      lt: new Date("2026-10-16T18:30:00Z"),
    });
    expect(result.salesTrend7d.at(-1)).toMatchObject({
      date: "2026-10-16",
      value: 10,
    });
  });
});
