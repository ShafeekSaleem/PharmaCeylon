import { NotFoundException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { SuppliersService } from "./suppliers.service";

describe("SuppliersService tenant isolation", () => {
  const tenantId = "tenant-a";
  const supplierId = "supplier-1";

  function makeService() {
    const prisma = {
      supplier: {
        findFirst: jest.fn().mockResolvedValue({ id: supplierId, tenantId }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const service = new SuppliersService(prisma as never, audit);
    jest.spyOn(service, "getById").mockResolvedValue({ id: supplierId } as never);
    return { service, prisma, audit };
  }

  it("scopes the final supplier update by tenant and id", async () => {
    const { service, prisma } = makeService();

    await service.update(tenantId, "user-1", supplierId, { name: "Updated Supplier" });

    expect(prisma.supplier.findFirst).toHaveBeenCalledWith({
      where: { id: supplierId, tenantId },
    });
    expect(prisma.supplier.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: supplierId, tenantId } }),
    );
  });

  it("treats a zero-row scoped mutation as not found and does not audit it", async () => {
    const { service, prisma, audit } = makeService();
    prisma.supplier.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.update(tenantId, "user-1", supplierId, { name: "Updated Supplier" }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.log as jest.Mock).not.toHaveBeenCalled();
  });
});
