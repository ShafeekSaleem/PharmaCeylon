import { randomUUID } from "node:crypto";
import type {
  OnlineTerminalCommand,
  SignedPhysicalOperation,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { Prisma, PrismaClient } from "@prisma/client";
import { AuditService, type AuditInput } from "../../src/audit/audit.service";
import { CounterWorkService } from "../../src/terminal-commands/counter-work.service";
import { SupplierCashPayoutService } from "../../src/purchasing/ledger/supplier-cash-payout.service";
import { SupplierLedgerService } from "../../src/purchasing/ledger/supplier-ledger.service";
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
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, daysFromToday, openTestShift, type TenantFixture } from "./fixtures";

const prisma: PrismaClient = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);

class InjectableAudit extends AuditService {
  failOn: string | null = null;
  override async log(input: AuditInput, client?: Prisma.TransactionClient) {
    if (input.eventName === this.failOn) throw new Error(`Injected ${input.eventName} audit failure`);
    return super.log(input, client);
  }
}

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

class OpenHours extends MandatoryOperationEvidence {
  override async hours() {}
}

const audit = new InjectableAudit(proxy as never);
const access = new AccessService(proxy as never, {} as never);
const approvals = new ManagementApprovalsService(access, audit);
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const authorization = new OperationAuthorizationService(access, trust, new OpenHours(), approvals);
const shifts = new TillShiftsService(proxy as never, trust, new OperatingHoursEvidence(), access, audit, {} as never);
const ledger = new SupplierLedgerService(proxy as never, audit);
const payouts = new SupplierCashPayoutService(proxy as never, audit, access, approvals, ledger, shifts);
const operations = new SignedOperations(
  {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  {} as never, {} as never, {} as never, {} as never, payouts, {} as never,
);
const executor = new TerminalCommandExecutor(proxy as never, trust, authorization, operations, audit, access);
const counterWork = new CounterWorkService(proxy as never, access, { list: async () => [] } as never);
const EXECUTE = "POST /api/v1/purchasing/cash-payouts/:id/execute" satisfies SignedPhysicalOperation;

let fx: TenantFixture;
const branch = () => fx.mainBranchId;
const user = (userId: string): RequestUser => ({
  userId, tenantId: fx.tenantId, tokenVersion: 0, branchRoles: [], email: "payout@it.test",
  fullName: "Payout actor", authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
const today = () => daysFromToday(0).toISOString().slice(0, 10);

async function invoice(total: string, dueInDays = 10) {
  const row = await ledger.createInvoice(fx.tenantId, branch(), fx.managerId, {
    supplierId: fx.supplierId,
    invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
    invoiceDate: daysFromToday(dueInDays - 30).toISOString().slice(0, 10),
    dueDate: daysFromToday(dueInDays).toISOString().slice(0, 10),
    lines: [{ description: "Goods", qty: 1, unitCost: total }],
  });
  return row.id;
}

async function approvedPayout(
  amount: string,
  opts: { preparer?: string; approver?: string | null; supplierId?: string } = {},
) {
  const preparer = opts.preparer ?? fx.managerId;
  const supplierId = opts.supplierId ?? fx.supplierId;
  if (supplierId === fx.supplierId) {
    await invoice(amount);
  } else {
    await ledger.createInvoice(fx.tenantId, branch(), fx.managerId, {
      supplierId,
      invoiceNumber: `INV-${randomUUID().slice(0, 6)}`,
      invoiceDate: daysFromToday(-30).toISOString().slice(0, 10),
      dueDate: daysFromToday(10).toISOString().slice(0, 10),
      lines: [{ description: "Goods", qty: 1, unitCost: amount }],
    });
  }
  let row = await payouts.prepare(user(preparer), branch(), {
    supplierId,
    paidOn: today(),
    amount,
    reference: "CASH-OUT",
  });
  if (opts.approver === null) return row;
  if (row.status === "approved") return row;
  const approver = opts.approver ?? fx.ownerId;
  const review = row.approvalReview!;
  return payouts.approve(user(approver), branch(), row.id, { approvalId: randomUUID(), ...review });
}

async function counterFor(who: string, openShift = true, openingCashMinor = 0) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, branch(), `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx((c) => trust.beginEnrollment(c, owner, branch(), {
    registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex,
  }));
  const identity = await tx((c) => trust.finishEnrollment(c, owner, branch(),
    device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment, "enrollment")));
  const staff = user(who);
  const sessionPayload = await tx((c) => trust.beginSession(c, staff, branch(), identity));
  const session = await tx((c) => trust.finishSession(c, staff, branch(),
    device.sign(sessionPayload, identity.keyId), attendance.allow(sessionPayload, "session")));
  const shiftId = openShift ? await openTestShift(prisma, fx.tenantId, session.workSessionId) : null;
  if (shiftId && openingCashMinor > 0) {
    await prisma.tillShift.update({ where: { id: shiftId }, data: { openingCashMinor } });
  }
  return { device, identity, session, staff, shiftId };
}

type Counter = Awaited<ReturnType<typeof counterFor>>;

async function signed(counter: Counter, cashPayoutId: string, approvalEvidenceId: string | null) {
  const payload = await executor.prepare(counter.staff, branch(), {
    workSessionId: counter.session.workSessionId, operation: EXECUTE, body: { cashPayoutId },
    approvalEvidenceId, pharmacistEvidenceId: null, operatingHoursExceptionId: null,
  }) as OnlineTerminalCommand<unknown>;
  return {
    payload,
    request: {
      command: counter.device.sign(payload, counter.identity.keyId),
      attendanceProofId: attendance.allow(payload, "command"),
    },
  };
}

const run = (counter: Counter, request: unknown) => executor.execute(counter.staff, branch(), request);

const owedOn = async (invoiceId: string) =>
  (await prisma.supplierInvoice.findFirstOrThrow({ where: { id: invoiceId } })).paidAmount.toFixed(2);

beforeAll(async () => {
  fx = await createTenant(prisma, "supplier-cash-payout");
  await prisma.userBranchRole.createMany({ data: [
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.ownerId, role: "owner" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.managerId, role: "manager" },
    { tenantId: fx.tenantId, branchId: branch(), userId: fx.clerkId, role: "cashier" },
  ] });
});
afterAll(() => prisma.$disconnect());
afterEach(async () => {
  audit.failOn = null;
  await prisma.tenantSettings.update({
    where: { tenantId: fx.tenantId },
    data: { selfApprovalRoleKeys: ["owner", "manager"] },
  });
  const open = await prisma.supplierCashPayout.findMany({
    where: {
      tenantId: fx.tenantId,
      branchId: branch(),
      status: { in: ["prepared", "approved"] },
    },
  });
  for (const row of open) {
    await payouts.cancel(user(fx.managerId), branch(), row.id).catch(() => undefined);
  }
});

describe("supplier cash payout contract (#174)", () => {
  it("prepare and approve record nothing in the supplier ledger", async () => {
    const invoiceId = await invoice("250.00");
    const before = await owedOn(invoiceId);
    const prepared = await payouts.prepare(user(fx.managerId), branch(), {
      supplierId: fx.supplierId,
      paidOn: today(),
      amount: "250.00",
    });
    expect(prepared).toMatchObject({ status: "approved", readyAtCounter: true, amount: "250.00" });
    expect(await owedOn(invoiceId)).toBe(before);
    expect(await prisma.supplierPayment.count({ where: { tenantId: fx.tenantId } })).toBe(0);
  });

  it("refuses a second open payout for the same supplier at this branch", async () => {
    await approvedPayout("80.00");
    await expect(payouts.prepare(user(fx.managerId), branch(), {
      supplierId: fx.supplierId,
      paidOn: today(),
      amount: "10.00",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("needs a second approver when self-approval is withheld", async () => {
    await prisma.tenantSettings.update({
      where: { tenantId: fx.tenantId },
      data: { selfApprovalRoleKeys: ["owner"] },
    });
    const prepared = await payouts.prepare(user(fx.managerId), branch(), {
      supplierId: fx.supplierId,
      paidOn: today(),
      amount: "120.00",
    });
    expect(prepared).toMatchObject({ status: "prepared", readyAtCounter: false, executionApprovalId: null });
    const review = prepared.approvalReview!;
    await expect(payouts.approve(user(fx.managerId), branch(), prepared.id,
      { approvalId: randomUUID(), expectedVersion: review.expectedVersion, expectedDigest: "0".repeat(64) }))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
    const approved = await payouts.approve(user(fx.ownerId), branch(), prepared.id,
      { approvalId: randomUUID(), ...review });
    expect(approved).toMatchObject({ status: "approved", readyAtCounter: true });
  });

  it("signed execution pays the supplier, moves drawer cash once, and replays", async () => {
    const invoiceId = await invoice("300.00");
    const payout = await approvedPayout("300.00");
    const counter = await counterFor(fx.managerId, true, 30_000);
    const command = await signed(counter, payout.id, payout.executionApprovalId);
    const first = await run(counter, command.request);
    const replay = await run(counter, command.request);
    expect(first.result).toMatchObject({
      type: "supplier_cash_payout.executed",
      cashPayoutId: payout.id,
      approvalId: payout.executionApprovalId,
      amountMinor: 30000,
      effect: "applied",
    });
    expect({ ...replay, replayed: false }).toEqual(first);
    const payment = await prisma.supplierPayment.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: (first.result as { supplierPaymentId: string }).supplierPaymentId },
    });
    expect(payment).toMatchObject({ method: "cash", amount: new Prisma.Decimal("300"), voidedAt: null });
    expect((await owedOn(invoiceId))).toBe("300.00");
    const movement = await prisma.tillCashMovement.findFirst({
      where: { tenantId: fx.tenantId, referenceType: "supplier_payment", referenceId: payment.id },
    });
    expect(movement).toMatchObject({ direction: "out", amountMinor: 30000, shiftId: counter.shiftId });
    const again = await signed(counter, payout.id, payout.executionApprovalId);
    expect((await run(counter, again.request)).result).toMatchObject({ effect: "already_applied" });
  });

  it("refuses execution without an open shift on the till", async () => {
    const payout = await approvedPayout("50.00");
    const counter = await counterFor(fx.managerId, false, 5_000);
    const command = await signed(counter, payout.id, payout.executionApprovalId);
    await expect(run(counter, command.request)).rejects.toMatchObject({ response: { code: "SHIFT_REQUIRED" } });
    expect(await prisma.supplierPayment.count({ where: { tenantId: fx.tenantId, supplierId: fx.supplierId } })).toBe(0);
  });

  it("refuses a revoked approval and stale client approval ids", async () => {
    const payout = await approvedPayout("90.00");
    await tx((c) => approvals.revoke(c, user(fx.ownerId), branch(), payout.executionApprovalId!, "Wrong supplier"));
    const counter = await counterFor(fx.managerId, true, 10_000);
    const command = await signed(counter, payout.id, payout.executionApprovalId);
    await expect(run(counter, command.request)).rejects.toMatchObject({ response: { code: "APPROVAL_INVALID" } });
    await expect(payouts.execute(user(fx.managerId), branch(), payout.id,
      { approvalId: payout.executionApprovalId }, "idem-1"))
      .rejects.toMatchObject({ response: { code: "APPROVAL_STALE" } });
  });

  it("browser authorization for execute is TERMINAL_REQUIRED", async () => {
    const payout = await approvedPayout("40.00");
    const descriptor = operations.get(EXECUTE).descriptor;
    await expect(tx((c) => authorization.authorize(c, user(fx.managerId), branch(), descriptor, {
      body: { cashPayoutId: payout.id },
    }))).rejects.toMatchObject({ response: { code: "TERMINAL_REQUIRED" } });
  });

  it("detail, list and counter-work respect tenant and branch boundaries", async () => {
    const payout = await approvedPayout("60.00");
    await expect(payouts.getOne(fx.tenantId, fx.otherBranchId, payout.id)).rejects.toMatchObject({ status: 404 });
    await expect(payouts.getOne(randomUUID(), branch(), payout.id)).rejects.toMatchObject({ status: 404 });
    const ready = await payouts.list(fx.tenantId, branch(), { readyAtCounter: "true" });
    expect(ready.map((r) => r.id)).toContain(payout.id);
    expect((await payouts.list(fx.tenantId, fx.otherBranchId, { readyAtCounter: "true" })).map((r) => r.id))
      .not.toContain(payout.id);
    const roles = await prisma.userBranchRole.findMany({ where: { tenantId: fx.tenantId, userId: fx.ownerId } });
    const owner: RequestUser = {
      ...user(fx.ownerId),
      branchRoles: roles.map((r) => ({ branchId: r.branchId, role: r.role, roleId: r.roleId })),
    };
    const item = (await counterWork.list(owner, branch())).find((row) => row.id === payout.id)!;
    expect(item).toMatchObject({
      kind: "supplier_cash_payout",
      operation: EXECUTE,
      amount: "60.00",
      approval: { state: "matches" },
    });
    expect(item.task).toMatchObject({
      stage: "ready_for_execution",
      dailyWorkKind: "supplier_cash_payout.execute",
      destination: "supplier_payout",
      destinationStatus: "planned",
      signedExecution: { bodyIdKey: "cashPayoutId", approvalEvidenceId: payout.executionApprovalId },
    });
    expect(item.task.nextAction.executable).toBe(false);
    expect((await counterWork.list(owner, fx.otherBranchId)).map((row) => row.id)).not.toContain(payout.id);
  });

  it("refuses a payout when expected drawer cash is below the amount", async () => {
    const payout = await approvedPayout("50.00");
    const counter = await counterFor(fx.managerId, true, 2_000);
    const command = await signed(counter, payout.id, payout.executionApprovalId);
    await expect(run(counter, command.request)).rejects.toMatchObject({
      response: { code: "INSUFFICIENT_DRAWER_CASH", expectedCashMinor: 2_000, requiredMinor: 5_000 },
    });
    expect(await prisma.supplierPayment.count({ where: { tenantId: fx.tenantId, supplierId: fx.supplierId } })).toBe(0);
    expect(await prisma.tillCashMovement.count({ where: { tenantId: fx.tenantId, shiftId: counter.shiftId! } })).toBe(0);
  });

  it("allows a payout when expected drawer cash exactly equals the amount", async () => {
    const payout = await approvedPayout("50.00");
    const counter = await counterFor(fx.managerId, true, 5_000);
    const done = await run(counter, (await signed(counter, payout.id, payout.executionApprovalId)).request);
    expect(done.result).toMatchObject({ type: "supplier_cash_payout.executed", amountMinor: 5_000, effect: "applied" });
    const detail = await shifts.detail(user(fx.managerId), branch(), counter.session.workSessionId, counter.shiftId!);
    expect(detail.summary.expectedCashMinor).toBe(0);
  });

  it("serialises two payouts against the same drawer so the second cannot overdraw", async () => {
    const other = await prisma.supplier.create({
      data: { tenantId: fx.tenantId, code: `S2-${randomUUID().slice(0, 4)}`, name: "Second supplier" },
    });
    const first = await approvedPayout("60.00", { supplierId: fx.supplierId });
    const second = await approvedPayout("60.00", { supplierId: other.id });
    const counter = await counterFor(fx.managerId, true, 10_000);
    await run(counter, (await signed(counter, first.id, first.executionApprovalId)).request);
    await expect(
      run(counter, (await signed(counter, second.id, second.executionApprovalId)).request),
    ).rejects.toMatchObject({ response: { code: "INSUFFICIENT_DRAWER_CASH", expectedCashMinor: 4_000, requiredMinor: 6_000 } });
    expect(await prisma.supplierPayment.count({ where: { tenantId: fx.tenantId } })).toBe(1);
  });

  it("refuses counter prepare and execute without suppliers.pay", async () => {
    const payout = await approvedPayout("20.00");
    const counter = await counterFor(fx.clerkId, true, 5_000);
    await expect(
      executor.prepare(counter.staff, branch(), {
        workSessionId: counter.session.workSessionId,
        operation: EXECUTE,
        body: { cashPayoutId: payout.id },
        approvalEvidenceId: payout.executionApprovalId,
        pharmacistEvidenceId: null,
        operatingHoursExceptionId: null,
      }),
    ).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    const payer = await counterFor(fx.managerId, true, 5_000);
    await expect(
      run(payer, (await signed(payer, payout.id, payout.executionApprovalId)).request),
    ).resolves.toMatchObject({ result: expect.objectContaining({ effect: "applied" }) });
  });

  it("immutable payout rows reject in-place edits", async () => {
    const payout = await payouts.prepare(user(fx.managerId), branch(), {
      supplierId: fx.supplierId,
      paidOn: today(),
      amount: "25.00",
    });
    await expect(prisma.$executeRaw`UPDATE supplier_cash_payout SET amount = 999 WHERE id = ${payout.id}::uuid`)
      .rejects.toThrow(/immutable/);
  });
});
