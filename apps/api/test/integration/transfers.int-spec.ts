import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  OnlineTerminalCommand,
  SignedPhysicalOperation,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService, type AuditInput } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { ManagementApprovalsService } from "../../src/security/management-approvals.service";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { SignedOperations } from "../../src/terminal-commands/signed-operations";
import { TerminalCommandExecutor } from "../../src/terminal-commands/terminal-command.executor";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { TransfersService } from "../../src/transfers/transfers.service";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  actor,
  batchTotals,
  createPrisma,
  createStockedBatch,
  createTenant,
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
/** Test-only independent attendance authority, as in terminal-execution.int-spec.ts. */
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
const access = new AccessService(proxy as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const authorization = new OperationAuthorizationService(access, trust, new OpenHours(), approvals);
const transfers = new TransfersService(proxy as never, audit, stock, access, approvals);
const executor = new TerminalCommandExecutor(proxy as never, trust, authorization,
  new SignedOperations({} as never, {} as never, {} as never, {} as never, {} as never, transfers, {} as never, {} as never, {} as never),
  audit, access);

const SHIP = "POST /api/v1/transfers/:id/ship" satisfies SignedPhysicalOperation;
const RECEIVE = "POST /api/v1/transfers/:id/receive" satisfies SignedPhysicalOperation;

let fx: TenantFixture;
const source = () => fx.mainBranchId;
const destination = () => fx.otherBranchId;
const user = (userId: string): RequestUser => ({
  userId, tenantId: fx.tenantId, tokenVersion: 0, branchRoles: [], email: "transfer@it.test",
  fullName: "Transfer actor", authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

/** An enrolled counter at `branchId` with an authorized staff session for `who`. */
async function counterAt(branchId: string, who: string) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx(c => trust.createCounter(c, owner, branchId, `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx(c => trust.beginEnrollment(c, owner, branchId, {
    registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex,
  }));
  const identity = await tx(c => trust.finishEnrollment(c, owner, branchId,
    device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment, "enrollment")));
  const staff = user(who);
  const sessionPayload = await tx(c => trust.beginSession(c, staff, branchId, identity));
  const session = await tx(c => trust.finishSession(c, staff, branchId,
    device.sign(sessionPayload, identity.keyId), attendance.allow(sessionPayload, "session")));
  return { branchId, device, identity, session, staff };
}
type Counter = Awaited<ReturnType<typeof counterAt>>;

async function signed(counter: Counter, operation: SignedPhysicalOperation, body: unknown,
  approvalEvidenceId: string | null) {
  const payload = await executor.prepare(counter.staff, counter.branchId, {
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
const run = (counter: Counter, request: unknown, branchId = counter.branchId) =>
  executor.execute(counter.staff, branchId, request);

async function setApprovalRequired(required: boolean) {
  await prisma.tenantSettings.upsert({
    where: { tenantId: fx.tenantId },
    create: { tenantId: fx.tenantId, approvalRequiredForBranchTransfers: required },
    update: { approvalRequiredForBranchTransfers: required },
  });
}

/** A clerk's request (waiting for approval) of `qty` units from a fresh source batch. */
async function requestedTransfer(qty = 5, stocked = 12) {
  const batchId = await createStockedBatch(prisma, stock, fx, { qty: stocked, batchNo: `TR-${randomUUID().slice(0, 6)}` });
  const created = await transfers.create(user(fx.clerkId), source(), actor(fx.clerkId, ["transfers.manage"]), {
    toBranchId: destination(),
    items: [{ productId: fx.productId, batchId, qty }],
  });
  return { id: created!.id, batchId };
}
async function approvedTransfer(qty = 5, stocked = 12) {
  const t = await requestedTransfer(qty, stocked);
  const review = (await transfers.getOne(fx.tenantId, source(), t.id))!.approvalReview!;
  const approved = await transfers.approve(user(fx.managerId), source(), t.id, { approvalId: randomUUID(), ...review });
  return { ...t, approvalId: approved!.executionApprovalId as string };
}
async function dispatchedTransfer(qty = 5, stocked = 12) {
  const t = await approvedTransfer(qty, stocked);
  await transfers.ship(user(fx.managerId), source(), t.id, { approvalId: t.approvalId });
  const items = await prisma.transferItem.findMany({ where: { tenantId: fx.tenantId, transferId: t.id } });
  return { ...t, itemId: items[0]!.id };
}
async function destinationOnHand(sourceBatchId: string) {
  const sourceBatch = await prisma.batch.findFirstOrThrow({ where: { id: sourceBatchId } });
  const dest = await prisma.batch.findFirst({ where: { tenantId: fx.tenantId, branchId: destination(),
    productId: fx.productId, batchNo: sourceBatch.batchNo } });
  return dest ? (await batchTotals(prisma, dest.id)).onHand : 0;
}
const audits = (eventName: string, entityId: string) =>
  prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName, entityId } });
const receipts = (commandId: string) =>
  prisma.terminalCommandReceipt.count({ where: { tenantId: fx.tenantId, commandId } });

beforeAll(async () => {
  fx = await createTenant(prisma, "transfers");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.managerId, role: "manager" },
    // The clerk works at the source branch only.
    { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
  ] });
});
afterAll(() => prisma.$disconnect());
afterEach(async () => {
  audit.failOn = null;
  jest.restoreAllMocks();
  await setApprovalRequired(true);
});

describe("remote approval reserves stock without moving it", () => {
  it("approves the exact displayed content: reservation only, no ledger movement", async () => {
    const t = await requestedTransfer(5, 12);
    expect((await batchTotals(prisma, t.batchId)).reserved).toBe(0);
    const before = await prisma.stockLedger.count({ where: { tenantId: fx.tenantId, batchId: t.batchId } });
    const approved = await approvedTransfer(4, 10);
    expect(await batchTotals(prisma, approved.batchId)).toEqual(
      expect.objectContaining({ onHand: 10, reserved: 4, available: 6 }));
    expect(await prisma.stockLedger.count({ where: { tenantId: fx.tenantId, batchId: t.batchId } })).toBe(before);
    const row = await transfers.getOne(fx.tenantId, source(), approved.id);
    expect(row).toMatchObject({ status: "approved", executionApprovalId: approved.approvalId, dispatchedQty: 0, inTransitQty: 0 });
    const evidence = await prisma.managementApproval.findFirstOrThrow({ where: { id: approved.approvalId } });
    expect(evidence).toMatchObject({ documentType: "transfer", authorizedAction: "transfer.ship",
      requestedByUserId: fx.clerkId, approvedByUserId: fx.managerId, branchId: source() });
  });

  it("refuses a stale version/digest and the requester approving their own request", async () => {
    const t = await requestedTransfer();
    const review = (await transfers.getOne(fx.tenantId, source(), t.id))!.approvalReview!;
    await expect(transfers.approve(user(fx.managerId), source(), t.id,
      { approvalId: randomUUID(), expectedVersion: review.expectedVersion, expectedDigest: "0".repeat(64) }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    await expect(transfers.approve(user(fx.clerkId), source(), t.id, { approvalId: randomUUID(), ...review }))
      .rejects.toMatchObject({ status: 403 });
    expect((await batchTotals(prisma, t.batchId)).reserved).toBe(0);
  });

  it("self-approves on creation with exact evidence for a manager who may approve their own requests", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 9 });
    const created = await transfers.create(user(fx.managerId), source(),
      actor(fx.managerId, "all", { canSelfApprove: true }),
      { toBranchId: destination(), items: [{ productId: fx.productId, batchId, qty: 3 }] });
    expect(created).toMatchObject({ status: "approved", approvalWaived: false });
    expect(created!.executionApprovalId).toEqual(expect.any(String));
    expect((await batchTotals(prisma, batchId)).reserved).toBe(3);
  });
});

describe("browser dispatch is pinned to the approval", () => {
  it("dispatches once: stock leaves the source, is in transit, and the audit names every actor", async () => {
    const t = await approvedTransfer(5, 12);
    await expect(transfers.ship(user(fx.managerId), source(), t.id, { approvalId: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    const shipped = await transfers.ship(user(fx.managerId), source(), t.id, { approvalId: t.approvalId });
    expect(shipped).toMatchObject({ status: "in_transit", dispatchedQty: 5, inTransitQty: 5, receivedQty: 0 });
    expect(await batchTotals(prisma, t.batchId)).toEqual(expect.objectContaining({ onHand: 7, reserved: 0 }));
    // A second distinct dispatch is a no-op, not a second issue.
    await transfers.ship(user(fx.managerId), source(), t.id, { approvalId: t.approvalId });
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(7);
    expect(await audits("transfer.shipped", t.id)).toBe(1);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "transfer.shipped", entityId: t.id } });
    expect(event.payload).toMatchObject({ approvalId: t.approvalId, requestedByUserId: fx.clerkId,
      approvedByUserId: fx.managerId, executedByUserId: fx.managerId });
  });

  it("concurrent dispatches of one transfer move stock once", async () => {
    const t = await approvedTransfer(4, 10);
    const results = await Promise.allSettled([1, 2, 3].map(() =>
      transfers.ship(user(fx.managerId), source(), t.id, { approvalId: t.approvalId })));
    expect(results.every(r => r.status === "fulfilled")).toBe(true);
    expect(await batchTotals(prisma, t.batchId)).toEqual(expect.objectContaining({ onHand: 6, reserved: 0 }));
    expect(await audits("transfer.shipped", t.id)).toBe(1);
  });

  it("rejects a revoked approval and a material change made after approval", async () => {
    const revoked = await approvedTransfer(2, 8);
    await tx(c => approvals.revoke(c, user(fx.ownerId), source(), revoked.approvalId, "Wrong branch"));
    await expect(transfers.ship(user(fx.managerId), source(), revoked.id, { approvalId: revoked.approvalId }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });

    const edited = await approvedTransfer(2, 8);
    // A material edit through any writer bumps the approval version (database trigger).
    await prisma.transferItem.updateMany({ where: { tenantId: fx.tenantId, transferId: edited.id }, data: { qty: 3 } });
    await expect(transfers.ship(user(fx.managerId), source(), edited.id, { approvalId: edited.approvalId }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    for (const t of [revoked, edited])
      expect((await batchTotals(prisma, t.batchId)).onHand).toBe(8);

    // Bookkeeping columns written by dispatch are not material content.
    const fine = await approvedTransfer(1, 4);
    const version = (await prisma.transfer.findFirstOrThrow({ where: { id: fine.id } })).approvalVersion;
    await transfers.ship(user(fx.managerId), source(), fine.id, { approvalId: fine.approvalId });
    expect((await prisma.transfer.findFirstOrThrow({ where: { id: fine.id } })).approvalVersion).toBe(version);
  });

  it("an approved transfer with no evidence needs fresh approval while approval is required", async () => {
    const t = await requestedTransfer(2, 6);
    await prisma.$executeRaw`UPDATE transfer SET status = 'approved' WHERE id = ${t.id}::uuid`;
    await expect(transfers.ship(user(fx.managerId), source(), t.id, { approvalId: null }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_REQUIRED" } });
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(6);
  });
});

describe("destination receipt keeps in-transit accounting and destination authority", () => {
  it("receives partially then fully at the destination only", async () => {
    const t = await dispatchedTransfer(5, 12);
    await expect(transfers.receive(user(fx.clerkId), destination(), t.id, {})).rejects.toMatchObject({ status: 403 });
    await expect(transfers.receive(user(fx.managerId), source(), t.id, {})).rejects.toMatchObject({ status: 404 });
    const partial = await transfers.receive(user(fx.managerId), destination(), t.id,
      { dispatchApprovalId: t.approvalId, lines: [{ transferItemId: t.itemId, qty: 2 }] });
    expect(partial).toMatchObject({ status: "partially_received", dispatchedQty: 5, receivedQty: 2, inTransitQty: 3 });
    await expect(transfers.receive(user(fx.managerId), destination(), t.id,
      { dispatchApprovalId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    const done = await transfers.receive(user(fx.managerId), destination(), t.id, {});
    expect(done).toMatchObject({ status: "received", receivedQty: 5, inTransitQty: 0 });
    expect(await destinationOnHand(t.batchId)).toBe(5);
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(7);
  });
});

describe("browser partial receipts pinned to the count on screen", () => {
  it("two partial receives of the same count post once; the stale one is refused", async () => {
    const t = await dispatchedTransfer(5, 12);
    const count = { dispatchApprovalId: t.approvalId,
      lines: [{ transferItemId: t.itemId, qty: 2, receivedQtyBefore: 0 }] };
    const settled = await Promise.allSettled([
      transfers.receive(user(fx.managerId), destination(), t.id, count),
      transfers.receive(user(fx.managerId), destination(), t.id, count, "receive-key-b"),
    ]);
    expect(settled.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await destinationOnHand(t.batchId)).toBe(2);
    // A count taken after the first receipt still works.
    await transfers.receive(user(fx.managerId), destination(), t.id,
      { lines: [{ transferItemId: t.itemId, qty: 3, receivedQtyBefore: 2 }] });
    expect(await destinationOnHand(t.batchId)).toBe(5);
  });
});

describe("signed counter execution", () => {
  let sourceCounter: Counter;
  let destinationCounter: Counter;
  beforeAll(async () => {
    sourceCounter = await counterAt(fx.mainBranchId, fx.managerId);
    destinationCounter = await counterAt(fx.otherBranchId, fx.managerId);
  });

  it("dispatches at the source and receives at the destination end to end, replaying both", async () => {
    const t = await approvedTransfer(6, 10);
    const ship = await signed(sourceCounter, SHIP, { transferId: t.id }, t.approvalId);
    const first = await run(sourceCounter, ship.request);
    const replay = await run(sourceCounter, ship.request);
    expect(first.result).toEqual({ type: "transfer.dispatched", transferId: t.id, approvalId: t.approvalId,
      dispatchedQty: 6, effect: "applied" });
    expect({ ...replay, replayed: false }).toEqual(first);
    expect(replay.replayed).toBe(true);
    expect(await batchTotals(prisma, t.batchId)).toEqual(expect.objectContaining({ onHand: 4, reserved: 0 }));
    const shipped = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId, eventName: "transfer.shipped", entityId: t.id } });
    expect(shipped.payload).toMatchObject({ command: { commandId: ship.payload.commandId,
      enrollmentId: sourceCounter.identity.enrollmentId, requestDigest: first.requestDigest } });

    const itemId = (await prisma.transferItem.findFirstOrThrow({ where: { transferId: t.id } })).id;
    const body = { transferId: t.id, dispatchApprovalId: t.approvalId,
      lines: [{ transferItemId: itemId, qty: 6, receivedQtyBefore: 0 }] };
    const receive = await signed(destinationCounter, RECEIVE, body, null);
    const got = await run(destinationCounter, receive.request);
    expect(got.result).toEqual({ type: "transfer.received", transferId: t.id, dispatchApprovalId: t.approvalId,
      status: "received", receivedQty: 6 });
    expect((await run(destinationCounter, receive.request)).replayed).toBe(true);
    expect(await destinationOnHand(t.batchId)).toBe(6);
    expect(await audits("transfer.received", t.id)).toBe(1);
  });

  it("a distinct second receipt command for the same count is refused, never received twice", async () => {
    const t = await dispatchedTransfer(4, 8);
    const body = { transferId: t.id, dispatchApprovalId: t.approvalId,
      lines: [{ transferItemId: t.itemId, qty: 2, receivedQtyBefore: 0 }] };
    const a = await signed(destinationCounter, RECEIVE, body, null);
    const b = await signed(destinationCounter, RECEIVE, body, null);
    const settled = await Promise.allSettled([run(destinationCounter, a.request), run(destinationCounter, b.request)]);
    expect(settled.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(settled.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await destinationOnHand(t.batchId)).toBe(2);
  });

  it("concurrent identical dispatch retries produce one effect and one receipt", async () => {
    const t = await approvedTransfer(3, 9);
    const ship = await signed(sourceCounter, SHIP, { transferId: t.id }, t.approvalId);
    const results = await Promise.all([1, 2, 3].map(() => run(sourceCounter, ship.request)));
    expect(new Set(results.map(r => r.receiptId)).size).toBe(1);
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(6);
    expect(await receipts(ship.payload.commandId)).toBe(1);
    expect(await audits("transfer.shipped", t.id)).toBe(1);
  });

  it("a source counter cannot receive for the destination, and receipt requires destination authority", async () => {
    const t = await dispatchedTransfer(2, 5);
    const body = { transferId: t.id, dispatchApprovalId: t.approvalId,
      lines: [{ transferItemId: t.itemId, qty: 2, receivedQtyBefore: 0 }] };
    const fromSource = await signed(sourceCounter, RECEIVE, body, null);
    await expect(run(sourceCounter, fromSource.request, destination()))
      .rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(run(sourceCounter, fromSource.request)).rejects.toMatchObject({ status: 404 });
    expect(await destinationOnHand(t.batchId)).toBe(0);
  });

  it("refuses a dispatch command pinned to a replaced approval", async () => {
    const t = await approvedTransfer(2, 6);
    await tx(c => approvals.revoke(c, user(fx.ownerId), source(), t.approvalId, "Recount first"));
    const review = (await transfers.getOne(fx.tenantId, source(), t.id))!.approvalReview!;
    const replaced = await transfers.approve(user(fx.ownerId), source(), t.id, { approvalId: randomUUID(), ...review });
    expect(replaced!.executionApprovalId).not.toBe(t.approvalId);
    expect((await batchTotals(prisma, t.batchId)).reserved).toBe(2); // re-approval never reserves twice
    const ship = await signed(sourceCounter, SHIP, { transferId: t.id }, t.approvalId);
    await expect(run(sourceCounter, ship.request)).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(6);
  });

  it("dispatches with no approval evidence only while the tenant waives transfer approval", async () => {
    await setApprovalRequired(false);
    const t = await requestedTransfer(2, 7);
    const row = await transfers.getOne(fx.tenantId, source(), t.id);
    expect(row).toMatchObject({ status: "approved", executionApprovalId: null, approvalWaived: true });
    const withEvidence = await signed(sourceCounter, SHIP, { transferId: t.id }, randomUUID());
    await expect(run(sourceCounter, withEvidence.request)).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });

    await setApprovalRequired(true);
    const required = await signed(sourceCounter, SHIP, { transferId: t.id }, null);
    await expect(run(sourceCounter, required.request)).rejects.toMatchObject({ response: { code: "APPROVAL_REQUIRED" } });

    await setApprovalRequired(false);
    const ship = await signed(sourceCounter, SHIP, { transferId: t.id }, null);
    expect((await run(sourceCounter, ship.request)).result).toMatchObject({ approvalId: null, effect: "applied" });
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(5);
  });

  it("an injected audit failure rolls back the dispatch, its receipt and nonce; the retry succeeds once", async () => {
    const t = await approvedTransfer(3, 9);
    const ship = await signed(sourceCounter, SHIP, { transferId: t.id }, t.approvalId);
    audit.failOn = "transfer.shipped";
    await expect(run(sourceCounter, ship.request)).rejects.toThrow("Injected transfer.shipped audit failure");
    expect(await batchTotals(prisma, t.batchId)).toEqual(expect.objectContaining({ onHand: 9, reserved: 3 }));
    expect((await prisma.transfer.findFirstOrThrow({ where: { id: t.id } })).status).toBe("approved");
    expect(await receipts(ship.payload.commandId)).toBe(0);
    const nonce = (ship.payload as { serverNonce: string }).serverNonce;
    const challenge = await prisma.terminalChallenge.findFirstOrThrow({ where: { tenantId: fx.tenantId, nonceHash: sha256(nonce) } });
    expect(challenge.consumedAt).toBeNull();
    audit.failOn = null;
    expect((await run(sourceCounter, ship.request)).replayed).toBe(false);
    expect((await batchTotals(prisma, t.batchId)).onHand).toBe(6);
    expect(await audits("transfer.shipped", t.id)).toBe(1);
  });
});
