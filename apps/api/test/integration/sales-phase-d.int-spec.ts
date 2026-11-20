import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { PaymentMethod, RoleName } from "@prisma/client";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { SaleReadService } from "../../src/sales/sale-read.service";
import { SalesQueuesService } from "../../src/sales/sales-queues.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { StockService } from "../../src/inventory/stock/stock.service";
import {
  counter,
  offlineJournal,
  sync,
  type Counter,
} from "./offline-counter.kit";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

const localPrisma = createPrisma();
const access = new AccessService(localPrisma as never, {} as never);
const stock = new StockService();

const queues = new SalesQueuesService(localPrisma as never);
const config = { get: () => 0 } as never;
const permissions = new PermissionsService(localPrisma as never, config);
const reads = new SaleReadService(localPrisma as never, permissions);

let main: Counter;
let otherTenant: Counter;
let fx: TenantFixture;
let offlineOnFx: string;
let pendingOnFx: string;
let journaledSaleId: string;
let journaledCommand: { commandId: string; occurredAt: number; receiptNumber: string };

const ownerOn = (c: Counter): RequestUser => ({
  ...c.owner,
  branchRoles: [{ branchId: c.fx.mainBranchId, role: RoleName.owner }],
});

const cashierOn = (c: Counter): RequestUser => ({
  ...c.cashier,
  branchRoles: [{ branchId: c.fx.mainBranchId, role: RoleName.cashier }],
});

const guardBranch = (user: RequestUser, branchId: string) => {
  if (!user.branchRoles.some((entry) => entry.branchId === branchId)) {
    throw new ForbiddenException("No access to requested branch");
  }
};

const guardPermission = async (user: RequestUser, branchId: string) => {
  const live = await localPrisma.$transaction((tx) => access.resolveLive(user, branchId, tx));
  if (!live.has("tenant.management")) throw new ForbiddenException("Permission denied");
};

async function seedAcceptedIncident(c: Counter, description: string) {
  const enrollment = await localPrisma.terminalEnrollment.findFirstOrThrow({
    where: { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, terminalId: c.identity.terminalId },
  });
  await localPrisma.offlineSupportRecord.create({
    data: {
      tenantId: c.fx.tenantId,
      branchId: c.fx.mainBranchId,
      terminalId: c.identity.terminalId,
      enrollmentId: enrollment.id,
      keyId: enrollment.keyId,
      kind: "sale_incident",
      recordId: randomUUID(),
      recordHash: randomUUID().replace(/-/g, "").slice(0, 64),
      envelope: {},
      staffSignInId: randomUUID(),
      workSessionId: randomUUID(),
      recordedAt: new Date("2026-10-01T10:00:00.000Z"),
      receivedAt: new Date("2026-10-01T10:01:00.000Z"),
      receivedByUserId: c.owner.userId,
      status: "accepted",
      incidentCategory: "other",
      description,
      recordedByUserId: c.cashier.userId,
    },
  });
}

async function seedHeldCard(c: Counter) {
  const enrollment = await localPrisma.terminalEnrollment.findFirstOrThrow({
    where: { tenantId: c.fx.tenantId, branchId: c.fx.mainBranchId, terminalId: c.identity.terminalId },
  });
  const attemptId = randomUUID();
  await localPrisma.offlineSupportRecord.create({
    data: {
      tenantId: c.fx.tenantId,
      branchId: c.fx.mainBranchId,
      terminalId: c.identity.terminalId,
      enrollmentId: enrollment.id,
      keyId: enrollment.keyId,
      kind: "external_card_attempt",
      recordId: randomUUID(),
      recordHash: randomUUID().replace(/-/g, "").slice(0, 64),
      envelope: {},
      staffSignInId: randomUUID(),
      workSessionId: randomUUID(),
      recordedAt: new Date("2026-10-02T10:00:00.000Z"),
      receivedAt: new Date("2026-10-02T10:01:00.000Z"),
      receivedByUserId: c.owner.userId,
      status: "held",
      heldReason: "card_not_used",
      attemptId,
      cardState: "not_used",
      amountMinor: 1500n,
      providerReference: "RRN-PHASE-D",
      approvalCode: "OK1",
    },
  });
  return attemptId;
}

beforeAll(async () => {
  await ensureRbacSeed(localPrisma);
  main = await counter({ main: 20 });
  otherTenant = await counter({ main: 10 });
  await seedAcceptedIncident(main, "Main branch incident");
  await seedAcceptedIncident(otherTenant, "Other tenant incident");
  await seedHeldCard(main);
  await seedHeldCard(otherTenant);

  fx = await createTenant(localPrisma, "sales-phase-d-fx");
  await localPrisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: RoleName.owner },
    ],
  });
  const batchId = await createStockedBatch(localPrisma, stock, fx, { qty: 50 });
  offlineOnFx = (
    await localPrisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `OFF-ACC-${randomUUID().slice(0, 6)}`,
        offlineCommandId: randomUUID(),
        subtotal: "20",
        grandTotal: "20",
        amountPaid: "20",
        soldBy: fx.clerkId,
        items: {
          create: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            batchId,
            qty: 1,
            unitPrice: "20",
            lineTotal: "20",
          },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "20" } },
      },
    })
  ).id;
  pendingOnFx = (
    await localPrisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `OFF-PEN-${randomUUID().slice(0, 6)}`,
        offlineCommandId: randomUUID(),
        stockPosting: "pending_reconciliation",
        subtotal: "15",
        grandTotal: "15",
        amountPaid: "15",
        soldBy: fx.clerkId,
        items: {
          create: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            batchId,
            qty: 1,
            unitPrice: "15",
            lineTotal: "15",
          },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "15" } },
      },
    })
  ).id;

  const j = offlineJournal(main);
  const signIn = j.signIn(main.cashier.userId, randomUUID());
  const open = j.open(signIn, 0);
  const saleCmd = j.sale(signIn, [[main.batches.main, 1]]);
  journaledCommand = {
    commandId: saleCmd.payload.commandId,
    occurredAt: saleCmd.payload.occurredAt,
    receiptNumber: saleCmd.payload.receiptNumber,
  };
  await sync(main, { staffSignIns: [signIn], commands: [open, saleCmd] });
  journaledSaleId = (
    await localPrisma.sale.findFirstOrThrow({
      where: { tenantId: main.fx.tenantId, offlineCommandId: saleCmd.payload.commandId },
    })
  ).id;
});

