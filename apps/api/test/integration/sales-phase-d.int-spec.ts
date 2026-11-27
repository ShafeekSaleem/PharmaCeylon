import { randomUUID } from "node:crypto";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DesktopPosRollout, PaymentMethod, RoleName } from "@prisma/client";
import type { ExternalCardAttemptRecord, OfflineSaleIncident, TerminalIdentity } from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { DailyWorkService } from "../../src/dashboard/daily-work.service";
import { SaleReadService } from "../../src/sales/sale-read.service";
import { SalesQueuesService } from "../../src/sales/sales-queues.service";
import { NotificationsService } from "../../src/notifications/notifications.service";
import { SALES_RECOVERY_DAILY_WORK_KINDS, SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS } from "@pharmaceylon/shared";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { TenantBranchGuard } from "../../src/security/guards/tenant-branch.guard";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import { OfflineSupportRecords } from "../../src/terminals/offline-support-records.service";
import { sha256 } from "../../src/terminals/terminal-wire";
import {
  access,
  attest,
  counter,
  offlineJournal,
  prisma,
  proofs,
  sync,
  trust,
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
let mainAcceptedIncidentRecordId: string;
let mainSecondAcceptedIncidentRecordId: string;
let otherTenantAcceptedIncidentRecordId: string;
let hiddenBranchIncidentRecordId: string;
let hiddenBranchIdentity: TerminalIdentity;
let mainPaymentAttemptIds: string[];
let otherTenantPaymentAttemptId: string;
let hiddenBranchPaymentAttemptId: string;
let mainCollectedPaymentIds: string[];
let otherTenantCollectedPaymentId: string;
let hiddenBranchCollectedPaymentId: string;

const MAIN_PAYMENT_RECOVERY_FIXTURE_ATTEMPTS = 2;
const MAIN_COLLECTED_MONEY_FIXTURES = 2;
const MAIN_INCIDENT_NOTES_FIXTURES = 2;

const tenantBranchGuard = new TenantBranchGuard({ getAllAndOverride: () => false } as unknown as Reflector);

const ownerOn = (c: Counter): RequestUser => ({
  ...c.owner,
  branchRoles: [{ branchId: c.fx.mainBranchId, role: RoleName.owner }],
});

const cashierOn = (c: Counter): RequestUser => ({
  ...c.cashier,
  branchRoles: [{ branchId: c.fx.mainBranchId, role: RoleName.cashier }],
});

const denyBranchViaTenantGuard = (user: RequestUser, branchId: string) => {
  const request = { user, headers: { "x-branch-id": branchId } };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  expect(() => tenantBranchGuard.canActivate(ctx)).toThrow(ForbiddenException);
};

const guardPermission = async (user: RequestUser, branchId: string) => {
  const live = await prisma.$transaction((tx) => access.resolveLive(user, branchId, tx));
  if (!live.has("tenant.management")) throw new ForbiddenException("Permission denied");
};

const tx15 = <T>(run: (client: import("@prisma/client").Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

async function seedAcceptedSaleIncidentViaSync(c: Counter): Promise<string> {
  const j = offlineJournal(c);
  const signIn = j.signIn(c.cashier.userId, randomUUID());
  const open = j.open(signIn, 0);
  const sale = j.sale(signIn, [[c.batches.main, 1]]);
  const { staffSignInId, session } = signIn.payload;
  const incident = c.device.sign(
    {
      contractVersion: 1,
      kind: "sale_incident",
      recordId: randomUUID(),
      identity: c.identity,
      saleCommandId: sale.payload.commandId,
      recordedByUserId: c.cashier.userId,
      staffSignInId,
      workSessionId: session.workSessionId,
      recordedAt: sale.payload.occurredAt + 100,
      category: "other",
      description: "Phase D incident-notes queue fixture",
    } satisfies OfflineSaleIncident,
    c.identity.keyId,
  );
  await sync(c, { staffSignIns: [signIn], commands: [open, sale], supportRecords: [incident] });
  const row = await prisma.offlineSupportRecord.findFirstOrThrow({
    where: {
      tenantId: c.fx.tenantId,
      branchId: c.fx.mainBranchId,
      recordId: incident.payload.recordId,
    },
  });
  expect(row.status).toBe("accepted");
  return row.recordId;
}

async function enrollOtherBranch(c: Counter): Promise<TerminalIdentity> {
  const branchId = c.fx.otherBranchId;
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: c.fx.tenantId, branchId, userId: c.owner.userId, role: RoleName.owner },
      { tenantId: c.fx.tenantId, branchId, userId: c.cashier.userId, role: RoleName.cashier },
    ],
    skipDuplicates: true,
  });
  const register = await tx15((t) => trust.createCounter(t, c.owner, branchId, `Other ${randomUUID().slice(0, 4)}`));
  const challenge = await tx15((t) =>
    trust.beginEnrollment(t, c.owner, branchId, {
      registerId: register.id,
      keyId: randomUUID(),
      publicKeyHex: c.device.publicKeyHex,
      label: "Other desk",
    }),
  );
  const proof = await proofs.record(
    c.owner,
    branchId,
    c.device.sign(attest(c.fx, challenge, "enrollment", c.owner), challenge.identity.keyId, "attendance"),
  );
  const identity = await tx15((t) =>
    trust.finishEnrollment(t, c.owner, branchId, c.device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  await prisma.terminalStaffPreparation.create({
    data: { ...identity, id: undefined, staffUserId: c.cashier.userId, pinVersion: 1 },
  });
  return identity;
}

async function seedAcceptedIncidentOnPostedSale(
  c: Counter,
  saleCommandId: string,
  staffSignInId: string,
  workSessionId: string,
  description: string,
  recordedAt?: number,
): Promise<string> {
  const recordId = randomUUID();
  const signed = c.device.sign(
    {
      contractVersion: 1,
      kind: "sale_incident",
      recordId,
      identity: c.identity,
      saleCommandId,
      recordedByUserId: c.cashier.userId,
      staffSignInId,
      workSessionId,
      recordedAt: recordedAt ?? Date.now() - 30_000,
      category: "payment_uncertain",
      description,
    } satisfies OfflineSaleIncident,
    c.identity.keyId,
  );
  await prisma.$transaction((client) => support.record(client, c.owner, c.fx.mainBranchId, signed, Date.now()));
  await prisma.offlineSupportRecord.updateMany({
    where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId, recordId, status: "held" },
    data: { status: "accepted", heldReason: null, verifiedAt: new Date() },
  });
  return recordId;
}

