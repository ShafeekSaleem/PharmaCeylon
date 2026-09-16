import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma, SupplierInvoiceStatus } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { createInvoiceFromGoodsReceipt, SuppliersService } from "./suppliers.service";

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

describe("supplier invoice payments", () => {
  function makeService(updateCount: number) {
    const prisma = {
      supplierInvoice: {
        findFirst: jest.fn().mockResolvedValue({
          id: "inv-1",
          tenantId: "t1",
          supplierId: "s1",
          branchId: "b1",
          status: SupplierInvoiceStatus.open,
          totalAmount: new Prisma.Decimal(1000),
          paidAmount: new Prisma.Decimal(400),
          notes: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: updateCount }),
      },
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const service = new SuppliersService(prisma as never, audit);
    jest.spyOn(service, "getById").mockResolvedValue({ id: "s1" } as never);
    return { service, prisma, audit };
  }

  it("writes the payment only if the paid amount is still what was checked", async () => {
    const { service, prisma } = makeService(1);
    await service.recordPayment("t1", "u1", "inv-1", { amount: 600 });
    expect(prisma.supplierInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "inv-1",
          tenantId: "t1",
          paidAmount: new Prisma.Decimal(400),
        }),
        data: expect.objectContaining({ status: SupplierInvoiceStatus.paid }),
      }),
    );
  });

  it("refuses a payment that raced another one instead of overpaying", async () => {
    const { service, audit } = makeService(0);
    await expect(
      service.recordPayment("t1", "u1", "inv-1", { amount: 600 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(audit.log as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("auto-created supplier invoices", () => {
  function tx(taken: string[]) {
    return {
      supplierInvoice: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(taken.map((invoiceNumber) => ({ invoiceNumber }))),
        create: jest.fn(async ({ data }: { data: { invoiceNumber: string } }) => data),
      },
      branch: { findFirst: jest.fn().mockResolvedValue({ code: "GALLE" }) },
    };
  }
  const params = {
    tenantId: "t1",
    branchId: "b2",
    supplierId: "s1",
    goodsReceiptId: "abcdef12-0000-4000-8000-000000000000",
    grnNumber: "GRN-00001",
    invoiceDate: new Date("2026-09-15"),
    paymentTermsDays: 30,
    totalAmount: new Prisma.Decimal(100),
  };

  it("includes the branch code, so each branch's first delivery gets its own number", async () => {
    const client = tx([]);
    const invoice = await createInvoiceFromGoodsReceipt(client as never, params);
    expect(invoice).toEqual(expect.objectContaining({ invoiceNumber: "SINV-GALLE-00001" }));
  });

  it("picks a free number up front rather than retrying a failed insert", async () => {
    const client = tx(["SINV-GALLE-00001"]);
    const invoice = await createInvoiceFromGoodsReceipt(client as never, params);
    expect(invoice).toEqual(expect.objectContaining({ invoiceNumber: "SINV-GALLE-00001-ABCDEF12" }));
    expect(client.supplierInvoice.create).toHaveBeenCalledTimes(1);
  });
});
