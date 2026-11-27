import { randomUUID } from "node:crypto";
import { GoodsReturnStatus, GoodsReturnType, Prisma, SaleRefundRequestStatus } from "@prisma/client";
import { CardAttemptsReportService } from "../../src/reports/card-attempts-report.service";
import { RefundAuthorizationsReportService } from "../../src/reports/refund-authorizations-report.service";
import { SalesReportScopeService } from "../../src/reports/sales-report-scope.service";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/**
 * W10 #72: the external card attempts and refund authorizations reports read the stored
 * counter evidence and refunds, scoped to the tenant and branch.
 */
const prisma = createPrisma();
const scope = new SalesReportScopeService(prisma as never);
const cards = new CardAttemptsReportService(prisma as never, scope);
const refunds = new RefundAuthorizationsReportService(prisma as never, scope);

let fx: TenantFixture;
let other: TenantFixture;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

type Counter = { id: string; tillId: string; terminalId: string; enrollmentId: string; keyId: string; sessionId: string };

async function counter(tenantId: string, branchId: string, label: string, staffUserId: string, enrolledBy: string): Promise<Counter> {
  const row = await prisma.terminalCounter.create({ data: { tenantId, branchId, label } });
  const terminal = await prisma.operationalTerminal.create({
    data: { tenantId, branchId, label: `${label} PC`, registerId: row.id, tillId: row.tillId },
  });
  const keyId = `key-${randomUUID()}`;
  const enrollment = await prisma.terminalEnrollment.create({
    data: { tenantId, branchId, terminalId: terminal.id, keyId, publicKeyHex: "a".repeat(64), enrolledByUserId: enrolledBy },
  });
  const session = await prisma.terminalStaffSession.create({
    data: {
      tenantId,
      branchId,
      terminalId: terminal.id,
      enrollmentId: enrollment.id,
      keyId,
      registerId: row.id,
      tillId: row.tillId,
      staffUserId,
      tokenVersion: 0,
    },
  });
  return { id: row.id, tillId: row.tillId, terminalId: terminal.id, enrollmentId: enrollment.id, keyId, sessionId: session.id };
}

type CardEvent = {
  state: string;
  at: Date;
  amountMinor?: number;
  status?: string;
  heldReason?: string;
  saleCommandId?: string;
  payload?: Record<string, unknown>;
};

async function attempt(tenantId: string, branchId: string, c: Counter, events: CardEvent[]): Promise<string> {
  const attemptId = randomUUID();
  for (const e of events) {
    await prisma.offlineSupportRecord.create({
      data: {
        tenantId,
        branchId,
        terminalId: c.terminalId,
        enrollmentId: c.enrollmentId,
        keyId: c.keyId,
        kind: "external_card_attempt",
        recordId: randomUUID(),
        recordHash: "b".repeat(64),
        envelope: { payload: { state: e.state, ...(e.payload ?? {}) } },
        staffSignInId: randomUUID(),
        workSessionId: c.sessionId,
        recordedAt: e.at,
        attemptId,
        checkoutDraftId: randomUUID(),
        reviewedSaleDigest: "c".repeat(64),
        amountMinor: BigInt(e.amountMinor ?? 250_000),
        cardState: e.state,
        // The table's shape check: which evidence each state carries.
        providerReference: e.state === "prepared" || e.state === "uncertain" ? null : "RRN-1",
        approvalCode: e.state === "approved" ? "A1" : null,
        approvedAt: e.state === "approved" ? e.at : null,
        verifiedByUserId: e.state === "declined" || e.state === "not_used" ? fx.managerId : null,
        saleCommandId: e.saleCommandId ?? null,
        status: e.status ?? "accepted",
        verifiedAt: (e.status ?? "accepted") === "held" ? null : e.at,
        heldReason: e.heldReason ?? null,
        receivedByUserId: fx.ownerId,
      },
    });
  }
  return attemptId;
}

let linkedAttempt: string;
let owedAttempt: string;
let oldAttempt: string;
let otherBranchAttempt: string;
let mainCounter: Counter;

let saleId: string;
let requestReturnNo: string;
let directReturnNo: string;
let selfReturnNo: string;
let otherBranchReturnNo: string;

async function sale(tenantId: string, branchId: string, soldBy: string, over: Partial<Prisma.SaleUncheckedCreateInput> = {}) {
  const row = await prisma.sale.create({
    data: {
      tenantId,
      branchId,
      invoiceNo: `INV-${randomUUID().slice(0, 8)}`,
      subtotal: new Prisma.Decimal("2500.00"),
      grandTotal: new Prisma.Decimal("2500.00"),
      soldBy,
      ...over,
    },
  });
  return row;
}