async function seedHiddenBranchAcceptedIncident(c: Counter, identity: TerminalIdentity): Promise<string> {
  const branchId = c.fx.otherBranchId;
  const recordId = randomUUID();
  const signed = c.device.sign(
    {
      contractVersion: 1,
      kind: "sale_incident",
      recordId,
      identity,
      saleCommandId: randomUUID(),
      recordedByUserId: c.cashier.userId,
      staffSignInId: randomUUID(),
      workSessionId: randomUUID(),
      recordedAt: Date.now() - 60_000,
      category: "customer_dispute",
      description: "Hidden-branch incident-notes fixture",
    } satisfies OfflineSaleIncident,
    identity.keyId,
  );
  await prisma.$transaction((client) => support.record(client, c.owner, branchId, signed, Date.now()));
  await prisma.offlineSupportRecord.updateMany({
    where: { tenantId: c.fx.tenantId, enrollmentId: identity.enrollmentId, recordId, status: "held" },
    data: { status: "accepted", heldReason: null, verifiedAt: new Date() },
  });
  return recordId;
}

async function seedCollectedPaymentRow(
  c: Counter,
  opts: {
    branchId?: string;
    identity?: TerminalIdentity;
    sequence: number;
    providerReference: string;
    collectedAt?: Date;
  },
): Promise<string> {
  const branchId = opts.branchId ?? c.fx.mainBranchId;
  const identity = opts.identity ?? c.identity;
  const reviewId = randomUUID();
  const settlementId = randomUUID();
  const commandId = randomUUID();
  const recordHash = sha256(`collected-money-fixture-${settlementId}`);
  const now = opts.collectedAt ?? new Date();
  await prisma.offlineJournalReview.create({
    data: {
      id: reviewId,
      tenantId: c.fx.tenantId,
      branchId,
      terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId,
      keyId: identity.keyId,
      recordKind: "command",
      recordId: commandId,
      sequence: BigInt(opts.sequence),
      recordHash,
      outcome: "rejected",
      errorCode: "TEST_FIXTURE",
      envelope: {},
      receivedByUserId: c.owner.userId,
    },
  });
  await prisma.offlineJournalSettlement.create({
    data: {
      id: settlementId,
      tenantId: c.fx.tenantId,
      branchId,
      reviewId,
      enrollmentId: identity.enrollmentId,
      commandId,
      sequence: BigInt(opts.sequence),
      recordHash: sha256(commandId),
      decision: "not_honoured",
      reason: "Phase D collected-money queue fixture",
      status: "prepared",
      requestedBy: c.manager.userId,
    },
  });
  const signInRow = await prisma.offlineStaffSignIn.findFirst({
    where: { tenantId: c.fx.tenantId, branchId, enrollmentId: identity.enrollmentId },
    orderBy: { receivedAt: "desc" },
  });
  const shiftRow = await prisma.tillShift.findFirst({
    where: { tenantId: c.fx.tenantId, branchId },
    orderBy: { openedAt: "desc" },
  });
  const paymentId = randomUUID();
  await prisma.offlineCollectedPayment.create({
    data: {
      id: paymentId,
      tenantId: c.fx.tenantId,
      branchId,
      settlementId,
      enrollmentId: identity.enrollmentId,
      commandId,
      paymentIndex: 0,
      method: "external_card",
      amountMinor: 1500n,
      providerReference: opts.providerReference,
      approvalCode: "123456",
      approvedAt: now,
      workSessionId: signInRow?.workSessionId ?? randomUUID(),
      shiftId: shiftRow?.id ?? null,
      staffUserId: c.cashier.userId,
      collectedAt: now,
    },
  });
  return paymentId;
}

