import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  OnlineCommandReceipt,
  OnlineTerminalCommand,
  SignedPhysicalOperation,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService, type AuditInput } from "../../src/audit/audit.service";
import { CategoryTaxonomyService } from "../../src/catalog/category-taxonomy.service";
import { PharmacistRegistrationService } from "../../src/clinical/pharmacist-registration.service";
import { businessDateKey } from "../../src/common/business-date.util";
import { PrescriptionsService } from "../../src/customers/prescriptions.service";
import { AdjustmentService } from "../../src/inventory/adjustment.service";
import { InventoryService } from "../../src/inventory/inventory.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { StockReadService } from "../../src/inventory/stock/stock-read.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { ImportStockService } from "../../src/product-import/import-stock.service";
import { ProductImportService } from "../../src/product-import/product-import.service";
import { HeldDeliveryService } from "../../src/purchasing/held-delivery.service";
import { PurchasingService } from "../../src/purchasing/purchasing.service";
import { AccessService } from "../../src/security/access.service";
import { WorkerAuthority } from "../../src/security/worker-authority";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { StocktakesService } from "../../src/stocktakes/stocktakes.service";
import { SignedOperations } from "../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../src/terminal-commands/terminal-command.executor";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  actor,
  batchTotals,
  createPrisma,
  createStockedBatch,
  createTenant,
  daysFromToday,
  type TenantFixture,
} from "./fixtures";

const prisma: PrismaClient = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);

/** Test-only: fail one named audit event, to prove audit failures roll back everything. */
class InjectableAudit extends AuditService {
  failOn: string | null = null;
  override async log(input: AuditInput, client?: Prisma.TransactionClient) {
    if (input.eventName === this.failOn) throw new Error(`Injected ${input.eventName} audit failure`);
    return super.log(input, client);
  }
}
/** Test-only independent attendance authority, as in terminal-verification.int-spec.ts. */
class FixtureAttendance extends LocalAttendanceVerifier {
  readonly proofs = new Map<string, AttendanceExpectation>();
  allow(
    p: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
    purpose: AttendanceExpectation["purpose"],
  ) {
    const id = randomUUID();
    this.proofs.set(id, {
      purpose,
      identity: p.identity,
      actorUserId: "requestedByUserId" in p ? p.requestedByUserId : p.session.staffUserId,
      registerId: "registerId" in p ? p.registerId : p.session.registerId,
      tillId: "tillId" in p ? p.tillId : p.session.tillId,
      payloadDigest: sha256(boundedCanonical(p)),
    });
    return id;
  }
  override async verify(_tx: Prisma.TransactionClient, proofId: string, expected: AttendanceExpectation) {
    if (boundedCanonical(this.proofs.get(proofId) ?? {}) !== boundedCanonical(expected))
      throw new Error("Unverified attendance");
    return proofId;
  }
}
/** Test-only hours provider; production still fails closed with TEMPORARILY_UNAVAILABLE. */
class OpenHours extends MandatoryOperationEvidence {
  override async hours() {}
}

