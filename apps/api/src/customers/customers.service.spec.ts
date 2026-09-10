import { BadRequestException, NotFoundException } from "@nestjs/common";
import { CustomersService } from "./customers.service";

describe("CustomersService", () => {
  let prisma: any;
  let service: CustomersService;

  const customer = {
    id: "cust-1",
    fullName: "Priya Fernando",
    phone: "0771234567",
    email: "priya@example.lk",
    address: null,
    notes: null,
    isActive: true,
    createdAt: new Date("2026-01-05T00:00:00Z"),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      customer: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(customer),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      sale: {
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { grandTotal: null }, _count: 0 }),
      },
      prescription: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new CustomersService(prisma as never);
  });

  describe("list", () => {
    it("scopes to the tenant and pages the results", async () => {
      await service.list("t1", { page: 3, pageSize: 25 });

      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args.where.tenantId).toBe("t1");
      expect(args.skip).toBe(50);
      expect(args.take).toBe(25);
    });

    it("shows deactivated customers by default, unlike the POS picker", async () => {
      await service.list("t1", {});

      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(args.where.isActive).toBeUndefined();
    });

    it.each([
      ["active", true],
      ["inactive", false],
    ])("filters to %s when asked", async (status, expected) => {
      await service.list("t1", { status });

      expect(prisma.customer.findMany.mock.calls[0][0].where.isActive).toBe(
        expected,
      );
    });

    it("searches name, phone and email together", async () => {
      await service.list("t1", { q: "  priya " });

      const or = prisma.customer.findMany.mock.calls[0][0].where.OR;
      expect(or).toHaveLength(3);
      // Trimmed, so a stray space from the search box doesn't miss everything.
      expect(or[0].fullName.contains).toBe("priya");
    });

    it("caps the page size so a crafted request can't dump the directory", async () => {
      await service.list("t1", { pageSize: 5000 });

      expect(prisma.customer.findMany.mock.calls[0][0].take).toBe(100);
    });
  });

  describe("getProfile", () => {
    it("pulls history across every branch, not just the active one", async () => {
      await service.getProfile("t1", "cust-1");

      expect(prisma.sale.findMany.mock.calls[0][0].where).toEqual({
        tenantId: "t1",
        customerId: "cust-1",
      });
      expect(prisma.prescription.findMany.mock.calls[0][0].where).toEqual({
        tenantId: "t1",
        customerId: "cust-1",
      });
    });

    it("counts only posted sales toward lifetime value", async () => {
      await service.getProfile("t1", "cust-1");

      expect(prisma.sale.aggregate.mock.calls[0][0].where.status).toBe("posted");
    });

    it("reports a zero lifetime value rather than null for a new customer", async () => {
      const result = await service.getProfile("t1", "cust-1");

      expect(result.stats.lifetimeValue).toBe("0.00");
      expect(result.stats.lastPurchaseAt).toBeNull();
    });

    it("404s for a customer in another tenant", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(service.getProfile("t1", "cust-9")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe("update", () => {
    it("applies only the fields that were sent", async () => {
      await service.update("t1", "cust-1", { fullName: "  Priya Silva  " });

      expect(prisma.customer.updateMany.mock.calls[0][0].data).toEqual({
        fullName: "Priya Silva",
      });
    });

    it("clears a field when an empty string is sent", async () => {
      await service.update("t1", "cust-1", { email: "" });

      expect(prisma.customer.updateMany.mock.calls[0][0].data).toEqual({
        email: null,
      });
    });

    it("rejects a phone that belongs to someone else", async () => {
      prisma.customer.findFirst
        .mockResolvedValueOnce(customer) // the getOne existence check
        .mockResolvedValueOnce({ id: "cust-2", fullName: "Nimal Perera" });

      await expect(
        service.update("t1", "cust-1", { phone: "0777654321" }),
      ).rejects.toThrow(/already belongs to Nimal Perera/);
      expect(prisma.customer.updateMany).not.toHaveBeenCalled();
    });

    it("allows a customer to keep their own phone number", async () => {
      // The clash lookup excludes the row being edited, so re-saving an
      // unchanged profile must not trip over itself.
      prisma.customer.findFirst
        .mockResolvedValueOnce(customer)
        .mockResolvedValueOnce(null);

      await service.update("t1", "cust-1", { phone: customer.phone });

      const clashWhere = prisma.customer.findFirst.mock.calls[1][0].where;
      expect(clashWhere.id).toEqual({ not: "cust-1" });
    });

    it("deactivates without touching anything else", async () => {
      await service.update("t1", "cust-1", { isActive: false });

      expect(prisma.customer.updateMany.mock.calls[0][0].data).toEqual({
        isActive: false,
      });
    });

    it("404s for a customer in another tenant", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);

      await expect(
        service.update("t1", "cust-9", { fullName: "Nope" }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("create", () => {
    it("rejects a duplicate phone with the existing owner's name", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-2",
        fullName: "Nimal Perera",
      });

      await expect(
        service.create("t1", { fullName: "Priya", phone: "0771234567" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
