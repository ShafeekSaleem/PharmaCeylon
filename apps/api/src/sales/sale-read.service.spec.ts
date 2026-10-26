import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PaymentMethod, Prisma, RoleName, SaleStatus } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { PERMISSION_KEY } from "../security/decorators/require-permission.decorator";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { SalesHistoryQueryDto } from "./dto/sales-history-query.dto";
import { SaleReadService } from "./sale-read.service";
import { SalesController } from "./sales.controller";

const dec = (value: string) => new Prisma.Decimal(value);

const BRANCHES = [
  { id: "branch-a", name: "Colombo", tenantId: "tenant-1", isActive: true },
  { id: "branch-b", name: "Kandy", tenantId: "tenant-1", isActive: true },
  { id: "branch-c", name: "Galle", tenantId: "tenant-1", isActive: true },
  { id: "branch-x", name: "Other tenant", tenantId: "tenant-2", isActive: true },
];

/** Custom-role grants by role id — what the tenant configured in Roles & Permissions. */
const ROLE_GRANTS: Record<string, string[]> = {
  "role-viewer": ["sales.view"],
  "role-viewer-costs": ["sales.view", "costs.view"],
  "role-no-sales": ["inventory.view"],
};

function summaryRow(id: string, branchId = "branch-a") {
  const branch = BRANCHES.find((b) => b.id === branchId)!;
  return {
    id,
    invoiceNo: `INV-2610-${id}`,
    status: SaleStatus.posted,
    soldAt: new Date("2026-10-20T04:00:00.000Z"),
    grandTotal: dec("1250"),
    branch: { id: branch.id, name: branch.name },
    customer: null,
    seller: { id: "user-cashier", fullName: "Nimal Perera" },
    items: [{ qty: 2, productId: "product-1", product: { name: "Paracetamol" } }],
    payments: [
      { method: PaymentMethod.cash, amount: dec("1250") },
      { method: PaymentMethod.card, amount: dec("-200") },
    ],
  };
}

function detailRow(branchId = "branch-b") {
  const branch = BRANCHES.find((b) => b.id === branchId)!;
  return {
    id: "sale-1",
    tenantId: "tenant-1",
    branchId,
    invoiceNo: "INV-2610-000042",
    status: SaleStatus.partially_refunded,
    soldAt: new Date("2026-10-20T04:00:00.000Z"),
    subtotal: dec("1000"),
    discountTotal: dec("50"),
    taxTotal: dec("0"),
    grandTotal: dec("950"),
    amountPaid: dec("1000"),
    changeDue: dec("50"),
    notes: null,
    branch: { id: branch.id, name: branch.name },
    customer: { id: "customer-1", fullName: "Kamala Silva", phone: "0771234567" },
    prescription: { id: "rx-1", rxNumber: "RX-17", patientName: "Kamala Silva", doctorName: "Dr Fernando" },
    seller: { id: "user-cashier", fullName: "Nimal Perera" },
    dispenser: { id: "user-pharmacist", fullName: "Ruwan Jayasuriya" },
    items: [
      {
        id: "item-1",
        qty: 4,
        unitPrice: dec("250"),
        discountAmount: dec("50"),
        taxAmount: dec("0"),
        lineTotal: dec("950"),
        product: { id: "product-1", name: "Amoxicillin 500mg", sku: "AMX-500", unit: "capsule" },
        batch: {
          id: "batch-1",
          batchNo: "B-77",
          expiryDate: new Date("2027-06-30T00:00:00.000Z"),
          costPrice: dec("120.5"),
        },
      },
    ],
    payments: [
      { id: "pay-1", method: PaymentMethod.cash, amount: dec("1000"), reference: null, createdAt: new Date("2026-10-20T04:00:00.000Z") },
      { id: "pay-2", method: PaymentMethod.cash, amount: dec("-237.5"), reference: "POS refund RET-2026-00003", createdAt: new Date("2026-10-21T04:00:00.000Z") },
    ],
    goodsReturns: [
      { id: "return-1", returnNumber: "RET-2026-00003", amount: dec("237.5"), createdAt: new Date("2026-10-21T04:00:00.000Z") },
    ],
  };
}

