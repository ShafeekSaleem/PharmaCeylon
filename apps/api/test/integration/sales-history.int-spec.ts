import { randomUUID } from "node:crypto";
import { PaymentMethod, PrismaClient, RoleName } from "@prisma/client";
import { StockService } from "../../src/inventory/stock/stock.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { SaleReadService } from "../../src/sales/sale-read.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

/**
 * Finding a sale without the receipt (the desktop Returns page): by the customer's phone, however
 * it was typed in, and by the sale total. The phone match strips separators in SQL, so it runs
 * against PostgreSQL rather than a mock.
 */
const prisma: PrismaClient = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const reads = new SaleReadService(proxy as never, {} as never);
const stock = new StockService();

let fx: TenantFixture;
let other: TenantFixture;
const owner = (tenant: TenantFixture): RequestUser => ({
  userId: tenant.ownerId,
  tenantId: tenant.tenantId,
  tokenVersion: 0,
  email: "owner@it.test",
  fullName: "Owner",
  authMethod: "bearer",
  branchRoles: [{ branchId: tenant.mainBranchId, role: RoleName.owner }],
});

async function sale(tenant: TenantFixture, total: string, customerId: string | null, branchId = tenant.mainBranchId) {
  const batchId = await createStockedBatch(prisma, stock, tenant, { qty: 0, branchId });
  const row = await prisma.sale.create({
    data: {
      tenantId: tenant.tenantId,
      branchId,
      invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      subtotal: total,
      grandTotal: total,
      amountPaid: total,
      soldBy: tenant.clerkId,
      customerId,
      items: {
        create: { tenantId: tenant.tenantId, productId: tenant.productId, batchId, qty: 1, unitPrice: total, lineTotal: total },
      },
      payments: { create: { tenantId: tenant.tenantId, method: PaymentMethod.card, amount: total } },
    },
  });
  return row.invoiceNo;
}
const customer = (tenant: TenantFixture, fullName: string, phone: string | null) =>
  prisma.customer.create({ data: { tenantId: tenant.tenantId, fullName, phone } }).then((row) => row.id);

const invoices = (result: { items: Array<{ invoiceNo: string }> }) => result.items.map((row) => row.invoiceNo).sort();

let ruwanSale: string;
let ruwanSecond: string;
let nimalSale: string;
let walkIn: string;

beforeAll(async () => {
  fx = await createTenant(prisma, "sales-history");
  other = await createTenant(prisma, "sales-history-other");
  const ruwan = await customer(fx, "Ruwan Jayawardena", "071 482 0937");
  const nimal = await customer(fx, "Nimal Perera", "+94 77 123-4567");
  await customer(fx, "No phone", null);
  ruwanSale = await sale(fx, "6992.00", ruwan);
  ruwanSecond = await sale(fx, "120.00", ruwan);
  nimalSale = await sale(fx, "1250.00", nimal);
  walkIn = await sale(fx, "7000.00", null);
  // Ruwan's sale at another branch, and the same phone at another pharmacy.
  await sale(fx, "500.00", ruwan, fx.otherBranchId);
  await sale(other, "6992.00", await customer(other, "Someone else", "0714820937"));
});
afterAll(() => prisma.$disconnect());

describe("sales history: finding a sale without the receipt", () => {
  it.each(["071 482 0937", "0714820937", "+94714820937", "4820937"])(
    "finds the customer's sales at this branch by %p",
    async (typed) => {
      const result = await reads.history(owner(fx), fx.mainBranchId, { customerPhone: typed });
      expect(invoices(result)).toEqual([ruwanSale, ruwanSecond].sort());
      expect(result.items[0]).toMatchObject({ customerName: "Ruwan Jayawardena", customerPhone: "071 482 0937" });
    },
  );

  it("matches a phone stored with the country code and separators", async () => {
    const result = await reads.history(owner(fx), fx.mainBranchId, { customerPhone: "077 1234567" });
    expect(invoices(result)).toEqual([nimalSale]);
  });

  it("finds nothing for a phone nobody at this pharmacy has", async () => {
    const result = await reads.history(owner(fx), fx.mainBranchId, { customerPhone: "0112 999 888" });
    expect(result).toMatchObject({ total: 0, items: [] });
  });

  it("filters by the sale total, both ends inclusive", async () => {
    const result = await reads.history(owner(fx), fx.mainBranchId, { minTotal: "6992", maxTotal: "7000" });
    expect(invoices(result)).toEqual([ruwanSale, walkIn].sort());
  });

  it("combines phone and amount", async () => {
    const result = await reads.history(owner(fx), fx.mainBranchId, {
      customerPhone: "0714820937",
      minTotal: "1000",
    });
    expect(invoices(result)).toEqual([ruwanSale]);
  });

  it("keeps to today's dates alongside the new filters", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
    const result = await reads.history(owner(fx), fx.mainBranchId, {
      from: today,
      to: today,
      paymentMethod: PaymentMethod.card,
      soldBy: fx.clerkId,
      maxTotal: "1250.00",
    });
    expect(invoices(result)).toEqual([nimalSale, ruwanSecond].sort());
  });
});