const audit = new InjectableAudit(proxy as never);
const stock = new StockService();
const read = new StockReadService(proxy as never);
const access = new AccessService(proxy as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const registrations = new PharmacistRegistrationService(proxy as never, access, audit);
const authorization = new OperationAuthorizationService(access, trust,
  new OpenHours(undefined, undefined, registrations), approvals);
const prescriptions = new PrescriptionsService(proxy as never, audit);
const notifications = { notifyByPermission: jest.fn().mockResolvedValue(1), notifyUser: jest.fn().mockResolvedValue(undefined) };
const stocktakes = new StocktakesService(proxy as never, audit, stock, access, approvals);
const adjustments = new AdjustmentService(proxy as never,
  new InventoryService(proxy as never, audit, stock, read), notifications as never, audit, access, approvals);
const deliveries = new HeldDeliveryService(proxy as never,
  new PurchasingService(proxy as never, audit, stock, read), notifications as never, audit, access, approvals);
const importStock = new ImportStockService(proxy as never, stock, audit, access);
let runImport: (() => Promise<void>) | undefined;
const imports = new ProductImportService(proxy as never, audit, new CategoryTaxonomyService(proxy as never),
  { start: (_j: string, _t: string, id: string, work: (ctx: unknown) => Promise<void>) => {
    runImport = () => work({ jobId: id, importId: id, progress: () => {} });
  } } as never, { refresh: async () => {} } as never, stock, new WorkerAuthority(access));
const operations = new SignedOperations(stocktakes, adjustments, deliveries, importStock, imports, {} as never, {} as never, {} as never, {} as never, prescriptions);
const executor = new TerminalCommandExecutor(proxy as never, trust, authorization, operations, audit, access);

let fx: TenantFixture;
let foreign: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (userId: string, tenantId = fx.tenantId): RequestUser => ({
  userId, tenantId, tokenVersion: 0, branchRoles: [], email: "exec@it.test", fullName: "Executor",
  authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

/** An enrolled counter with an authorized staff session for `who`, through the real trust service. */
async function counterFor(who: string) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx(c => trust.createCounter(c, owner, branch(), `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx(c => trust.beginEnrollment(c, owner, branch(), {
    registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex,
  }));
  const identity = await tx(c => trust.finishEnrollment(c, owner, branch(),
    device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment, "enrollment")));
  const staff = user(who);
  const sessionPayload = await tx(c => trust.beginSession(c, staff, branch(), identity));
  const session = await tx(c => trust.finishSession(c, staff, branch(),
    device.sign(sessionPayload, identity.keyId), attendance.allow(sessionPayload, "session")));
  return { device, identity, session, staff };
}
type Counter = Awaited<ReturnType<typeof counterFor>>;

async function signedCommand(counter: Counter, operation: SignedPhysicalOperation, body: unknown,
  approvalEvidenceId: string | null) {
  const payload = await executor.prepare(counter.staff, branch(), {
    workSessionId: counter.session.workSessionId, operation, body, approvalEvidenceId,
    pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  return {
    payload,
    request: {
      command: counter.device.sign(payload, counter.identity.keyId),
      attendanceProofId: attendance.allow(payload, "command"),
    },
  };
}
const run = (counter: Counter, request: unknown, who = counter.staff, branchId = branch()) =>
  executor.execute(who, branchId, request);

// ── domain fixtures ─────────────────────────────────────────────────────────────
async function approvedStocktake(countedQty = 47, stocked = 50, approverId = fx.ownerId) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: stocked });
  const counter = actor(fx.clerkId, ["stocktakes.use"]);
  const reviewer = actor(fx.managerId, "all", { canSelfApprove: true });
  const created = await stocktakes.create(fx.tenantId, branch(), fx.clerkId,
    { scope: "custom", batchIds: [batchId], counterIds: [fx.clerkId] }, counter);
  await stocktakes.start(fx.tenantId, branch(), fx.clerkId, created.id, counter);
  await stocktakes.upsertLines(fx.tenantId, branch(), fx.clerkId, created.id,
    { lines: [{ batchId, countedQty }] }, counter);
  await stocktakes.submit(fx.tenantId, branch(), fx.clerkId, created.id, counter);
  await stocktakes.startReview(fx.tenantId, branch(), fx.managerId, created.id, reviewer);
  const detail = await stocktakes.getOne(fx.tenantId, branch(), created.id, reviewer);
  await stocktakes.reviewLines(fx.tenantId, branch(), fx.managerId, created.id,
    { lines: [{ lineId: detail.lines[0]!.id, reviewReason: "counting_error" }] }, reviewer);
  const fresh = await stocktakes.getOne(fx.tenantId, branch(), created.id, reviewer);
  const approved = await stocktakes.approve(user(approverId), branch(), created.id,
    { approvalId: randomUUID(), ...fresh.approvalReview! });
  return { id: created.id, batchId, approvalId: approved.executionApprovalId as string };
}
async function approvedHeldAdjustment() {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  const held = await adjustments.request(user(fx.clerkId), branch(), {
    productId: fx.productId, batchId, qty: 2, kind: "lost", reason: "Missing during count",
  });
  const id = held.heldAdjustment.id;
  const review = (await adjustments.listHeld(fx.tenantId, branch(), true)).find(row => row.id === id)!.approvalReview;
  const accepted = await adjustments.accept(user(fx.ownerId), branch(), id, { approvalId: randomUUID(), ...review });
  return { id, batchId, approvalId: accepted.executionApprovalId! };
}
async function approvedHeldDelivery() {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: 20 });
  const batch = await prisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: batchId } });
  const po = await prisma.purchaseOrder.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), supplierId: fx.supplierId, createdBy: fx.clerkId,
    poNumber: randomUUID(), status: "issued", items: { create: { tenantId: fx.tenantId,
      productId: fx.productId, orderedQty: 1, unitCost: "10.00", taxPercent: 0 } },
  } });
  const held = await deliveries.hold(fx.tenantId, branch(), fx.clerkId, po.id, {
    reasons: ["over_delivery"], detail: "Two delivered, one ordered", delivery: { purchaseOrderId: po.id,
      receivedOn: daysFromToday(0).toISOString().slice(0, 10), lines: [{ productId: fx.productId,
        batchNo: batch.batchNo, expiryDate: batch.expiryDate.toISOString(), receivedQty: 2, costPrice: "10.00", sellingPrice: "15.00" }] },
  });
  const review = (await deliveries.list(fx.tenantId, branch(), { canViewCost: true })).find(row => row.id === held.held.id)!.approvalReview;
  const accepted = await deliveries.accept(user(fx.ownerId), branch(), held.held.id, { approvalId: randomUUID(), ...review });
  return { id: held.held.id, batchId, poId: po.id, approvalId: accepted.executionApprovalId! };
}
async function stagedImport(qty = 12) {
  return prisma.productImport.create({ data: {
    tenantId: fx.tenantId, branchId: branch(), createdBy: fx.managerId, filename: "stock.csv",
    stockStaged: true, status: "completed",
    stagedStock: [{ rowNumber: 2, productId: fx.productId, name: "Opening", categoryName: "Medicines",
      qty, costPrice: 10.25, sellingPrice: 15, batchNo: randomUUID(), expiryDate: "2028-01-01T00:00:00.000Z" }] as never,
  } });
}
async function legacyImportWithStock() {
  const file = { buffer: Buffer.from(`Name,Qty,Cost,Sell,Batch\nImported ${randomUUID()},5,8,12,${randomUUID()}\n`),
    originalname: "opening.csv" } as Express.Multer.File;
  const started = await imports.startImport(fx.tenantId, { userId: fx.managerId, tokenVersion: 0 }, branch(), file,
    { name: "Name", qty: "Qty", costPrice: "Cost", sellingPrice: "Sell", batchNo: "Batch" }, [], {}, randomUUID());
  await runImport!();
  return started.importId;
}

// ── observation helpers ─────────────────────────────────────────────────────────
const receiptsFor = (commandId: string) =>
  prisma.terminalCommandReceipt.count({ where: { tenantId: fx.tenantId, commandId } });
const auditsFor = (eventName: string, entityId: string) =>
  prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName, entityId } });
const executionAudits = (commandId: string) => prisma.auditEvent.count({ where: {
  tenantId: fx.tenantId, eventName: "terminal.command_executed", payload: { path: ["commandId"], equals: commandId },
} });
const challengeConsumed = async (nonce: string) =>
  (await prisma.terminalChallenge.findFirstOrThrow({ where: { tenantId: fx.tenantId, nonceHash: sha256(nonce) } })).consumedAt !== null;

beforeAll(async () => {
  fx = await createTenant(prisma, "signed-exec");
  foreign = await createTenant(prisma, "signed-exec-foreign");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
    { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.managerId, role: "manager" },
    { tenantId: foreign.tenantId, branchId: foreign.mainBranchId, userId: foreign.ownerId, role: "owner" },
  ] });
});
afterAll(() => prisma.$disconnect());
afterEach(() => {
  audit.failOn = null;
  jest.restoreAllMocks();
});

describe("signed stocktake posting with original-result receipts", () => {
  it("lost response: retry returns the identical original result with one effect and one audit chain", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(47, 50);
    const { payload, request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post",
      { stocktakeId: st.id }, st.approvalId);
    const first = await run(counter, request);
    const retried = await run(counter, request); // the device never saw `first`
    expect(first).toMatchObject({
      kind: "online_command_receipt", commandId: payload.commandId, replayed: false,
      requestDigest: sha256(boundedCanonical(payload)), actorUserId: fx.managerId,
      workSessionId: counter.session.workSessionId,
      result: { type: "stocktake.posted", stocktakeId: st.id, approvalId: st.approvalId, effect: "applied" },
    });
    expect({ ...retried, replayed: false }).toEqual(first);
    expect(retried.replayed).toBe(true);
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(47);
    expect(await receiptsFor(payload.commandId)).toBe(1);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(1);
    expect(await executionAudits(payload.commandId)).toBe(1);
    const posted = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "stocktake.posted", entityId: st.id } });
    expect(posted.payload).toMatchObject({
      approvedByUserId: fx.ownerId, executedByUserId: fx.managerId,
      command: { commandId: payload.commandId, enrollmentId: counter.identity.enrollmentId,
        workSessionId: counter.session.workSessionId, requestDigest: first.requestDigest },
    });
  });

  it("concurrent identical retries produce one effect and the same receipt", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(40, 50);
    const { payload, request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post",
      { stocktakeId: st.id }, st.approvalId);
    const results = await Promise.all([run(counter, request), run(counter, request), run(counter, request)]);
    expect(new Set(results.map(r => r.receiptId)).size).toBe(1);
    expect(results.filter(r => !r.replayed)).toHaveLength(1);
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(40);
    expect(await receiptsFor(payload.commandId)).toBe(1);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(1);
    expect(await executionAudits(payload.commandId)).toBe(1);
  });

  it("rejects an altered replay of a committed command and an altered unexecuted command", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(45, 50);
    const other = await approvedStocktake(44, 50);
    const { payload, request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post",
      { stocktakeId: st.id }, st.approvalId);
    await run(counter, request);
    const altered = { ...payload, body: { stocktakeId: other.id }, approvalEvidenceId: other.approvalId };
    await expect(run(counter, { command: counter.device.sign(altered, counter.identity.keyId),
      attendanceProofId: attendance.allow(altered, "command") })).rejects.toMatchObject({
      status: 409, response: { code: "REPLAY_CONFLICT" } });
    // Changing a prepared-but-unexecuted command breaks its challenge digest.
    const fresh = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: other.id }, other.approvalId);
    const tampered = { ...fresh.payload, approvalEvidenceId: st.approvalId };
    await expect(run(counter, { command: counter.device.sign(tampered, counter.identity.keyId),
      attendanceProofId: attendance.allow(tampered, "command") })).rejects.toMatchObject({
      response: { code: "CHALLENGE_INVALID" } });
    expect((await batchTotals(prisma, other.batchId)).onHand).toBe(50);
    expect(await receiptsFor(fresh.payload.commandId)).toBe(0);
  });
});

describe("identity and device rejection, including owners", () => {
  let counter: Counter;
  beforeAll(async () => { counter = await counterFor(fx.ownerId); });

  async function command() {
    const st = await approvedStocktake(48, 50);
    return { st, ...(await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: st.id }, st.approvalId)) };
  }
  async function expectNoEffect(st: { id: string; batchId: string }, commandId: string) {
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(50);
    expect(await receiptsFor(commandId)).toBe(0);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(0);
  }

  it("rejects another tenant's owner and a different branch header", async () => {
    const { st, payload, request } = await command();
    await expect(run(counter, request, user(foreign.ownerId, foreign.tenantId), foreign.mainBranchId))
      .rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(run(counter, request, user(fx.ownerId), fx.otherBranchId))
      .rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expectNoEffect(st, payload.commandId);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
  });

  it("rejects another enrollment's identity and another device's signature", async () => {
    const other = await counterFor(fx.ownerId);
    const { st, payload } = await command();
    const borrowed = { ...payload, identity: other.identity };
    await expect(run(counter, { command: other.device.sign(borrowed, other.identity.keyId),
      attendanceProofId: attendance.allow(borrowed, "command") })).rejects.toMatchObject({
      response: { code: expect.stringMatching(/IDENTITY_MISMATCH|SESSION_INVALID/) } });
    await expect(run(counter, { command: other.device.sign(payload, counter.identity.keyId),
      attendanceProofId: attendance.allow(payload, "command") })).rejects.toMatchObject({
      response: { code: "INVALID_SIGNATURE" } });
    await expectNoEffect(st, payload.commandId);
  });

  it("rejects unverified attendance for the owner", async () => {
    const { st, payload, request } = await command();
    await expect(run(counter, { ...request, attendanceProofId: randomUUID() })).rejects.toThrow(/Unverified attendance/);
    await expectNoEffect(st, payload.commandId);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
  });

  it("rejects execution and replay from a revoked device", async () => {
    const device = await counterFor(fx.ownerId);
    const st = await approvedStocktake(46, 50);
    const done = await signedCommand(device, "POST /api/v1/stocktakes/:id/post", { stocktakeId: st.id }, st.approvalId);
    await run(device, done.request);
    const pendingSt = await approvedStocktake(48, 50);
    const pending = await signedCommand(device, "POST /api/v1/stocktakes/:id/post", { stocktakeId: pendingSt.id }, pendingSt.approvalId);
    await tx(c => trust.revokeEnrollment(c, user(fx.ownerId), branch(), device.identity.enrollmentId, "Stolen"));
    await expect(run(device, pending.request)).rejects.toMatchObject({ response: { code: "TERMINAL_REVOKED" } });
    await expect(run(device, done.request)).rejects.toMatchObject({ response: { code: "TERMINAL_REVOKED" } });
    await expectNoEffect(pendingSt, pending.payload.commandId);
  });

  it("refuses to replay another staff member's receipt", async () => {
    const st = await approvedStocktake(43, 50);
    const { request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: st.id }, st.approvalId);
    await run(counter, request);
    await expect(run(counter, request, user(fx.managerId))).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
  });
});

describe("live authority and lock scope", () => {
  const setManagerRole = (data: Prisma.UserBranchRoleUncheckedUpdateManyInput) =>
    prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId }, data });
  afterEach(() => setManagerRole({ role: "manager", roleId: null }));

  it("refuses execution and replay after the operation permission is removed", async () => {
    const counter = await counterFor(fx.managerId);
    const done = await approvedStocktake(39, 50);
    const committed = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: done.id }, done.approvalId);
    await run(counter, committed.request);
    const pendingSt = await approvedStocktake(38, 50);
    const pending = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: pendingSt.id }, pendingSt.approvalId);
    await setManagerRole({ role: "cashier" });
    await expect(run(counter, committed.request)).rejects.toMatchObject({ status: 403 });
    await expect(run(counter, pending.request)).rejects.toMatchObject({ status: 403 });
    expect((await batchTotals(prisma, pendingSt.batchId)).onHand).toBe(50);
    expect(await receiptsFor(pending.payload.commandId)).toBe(0);
    await setManagerRole({ role: "manager" });
    expect((await run(counter, committed.request)).replayed).toBe(true);
  });

  it("refuses execution and replay to a custom role without terminal.execute", async () => {
    const counter = await counterFor(fx.managerId);
    const done = await approvedStocktake(37, 50);
    const committed = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: done.id }, done.approvalId);
    await run(counter, committed.request);
    const pendingSt = await approvedStocktake(36, 50);
    const pending = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: pendingSt.id }, pendingSt.approvalId);
    // Migrations seed only migration-added keys; the catalog rows come from the app seed.
    await prisma.permission.createMany({ skipDuplicates: true, data: ["stocktakes.use", "stocktakes.review"]
      .map(key => ({ key, module: "stocktakes", label: key, description: key })) });
    const role = await prisma.role.create({ data: {
      tenantId: fx.tenantId, key: `reviewer-${randomUUID().slice(0, 8)}`, name: "Count reviewer",
      permissions: { create: ["stocktakes.use", "stocktakes.review"].map(permissionKey => ({ tenantId: fx.tenantId, permissionKey })) },
    } });
    await setManagerRole({ role: "custom", roleId: role.id });
    await expect(run(counter, committed.request)).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    await expect(run(counter, pending.request)).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    expect((await batchTotals(prisma, pendingSt.batchId)).onHand).toBe(50);
    expect(await challengeConsumed(pending.payload.serverNonce)).toBe(false);
  });

  it("replays a committed command while unrelated work holds the enrollment lock", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(35, 50);
    const { request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: st.id }, st.approvalId);
    const first = await run(counter, request);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const blocker = tx(async c => {
      await c.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${fx.tenantId}::uuid
        AND id = ${counter.identity.enrollmentId}::uuid FOR UPDATE`;
      locked();
      await gate;
    });
    try {
      await held;
      const replay = await Promise.race([
        run(counter, request),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Replay queued behind the enrollment lock")), 5_000)),
      ]);
      expect(replay).toEqual({ ...first, replayed: true });
    } finally {
      release();
      await blocker;
    }
  });
});