function setup() {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Asia/Colombo" }) },
    branch: {
      findMany: jest.fn(async ({ where }: { where: { tenantId: string; id?: { in: string[] } } }) =>
        BRANCHES.filter(
          (b) => b.tenantId === where.tenantId && b.isActive && (!where.id || where.id.in.includes(b.id)),
        ).map(({ id, name }) => ({ id, name })),
      ),
    },
    sale: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const permissions = {
    resolveGrantedKeys: jest.fn(async (entries: Array<{ roleId?: string | null }>) =>
      new Set(entries.flatMap((entry) => ROLE_GRANTS[entry.roleId ?? ""] ?? [])),
    ),
  };
  const service = new SaleReadService(prisma as never, permissions as never);
  return { prisma, permissions, service };
}

function userWith(branchRoles: RequestUser["branchRoles"]): RequestUser {
  return {
    userId: "user-1",
    tenantId: "tenant-1",
    email: "person@example.com",
    fullName: "Person",
    authMethod: "cookie",
    branchRoles,
  };
}

const owner = userWith([{ branchId: "branch-a", role: RoleName.owner }]);
/** Sees sales at A (with costs) and B (without); works at C but may not view its sales. */
const multiBranch = userWith([
  { branchId: "branch-a", role: RoleName.custom, roleId: "role-viewer-costs" },
  { branchId: "branch-b", role: RoleName.custom, roleId: "role-viewer" },
  { branchId: "branch-c", role: RoleName.custom, roleId: "role-no-sales" },
]);

function lastWhere(mock: jest.Mock) {
  return mock.mock.calls.at(-1)![0].where;
}

describe("SaleReadService.history — branch and tenant scope", () => {
  it("defaults to the active branch and always filters by tenant", async () => {
    const { prisma, service } = setup();

    await service.history(multiBranch, "branch-a", {});

    const where = lastWhere(prisma.sale.findMany);
    expect(where).toMatchObject({ tenantId: "tenant-1", branchId: { in: ["branch-a"] } });
    expect(lastWhere(prisma.sale.count)).toEqual(where);
  });

  it("reads every branch where the caller holds sales.view for branchId=all, and no other", async () => {
    const { prisma, service } = setup();

    await service.history(multiBranch, "branch-a", { branchId: "all" });

    const scope = lastWhere(prisma.sale.findMany).branchId.in as string[];
    expect(scope.sort()).toEqual(["branch-a", "branch-b"]);
  });

  it("refuses a branch the caller works at but cannot view sales at", async () => {
    const { prisma, service } = setup();

    await expect(service.history(multiBranch, "branch-a", { branchId: "branch-c" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  it("refuses a branch of another tenant, even for an owner", async () => {
    const { prisma, service } = setup();

    await expect(service.history(owner, undefined, { branchId: "branch-x" })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });

  it("gives an owner every active branch of their own tenant when no branch is active", async () => {
    const { prisma, service } = setup();

    await service.history(owner, undefined, {});

    expect(lastWhere(prisma.branch.findMany)).toEqual({ tenantId: "tenant-1", isActive: true });
    expect((lastWhere(prisma.sale.findMany).branchId.in as string[]).sort()).toEqual([
      "branch-a",
      "branch-b",
      "branch-c",
    ]);
  });
});

describe("SaleReadService.history — filters and pagination", () => {
  it("pages on the server and reports the total", async () => {
    const { prisma, service } = setup();
    prisma.sale.findMany.mockResolvedValue([summaryRow("000051"), summaryRow("000052")]);
    prisma.sale.count.mockResolvedValue(52);

    const result = await service.history(owner, "branch-a", { page: 3, pageSize: 25 });

    expect(prisma.sale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 50, take: 25, orderBy: [{ soldAt: "desc" }, { id: "desc" }] }),
    );
    expect(result).toMatchObject({ total: 52, page: 3, pageSize: 25 });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      invoiceNo: "INV-2610-000051",
      grandTotal: "1250.00",
      branch: { id: "branch-a", name: "Colombo" },
      itemCount: 2,
      sellerName: "Nimal Perera",
      // The negative card row is a refund, not a way the customer paid.
      paymentMethods: [PaymentMethod.cash],
    });
  });

  it("caps the page size and starts at page 1", async () => {
    const { prisma, service } = setup();

    const result = await service.history(owner, "branch-a", { page: 0, pageSize: 5000 });

    expect(prisma.sale.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 100 }));
    expect(result).toMatchObject({ page: 1, pageSize: 100 });
  });

  it("applies staff, payment method and invoice filters", async () => {
    const { prisma, service } = setup();

    await service.history(owner, "branch-a", {
      soldBy: "user-cashier",
      paymentMethod: PaymentMethod.card,
      invoiceNo: " inv-2610 ",
    });

    expect(lastWhere(prisma.sale.findMany)).toMatchObject({
      soldBy: "user-cashier",
      payments: { some: { method: PaymentMethod.card, amount: { gt: 0 } } },
      invoiceNo: { contains: "inv-2610", mode: "insensitive" },
    });
  });

  it("reads a date range as the tenant's calendar days, both ends inclusive", async () => {
    const { prisma, service } = setup();

    await service.history(owner, "branch-a", { from: "2026-10-01", to: "2026-10-27" });

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "tenant-1" } }));
    expect(lastWhere(prisma.sale.findMany).soldAt).toEqual({
      // Colombo is UTC+05:30, so its day starts at 18:30 UTC the evening before.
      gte: new Date("2026-09-30T18:30:00.000Z"),
      lt: new Date("2026-10-27T18:30:00.000Z"),
    });
  });

  it.each<[{ from?: string; to?: string }, string]>([
    [{ from: "2026-02-31" }, "a date that doesn't exist"],
    [{ from: "2026-10-27", to: "2026-10-01" }, "a range that ends before it starts"],
  ])("refuses %j (%s)", async (filters) => {
    const { prisma, service } = setup();

    await expect(service.history(owner, "branch-a", filters)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.sale.findMany).not.toHaveBeenCalled();
  });
});