afterAll(() => localPrisma.$disconnect());

describe("sales phase D queues (Postgres)", () => {
  it("keeps incident notes tenant- and branch-scoped", async () => {
    const page = await queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, {});
    expect(page.items.some((row) => row.description === "Main branch incident")).toBe(true);
    expect(page.items.some((row) => row.description === "Other tenant incident")).toBe(false);
    const otherPage = await queues.incidentNotes(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    expect(otherPage.items.some((row) => row.description === "Other tenant incident")).toBe(true);
    expect(otherPage.items.some((row) => row.description === "Main branch incident")).toBe(false);
  });

  it("scopes collected-money rows to the requested branch", async () => {
    const page = await queues.collectedMoney(ownerOn(main), main.fx.mainBranchId, {});
    const otherPage = await queues.collectedMoney(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    for (const row of page.items) expect(row.branchId).toBe(main.fx.mainBranchId);
    for (const row of otherPage.items) expect(row.branchId).toBe(otherTenant.fx.mainBranchId);
    expect(page.items.some((row) => row.branchId === otherTenant.fx.mainBranchId)).toBe(false);
  });

  it("keeps payment recovery tenant-scoped", async () => {
    const page = await queues.paymentRecovery(ownerOn(main), main.fx.mainBranchId, {});
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((row) => row.branchId === main.fx.mainBranchId)).toBe(true);
    const otherPage = await queues.paymentRecovery(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    expect(otherPage.items.every((row) => row.branchId === otherTenant.fx.mainBranchId)).toBe(true);
  });

  it("reports pagination total on incident notes", async () => {
    for (let i = 0; i < 2; i++) await seedAcceptedIncident(main, `Extra note ${i}`);
    const page = await queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, { page: 1, pageSize: 2 });
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.items).toHaveLength(2);
  });

  it("honours payment-recovery sort=recordedAt", async () => {
    const page = await queues.paymentRecovery(ownerOn(main), main.fx.mainBranchId, {
      sort: "recordedAt",
    });
    const stamps = page.items.map((row) => row.recordedAt);
    const sorted = [...stamps].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    expect(stamps).toEqual(sorted);
  });

  it("denies queue access for cashier and foreign branches", async () => {
    await expect(guardPermission(cashierOn(main), main.fx.mainBranchId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(() => guardBranch(ownerOn(main), otherTenant.fx.mainBranchId)).toThrow(ForbiddenException);
  });
});

describe("sales history sync-state filters (Postgres)", () => {
  const fxOwner = (): RequestUser => ({
    userId: fx.ownerId,
    tenantId: fx.tenantId,
    tokenVersion: 0,
    email: "owner@phase-d.test",
    fullName: "Owner",
    authMethod: "bearer",
    branchRoles: [
      { branchId: fx.mainBranchId, role: RoleName.owner },
      { branchId: fx.otherBranchId, role: RoleName.owner },
    ],
  });

  it("filters accepted and pending_stock_posting and excludes online sales", async () => {
    const online = await localPrisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `WEB-${randomUUID().slice(0, 6)}`,
        subtotal: "9",
        grandTotal: "9",
        amountPaid: "9",
        soldBy: fx.clerkId,
        items: {
          create: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            batchId: (await localPrisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId } })).id,
            qty: 1,
            unitPrice: "9",
            lineTotal: "9",
          },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "9" } },
      },
    });
    const accepted = await reads.history(fxOwner(), fx.mainBranchId, { offlineSyncState: "accepted" });
    expect(accepted.items.some((row) => row.id === offlineOnFx)).toBe(true);
    expect(accepted.items.some((row) => row.id === online.id)).toBe(false);
    const pending = await reads.history(fxOwner(), fx.mainBranchId, {
      offlineSyncState: "pending_stock_posting",
    });
    expect(pending.items.some((row) => row.id === pendingOnFx)).toBe(true);
    expect(pending.items.every((row) => row.offlineSyncState === "pending_stock_posting")).toBe(true);
  });
});

describe("journaled offline sale receipt on history detail", () => {
  it("returns receipt number and counter recordedAt from the signed journal payload", async () => {
    const replayed = await localPrisma.terminalCommandReceipt.findFirstOrThrow({
      where: {
        tenantId: main.fx.tenantId,
        branchId: main.fx.mainBranchId,
        commandId: journaledCommand.commandId,
      },
    });
    const detail = await reads.detail(ownerOn(main), journaledSaleId);
    expect(detail.offlineReceipt).toMatchObject({
      receiptNumber: journaledCommand.receiptNumber,
      recordedAt: new Date(journaledCommand.occurredAt).toISOString(),
      syncedAt: replayed.recordedAt.toISOString(),
    });
    expect(detail.invoiceNo).toBe(journaledCommand.receiptNumber);
  });
});