describe("injected failures roll back business effects, audit, receipt and nonce", () => {
  const failures: Array<[string, (commandId: string) => Promise<void>]> = [
    ["business", async () => {
      const original = stocktakes.postInTransaction.bind(stocktakes);
      jest.spyOn(stocktakes, "postInTransaction").mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error("Injected business failure after stock effects");
      });
    }],
    ["domain audit", async () => { audit.failOn = "stocktake.posted"; }],
    ["execution audit", async () => { audit.failOn = "terminal.command_executed"; }],
    ["receipt", async (commandId) => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS it_fail_receipt (command_id uuid PRIMARY KEY)`);
      await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION it_fail_receipt() RETURNS trigger AS $$
        BEGIN IF EXISTS (SELECT 1 FROM it_fail_receipt WHERE command_id = NEW.command_id) THEN
          RAISE EXCEPTION 'Injected receipt failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS it_fail_receipt ON terminal_command_receipt`);
      await prisma.$executeRawUnsafe(`CREATE TRIGGER it_fail_receipt BEFORE INSERT ON terminal_command_receipt
        FOR EACH ROW EXECUTE FUNCTION it_fail_receipt()`);
      await prisma.$executeRaw`INSERT INTO it_fail_receipt (command_id) VALUES (${commandId}::uuid)`;
    }],
  ];

  it.each(failures)("%s failure leaves no trace and the same signed command then succeeds once", async (_name, inject) => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(41, 50);
    const { payload, request } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post",
      { stocktakeId: st.id }, st.approvalId);
    await inject(payload.commandId);
    await expect(run(counter, request)).rejects.toThrow(/Injected/);
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(50);
    expect((await prisma.stocktake.findFirstOrThrow({ where: { id: st.id } })).status).toBe("approved");
    expect(await receiptsFor(payload.commandId)).toBe(0);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(0);
    expect(await executionAudits(payload.commandId)).toBe(0);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);

    audit.failOn = null;
    await prisma.$executeRawUnsafe(`DELETE FROM it_fail_receipt WHERE TRUE`).catch(() => undefined);
    const receipt = await run(counter, request);
    expect(receipt.replayed).toBe(false);
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(41);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(1);
    expect(await executionAudits(payload.commandId)).toBe(1);
  });
});