describe("SaleReadService.historyOptions", () => {
  it("offers only viewable branches, and sellers from those branches", async () => {
    const { prisma, service } = setup();
    prisma.sale.findMany.mockResolvedValue([
      { seller: { id: "user-2", fullName: "Sunil" } },
      { seller: { id: "user-1", fullName: "Amara" } },
    ]);

    const options = await service.historyOptions(multiBranch);

    expect(options.branches.map((b) => b.id).sort()).toEqual(["branch-a", "branch-b"]);
    expect(lastWhere(prisma.sale.findMany)).toEqual({
      tenantId: "tenant-1",
      branchId: { in: expect.arrayContaining(["branch-a", "branch-b"]) },
    });
    expect(options.sellers.map((s) => s.fullName)).toEqual(["Amara", "Sunil"]);
  });
});

describe("SaleReadService.detail", () => {
  it("looks the sale up within the tenant and the branches the caller can view", async () => {
    const { prisma, service } = setup();

    await expect(service.detail(multiBranch, "sale-1")).rejects.toBeInstanceOf(NotFoundException);

    const where = lastWhere(prisma.sale.findFirst);
    expect(where).toMatchObject({ id: "sale-1", tenantId: "tenant-1" });
    expect((where.branchId.in as string[]).sort()).toEqual(["branch-a", "branch-b"]);
  });

  it("withholds costs without costs.view at the sale's branch", async () => {
    const { prisma, service } = setup();
    prisma.sale.findFirst.mockResolvedValue(detailRow("branch-b"));

    const sale = await service.detail(multiBranch, "sale-1");

    expect(sale.costTotal).toBeNull();
    expect(sale.items[0]!.unitCost).toBeNull();
    expect(JSON.stringify(sale)).not.toContain("120.5");
    expect(JSON.stringify(sale)).not.toContain("costPrice");
  });

  it("includes costs with costs.view at the sale's branch", async () => {
    const { prisma, service } = setup();
    prisma.sale.findFirst.mockResolvedValue(detailRow("branch-a"));

    const sale = await service.detail(multiBranch, "sale-1");

    expect(sale.items[0]!.unitCost).toBe("120.50");
    expect(sale.costTotal).toBe("482.00");
  });

  it("returns items, payments, customer, prescription and refunds", async () => {
    const { prisma, service } = setup();
    prisma.sale.findFirst.mockResolvedValue(detailRow("branch-b"));

    const sale = await service.detail(owner, "sale-1");

    expect(sale).toMatchObject({
      invoiceNo: "INV-2610-000042",
      branch: { id: "branch-b", name: "Kandy" },
      grandTotal: "950.00",
      customer: { fullName: "Kamala Silva" },
      prescription: { id: "rx-1", rxNumber: "RX-17" },
      dispenser: { fullName: "Ruwan Jayasuriya" },
      items: [
        expect.objectContaining({
          qty: 4,
          lineTotal: "950.00",
          batch: { id: "batch-1", batchNo: "B-77", expiryDate: "2027-06-30" },
        }),
      ],
      payments: [
        expect.objectContaining({ method: "cash", amount: "1000.00" }),
        expect.objectContaining({ amount: "-237.50", reference: "POS refund RET-2026-00003" }),
      ],
      refunds: [expect.objectContaining({ returnNumber: "RET-2026-00003", amount: "237.50" })],
      costTotal: "482.00",
    });
  });
});