/** Retention triggers block ORM updates on collected payments; test-only. */
async function setCollectedPaymentCreatedAtForTest(paymentId: string, createdAt: Date) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
    await tx.$executeRaw`
      UPDATE offline_collected_payment
      SET created_at = ${createdAt}
      WHERE id = ${paymentId}::uuid`;
  });
}

/** Support records are immutable except verification fields; test-only receive/record shifts. */
async function setAcceptedIncidentReceiveTimesForTest(
  tenantId: string,
  recordId: string,
  receivedAt: Date,
  recordedAt?: Date,
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = 'replica'`;
    await tx.$executeRaw`
      UPDATE offline_support_record
      SET received_at = ${receivedAt},
          recorded_at = COALESCE(${recordedAt ?? null}, recorded_at)
      WHERE tenant_id = ${tenantId}::uuid AND record_id = ${recordId}::uuid AND status = 'accepted'`;
  });
}

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

async function seedHeldCardAttempt(
  c: Counter,
  branchId: string = c.fx.mainBranchId,
  identity: TerminalIdentity = c.identity,
): Promise<string> {
  const attempt = cardBinding();
  await prisma.$transaction((tx) =>
    support.record(
      tx,
      c.owner,
      branchId,
      c.device.sign(
        cardEvent(identity, attempt, {
          state: "not_used",
          providerReference: `RRN-${attempt.attemptId.slice(0, 8)}`,
          settlement: "refund_owed",
          reversalReference: null,
          reason: "Card approved, sale never completed",
          verifiedByUserId: c.manager.userId,
        }),
        identity.keyId,
      ),
      Date.now(),
    ),
  );
  return attempt.attemptId;
}

beforeAll(async () => {
  await ensureRbacSeed(prisma);
  main = await counter({ main: 20 });
  otherTenant = await counter({ main: 10 });
  const j = offlineJournal(main);
  const signIn = j.signIn(main.cashier.userId, randomUUID());
  const open = j.open(signIn, 0);
  const saleCmd = j.sale(signIn, [[main.batches.main, 1]]);
  journaledCommand = {
    commandId: saleCmd.payload.commandId,
    occurredAt: saleCmd.payload.occurredAt,
    receiptNumber: saleCmd.payload.receiptNumber,
  };
  const { staffSignInId, session } = signIn.payload;
  const mainIncident = main.device.sign(
    {
      contractVersion: 1,
      kind: "sale_incident",
      recordId: randomUUID(),
      identity: main.identity,
      saleCommandId: saleCmd.payload.commandId,
      recordedByUserId: main.cashier.userId,
      staffSignInId,
      workSessionId: session.workSessionId,
      recordedAt: saleCmd.payload.occurredAt + 100,
      category: "other",
      description: "Phase D incident-notes queue fixture",
    } satisfies OfflineSaleIncident,
    main.identity.keyId,
  );
  mainAcceptedIncidentRecordId = mainIncident.payload.recordId;
  await sync(main, { staffSignIns: [signIn], commands: [open, saleCmd], supportRecords: [mainIncident] });

  mainSecondAcceptedIncidentRecordId = await seedAcceptedIncidentOnPostedSale(
    main,
    journaledCommand.commandId,
    staffSignInId,
    session.workSessionId,
    "Second phase D incident-notes fixture",
  );

  mainPaymentAttemptIds = [
    await seedHeldCardAttempt(main),
    await seedHeldCardAttempt(main),
  ];
  otherTenantPaymentAttemptId = await seedHeldCardAttempt(otherTenant);
  hiddenBranchIdentity = await enrollOtherBranch(main);
  hiddenBranchPaymentAttemptId = await seedHeldCardAttempt(
    main,
    main.fx.otherBranchId,
    hiddenBranchIdentity,
  );

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

  const mainIncidentRow = await prisma.offlineSupportRecord.findFirstOrThrow({
    where: {
      tenantId: main.fx.tenantId,
      branchId: main.fx.mainBranchId,
      recordId: mainAcceptedIncidentRecordId,
    },
  });
  expect(mainIncidentRow.status).toBe("accepted");
  otherTenantAcceptedIncidentRecordId = await seedAcceptedSaleIncidentViaSync(otherTenant);
  hiddenBranchIncidentRecordId = await seedHiddenBranchAcceptedIncident(main, hiddenBranchIdentity);
  mainCollectedPaymentIds = [
    await seedCollectedPaymentRow(main, { sequence: 99_001, providerReference: "RRN-PHASE-D-COLLECTED-1" }),
    await seedCollectedPaymentRow(main, { sequence: 99_002, providerReference: "RRN-PHASE-D-COLLECTED-2" }),
  ];
  otherTenantCollectedPaymentId = await seedCollectedPaymentRow(otherTenant, {
    sequence: 99_011,
    providerReference: "RRN-PHASE-D-COLLECTED-OTHER",
  });
  hiddenBranchCollectedPaymentId = await seedCollectedPaymentRow(main, {
    branchId: main.fx.otherBranchId,
    identity: hiddenBranchIdentity,
    sequence: 99_021,
    providerReference: "RRN-PHASE-D-COLLECTED-HIDDEN",
  });
});

afterAll(() => prisma.$disconnect());

describe("sales phase D queues (Postgres)", () => {
  it("scopes collected money by row id across tenant and branch", async () => {
    const page = await queues.collectedMoney(ownerOn(main), main.fx.mainBranchId, {});
    const ids = page.items.map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(mainCollectedPaymentIds));
    expect(ids).not.toContain(otherTenantCollectedPaymentId);
    expect(ids).not.toContain(hiddenBranchCollectedPaymentId);
    expect(page.total).toBe(MAIN_COLLECTED_MONEY_FIXTURES);
    const otherPage = await queues.collectedMoney(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    expect(otherPage.items.map((row) => row.id)).toContain(otherTenantCollectedPaymentId);
    expect(otherPage.items.map((row) => row.id)).not.toContain(mainCollectedPaymentIds[0]);
  });

  it("reports pagination total on collected money", async () => {
    const page = await queues.collectedMoney(ownerOn(main), main.fx.mainBranchId, {
      page: 1,
      pageSize: 1,
    });
    expect(page.total).toBe(MAIN_COLLECTED_MONEY_FIXTURES);
    expect(page.items).toHaveLength(1);
  });

  it("scopes payment recovery by attempt id across tenant and branch", async () => {
    const page = await queues.paymentRecovery(ownerOn(main), main.fx.mainBranchId, {});
    const attemptIds = page.items.map((row) => row.attemptId);
    expect(attemptIds).toEqual(expect.arrayContaining(mainPaymentAttemptIds));
    expect(attemptIds).not.toContain(otherTenantPaymentAttemptId);
    expect(attemptIds).not.toContain(hiddenBranchPaymentAttemptId);
    expect(page.total).toBe(MAIN_PAYMENT_RECOVERY_FIXTURE_ATTEMPTS);
    const otherPage = await queues.paymentRecovery(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    expect(otherPage.items.map((row) => row.attemptId)).toContain(otherTenantPaymentAttemptId);
    expect(otherPage.items.map((row) => row.attemptId)).not.toContain(mainPaymentAttemptIds[0]);
  });

  it("reports pagination total on payment recovery", async () => {
    const page = await queues.paymentRecovery(ownerOn(main), main.fx.mainBranchId, {
      page: 1,
      pageSize: 1,
    });
    expect(page.total).toBe(MAIN_PAYMENT_RECOVERY_FIXTURE_ATTEMPTS);
    expect(page.items).toHaveLength(1);
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
    denyBranchViaTenantGuard(ownerOn(main), otherTenant.fx.mainBranchId);
  });
});

describe("incident notes queue (Postgres)", () => {
  it("lists accepted sale incidents for the caller branch with pagination total", async () => {
    const page = await queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, {
      page: 1,
      pageSize: 1,
    });
    expect(page.total).toBe(MAIN_INCIDENT_NOTES_FIXTURES);
    expect(page.items).toHaveLength(1);
    const full = await queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, {});
    const recordIds = full.items.map((row) => row.recordId);
    expect(recordIds).toEqual(expect.arrayContaining([mainAcceptedIncidentRecordId, mainSecondAcceptedIncidentRecordId]));
    expect(recordIds).not.toContain(otherTenantAcceptedIncidentRecordId);
    expect(recordIds).not.toContain(hiddenBranchIncidentRecordId);
  });

  it("keeps incident notes tenant- and branch-scoped", async () => {
    const otherPage = await queues.incidentNotes(ownerOn(otherTenant), otherTenant.fx.mainBranchId, {});
    expect(otherPage.items.some((row) => row.recordId === otherTenantAcceptedIncidentRecordId)).toBe(true);
    expect(otherPage.items.some((row) => row.recordId === mainAcceptedIncidentRecordId)).toBe(false);
    expect(otherPage.items.every((row) => row.branchId === otherTenant.fx.mainBranchId)).toBe(true);
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

describe("daily work sales recovery (W11 #145)", () => {
  const workAccess = new AccessService(prisma as never, permissions as never);
  const dailyWork = () => new DailyWorkService(prisma as never, workAccess as never);
  const notify = () =>
    new NotificationsService(
      prisma as never,
      permissions,
      dailyWork() as never,
    );

  const recoveryItems = (items: { id: string; kind: string }[]) =>
    items.filter((row) =>
      (SALES_RECOVERY_DAILY_WORK_KINDS as readonly string[]).includes(row.kind),
    );

  it("matches queue eligibility and counts for managers only", async () => {
    const [incidentQueue, paymentQueue, collectedQueue] = await Promise.all([
      queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, {}),
      queues.paymentRecovery(ownerOn(main), main.fx.mainBranchId, {}),
      queues.collectedMoney(ownerOn(main), main.fx.mainBranchId, {}),
    ]);
    const work = await dailyWork().get(ownerOn(main), main.fx.mainBranchId, {
      filter: "all",
      page: 1,
      pageSize: 100,
    });
    const recovery = recoveryItems(work.items);
    const incidentIds = recovery
      .filter((row) => row.kind === "sale_incident.review")
      .map((row) => row.id);
    const paymentIds = recovery
      .filter((row) => row.kind === "payment_recovery.review")
      .map((row) => row.id);
    const collectedIds = recovery
      .filter((row) => row.kind === "collected_money.review")
      .map((row) => row.id);

    expect(incidentIds).toEqual(
      expect.arrayContaining([
        `incident:${mainAcceptedIncidentRecordId}`,
        `incident:${mainSecondAcceptedIncidentRecordId}`,
      ]),
    );
    expect(incidentIds).not.toContain(`incident:${otherTenantAcceptedIncidentRecordId}`);
    expect(incidentIds).not.toContain(`incident:${hiddenBranchIncidentRecordId}`);
    expect(incidentIds.length).toBeLessThanOrEqual(incidentQueue.total);
    expect(incidentIds.length).toBeGreaterThan(0);

    expect(paymentIds).toEqual(
      expect.arrayContaining(mainPaymentAttemptIds.map((id) => `payment_recovery:${id}`)),
    );
    expect(paymentIds).not.toContain(`payment_recovery:${otherTenantPaymentAttemptId}`);
    expect(paymentIds).not.toContain(`payment_recovery:${hiddenBranchPaymentAttemptId}`);
    expect(paymentIds).toHaveLength(paymentQueue.total);

    expect(collectedIds).toEqual(
      expect.arrayContaining(mainCollectedPaymentIds.map((id) => `collected_money:${id}`)),
    );
    expect(collectedIds).not.toContain(`collected_money:${otherTenantCollectedPaymentId}`);
    expect(collectedIds).not.toContain(`collected_money:${hiddenBranchCollectedPaymentId}`);
    expect(collectedIds.length).toBeLessThanOrEqual(collectedQueue.total);
    expect(collectedIds.length).toBeGreaterThan(0);

    const cashierWork = await dailyWork().get(cashierOn(main), main.fx.mainBranchId, {
      filter: "all",
      page: 1,
      pageSize: 100,
    });
    expect(recoveryItems(cashierWork.items)).toHaveLength(0);
  });

  it("retires tasks when the domain row leaves the queue and deep-links Sales tabs", async () => {
    const attemptId = mainPaymentAttemptIds[0];
    const before = await dailyWork().get(ownerOn(main), main.fx.mainBranchId, {
      kind: "payment_recovery.review",
      filter: "all",
      page: 1,
      pageSize: 50,
    });
    expect(before.items.find((row) => row.id === `payment_recovery:${attemptId}`)).toMatchObject({
      href: `/sales?view=payment-recovery&attemptId=${attemptId}`,
      approval: false,
      blocked: false,
      where: "web",
    });
    await prisma.offlineSupportRecord.updateMany({
      where: {
        tenantId: main.fx.tenantId,
        branchId: main.fx.mainBranchId,
        attemptId,
        status: "held",
      },
      data: { status: "accepted", heldReason: null, verifiedAt: new Date() },
    });
    const after = await dailyWork().get(ownerOn(main), main.fx.mainBranchId, {
      kind: "payment_recovery.review",
      filter: "all",
      page: 1,
      pageSize: 50,
    });
    expect(after.total).toBe(before.total - 1);
    expect(after.items.some((row) => row.id === `payment_recovery:${attemptId}`)).toBe(false);
  });

  it("dedupes and retires operational notifications per recovery task", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    const notificationService = notify();
    const attemptId = mainPaymentAttemptIds[1];
    const key = `operational:${branchId}:work:payment_recovery:${attemptId}:payment_recovery.review`;
    await notificationService.list(owner, branchId, { status: "all", take: 100 });
    const created = await prisma.notification.findMany({
      where: {
        tenantId: owner.tenantId,
        recipientUserId: owner.userId,
        branchId,
        source: "operational_scan",
        dedupeKey: key,
        resolvedAt: null,
      },
    });
    expect(created).toHaveLength(1);

    await prisma.offlineSupportRecord.updateMany({
      where: {
        tenantId: main.fx.tenantId,
        branchId: main.fx.mainBranchId,
        attemptId,
        status: "held",
      },
      data: { status: "accepted", heldReason: null, verifiedAt: new Date() },
    });
    await notificationService.updatePreferences(owner.tenantId, owner.userId, {});
    await notificationService.list(owner, branchId, { status: "all", take: 100 });
    const retired = await prisma.notification.findFirst({
      where: { tenantId: owner.tenantId, recipientUserId: owner.userId, dedupeKey: key },
    });
    expect(retired?.resolvedAt).not.toBeNull();
  });

  it("does not resolve legacy counter notifications when recovery rows exceed the separate scan cap", async () => {
    await prisma.branch.update({
      where: { id: main.fx.mainBranchId, tenantId: main.fx.tenantId },
      data: { desktopPosRollout: DesktopPosRollout.live, desktopPosLiveAt: new Date() },
    });
    const importRow = await prisma.productImport.create({
      data: {
        tenantId: main.fx.tenantId,
        branchId: main.fx.mainBranchId,
        filename: "w11-notification-starvation.csv",
        status: "completed",
        stockStaged: true,
        stockStagedBy: main.manager.userId,
        createdBy: main.manager.userId,
        stagedStock: [
          {
            rowNumber: 1,
            productId: main.fx.productId,
            name: "Opening",
            categoryName: "Medicines",
            qty: 5,
            batchNo: `STARVE-${randomUUID().slice(0, 6)}`,
            expiryDate: "2031-12-31",
            unitCost: "10",
          },
        ],
      },
    });
    for (let n = 0; n < 24; n++) {
      await seedCollectedPaymentRow(main, {
        sequence: 88_000 + n,
        providerReference: `RRN-STARVE-${n}`,
      });
    }
    const owner = ownerOn(main);
    const svc = notify();
    await svc.updatePreferences(owner.tenantId, owner.userId, {});
    await svc.list(owner, main.fx.mainBranchId, { status: "all", take: 200 });

    const importKey = `operational:${main.fx.mainBranchId}:work:import:${importRow.id}:import_stock.post`;
    const staged = await prisma.notification.findFirst({
      where: {
        tenantId: owner.tenantId,
        recipientUserId: owner.userId,
        dedupeKey: importKey,
      },
    });
    expect(staged?.resolvedAt).toBeNull();

    const work = await dailyWork().get(owner, main.fx.mainBranchId, {
      filter: "all",
      page: 1,
      pageSize: 100,
    });
    expect(work.items.some((row) => row.id === `import:${importRow.id}`)).toBe(true);
    expect(work.items.filter((row) => row.kind === "collected_money.review").length).toBeGreaterThan(
      25,
    );
  });

  it("omits sales recovery notifications for cashiers", async () => {
    const svc = notify();
    await svc.list(cashierOn(main), main.fx.mainBranchId, { status: "all", take: 50 });
    const recovery = await prisma.notification.findMany({
      where: {
        tenantId: main.fx.tenantId,
        recipientUserId: main.cashier.userId,
        branchId: main.fx.mainBranchId,
        source: "operational_scan",
        dedupeKey: { contains: ":collected_money:" },
      },
    });
    expect(recovery).toHaveLength(0);
  });

  it("drops stale accepted incidents and collected money from work and resolves notifications", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    const staleMs = (SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    const insideMs = (SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS - 1) * 24 * 60 * 60 * 1000;
    const staleAt = new Date(Date.now() - staleMs);
    const freshAt = new Date(Date.now() - insideMs);
    const staleCollectedId = await seedCollectedPaymentRow(main, {
      sequence: 99_880,
      providerReference: "RRN-AGE-STALE",
      collectedAt: freshAt,
    });
    await setCollectedPaymentCreatedAtForTest(staleCollectedId, staleAt);
    const freshCollectedId = await seedCollectedPaymentRow(main, {
      sequence: 99_881,
      providerReference: "RRN-AGE-FRESH",
      collectedAt: freshAt,
    });
    const staleIncidentRecordId = await seedAcceptedIncidentOnPostedSale(
      main,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      "Stale accepted incident for max-age daily work",
      Date.now() - insideMs,
    );
    await setAcceptedIncidentReceiveTimesForTest(
      main.fx.tenantId,
      staleIncidentRecordId,
      staleAt,
      freshAt,
    );

    const notificationService = notify();
    const staleCollectedKey = `operational:${branchId}:work:collected_money:${staleCollectedId}:collected_money.review`;
    const staleIncidentKey = `operational:${branchId}:work:incident:${staleIncidentRecordId}:sale_incident.review`;
    await notificationService.list(owner, branchId, { status: "all", take: 200 });

    const work = await dailyWork().get(owner, branchId, {
      filter: "all",
      page: 1,
      pageSize: 100,
    });
    expect(work.items.some((row) => row.id === `collected_money:${staleCollectedId}`)).toBe(false);
    expect(work.items.some((row) => row.id === `collected_money:${freshCollectedId}`)).toBe(true);
    expect(work.items.some((row) => row.id === `incident:${staleIncidentRecordId}`)).toBe(false);
    expect(work.items.some((row) => row.id === `incident:${mainAcceptedIncidentRecordId}`)).toBe(
      true,
    );

    const [collectedQueue, incidentQueue] = await Promise.all([
      queues.collectedMoney(owner, branchId, { pageSize: 100 }),
      queues.incidentNotes(owner, branchId, { pageSize: 100 }),
    ]);
    expect(collectedQueue.items.some((row) => row.id === staleCollectedId)).toBe(true);
    expect(incidentQueue.items.some((row) => row.recordId === staleIncidentRecordId)).toBe(true);

    await notificationService.updatePreferences(owner.tenantId, owner.userId, {});
    await notificationService.list(owner, branchId, { status: "all", take: 200 });
    const staleCollectedNotice = await prisma.notification.findFirst({
      where: { tenantId: owner.tenantId, recipientUserId: owner.userId, dedupeKey: staleCollectedKey },
    });
    const staleIncidentNotice = await prisma.notification.findFirst({
      where: { tenantId: owner.tenantId, recipientUserId: owner.userId, dedupeKey: staleIncidentKey },
    });
    expect(staleCollectedNotice?.resolvedAt).not.toBeNull();
    expect(staleIncidentNotice?.resolvedAt).not.toBeNull();
  });

  it("uses server receive time for max-age so old device timestamps still show after sync", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    const staleDeviceMs = (SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS + 2) * 24 * 60 * 60 * 1000;
    const paymentId = await seedCollectedPaymentRow(main, {
      sequence: 99_770,
      providerReference: "RRN-OFFLINE-SYNC",
      collectedAt: new Date(Date.now() - staleDeviceMs),
    });
    const incidentRecordId = await seedAcceptedIncidentOnPostedSale(
      main,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      "Accepted after long offline outage",
      Date.now() - staleDeviceMs,
    );
    const work = await dailyWork().get(owner, branchId, { filter: "all", page: 1, pageSize: 100 });
    expect(work.items.some((row) => row.id === `collected_money:${paymentId}`)).toBe(true);
    expect(work.items.some((row) => row.id === `incident:${incidentRecordId}`)).toBe(true);
  });

  it("applies the max-age cutoff in UTC even when the DB session time zone is not UTC", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    const insideMs = 6 * 24 * 60 * 60 * 1000 + 22 * 60 * 60 * 1000;
    const receivedAt = new Date(Date.now() - insideMs);
    const recordId = await seedAcceptedIncidentOnPostedSale(
      main,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      "Max-age cutoff with non-UTC session",
      Date.now() - insideMs,
    );
    await setAcceptedIncidentReceiveTimesForTest(main.fx.tenantId, recordId, receivedAt, new Date(0));

    await prisma.$executeRaw`SET TIME ZONE 'Asia/Colombo'`;
    try {
      const work = await dailyWork().get(owner, branchId, { filter: "all", page: 1, pageSize: 100 });
      expect(work.items.some((row) => row.id === `incident:${recordId}`)).toBe(true);
    } finally {
      await prisma.$executeRaw`SET TIME ZONE 'UTC'`;
    }
  });

  it("keeps rows at the max-age boundary and drops rows just past it", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    const edgeMs = SALES_RECOVERY_DAILY_WORK_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const boundary = new Date(Date.now() - edgeMs + 2_000);
    const pastBoundary = new Date(Date.now() - edgeMs - 2_000);
    const insideId = await seedCollectedPaymentRow(main, {
      sequence: 99_771,
      providerReference: "RRN-BOUNDARY-IN",
    });
    const outsideId = await seedCollectedPaymentRow(main, {
      sequence: 99_772,
      providerReference: "RRN-BOUNDARY-OUT",
    });
    await setCollectedPaymentCreatedAtForTest(insideId, boundary);
    await setCollectedPaymentCreatedAtForTest(outsideId, pastBoundary);

    const work = await dailyWork().get(owner, branchId, { filter: "all", page: 1, pageSize: 100 });
    expect(work.items.some((row) => row.id === `collected_money:${insideId}`)).toBe(true);
    expect(work.items.some((row) => row.id === `collected_money:${outsideId}`)).toBe(false);
  });

  it("does not resolve accepted-incident notifications when collected-money rows fill that kind's cap", async () => {
    const owner = ownerOn(main);
    const branchId = main.fx.mainBranchId;
    for (let n = 0; n < 26; n++) {
      await seedCollectedPaymentRow(main, {
        sequence: 77_000 + n,
        providerReference: `RRN-PER-KIND-CAP-${n}`,
      });
    }
    const acceptedKey = `operational:${branchId}:work:incident:${mainAcceptedIncidentRecordId}:sale_incident.review`;
    const svc = notify();
    await svc.list(owner, branchId, { status: "all", take: 200 });
    const acceptedNotice = await prisma.notification.findFirst({
      where: { tenantId: owner.tenantId, recipientUserId: owner.userId, dedupeKey: acceptedKey },
    });
    expect(acceptedNotice?.resolvedAt).toBeNull();
  });

  it("excludes held sale incidents that are not in the manager-held reason set", async () => {
    const recordId = randomUUID();
    const signed = main.device.sign(
      {
        contractVersion: 1,
        kind: "sale_incident",
        recordId,
        identity: main.identity,
        saleCommandId: randomUUID(),
        recordedByUserId: main.cashier.userId,
        staffSignInId: randomUUID(),
        workSessionId: randomUUID(),
        recordedAt: Date.now() - 30_000,
        category: "other",
        description: "Held incident with non-manager reason",
      } satisfies OfflineSaleIncident,
      main.identity.keyId,
    );
    await prisma.$transaction((client) => support.record(client, main.owner, main.fx.mainBranchId, signed, Date.now()));
    await prisma.offlineSupportRecord.updateMany({
      where: { tenantId: main.fx.tenantId, recordId, status: "held" },
      data: { heldReason: "cashier_pending" },
    });

    const work = await dailyWork().get(ownerOn(main), main.fx.mainBranchId, {
      filter: "all",
      page: 1,
      pageSize: 100,
    });
    expect(work.items.some((row) => row.id === `incident:${recordId}`)).toBe(false);
    const queue = await queues.incidentNotes(ownerOn(main), main.fx.mainBranchId, {
      status: "held",
      pageSize: 100,
    });
    expect(queue.items.some((row) => row.recordId === recordId)).toBe(false);
  });

  it("does not duplicate notifications across repeated projection scans", async () => {
    const owner = ownerOn(main);
    const svc = notify();
    await svc.list(owner, main.fx.mainBranchId, { status: "all", take: 200 });
    await svc.updatePreferences(owner.tenantId, owner.userId, {});
    await svc.list(owner, main.fx.mainBranchId, { status: "all", take: 200 });
    const rows = await prisma.notification.findMany({
      where: {
        tenantId: owner.tenantId,
        recipientUserId: owner.userId,
        branchId: main.fx.mainBranchId,
        source: "operational_scan",
        dedupeKey: { contains: ":collected_money:" },
      },
      select: { dedupeKey: true },
    });
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(rows.length);
  });
});