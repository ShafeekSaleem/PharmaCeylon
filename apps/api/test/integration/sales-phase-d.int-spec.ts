import { randomUUID } from "node:crypto";
import { ForbiddenException } from "@nestjs/common";
import { PaymentMethod, RoleName } from "@prisma/client";
import type {
  ExternalCardAttemptRecord,
  OfflineSaleIncident,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { SaleReadService } from "../../src/sales/sale-read.service";
import { SalesQueuesService } from "../../src/sales/sales-queues.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import { OfflineSupportRecords } from "../../src/terminals/offline-support-records.service";
import { sha256 } from "../../src/terminals/terminal-wire";
import {
  access,
  counter,
  offlineJournal,
  prisma,
  sync,
  type Counter,
} from "./offline-counter.kit";
import { createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

const audit = new AuditService(prisma as never);
const support = new OfflineSupportRecords(
  access,
  audit,
  new BusinessHoursAcknowledgements(access, audit),
);
const stock = new StockService();

const queues = new SalesQueuesService(prisma as never);
const config = { get: () => 0 } as never;
const permissions = new PermissionsService(prisma as never, config);
const reads = new SaleReadService(prisma as never, permissions);

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
  const live = await prisma.$transaction((tx) => access.resolveLive(user, branchId, tx));
  if (!live.has("tenant.management")) throw new ForbiddenException("Permission denied");
};

const recordSigned = (c: Counter, signed: unknown) =>
  prisma.$transaction((tx) => support.record(tx, c.owner, c.fx.mainBranchId, signed, Date.now()));

const saleIncident = (c: Counter, description: string): OfflineSaleIncident => ({
  contractVersion: 1,
  kind: "sale_incident",
  recordId: randomUUID(),
  identity: c.identity,
  saleCommandId: randomUUID(),
  recordedByUserId: c.cashier.userId,
  staffSignInId: randomUUID(),
  workSessionId: randomUUID(),
  recordedAt: Date.now() - 60_000,
  category: "other",
  description,
});

type AttemptBinding = Pick<
  ExternalCardAttemptRecord,
  "attemptId" | "checkoutDraftId" | "reviewedSaleDigest" | "amountMinor" | "staffSignInId" | "workSessionId"
>;

const cardBinding = (): AttemptBinding => ({
  attemptId: randomUUID(),
  checkoutDraftId: randomUUID(),
  reviewedSaleDigest: sha256(randomUUID()),
  amountMinor: 245_000,
  staffSignInId: randomUUID(),
  workSessionId: randomUUID(),
});

const cardEvent = (
  identity: TerminalIdentity,
  attempt: AttemptBinding,
  state: Record<string, unknown> = { state: "prepared" },
): ExternalCardAttemptRecord =>
  ({
    contractVersion: 1,
    kind: "external_card_attempt",
    recordId: randomUUID(),
    identity,
    ...attempt,
    recordedAt: Date.now() - 30_000,
    ...state,
  }) as ExternalCardAttemptRecord;

async function syncAcceptedIncident(c: Counter, description: string) {
  const j = offlineJournal(c);
  const signIn = j.signIn(c.cashier.userId, randomUUID());
  const open = j.open(signIn, 0);
  const saleCmd = j.sale(signIn, [[c.batches.main, 1]]);
  const incident = c.device.sign(
    {
      ...saleIncident(c, description),
      saleCommandId: saleCmd.payload.commandId,
      staffSignInId: signIn.payload.staffSignInId,
      workSessionId: signIn.payload.session.workSessionId,
    },
    c.identity.keyId,
  );
  await sync(c, {
    staffSignIns: [signIn],
    commands: [open, saleCmd],
    supportRecords: [incident as never],
  });
  const row = await prisma.offlineSupportRecord.findFirstOrThrow({
    where: { tenantId: c.fx.tenantId, recordId: incident.payload.recordId },
  });
  if (row.status !== "accepted") {
    throw new Error(`expected accepted incident, got ${row.status}`);
  }
  return saleCmd;
}

async function seedHeldCard(c: Counter) {
  const attempt = cardBinding();
  await recordSigned(
    c,
    c.device.sign(
      cardEvent(c.identity, attempt, {
        state: "not_used",
        providerReference: "RRN-PHASE-D",
        settlement: "refund_owed",
        reversalReference: null,
        reason: "Card approved, sale never completed",
        verifiedByUserId: c.manager.userId,
      }),
      c.identity.keyId,
    ),
  );
  return attempt.attemptId;
}

beforeAll(async () => {
  await ensureRbacSeed(prisma);
  main = await counter({ main: 20 });
  otherTenant = await counter({ main: 10 });
  const journaledSale = await syncAcceptedIncident(main, "Main branch incident");
  journaledCommand = {
    commandId: journaledSale.payload.commandId,
    occurredAt: journaledSale.payload.occurredAt,
    receiptNumber: journaledSale.payload.receiptNumber,
  };
  await syncAcceptedIncident(otherTenant, "Other tenant incident");
  await seedHeldCard(main);
  await seedHeldCard(otherTenant);

  fx = await createTenant(prisma, "sales-phase-d-fx");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: RoleName.owner },
    ],
  });
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 50 });
  offlineOnFx = (
    await prisma.sale.create({
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
    await prisma.sale.create({
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

  journaledSaleId = (
    await prisma.sale.findFirstOrThrow({
      where: { tenantId: main.fx.tenantId, offlineCommandId: journaledCommand.commandId },
    })
  ).id;
});

afterAll(() => prisma.$disconnect());

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
    for (let i = 0; i < 2; i++) await syncAcceptedIncident(main, `Extra note ${i}`);
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
    const online = await prisma.sale.create({
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
            batchId: (await prisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId } })).id,
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
    const replayed = await prisma.terminalCommandReceipt.findFirstOrThrow({
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