describe("held and import physical operations through signed commands", () => {
  let counter: Counter;
  beforeAll(async () => { counter = await counterFor(fx.managerId); });
  beforeEach(() => { notifications.notifyUser.mockClear(); });

  it("posts a held write-off once, notifies after commit and replays the original result", async () => {
    const held = await approvedHeldAdjustment();
    const { payload, request } = await signedCommand(counter, "POST /api/v1/inventory/held-adjustments/:id/post",
      { heldAdjustmentId: held.id }, held.approvalId);
    const [a, b] = await Promise.all([run(counter, request), run(counter, request)]);
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.result).toMatchObject({ type: "held_adjustment.posted", heldAdjustmentId: held.id, effect: "applied" });
    expect((await batchTotals(prisma, held.batchId)).onHand).toBe(18);
    expect(await auditsFor("inventory.write_off_posted", held.id)).toBe(1);
    expect(await executionAudits(payload.commandId)).toBe(1);
    const posted = notifications.notifyUser.mock.calls.filter(call => call[3]?.title === "Write-off posted");
    expect(posted).toHaveLength(1);
    const saved = await prisma.heldAdjustment.findFirstOrThrow({ where: { id: held.id } });
    expect(saved).toMatchObject({ status: "accepted", executedBy: fx.managerId,
      referenceId: (a.result as { stockReferenceId: string }).stockReferenceId });
  });

  it("refuses a held write-off command pinned to a replaced approval", async () => {
    const held = await approvedHeldAdjustment();
    const review = (await adjustments.listHeld(fx.tenantId, branch(), true)).find(row => row.id === held.id)!.approvalReview;
    await adjustments.accept(user(fx.ownerId), branch(), held.id, { approvalId: randomUUID(), ...review });
    const { request, payload } = await signedCommand(counter, "POST /api/v1/inventory/held-adjustments/:id/post",
      { heldAdjustmentId: held.id }, held.approvalId);
    await expect(run(counter, request)).rejects.toThrow();
    expect((await batchTotals(prisma, held.batchId)).onHand).toBe(20);
    expect(await receiptsFor(payload.commandId)).toBe(0);
  });

  it("posts a held delivery once and replays the goods receipt", async () => {
    const held = await approvedHeldDelivery();
    const { request } = await signedCommand(counter, "POST /api/v1/purchasing/held-deliveries/:id/post",
      { heldDeliveryId: held.id }, held.approvalId);
    const first = await run(counter, request);
    const again = await run(counter, request);
    expect(again).toEqual({ ...first, replayed: true });
    expect(first.result).toMatchObject({ type: "held_delivery.posted", effect: "applied" });
    expect((await batchTotals(prisma, held.batchId)).onHand).toBe(22);
    expect(await prisma.goodsReceipt.count({ where: { tenantId: fx.tenantId, purchaseOrderId: held.poId } })).toBe(1);
    expect(await auditsFor("purchase_order.held_delivery_posted", held.id)).toBe(1);
  });

  it("posts staged import stock once and reports a later distinct command as already applied", async () => {
    const draft = await stagedImport(12);
    const body = { importId: draft.id, version: draft.stockVersion, selection: "all", categoryName: null };
    const { request } = await signedCommand(counter, "POST /api/v1/products/import/:importId/stock/post", body, null);
    const first = await run(counter, request);
    expect(first.result).toMatchObject({ type: "import_stock.posted", batchesPosted: 1, unitsPosted: 12, effect: "applied" });
    expect((await run(counter, request)).replayed).toBe(true);
    const second = await signedCommand(counter, "POST /api/v1/products/import/:importId/stock/post", body, null);
    expect((await run(counter, second.request)).result).toMatchObject({ batchesPosted: 0, effect: "already_applied" });
    expect(await prisma.stockLedger.count({ where: { tenantId: fx.tenantId, referenceId: draft.id } })).toBe(1);
    expect(await auditsFor("products.import_stock_posted", draft.id)).toBe(1);
  });

  it("undoes untouched legacy import stock once through a signed command", async () => {
    const importId = await legacyImportWithStock();
    const { request } = await signedCommand(counter, "POST /api/v1/products/import/:importId/undo-stock", { importId }, null);
    const first = await run(counter, request);
    expect(first.result).toMatchObject({ type: "import.undone", importId, batchesRemoved: 1, productsRemoved: 1 });
    expect((await run(counter, request)).result).toEqual(first.result);
    expect((await prisma.productImport.findFirstOrThrow({ where: { id: importId } })).status).toBe("undone");
    expect(await prisma.stockLedger.count({ where: { tenantId: fx.tenantId, referenceId: importId } })).toBe(0);
    expect(await auditsFor("products.import_undone", importId)).toBe(1);
  });

  it("rejects approval evidence on an import command and a missing one on a held command", async () => {
    const draft = await stagedImport(3);
    await expect(signedCommand(counter, "POST /api/v1/products/import/:importId/stock/post",
      { importId: draft.id, version: 1, selection: "all", categoryName: null }, randomUUID()))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    await expect(signedCommand(counter, "POST /api/v1/inventory/held-adjustments/:id/post",
      { heldAdjustmentId: randomUUID() }, null)).rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
  });
});

