import { StockService } from "../inventory/stock/stock.service";
import { SalesService } from "./sales.service";

describe("unreviewed expiry sale safety", () => {
  function setup(batch: unknown) {
    const prisma: any = {
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }) },
      product: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            {
              id: "p",
              name: "Product",
              isControlled: false,
              requiresPrescription: false,
            },
          ]),
      },
      batch: {
        findFirst: jest.fn().mockResolvedValue(batch),
        findMany: jest.fn().mockResolvedValue([]),
      },
      stockLedger: { create: jest.fn() },
      sale: { create: jest.fn() },
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    const service = new SalesService(
      prisma,
      {} as never,
      { getVatRatePercent: () => 0 } as never,
      {} as never,
      { assertCanSell: async () => {} } as never,
      new StockService(),
    );
    return { service, prisma };
  }
  it("rejects an explicitly supplied batch even when its placeholder expiry is in the future", async () => {
    const { service, prisma } = setup({
      id: "b",
      needsExpiryReview: true,
      isQuarantined: false,
      expiryDate: new Date("2099-12-31"),
    });
    await expect(
      service.checkout(
        "t",
        "branch",
        "u",
        [],
        { items: [{ productId: "p", batchId: "b", qty: 1, unitPrice: "10" }] },
        undefined,
      ),
    ).rejects.toThrow(/actual expiry/);
    expect(prisma.sale.create).not.toHaveBeenCalled();
    expect(prisma.stockLedger.create).not.toHaveBeenCalled();
  });
  it("excludes flagged batches from automatic FEFO selection", async () => {
    const { service, prisma } = setup(null);
    await expect(
      service.checkout(
        "t",
        "branch",
        "u",
        [],
        { items: [{ productId: "p", qty: 1, unitPrice: "10" }] },
        undefined,
      ),
    ).rejects.toThrow(/No sellable batch/);
    expect(prisma.batch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "t",
          branchId: "branch",
          needsExpiryReview: false,
        }),
      }),
    );
  });
});
