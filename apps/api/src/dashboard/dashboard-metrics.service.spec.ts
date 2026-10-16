import { DashboardMetricsService } from "./dashboard-metrics.service";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";

it("counts all controlled-stock exceptions and deduplicates overlapping low/expiry signals", async () => {
  const products = Array.from({ length: 35 }, (_, n) => ({
    id: `p-${n}`,
    reorderLevel: 2,
    isControlled: true,
  }));
  const productTotals = jest.fn().mockResolvedValue(
    new Map(
      products.map((p, n) => [
        p.id,
        {
          available: n < 30 ? 1 : 0,
          nearExpiryBatchCount: n < 10 ? 3 : 0,
          expiredBatchCount: n < 5 ? 1 : 0,
        },
      ]),
    ),
  );
  const prisma = {
    branch: {
      findFirst: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }),
    },
    product: { findMany: jest.fn().mockResolvedValue(products) },
  };
  const service = new DashboardMetricsService(
    prisma as never,
    { productTotals } as never,
  );
  const result = await service.stockMetrics(
    { tenantId: "tenant" } as RequestUser,
    "branch",
  );
  expect(result).toEqual({
    low: 30,
    out: 5,
    controlledLow: 35,
    controlledNearExpiry: 10,
    controlledAttention: 35,
  });
  expect(prisma.product.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant", isActive: true }),
    }),
  );
});
