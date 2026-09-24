import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
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
  /**
   * A payment from the supplier page is a real ledger payment now, allocated to one invoice.
   * Concurrency is a row lock (exercised against Postgres in the integration suite); these pin
   * what gets written and what is refused.
   */
  function makeService(locked: { status: SupplierInvoiceStatus; paid: number }) {
    const created: unknown[] = [];
    const invoice = {
      id: "inv-1",
      tenantId: "t1",
      supplierId: "s1",
      branchId: "b1",
      invoiceNumber: "INV-9",
      status: locked.status,
      totalAmount: new Prisma.Decimal(1000),
      paidAmount: new Prisma.Decimal(locked.paid),
      notes: null,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ next_value: 2 }]),
      branch: { findFirst: jest.fn().mockResolvedValue({ id: "b1" }) },
      supplierInvoice: {
        findFirst: jest.fn().mockResolvedValue(invoice),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      supplierPayment: {
        create: jest.fn(async ({ data }: { data: unknown }) => {
          created.push(data);
          return { id: "pay-1", ...(data as object) };
        }),
      },
      supplierPaymentAllocation: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: new Prisma.Decimal(1000) } }),
      },
      supplierDebitAllocation: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
    };
    const prisma = {
      supplierInvoice: {
        findFirst: jest.fn().mockResolvedValue({ ...invoice, status: SupplierInvoiceStatus.partial }),
      },
      $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const audit = { log: jest.fn() } as unknown as AuditService;
    const service = new SuppliersService(prisma as never, audit);
    jest.spyOn(service, "getById").mockResolvedValue({ id: "s1" } as never);
    return { service, tx, audit, created };
  }

  it("records a ledger payment allocated to the invoice, and re-derives what is paid", async () => {
    const { service, tx, created } = makeService({ status: SupplierInvoiceStatus.partial, paid: 400 });
    await service.recordPayment("t1", "u1", "inv-1", { amount: 600 });

    expect(created).toHaveLength(1);
    expect(created[0]).toEqual(
      expect.objectContaining({
        supplierId: "s1",
        amount: new Prisma.Decimal(600),
        allocations: { create: [expect.objectContaining({ invoiceId: "inv-1" })] },
      }),
    );
    // paidAmount is written from the ledger's sum, not by adding to the old figure.
    expect(tx.supplierInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paidAmount: new Prisma.Decimal(1000),
          status: SupplierInvoiceStatus.paid,
        }),
      }),
    );
  });

  it("refuses more than is left to pay, and writes nothing", async () => {
    const { service, created, audit } = makeService({ status: SupplierInvoiceStatus.partial, paid: 400 });
    await expect(service.recordPayment("t1", "u1", "inv-1", { amount: 700 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(created).toHaveLength(0);
    expect(audit.log as jest.Mock).not.toHaveBeenCalled();
  });

  it("refuses when the invoice was settled while this payment was being entered", async () => {
    const { service, created } = makeService({ status: SupplierInvoiceStatus.paid, paid: 1000 });
    await expect(service.recordPayment("t1", "u1", "inv-1", { amount: 100 })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(created).toHaveLength(0);
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
      goodsReceiptItem: { findMany: jest.fn().mockResolvedValue([]) },
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