describe("SaleReadService — till reads keep to one branch", () => {
  it("recent sales read only the till's branch", async () => {
    const { prisma, service } = setup();
    prisma.sale.findMany.mockResolvedValue([summaryRow("000001")]);

    const rows = await service.recent("tenant-1", "branch-a", 12, { todayOnly: true });

    expect(lastWhere(prisma.sale.findMany)).toMatchObject({ tenantId: "tenant-1", branchId: "branch-a" });
    expect(rows[0]).toMatchObject({ invoiceNo: "INV-2610-000001", summary: "2× Paracetamol" });
  });

  it("invoice search takes one branch or a set of branches", async () => {
    const { prisma, service } = setup();

    await service.searchInvoices("tenant-1", "branch-a", "0042");
    expect(lastWhere(prisma.sale.findMany)).toMatchObject({ tenantId: "tenant-1", branchId: "branch-a" });

    await service.searchInvoices("tenant-1", ["branch-a", "branch-b"], "0042");
    expect(lastWhere(prisma.sale.findMany)).toMatchObject({
      tenantId: "tenant-1",
      branchId: { in: ["branch-a", "branch-b"] },
    });
  });

  it("invoice lookup is scoped by tenant and branch", async () => {
    const { prisma, service } = setup();

    await expect(service.findByInvoice("tenant-1", "branch-a", "0042")).rejects.toBeInstanceOf(NotFoundException);
    for (const [args] of prisma.sale.findFirst.mock.calls) {
      expect(args.where).toMatchObject({ tenantId: "tenant-1", branchId: "branch-a" });
    }
  });
});

describe("SalesController — sales history permissions", () => {
  const permissionsOf = (method: string): string[] | undefined =>
    Reflect.getMetadata(
      PERMISSION_KEY,
      (SalesController.prototype as unknown as Record<string, () => unknown>)[method],
    );

  it.each(["history", "historyOptions", "historyDetail"])("%s requires sales.view", (method) => {
    expect(permissionsOf(method)).toEqual(["sales.view"]);
  });

  it("keeps the till's reads on sales.pos_use", () => {
    for (const method of ["posRecent", "posByInvoice", "posSearchInvoices"]) {
      expect(permissionsOf(method)).toEqual(["sales.pos_use"]);
    }
  });
});

describe("SalesHistoryQueryDto", () => {
  const errorsFor = async (query: Record<string, string>) =>
    (await validate(plainToInstance(SalesHistoryQueryDto, query), { forbidNonWhitelisted: true, whitelist: true }))
      .map((error) => error.property);

  it("accepts a branch id or all, and the paging and filter fields", async () => {
    expect(await errorsFor({ branchId: "all" })).toEqual([]);
    expect(
      await errorsFor({
        branchId: "0d4c1c2a-3f4b-4b7e-9a0c-6c1f2e3d4a5b",
        page: "2",
        pageSize: "50",
        from: "2026-10-01",
        to: "2026-10-27",
        soldBy: "6f9a2b1c-8d7e-4f60-a1b2-c3d4e5f6a7b8",
        paymentMethod: "mobile_wallet",
        invoiceNo: "INV-2610",
      }),
    ).toEqual([]);
  });

  it("rejects anything else", async () => {
    expect(
      await errorsFor({
        branchId: "everywhere",
        pageSize: "500",
        from: "27/10/2026",
        paymentMethod: "cheque",
        tenantId: "tenant-2",
      }),
    ).toEqual(expect.arrayContaining(["branchId", "pageSize", "from", "paymentMethod", "tenantId"]));
  });
});
