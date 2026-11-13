import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, StockMovementType } from "@prisma/client";
import { PERMISSION_KEYS } from "../../src/security/permission-catalog";
import type { ActorAccess } from "../../src/security/access.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { integrationDatabaseUrl } from "./database-url";

export function createPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: integrationDatabaseUrl(), max: 20 }),
  });
}

export type TenantFixture = {
  tenantId: string;
  mainBranchId: string;
  otherBranchId: string;
  ownerId: string;
  clerkId: string;
  managerId: string;
  supplierId: string;
  productId: string;
};

/** A tenant with two branches, three users, a supplier and a product — isolated per test file. */
export async function createTenant(prisma: PrismaClient, label: string): Promise<TenantFixture> {
  const suffix = randomUUID().slice(0, 8);
  const tenant = await prisma.tenant.create({
    data: {
      code: `IT-${label}-${suffix}`.toUpperCase(),
      legalName: `Integration ${label}`,
      displayName: `Integration ${label}`,
      complianceRegion: "LK",
      timezone: "Asia/Colombo",
    },
  });
  const [main, other] = await Promise.all(
    ["MAIN", "GALLE"].map((code) =>
      prisma.branch.create({
        data: { tenantId: tenant.id, code, name: `${code} branch`, timezone: "Asia/Colombo" },
      }),
    ),
  );
  const [owner, clerk, manager] = await Promise.all(
    ["owner", "clerk", "manager"].map((who) =>
      prisma.appUser.create({
        data: {
          tenantId: tenant.id,
          email: `${who}-${suffix}@it.test`,
          fullName: `${who} ${suffix}`,
          passwordHash: "not-used",
        },
      }),
    ),
  );
  await prisma.tenantMembership.createMany({
    data: [owner!, clerk!, manager!].map((user) => ({ tenantId: tenant.id, userId: user.id })),
  });
  const supplier = await prisma.supplier.create({
    data: { tenantId: tenant.id, code: `SUP-${suffix}`, name: "Integration Supplier" },
  });
  const product = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      sku: `IT-${suffix}`,
      name: `Paracetamol ${suffix}`,
      rangeStatus: "RANGED",
    },
  });
  return {
    tenantId: tenant.id,
    mainBranchId: main!.id,
    otherBranchId: other!.id,
    ownerId: owner!.id,
    clerkId: clerk!.id,
    managerId: manager!.id,
    supplierId: supplier.id,
    productId: product.id,
  };
}

export function daysFromToday(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}

/** A batch with `qty` units received through the stock service. */
export async function createStockedBatch(
  prisma: PrismaClient,
  stock: StockService,
  fx: TenantFixture,
  opts: { batchNo?: string; qty: number; branchId?: string; expiryInDays?: number },
): Promise<string> {
  const branchId = opts.branchId ?? fx.mainBranchId;
  const batch = await prisma.batch.create({
    data: {
      tenantId: fx.tenantId,
      branchId,
      productId: fx.productId,
      batchNo: opts.batchNo ?? `B-${randomUUID().slice(0, 6)}`,
      expiryDate: daysFromToday(opts.expiryInDays ?? 365),
      costPrice: "10.00",
      sellingPrice: "15.00",
      supplierId: fx.supplierId,
    },
  });
  if (opts.qty > 0) {
    await prisma.$transaction((tx) =>
      stock.receive(
        tx,
        {
          tenantId: fx.tenantId,
          branchId,
          userId: fx.ownerId,
          referenceType: "adjustment",
          referenceId: randomUUID(),
        },
        [
          {
            productId: fx.productId,
            batchId: batch.id,
            qty: opts.qty,
            movementType: StockMovementType.opening_stock,
          },
        ],
      ),
    );
  }
  return batch.id;
}

export function actor(
  userId: string,
  permissions: string[] | "all",
  opts: { canSelfApprove?: boolean; roleKeys?: string[] } = {},
): ActorAccess {
  const granted = new Set(permissions === "all" ? PERMISSION_KEYS : permissions);
  return {
    userId,
    permissions: granted,
    roleKeys: opts.roleKeys ?? [],
    canSelfApprove: opts.canSelfApprove ?? false,
    has: (key: string) => granted.has(key),
  };
}

export async function batchTotals(prisma: PrismaClient, batchId: string) {
  const row = await prisma.batchStock.findUnique({ where: { batchId } });
  const ledger = await prisma.stockLedger.aggregate({
    where: { batchId },
    _sum: { qtyDelta: true },
  });
  return {
    onHand: row?.onHandQty ?? 0,
    quarantined: row?.quarantinedQty ?? 0,
    reserved: row?.reservedQty ?? 0,
    available: (row?.onHandQty ?? 0) - (row?.quarantinedQty ?? 0) - (row?.reservedQty ?? 0),
    ledgerOnHand: ledger._sum.qtyDelta ?? 0,
  };
}

/**
 * P2b #103: an open till shift for a counter staff session (the sign-in), written straight to the
 * table so suites about something else can sell or refund at a counter. `till-shifts.int-spec.ts`
 * covers opening one properly.
 */
export async function openTestShift(
  prisma: PrismaClient,
  tenantId: string,
  workSessionId: string,
  openingCashMinor = 0,
): Promise<string> {
  const session = await prisma.terminalStaffSession.findFirstOrThrow({ where: { tenantId, id: workSessionId } });
  const id = randomUUID();
  await prisma.tillShift.create({
    data: {
      id,
      tenantId,
      branchId: session.branchId,
      shiftNumber: `S-T${id.slice(0, 8)}`,
      registerId: session.registerId,
      tillId: session.tillId,
      terminalId: session.terminalId,
      enrollmentId: session.enrollmentId,
      staffUserId: session.staffUserId,
      openedStaffSessionId: session.id,
      openingCashMinor,
      openingCount: openingCashMinor > 0 ? [{ denominationMinor: openingCashMinor, count: 1 }] : [],
    },
  });
  return id;
}

/**
 * P2b #103: the session's staff member's open shift on its till, opened if the till has none.
 * For suites where the seller signs in and out of one counter between sales.
 */
export async function ensureTestShift(prisma: PrismaClient, tenantId: string, workSessionId: string): Promise<string> {
  const session = await prisma.terminalStaffSession.findFirstOrThrow({ where: { tenantId, id: workSessionId } });
  const open = await prisma.tillShift.findFirst({ where: { tenantId, tillId: session.tillId, closedAt: null } });
  return open?.id ?? openTestShift(prisma, tenantId, workSessionId);
}