describe("direct adjustments through signed commands", () => {
  const DIRECT = "POST /api/v1/inventory/adjustments" as const;
  const writeOff = (batchId: string, qty = 2) => ({
    kind: "damaged", movementType: null, productId: fx.productId, batchId, newBatch: null,
    qty, reason: "Dropped", fromQuarantine: false,
  });
  afterEach(() => prisma.tenantSettings.updateMany({ where: { tenantId: fx.tenantId },
    data: { approvalRequiredWriteOffThreshold: null, selfApprovalRoleKeys: ["owner", "manager"] } }));

  it("posts a write-off once, replays the original result and records the command in the audit", async () => {
    const counter = await counterFor(fx.managerId);
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 10 });
    const { payload, request } = await signedCommand(counter, DIRECT, writeOff(batchId), null);
    const [a, b] = await Promise.all([run(counter, request), run(counter, request)]);
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.result).toEqual({ type: "stock_adjustment.posted", productId: fx.productId, batchId,
      movementType: "adjustment_out", qty: 2, stockReferenceId: expect.any(String) });
    expect((await batchTotals(prisma, batchId)).onHand).toBe(8);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "inventory.adjustment",
      payload: { path: ["referenceId"], equals: (a.result as { stockReferenceId: string }).stockReferenceId } } });
    expect(event.payload).toMatchObject({ kind: "damaged", qty: 2, command: { commandId: payload.commandId,
      terminalId: counter.identity.terminalId, workSessionId: counter.session.workSessionId } });
    expect(await executionAudits(payload.commandId)).toBe(1);
    // A distinct command is a second adjustment, not a replay.
    const second = await signedCommand(counter, DIRECT, writeOff(batchId), null);
    await run(counter, second.request);
    expect((await batchTotals(prisma, batchId)).onHand).toBe(6);
  });

  it("opens a new batch with opening stock for someone who may add, but not write off, stock", async () => {
    const counter = await counterFor(fx.clerkId);
    const batchNo = `OPEN-${randomUUID().slice(0, 8)}`;
    const body = { kind: "opening", movementType: null, productId: fx.productId, batchId: null,
      newBatch: { batchNo, expiryDate: daysFromToday(400).toISOString().slice(0, 10), costPriceMinor: 1250,
        sellingPriceMinor: 1899, supplierId: null }, qty: 7, reason: null, fromQuarantine: false };
    const { request } = await signedCommand(counter, DIRECT, body, null);
    const receipt = await run(counter, request);
    const batch = await prisma.batch.findFirstOrThrow({ where: { tenantId: fx.tenantId, branchId: branch(), batchNo } });
    expect(receipt.result).toMatchObject({ batchId: batch.id, movementType: "adjustment_in", qty: 7 });
    expect([batch.costPrice.toFixed(2), batch.sellingPrice.toFixed(2)]).toEqual(["12.50", "18.99"]);
    expect((await batchTotals(prisma, batch.id)).onHand).toBe(7);

    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 4 });
    await expect(signedCommand(counter, DIRECT, writeOff(batchId), null))
      .rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
  });

  it("refuses a write-off that needs approval with no effect, receipt, held request or spent nonce", async () => {
    await prisma.tenantSettings.upsert({ where: { tenantId: fx.tenantId },
      update: { approvalRequiredWriteOffThreshold: 1, selfApprovalRoleKeys: ["owner"] },
      create: { tenantId: fx.tenantId, approvalRequiredWriteOffThreshold: 1, selfApprovalRoleKeys: ["owner"] } });
    const counter = await counterFor(fx.managerId);
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 10 });
    const heldBefore = await prisma.heldAdjustment.count({ where: { tenantId: fx.tenantId } });
    const { payload, request } = await signedCommand(counter, DIRECT, writeOff(batchId), null);
    await expect(run(counter, request)).rejects.toMatchObject({ response: { code: "WRITE_OFF_APPROVAL_REQUIRED" } });
    expect((await batchTotals(prisma, batchId)).onHand).toBe(10);
    expect(await receiptsFor(payload.commandId)).toBe(0);
    expect(await prisma.heldAdjustment.count({ where: { tenantId: fx.tenantId } })).toBe(heldBefore);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
  });

  it("takes no approval evidence and rolls everything back when the adjustment audit fails", async () => {
    const counter = await counterFor(fx.managerId);
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 5 });
    await expect(signedCommand(counter, DIRECT, writeOff(batchId), randomUUID()))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    const { payload, request } = await signedCommand(counter, DIRECT, writeOff(batchId), null);
    audit.failOn = "inventory.adjustment";
    await expect(run(counter, request)).rejects.toThrow("Injected inventory.adjustment audit failure");
    expect((await batchTotals(prisma, batchId)).onHand).toBe(5);
    expect(await receiptsFor(payload.commandId)).toBe(0);
    expect(await executionAudits(payload.commandId)).toBe(0);
  });
});

