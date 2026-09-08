import { InventoryService } from "./inventory.service";

describe("confirm imported expiry", () => {
  function setup() {
    const prisma: any = {
      batch: {
        findFirst: jest
          .fn()
          .mockResolvedValue({
            productId: "p",
            expiryDate: new Date("2099-12-31"),
          }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditEvent: { create: jest.fn() },
    };
    prisma.$transaction = (fn: any) => fn(prisma);
    return {
      prisma,
      service: new InventoryService(prisma, {} as never, {} as never),
    };
  }
  it("saves the actual date and audit event scoped to the branch", async () => {
    const { service, prisma } = setup();
    await service.confirmBatchExpiry("t", "branch", "u", "b", "2025-02-28");
    expect(prisma.batch.updateMany).toHaveBeenCalledWith({
      where: {
        id: "b",
        tenantId: "t",
        branchId: "branch",
        needsExpiryReview: true,
      },
      data: { expiryDate: new Date("2025-02-28"), needsExpiryReview: false },
    });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventName: "batch.expiry_confirmed" }),
      }),
    );
  });
  it("rejects calendar rollover and inaccessible batches", async () => {
    const { service, prisma } = setup();
    await expect(
      service.confirmBatchExpiry("t", "branch", "u", "b", "2026-02-30"),
    ).rejects.toThrow(/actual expiry/);
    prisma.batch.findFirst.mockResolvedValue(null);
    await expect(
      service.confirmBatchExpiry("t", "branch", "u", "b", "2026-02-28"),
    ).rejects.toThrow(/not found/);
    expect(prisma.batch.updateMany).not.toHaveBeenCalled();
  });
  it("does not overwrite a batch another operator already reviewed", async () => {
    const { service, prisma } = setup();
    prisma.batch.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.confirmBatchExpiry("t", "branch", "u", "b", "2026-02-28"),
    ).rejects.toThrow(/already been reviewed/);
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });
});
