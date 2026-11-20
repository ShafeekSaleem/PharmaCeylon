import { randomUUID } from "node:crypto";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PaymentMethod, RoleName } from "@prisma/client";
import type {
  ExternalCardAttemptRecord,
  OfflineJournalCommand,
  OfflineSaleIncident,
  Signed,
  TerminalIdentity,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { ensureRbacSeed } from "../../prisma/rbac-seed";
import { SaleReadService } from "../../src/sales/sale-read.service";
import { SalesQueuesService } from "../../src/sales/sales-queues.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { TenantBranchGuard } from "../../src/security/guards/tenant-branch.guard";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { commandText } from "../../src/terminals/terminal-wire";
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

const tenantBranchGuard = new TenantBranchGuard({ getAllAndOverride: () => false } as Reflector);

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
  } as ExecutionContext;
  expect(() => tenantBranchGuard.canActivate(ctx)).toThrow(ForbiddenException);
};

const guardPermission = async (user: RequestUser, branchId: string) => {
  const live = await prisma.$transaction((tx) => access.resolveLive(user, branchId, tx));
  if (!live.has("tenant.management")) throw new ForbiddenException("Permission denied");
};

const tx15 = <T>(run: (client: import("@prisma/client").Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

async function resumeJournal(c: Counter) {
  const last = await prisma.terminalCommandReceipt.findFirstOrThrow({
    where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId },
    orderBy: { offlineSequence: "desc" },
    select: { recordedAt: true, command: true, offlineSequence: true },
  });
  const first = await prisma.terminalCommandReceipt.findFirstOrThrow({
    where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId },
    orderBy: { offlineSequence: "asc" },
    select: { command: true },
  });
  const lastPayload = (last.command as Signed<OfflineJournalCommand>).payload;
  const firstPayload = (first.command as Signed<OfflineJournalCommand>).payload;
  const saleReceipts = (
    await prisma.terminalCommandReceipt.findMany({
      where: { tenantId: c.fx.tenantId, enrollmentId: c.identity.enrollmentId },
      select: { command: true },
    })
  ).filter((row) => (row.command as Signed<OfflineJournalCommand>).payload.kind === "ordinary_sale").length;
  return offlineJournal(c, {
    sequence: Number(last.offlineSequence),
    previous: sha256(commandText(lastPayload)),
    clock: last.recordedAt.getTime(),
    offlineStartedAt: firstPayload.offlineStartedAt,
    offlineSessionId: firstPayload.offlineSessionId,
    receipts: c.grant.receiptNumbering.nextNumber - 1 + saleReceipts,
  });
}

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
  opts: { branchId?: string; identity?: TerminalIdentity; sequence: number; providerReference: string },
): Promise<string> {
  const branchId = opts.branchId ?? c.fx.mainBranchId;
  const identity = opts.identity ?? c.identity;
  const reviewId = randomUUID();
  const settlementId = randomUUID();
  const commandId = randomUUID();
  const recordHash = sha256(`collected-money-fixture-${settlementId}`);
  const now = new Date();
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

  const j2 = await resumeJournal(main);
  const signIn2 = j2.signIn(main.cashier.userId, signIn.payload.session.workSessionId);
  const sale2 = j2.sale(signIn2, [[main.batches.main, 1]]);
  const mainIncident2 = main.device.sign(
    {
      contractVersion: 1,
      kind: "sale_incident",
      recordId: randomUUID(),
      identity: main.identity,
      saleCommandId: sale2.payload.commandId,
      recordedByUserId: main.cashier.userId,
      staffSignInId: signIn2.payload.staffSignInId,
      workSessionId: signIn2.payload.session.workSessionId,
      recordedAt: sale2.payload.occurredAt + 100,
      category: "quantity_error",
      description: "Second phase D incident-notes fixture",
    } satisfies OfflineSaleIncident,
    main.identity.keyId,
  );
  mainSecondAcceptedIncidentRecordId = mainIncident2.payload.recordId;
  await sync(main, { staffSignIns: [signIn2], commands: [sale2], supportRecords: [mainIncident2] });

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