describe("remote callers, stale commands and stale authority (P1 #47 acceptance)", () => {
  const POST = "POST /api/v1/stocktakes/:id/post" as const;
  const setRole = (userId: string, data: Prisma.UserBranchRoleUncheckedUpdateManyInput) =>
    prisma.userBranchRole.updateMany({ where: { tenantId: fx.tenantId, branchId: branch(), userId }, data });
  const setTokenVersion = (userId: string, tokenVersion: number) =>
    prisma.appUser.update({ where: { id: userId }, data: { tokenVersion } });
  async function expectUnposted(st: { id: string; batchId: string }, commandId: string) {
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(50);
    expect((await prisma.stocktake.findFirstOrThrow({ where: { id: st.id } })).status).toBe("approved");
    expect(await receiptsFor(commandId)).toBe(0);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(0);
  }
  afterEach(async () => {
    await setRole(fx.managerId, { role: "manager", roleId: null });
    await setTokenVersion(fx.managerId, 0);
  });

  it("an owner's browser session cannot post stock: no terminal proof, no borrowed session, no unenrolled key", async () => {
    const st = await approvedStocktake(30, 50);
    const owner = user(fx.ownerId);
    const body = { stocktakeId: st.id };
    await expect(tx(c => authorization.authorize(c, owner, branch(), operations.get(POST).descriptor, { body })))
      .rejects.toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
    // Another person's counter session is not the owner's to sign with.
    const managers = await counterFor(fx.managerId);
    await expect(executor.prepare(owner, branch(), { workSessionId: managers.session.workSessionId, operation: POST,
      body, approvalEvidenceId: st.approvalId, pharmacistEvidenceId: null, operatingHoursExceptionId: null }))
      .rejects.toMatchObject({ response: { code: "SESSION_INVALID" } });
    // Nor is the manager's prepared command, re-signed by a key the owner made up.
    const { payload } = await signedCommand(managers, POST, body, st.approvalId);
    const ownKey = terminalDevice();
    await expect(run(managers, { command: ownKey.sign(payload, managers.identity.keyId),
      attendanceProofId: attendance.allow(payload, "command") }, owner)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" } });
    const invented = { ...payload, identity: { ...payload.identity, keyId: randomUUID() },
      session: { ...payload.session, staffUserId: fx.ownerId } };
    await expect(run(managers, { command: ownKey.sign(invented, invented.identity.keyId),
      attendanceProofId: attendance.allow(invented, "command") }, owner)).rejects.toMatchObject({
      response: { code: "IDENTITY_MISMATCH" } });
    await expectUnposted(st, payload.commandId);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
  });

  it("refuses an expired command without spending its nonce; the same command still runs once in time", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(31, 50);
    const { payload, request } = await signedCommand(counter, POST, { stocktakeId: st.id }, st.approvalId);
    jest.spyOn(Date, "now").mockReturnValue(payload.expiresAt + 1);
    await expect(run(counter, request)).rejects.toMatchObject({ response: { code: "CHALLENGE_EXPIRED" } });
    jest.restoreAllMocks();
    await expectUnposted(st, payload.commandId);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
    expect((await run(counter, request)).replayed).toBe(false);
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(31);
  });

  it("a spent nonce cannot carry a new command ID", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(32, 50);
    const { payload, request } = await signedCommand(counter, POST, { stocktakeId: st.id }, st.approvalId);
    await run(counter, request);
    const reused = { ...payload, commandId: randomUUID() };
    await expect(run(counter, { command: counter.device.sign(reused, counter.identity.keyId),
      attendanceProofId: attendance.allow(reused, "command") })).rejects.toMatchObject({
      response: { code: "CHALLENGE_INVALID" } });
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(32);
    expect(await receiptsFor(reused.commandId)).toBe(0);
    expect(await auditsFor("stocktake.posted", st.id)).toBe(1);
  });

  it("refuses a command signed before the executor's sign-in changed, and its replay", async () => {
    const counter = await counterFor(fx.managerId);
    const done = await approvedStocktake(33, 50);
    const committed = await signedCommand(counter, POST, { stocktakeId: done.id }, done.approvalId);
    await run(counter, committed.request);
    const pendingSt = await approvedStocktake(34, 50);
    const pending = await signedCommand(counter, POST, { stocktakeId: pendingSt.id }, pendingSt.approvalId);
    await setTokenVersion(fx.managerId, 1); // password change, logout-all or role edit
    await expect(run(counter, pending.request)).rejects.toThrow("Live branch authentication required");
    await expect(run(counter, committed.request)).rejects.toThrow("Live branch authentication required");
    await expectUnposted(pendingSt, pending.payload.commandId);
    expect(await challengeConsumed(pending.payload.serverNonce)).toBe(false);
  });

  it("refuses an approval whose approver has since lost the right to approve; a sign-in change alone does not void it", async () => {
    const counter = await counterFor(fx.ownerId);
    const st = await approvedStocktake(29, 50, fx.managerId);
    const { payload, request } = await signedCommand(counter, POST, { stocktakeId: st.id }, st.approvalId);
    await setRole(fx.managerId, { role: "cashier" });
    await expect(run(counter, request)).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    await expectUnposted(st, payload.commandId);
    expect(await challengeConsumed(payload.serverNonce)).toBe(false);
    // Approval evidence is held to the approver's current rights, not to their old access token.
    await setRole(fx.managerId, { role: "manager" });
    await setTokenVersion(fx.managerId, 5);
    const receipt = await run(counter, request);
    expect(receipt.result).toMatchObject({ type: "stocktake.posted", approvalId: st.approvalId, effect: "applied" });
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(29);
    const posted = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "stocktake.posted", entityId: st.id } });
    expect(posted.payload).toMatchObject({ approvedByUserId: fx.managerId, executedByUserId: fx.ownerId });
  });
});

