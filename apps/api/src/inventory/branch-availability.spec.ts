import { NotFoundException } from "@nestjs/common";
import { availabilityBand, InventoryService } from "./inventory.service";

describe("availabilityBand: another branch as a band, by stock-by-product's rule", () => {
  it("reads available against the reorder level", () => {
    expect(availabilityBand(0, 10)).toBe("out");
    expect(availabilityBand(10, 10)).toBe("low");
    expect(availabilityBand(11, 10)).toBe("in_stock");
    // No reorder level: anything to sell is in stock.
    expect(availabilityBand(1, 0)).toBe("in_stock");
  });
});

describe("InventoryService.otherBranchAvailability", () => {
  const branches = [
    { id: "b2", name: "Galle" },
    { id: "b3", name: "Kandy" },
  ];
  function service(product: { reorderLevel: number; isControlled: boolean } | null) {
    const prisma = {
      product: { findFirst: jest.fn().mockResolvedValue(product && { id: "p1", ...product }) },
      branch: { findMany: jest.fn().mockResolvedValue(branches) },
      tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }) },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const stockRead = {
      productTotalsByBranch: jest.fn().mockResolvedValue([{ branchId: "b2", onHand: 60, available: 40 }]),
    };
    return {
      prisma,
      stockRead,
      inventory: new InventoryService(prisma as never, {} as never, {} as never, stockRead as never),
    };
  }

  it("lists every other active branch of the tenant, with a band and no quantities", async () => {
    const { inventory, prisma } = service({ reorderLevel: 10, isControlled: false });
    expect(await inventory.otherBranchAvailability("t1", "b1", "p1")).toEqual({
      productId: "p1",
      controlled: false,
      branches: [
        { branchId: "b2", name: "Galle", band: "in_stock" },
        { branchId: "b3", name: "Kandy", band: "out" },
      ],
    });
    expect(prisma.branch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", isActive: true, id: { not: "b1" } } }),
    );
  });

  it("doesn't read a controlled product's stock at all", async () => {
    const { inventory, stockRead } = service({ reorderLevel: 10, isControlled: true });
    const result = await inventory.otherBranchAvailability("t1", "b1", "p1");
    expect(result.branches.map((b) => b.band)).toEqual(["ask_pharmacist", "ask_pharmacist"]);
    expect(stockRead.productTotalsByBranch).not.toHaveBeenCalled();
  });

  it("refuses a product outside the tenant", async () => {
    const { inventory } = service(null);
    await expect(inventory.otherBranchAvailability("t1", "b1", "p1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
