import { NotFoundException } from "@nestjs/common";
import { HeldSalesService } from "./held-sales.service";

describe("HeldSalesService tenant isolation", () => {
  const tenantId = "tenant-a";
  const branchId = "branch-a";
  const holdId = "hold-1";

  function makeService() {
    const heldSale = {
      findFirst: jest.fn().mockResolvedValue({ id: holdId }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const prisma = {
      heldSale,
      $transaction: jest.fn(async (fn: (tx: { heldSale: typeof heldSale }) => unknown) =>
        fn({ heldSale }),
      ),
    };
    return {
      service: new HeldSalesService(prisma as never),
      prisma,
      heldSale,
    };
  }

  it("scopes discard at both the ownership read and final delete", async () => {
    const { service, heldSale } = makeService();

    await service.discard(tenantId, branchId, holdId);

    expect(heldSale.findFirst).toHaveBeenCalledWith({
      where: { id: holdId, tenantId, branchId },
      select: { id: true },
    });
    expect(heldSale.deleteMany).toHaveBeenCalledWith({
      where: { id: holdId, tenantId, branchId },
    });
  });

  it("does not delete when the hold is outside the active tenant or branch", async () => {
    const { service, heldSale } = makeService();
    heldSale.findFirst.mockResolvedValueOnce(null);

    await expect(service.discard(tenantId, branchId, holdId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(heldSale.deleteMany).not.toHaveBeenCalled();
  });

  it("keeps recall's consuming delete tenant and branch scoped inside the transaction", async () => {
    const { service, heldSale } = makeService();
    heldSale.findFirst.mockResolvedValueOnce({
      id: holdId,
      holdRef: "HOLD-0001",
      label: null,
      itemCount: 1,
      total: { toFixed: () => "10.00" },
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      payload: { lines: [] },
    });

    await service.recall(tenantId, branchId, holdId);

    expect(heldSale.deleteMany).toHaveBeenCalledWith({
      where: { id: holdId, tenantId, branchId },
    });
  });
});