describe("prescriptions through signed commands (clinical)", () => {
  const RX = "POST /api/v1/prescriptions" as const;
  let pharmacistId: string;
  const prescription = (rxNumber: string | null) => ({
    rxNumber, patientName: "Nimal Perera", doctorName: "Dr. Silva", doctorRegNo: "SLMC 9921",
    issuedOn: businessDateKey("Asia/Colombo", new Date()), validUntil: null, customerId: null, notes: null,
  });
  const rxNumber = () => `RX-IT-${randomUUID().slice(0, 8)}`;
  const registered = () => registrations.record(user(fx.ownerId), branch(), {
    userId: pharmacistId, slmcNumber: `PH-${randomUUID().slice(0, 8).toUpperCase()}`,
    expiresOn: businessDateKey("Asia/Colombo", new Date(Date.now() + 365 * 86_400_000)),
  });
  const recorded = (number: string) =>
    prisma.prescription.count({ where: { tenantId: fx.tenantId, branchId: branch(), rxNumber: number } });

  beforeAll(async () => {
    const pharmacist = await prisma.appUser.create({ data: { tenantId: fx.tenantId,
      email: `rx-pharmacist-${randomUUID().slice(0, 8)}@it.test`, fullName: "Rx Pharmacist", passwordHash: "x" } });
    pharmacistId = pharmacist.id;
    await prisma.tenantMembership.create({ data: { tenantId: fx.tenantId, userId: pharmacistId } });
    await prisma.userBranchRole.create({ data: { tenantId: fx.tenantId, branchId: branch(), userId: pharmacistId,
      role: "pharmacist" } });
  });
  afterEach(() => prisma.pharmacistRegistration.updateMany({
    where: { tenantId: fx.tenantId, revokedAt: null },
    data: { revokedAt: new Date(Date.now() + 3_600_000), revokedByUserId: fx.ownerId, revocationReason: "test reset" },
  }));

  it("records once for a registered pharmacist, replays the original result and audits the registration", async () => {
    const registration = await registered();
    const counter = await counterFor(pharmacistId);
    const number = rxNumber();
    const { payload, request } = await signedCommand(counter, RX, prescription(number), null);
    const [a, b] = await Promise.all([run(counter, request), run(counter, request)]);
    expect(a.receiptId).toBe(b.receiptId);
    expect(a.result).toEqual({ type: "prescription.recorded", prescriptionId: expect.any(String), rxNumber: number,
      pharmacistRegistrationId: registration.id });
    expect(await recorded(number)).toBe(1);
    const row = await prisma.prescription.findFirstOrThrow({ where: { tenantId: fx.tenantId, rxNumber: number } });
    expect(row).toMatchObject({ createdBy: pharmacistId, doctorRegNo: "SLMC 9921", validUntil: null });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId,
      eventName: "prescription.recorded", entityId: row.id } });
    expect(event.payload).toMatchObject({ rxNumber: number, command: { commandId: payload.commandId,
      terminalId: counter.identity.terminalId, pharmacistRegistrationId: registration.id } });
    expect(await executionAudits(payload.commandId)).toBe(1);
    // A distinct command is another prescription; with no number the branch sequence allocates one.
    const second = await signedCommand(counter, RX, prescription(null), null);
    expect((await run(counter, second.request)).result).toMatchObject({ rxNumber: expect.stringMatching(/^RX-/) });
  });

  it("refuses an owner or manager with no registration: no prescription, receipt or spent nonce", async () => {
    for (const who of [fx.ownerId, fx.managerId]) {
      const counter = await counterFor(who);
      const number = rxNumber();
      const { payload, request } = await signedCommand(counter, RX, prescription(number), null);
      await expect(run(counter, request)).rejects.toMatchObject({ response: { code: "PHARMACIST_REQUIRED" } });
      expect(await recorded(number)).toBe(0);
      expect(await receiptsFor(payload.commandId)).toBe(0);
      expect(await challengeConsumed(payload.serverNonce)).toBe(false);
    }
  });

  it("refuses a command prepared before the registration was revoked", async () => {
    const registration = await registered();
    const counter = await counterFor(pharmacistId);
    const number = rxNumber();
    const { payload, request } = await signedCommand(counter, RX, prescription(number), null);
    await registrations.revoke(user(fx.ownerId), branch(), registration.id, "Struck off");
    await expect(run(counter, request)).rejects.toMatchObject({ response: { code: "PHARMACIST_REQUIRED" } });
    expect(await recorded(number)).toBe(0);
    expect(await receiptsFor(payload.commandId)).toBe(0);
  });

  it("takes no approval or pharmacist evidence and rolls everything back when its audit fails", async () => {
    await registered();
    const counter = await counterFor(pharmacistId);
    await expect(signedCommand(counter, RX, prescription(rxNumber()), randomUUID()))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    const number = rxNumber();
    const { payload, request } = await signedCommand(counter, RX, prescription(number), null);
    audit.failOn = "prescription.recorded";
    await expect(run(counter, request)).rejects.toThrow("Injected prescription.recorded audit failure");
    expect(await recorded(number)).toBe(0);
    expect(await receiptsFor(payload.commandId)).toBe(0);
    expect(await executionAudits(payload.commandId)).toBe(0);
    audit.failOn = null;
    expect((await run(counter, request)).result).toMatchObject({ rxNumber: number });
  });
});

