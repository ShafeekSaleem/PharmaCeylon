import { PaymentMethod, Prisma, RoleName, SaleStatus } from "@prisma/client";
import type { RequestUser } from "../security/interfaces/authenticated-request.interface";
import { defaultPermissionsForRole } from "../security/permission-catalog";
import { SaleReadService } from "./sale-read.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

const dec = (value: string) => new Prisma.Decimal(value);

const TENANT = "tenant-1";
const BRANCH = "branch-1";
const EXPIRY = new Date("2027-06-30T00:00:00.000Z");

/** The sale as the database holds it: every column, and whole related rows. */
const STORED_SALE = {
  id: "sale-1",
  tenantId: TENANT,
  branchId: BRANCH,
  invoiceNo: "INV-2610-000042",
  status: SaleStatus.posted,
  soldAt: new Date("2026-10-20T04:00:00.000Z"),
  subtotal: dec("500"),
  discountTotal: dec("0"),
  taxTotal: dec("0"),
  grandTotal: dec("500"),
  amountPaid: dec("500"),
  changeDue: dec("0"),
  customerId: null,
  prescriptionId: null,
  notes: null,
  soldBy: "user-cashier",
  dispensedBy: null,
  createdAt: new Date("2026-10-20T04:00:00.000Z"),
  customer: null,
  prescription: null,
  seller: { id: "user-cashier", tenantId: TENANT, fullName: "Nimal Perera", email: "nimal@example.com" },
  dispenser: null,
  items: [
    {
      id: "item-1",
      tenantId: TENANT,
      saleId: "sale-1",
      productId: "product-1",
      batchId: "batch-1",
      qty: 2,
      unitPrice: dec("250"),
      discountAmount: dec("0"),
      taxAmount: dec("0"),
      lineTotal: dec("500"),
      createdAt: new Date("2026-10-20T04:00:00.000Z"),
      product: {
        id: "product-1",
        tenantId: TENANT,
        sku: "PCM-500",
        barcode: "4791234567890",
        name: "Paracetamol 500mg",
        unit: "tablet",
        isControlled: false,
        requiresPrescription: false,
      },
      batch: {
        id: "batch-1",
        tenantId: TENANT,
        branchId: BRANCH,
        productId: "product-1",
        batchNo: "B-77",
        expiryDate: EXPIRY,
        costPrice: dec("180.25"),
        sellingPrice: dec("250"),
        supplierId: "supplier-1",
        isQuarantined: false,
      },
    },
  ],
  payments: [
    {
      id: "pay-1",
      tenantId: TENANT,
      saleId: "sale-1",
      method: PaymentMethod.cash,
      amount: dec("500"),
      reference: null,
      createdAt: new Date("2026-10-20T04:00:00.000Z"),
    },
  ],
};

type QueryShape = boolean | { select?: Record<string, QueryShape>; include?: Record<string, QueryShape> };

const isValue = (value: unknown) =>
  value === null || typeof value !== "object" || value instanceof Date || Prisma.Decimal.isDecimal(value);

function columns(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([, value]) => isValue(value)));
}

/**
 * What Prisma hands back for a query against a stored row: a row's own columns plus the
 * relations it includes (`relation: true` is the related row's columns), or exactly the fields
 * it selects. Mocking the result instead would only test the mock.
 */
function shape(row: unknown, query: QueryShape): unknown {
  if (Array.isArray(row)) return row.map((entry) => shape(entry, query));
  if (row === null || row === undefined) return row;
  const record = row as Record<string, unknown>;
  if (query === true) return columns(record);
  if (typeof query !== "object") return undefined;
  if (query.select) {
    return Object.fromEntries(
      Object.entries(query.select)
        .filter(([, field]) => field)
        .map(([key, field]) => [key, isValue(record[key]) ? record[key] : shape(record[key], field)]),
    );
  }
  return {
    ...columns(record),
    ...Object.fromEntries(
      Object.entries(query.include ?? {})
        .filter(([, field]) => field)
        .map(([key, field]) => [key, shape(record[key], field)]),
    ),
  };
}

function setup() {
  const prisma = {
    sale: {
      findFirst: jest.fn(async (query: QueryShape) => shape(STORED_SALE, query)),
      findMany: jest.fn(async (query: QueryShape) => [shape(STORED_SALE, query)]),
    },
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue({ resourceId: "sale-1" }) },
    // The void's stock and status writes aren't what's under test, only what it answers with.
    $transaction: jest.fn().mockResolvedValue(undefined),
  };
  const sales = new SalesService(
    prisma as never,
    { log: jest.fn() } as never,
    {} as never,
    {} as never,
    { assertCanSell: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
  );
  const saleRead = new SaleReadService(prisma as never, {} as never);
  const controller = new SalesController(sales, {} as never, saleRead, {} as never, {} as never, {} as never);
  return { controller };
}

function userAs(role: RoleName): RequestUser {
  return {
    userId: `user-${role}`,
    tenantId: TENANT,
    email: `${role}@example.com`,
    fullName: role,
    authMethod: "cookie",
    branchRoles: [{ branchId: BRANCH, role }],
  };
}

const cashier = userAs(RoleName.cashier);
/** Voiding is a pharmacist's button, and a tenant can take `costs.view` away from pharmacists. */
const pharmacist = userAs(RoleName.pharmacist);

describe("Sale responses carry no batch cost", () => {
  it("a cashier uses the till and views sales without costs.view", () => {
    const grants = defaultPermissionsForRole(RoleName.cashier);
    expect(grants).toEqual(expect.arrayContaining(["sales.pos_use", "sales.view"]));
    expect(grants).not.toContain("costs.view");
  });

  it("the stored sale would leak the cost through a whole batch row", () => {
    // Keeps the check below honest: the old `batch: true` include fails it.
    const leaky = shape(STORED_SALE, { include: { items: { include: { batch: true } } } });
    expect(JSON.stringify(leaky)).toContain("costPrice");
  });

  // Refund answers with the same `getSale` read as void and `GET /sales/:id`.
  it.each<[string, (controller: SalesController) => Promise<unknown>]>([
    ["POST /sales/checkout", (c) => c.checkout(cashier, BRANCH, "key-1", { items: [] } as never)],
    ["GET /sales/pos/by-invoice", (c) => c.posByInvoice(cashier, BRANCH, "0042")],
    ["GET /sales", (c) => c.list(cashier, BRANCH)],
    ["GET /sales/:id", (c) => c.getOne(cashier, BRANCH, "sale-1")],
    ["POST /sales/:id/void", (c) => c.voidSale(pharmacist, BRANCH, "sale-1", {})],
  ])("%s leaves the cost out and keeps what the till renders", async (_route, call) => {
    const { controller } = setup();

    const response = await call(controller);

    const json = JSON.stringify(response);
    expect(json).not.toContain("costPrice");
    expect(json).not.toContain("180.25");
    expect(json).not.toContain("sellingPrice");

    const sale = (Array.isArray(response) ? response[0] : response) as typeof STORED_SALE;
    expect(sale).toMatchObject({ invoiceNo: "INV-2610-000042", seller: { fullName: "Nimal Perera" } });
    expect(sale.items[0]).toMatchObject({ productId: "product-1", batchId: "batch-1", qty: 2 });
    expect(sale.items[0]!.product).toEqual({
      id: "product-1",
      name: "Paracetamol 500mg",
      sku: "PCM-500",
      unit: "tablet",
    });
    expect(sale.items[0]!.batch).toEqual({ id: "batch-1", batchNo: "B-77", expiryDate: EXPIRY });
    expect(sale.payments[0]).toMatchObject({ method: PaymentMethod.cash });
  });
});