async function customerReturn(
  tenantId: string,
  branchId: string,
  saleRowId: string,
  people: { requestedBy: string; approvedBy: string | null; processedBy: string },
  amount: string,
  over: Partial<Prisma.GoodsReturnUncheckedCreateInput> = {},
) {
  const returnNumber = `RET-${randomUUID().slice(0, 8)}`;
  const row = await prisma.goodsReturn.create({
    data: {
      tenantId,
      branchId,
      returnNumber,
      type: GoodsReturnType.customer,
      status: GoodsReturnStatus.completed,
      saleId: saleRowId,
      amount: new Prisma.Decimal(amount),
      ...people,
      ...over,
    },
  });
  return { id: row.id, returnNumber };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "money-reports");
  other = await createTenant(prisma, "money-reports-other");
  mainCounter = await counter(fx.tenantId, fx.mainBranchId, "Counter 1", fx.clerkId, fx.ownerId);
  const galle = await counter(fx.tenantId, fx.otherBranchId, "Galle 1", fx.clerkId, fx.ownerId);
  const foreign = await counter(other.tenantId, other.mainBranchId, "Foreign 1", other.clerkId, other.ownerId);

  // Card attempts. A linked attempt whose sale has synced; one approved then given up with the
  // refund still owed (held for a manager); one wholly before the window; one at another branch;
  // and one in another tenant.
  const commandId = randomUUID();
  const linkedSale = await sale(fx.tenantId, fx.mainBranchId, fx.clerkId, { offlineCommandId: commandId });
  linkedAttempt = await attempt(fx.tenantId, fx.mainBranchId, mainCounter, [
    { state: "prepared", at: hoursAgo(5) },
    { state: "approved", at: hoursAgo(4.9) },
    { state: "linked_to_sale", at: hoursAgo(4.8), saleCommandId: commandId },
  ]);
  owedAttempt = await attempt(fx.tenantId, fx.mainBranchId, mainCounter, [
    { state: "approved", at: hoursAgo(3), amountMinor: 80_000 },
    {
      state: "not_used",
      at: hoursAgo(2.5),
      amountMinor: 80_000,
      status: "held",
      heldReason: "card_not_used",
      payload: { settlement: "refund_owed", reversalReference: null, reason: "Machine offline, could not void" },
    },
  ]);
  oldAttempt = await attempt(fx.tenantId, fx.mainBranchId, mainCounter, [{ state: "declined", at: hoursAgo(24 * 60) }]);
  otherBranchAttempt = await attempt(fx.tenantId, fx.otherBranchId, galle, [{ state: "uncertain", at: hoursAgo(1) }]);
  await attempt(other.tenantId, other.mainBranchId, foreign, [{ state: "approved", at: hoursAgo(1) }]);
  expect(linkedSale.invoiceNo).toBeTruthy();

  // Refunds. A request approved by the manager and executed by the clerk at a counter shift; a
  // direct refund the manager PIN co-signed; a direct one the clerk did alone; one at the other
  // branch; and an open and a cancelled request.
  const s = await sale(fx.tenantId, fx.mainBranchId, fx.clerkId);
  saleId = s.id;
  const shiftId = randomUUID();
  await prisma.tillShift.create({
    data: {
      id: shiftId,
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      shiftNumber: "S-RF01",
      registerId: mainCounter.id,
      tillId: mainCounter.tillId,
      terminalId: mainCounter.terminalId,
      enrollmentId: mainCounter.enrollmentId,
      staffUserId: fx.clerkId,
      openedStaffSessionId: mainCounter.sessionId,
      openingCashMinor: 0,
      openingCount: [],
    },
  });
  const viaRequest = await customerReturn(
    fx.tenantId,
    fx.mainBranchId,
    saleId,
    { requestedBy: fx.clerkId, approvedBy: fx.managerId, processedBy: fx.clerkId },
    "1500.00",
    { shiftId },
  );
  requestReturnNo = viaRequest.returnNumber;
  const requestBase = {
    tenantId: fx.tenantId,
    branchId: fx.mainBranchId,
    saleId,
    lines: [{ productId: fx.productId, batchId: randomUUID(), qty: 1, unitPrice: "100.00", disposition: "restock" }],
    reason: "Damaged pack",
    requestedBy: fx.clerkId,
  };
  await prisma.saleRefundRequest.create({
    data: {
      ...requestBase,
      requestNumber: `RR-${randomUUID().slice(0, 8)}`,
      status: SaleRefundRequestStatus.executed,
      amount: new Prisma.Decimal("1500.00"),
      approvalRequired: true,
      approvedBy: fx.managerId,
      approvedAt: hoursAgo(3),
      executedBy: fx.clerkId,
      executedAt: hoursAgo(2),
      goodsReturnId: viaRequest.id,
    },
  });
  directReturnNo = (
    await customerReturn(fx.tenantId, fx.mainBranchId, saleId, { requestedBy: fx.clerkId, approvedBy: fx.managerId, processedBy: fx.clerkId }, "600.00")
  ).returnNumber;
  selfReturnNo = (
    await customerReturn(fx.tenantId, fx.mainBranchId, saleId, { requestedBy: fx.clerkId, approvedBy: fx.clerkId, processedBy: fx.clerkId }, "40.00")
  ).returnNumber;
  const galleSale = await sale(fx.tenantId, fx.otherBranchId, fx.clerkId);
  otherBranchReturnNo = (
    await customerReturn(fx.tenantId, fx.otherBranchId, galleSale.id, { requestedBy: fx.clerkId, approvedBy: fx.clerkId, processedBy: fx.clerkId }, "10.00")
  ).returnNumber;
  // A supplier return is not a refund.
  await prisma.goodsReturn.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      returnNumber: `SR-${randomUUID().slice(0, 8)}`,
      type: GoodsReturnType.supplier,
      status: GoodsReturnStatus.completed,
      supplierId: fx.supplierId,
      amount: new Prisma.Decimal("999.00"),
      requestedBy: fx.managerId,
    },
  });
  await prisma.saleRefundRequest.create({
    data: { ...requestBase, requestNumber: `RR-${randomUUID().slice(0, 8)}`, amount: new Prisma.Decimal("300.00"), approvalRequired: true },
  });
  await prisma.saleRefundRequest.create({
    data: {
      ...requestBase,
      requestNumber: `RR-${randomUUID().slice(0, 8)}`,
      status: SaleRefundRequestStatus.cancelled,
      amount: new Prisma.Decimal("200.00"),
      approvalRequired: false,
      cancelledBy: fx.clerkId,
      cancelledAt: hoursAgo(1),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("external card attempts report", () => {
  it("folds each attempt at the branch to how it ended, with its sale, counter and seller", async () => {
    const report = await cards.report(fx.tenantId, fx.mainBranchId, 30);
    expect(report.attempts.map((a) => a.attemptId).sort()).toEqual([linkedAttempt, owedAttempt].sort());
    const linked = report.attempts.find((a) => a.attemptId === linkedAttempt)!;
    expect(linked).toMatchObject({ outcome: "charged_sale", events: 3, counterLabel: "Counter 1", amountMinor: 250_000 });
    expect(linked.sale?.invoiceNo).toMatch(/^INV-/);
    expect(linked.staff?.id).toBe(fx.clerkId);
    const owed = report.attempts.find((a) => a.attemptId === owedAttempt)!;
    expect(owed).toMatchObject({
      outcome: "refund_owed",
      settlement: "refund_owed",
      reason: "Machine offline, could not void",
      review: "held",
      heldReason: "card_not_used",
    });
    expect(report.kpis).toMatchObject({ attempts: 2, heldForReview: 1, chargedWithoutSaleMinor: 80_000 });
  });

  it("spans the tenant's branches for an owner and never another tenant's", async () => {
    const report = await cards.report(fx.tenantId, null, 30);
    expect(report.attempts.map((a) => a.attemptId).sort()).toEqual([linkedAttempt, owedAttempt, otherBranchAttempt].sort());
    expect(report.attempts.find((a) => a.attemptId === otherBranchAttempt)!.outcome).toBe("unresolved");
    expect(report.attempts.some((a) => a.attemptId === oldAttempt)).toBe(false);
  });
});

describe("refund authorizations report", () => {
  it("shows who requested, approved and paid out each refund at the branch", async () => {
    const report = await refunds.report(fx.tenantId, fx.mainBranchId, 30);
    const byNo = new Map(report.refunds.map((r) => [r.returnNumber, r]));
    expect([...byNo.keys()].sort()).toEqual([requestReturnNo, directReturnNo, selfReturnNo].sort());
    expect(byNo.get(requestReturnNo)).toMatchObject({
      path: "request",
      approval: "approved_request",
      where: "counter",
      counterLabel: "Counter 1",
      shiftNumber: "S-RF01",
      separated: true,
      amountMinor: 150_000,
    });
    expect(byNo.get(requestReturnNo)!.approvedBy?.id).toBe(fx.managerId);
    expect(byNo.get(requestReturnNo)!.executedBy?.id).toBe(fx.clerkId);
    expect(byNo.get(directReturnNo)).toMatchObject({ path: "direct", approval: "other_approver", where: "web", separated: true });
    expect(byNo.get(selfReturnNo)).toMatchObject({ approval: "no_separate_approver", approvedBy: null, separated: false });
    expect(report.kpis).toMatchObject({
      refunds: 3,
      amountMinor: 214_000,
      separated: { count: 2, amountMinor: 210_000 },
      openRequests: { count: 1, amountMinor: 30_000 },
      cancelledRequests: { count: 1, amountMinor: 20_000 },
    });
  });

  it("includes the other branch only for the tenant scope, and leaves supplier returns out", async () => {
    const report = await refunds.report(fx.tenantId, null, 30);
    expect(report.refunds.map((r) => r.returnNumber)).toContain(otherBranchReturnNo);
    expect(report.refunds.every((r) => r.sale !== null)).toBe(true);
    expect(report.kpis.refunds).toBe(4);
    const foreign = await refunds.report(other.tenantId, null, 30);
    expect(foreign.refunds).toHaveLength(0);
  });
});