describe("production providers stay fail-closed", () => {
  it("denies execution without a test attendance or hours provider", async () => {
    const counter = await counterFor(fx.managerId);
    const st = await approvedStocktake(42, 50);
    const { request, payload } = await signedCommand(counter, "POST /api/v1/stocktakes/:id/post", { stocktakeId: st.id }, st.approvalId);
    const productionTrust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
    const production = new TerminalCommandExecutor(proxy as never, productionTrust,
      new OperationAuthorizationService(access, productionTrust, new MandatoryOperationEvidence(), approvals),
      new SignedOperations(stocktakes, adjustments, deliveries, importStock, imports, {} as never, {} as never, {} as never, {} as never, prescriptions), audit, access);
    await expect(production.execute(counter.staff, branch(), request)).rejects.toMatchObject({
      response: { code: "LOCAL_ATTENDANCE_UNAVAILABLE" } });
    const hoursOnly = new TerminalCommandExecutor(proxy as never, trust,
      new OperationAuthorizationService(access, trust, new MandatoryOperationEvidence(), approvals),
      new SignedOperations(stocktakes, adjustments, deliveries, importStock, imports, {} as never, {} as never, {} as never, {} as never, prescriptions), audit, access);
    await expect(hoursOnly.execute(counter.staff, branch(), request)).rejects.toMatchObject({
      response: { code: "TEMPORARILY_UNAVAILABLE" } });
    expect((await batchTotals(prisma, st.batchId)).onHand).toBe(50);
    expect(await receiptsFor(payload.commandId)).toBe(0);
  });
});

export type { OnlineCommandReceipt };
