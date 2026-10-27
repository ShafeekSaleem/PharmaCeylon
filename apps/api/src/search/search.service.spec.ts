import { RoleName } from "@prisma/client";
import { SearchService } from "./search.service";

describe("SearchService", () => {
  function setup(granted: string[]) {
    const prisma = {
      product: { findMany: jest.fn().mockResolvedValue([]) },
      stockLedger: { groupBy: jest.fn().mockResolvedValue([]) },
      sale: { findMany: jest.fn().mockResolvedValue([]) },
      customer: { findMany: jest.fn().mockResolvedValue([]) },
      supplier: { findMany: jest.fn().mockResolvedValue([]) },
      purchaseOrder: { findMany: jest.fn().mockResolvedValue([]) },
      transfer: { findMany: jest.fn().mockResolvedValue([]) },
      stocktake: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const permissions = {
      resolveGrantedKeys: jest.fn().mockResolvedValue(new Set(granted)),
    };
    const saleRead = {
      viewableBranches: jest.fn().mockResolvedValue([
        { id: "branch-1", name: "Colombo" },
        { id: "branch-2", name: "Kandy" },
      ]),
      searchInvoices: jest.fn().mockResolvedValue([]),
    };
    const service = new SearchService(prisma as never, permissions as never, saleRead as never);
    const user = {
      userId: "user-1",
      tenantId: "tenant-1",
      email: "person@example.com",
      fullName: "Person",
      authMethod: "cookie" as const,
      branchRoles: [
        { branchId: "branch-1", role: RoleName.custom, roleId: "role-1" },
      ],
    };
    return { prisma, permissions, saleRead, service, user };
  }

  it("queries only domains granted to the active branch role", async () => {
    const { prisma, service, user } = setup(["products.view"]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: "product-1",
        sku: "PARA-500",
        barcode: "123",
        name: "Paracetamol",
        strength: "500 mg",
        unit: "tablet",
      },
    ]);
    prisma.stockLedger.groupBy.mockResolvedValue([
      { productId: "product-1", _sum: { qtyDelta: 12 } },
    ]);

    const result = await service.globalSearch(user, "branch-1", "para", 5);

    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-1" }),
      }),
    );
    expect(prisma.stockLedger.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "tenant-1",
          branchId: "branch-1",
        }),
      }),
    );
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
    expect(result.groups[0]?.items[0]).toEqual(
      expect.objectContaining({ title: "Paracetamol", meta: "12 on hand" }),
    );
  });

  it("returns no protected entity groups when the role has no matching grants", async () => {
    const { prisma, service, user } = setup([]);

    const result = await service.globalSearch(user, "branch-1", "secret", 5);

    expect(result).toEqual({ query: "secret", groups: [], total: 0 });
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it("finds sales by invoice through the shared sale read and opens them on the Sales page", async () => {
    const { saleRead, service, user } = setup(["sales.view"]);
    saleRead.searchInvoices.mockResolvedValue([
      {
        id: "sale-1",
        invoiceNo: "INV-2610-000042",
        status: "posted",
        grandTotal: "950.00",
        branch: { id: "branch-1", name: "Colombo" },
        customer: null,
      },
    ]);

    const result = await service.globalSearch(user, "branch-1", "0042", 5);

    expect(saleRead.searchInvoices).toHaveBeenCalledWith("tenant-1", "branch-1", "0042", 5);
    expect(saleRead.viewableBranches).not.toHaveBeenCalled();
    expect(result.groups[0]?.items[0]).toEqual(
      expect.objectContaining({
        type: "sale",
        title: "INV-2610-000042",
        subtitle: "Walk-in customer · Colombo",
        href: "/sales/sale-1",
      }),
    );
  });

  it("without a branch, searches sales only where the caller may view them", async () => {
    const { saleRead, service, user } = setup(["sales.view"]);

    await service.globalSearch(user, undefined, "0042", 5);

    expect(saleRead.viewableBranches).toHaveBeenCalledWith(user);
    expect(saleRead.searchInvoices).toHaveBeenCalledWith("tenant-1", ["branch-1", "branch-2"], "0042", 5);
  });
});
