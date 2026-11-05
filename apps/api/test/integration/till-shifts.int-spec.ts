import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { PaymentMethod, Prisma, RoleName } from "@prisma/client";
import type {
  LocalAttendanceAttestation,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import type { CommandProvenance } from "../../src/terminals/command-provenance";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import type { PinAlerts } from "../../src/terminals/pin-alerts.service";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

/**
 * P2b #103: online till shifts and cash, against the real trust service and attendance verifier.
 * Sessions are opened the way a counter opens them; only the PIN lockout's alert is stubbed.
 */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const alerts = { switchedOff: jest.fn(async () => undefined) };
const hours = new OperatingHoursEvidence();
const shifts = new TillShiftsService(prisma as never, trust, hours, access, audit, alerts as unknown as PinAlerts);
const stock = new StockService();
const sales = new SalesService(
  prisma as never,
  audit,
  new TaxService({ get: () => "0" } as never),
  {} as never,
  { assertCanSell: async () => undefined } as never,
  stock,
  trust,
  hours,
  undefined,
  shifts,
);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

const PIN = "4826";
let fx: TenantFixture;
let owner: RequestUser;
let clerk: RequestUser;
let manager: RequestUser;
let batchId: string;

const user = (userId: string): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion: 0,
  email: "shift@example.test",
  fullName: "Shift",
  authMethod: "bearer",
  branchRoles: [],
});
type Device = ReturnType<typeof terminalDevice>;

function attestation(
  challenge: TerminalEnrollmentCommand | TerminalSessionCommand,
  purpose: "enrollment" | "session",
  actor: RequestUser,
): LocalAttendanceAttestation {
  const counter =
    "registerId" in challenge
      ? { registerId: challenge.registerId, tillId: challenge.tillId }
      : { registerId: challenge.session.registerId, tillId: challenge.session.tillId };
  return {
    contractVersion: 1,
    kind: "local_attendance",
    proofId: randomUUID(),
    purpose,
    identity: challenge.identity,
    actorUserId: actor.userId,
    ...counter,
    payloadDigest: sha256(boundedCanonical(challenge)),
    windowsSession: { sessionId: 1, protocol: "console", remoteSession: false },
    appVersion: "0.0.1",
    observedAt: Date.now(),
  };
}
const record = (device: Device, a: LocalAttendanceAttestation, actor: RequestUser) =>
  proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));

/** A freshly enrolled counter (its own till). */
async function enroll() {
  const device = terminalDevice();
  const { id: registerId } = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, `Till ${randomUUID().slice(0, 4)}`));
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Front desk",
    }),
  );
  const proof = await record(device, attestation(challenge, "enrollment", owner), owner);
  const identity = await tx((c) =>
    trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  return { device, identity };
}

/** `who` signs in at the counter; returns their staff session (the sign-in). */
async function signIn(counter: { device: Device; identity: TerminalIdentity }, who: RequestUser) {
  const challenge = await tx((c) => trust.beginSession(c, who, fx.mainBranchId, counter.identity));
  const proof = await record(counter.device, attestation(challenge, "session", who), who);
  return tx((c) =>
    trust.finishSession(c, who, fx.mainBranchId, counter.device.sign(challenge, counter.identity.keyId), proof.proofId),
  );
}

/** Rs 5,000: two 2,000 notes and two 500s. */
const FIVE_THOUSAND = {
  totalMinor: 500_000,
  lines: [
    { denominationMinor: 200_000, count: 2 },
    { denominationMinor: 50_000, count: 2 },
  ],
};
const rupees = (n: number) => ({ totalMinor: n * 100, lines: n === 0 ? [] : [{ denominationMinor: 100, count: n }] });

const open = (who: RequestUser, sessionId: string, count = FIVE_THOUSAND, shiftId: string = randomUUID(), pin = PIN) =>
  shifts.open(who, fx.mainBranchId, sessionId, { shiftId, pin, openingCount: count });
const close = (
  who: RequestUser,
  sessionId: string,
  shiftId: string,
  count: { totalMinor: number; lines: Array<{ denominationMinor: number; count: number }> },
  extra: {
    commandId?: string;
    assistance?: { pin: string; reason: string };
    counterExpectedCashMinor?: number;
    varianceNote?: string;
  } = {},
) =>
  shifts.close(who, fx.mainBranchId, sessionId, shiftId, {
    commandId: extra.commandId ?? randomUUID(),
    closingCount: count,
    counterExpectedCashMinor: extra.counterExpectedCashMinor,
    varianceNote: extra.varianceNote,
    assistance: extra.assistance,
  });

const sell = (who: RequestUser, sessionId: string, payments?: Array<{ method: PaymentMethod; amount: string }>) =>
  sales.checkout(
    fx.tenantId,
    fx.mainBranchId,
    who.userId,
    [],
    { items: [{ productId: fx.productId, batchId, qty: 1, unitPrice: "15.00" }], payments } as never,
    randomUUID(),
    { user: who, workSessionId: sessionId },
  );

/** A refund executed at a counter, as the signed refund command does it. */
const refundAtCounter = (who: RequestUser, tillId: string, saleId: string, refundMethod: PaymentMethod | null) =>
  tx(async (c) => {
    const sale = await sales.lockSaleForRefund(c, fx.tenantId, fx.mainBranchId, saleId);
    const plan = await sales.planRefund(c, fx.tenantId, fx.mainBranchId, sale, [{ productId: fx.productId, batchId, qty: 1 }]);
    return sales.applyRefund(c, {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      executorUserId: who.userId,
      requestedBy: who.userId,
      approvedBy: null,
      sale,
      plan,
      reason: "Changed mind",
      reasonCode: "changed_mind",
      refundMethod,
      refundRequest: { id: randomUUID(), approvalId: null, command: { tillId } as CommandProvenance },
    });
  });

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { response?: { code?: string } }) => e.response?.code ?? String(e),
  );
const shiftRow = (id: string) => prisma.tillShift.findFirstOrThrow({ where: { tenantId: fx.tenantId, id } });

beforeAll(async () => {
  fx = await createTenant(prisma, "till-shifts");
  owner = user(fx.ownerId);
  clerk = user(fx.clerkId);
  manager = user(fx.managerId);
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
    ],
  });
  const posPinHash = await bcrypt.hash(PIN, 4);
  // tenant-scope: test fixture — every person here has a personal PIN.
  await prisma.appUser.updateMany({
    where: { id: { in: [fx.ownerId, fx.managerId, fx.clerkId] } },
    data: { posPinHash, posPinVersion: 1 },
  });
  batchId = await createStockedBatch(prisma, stock, fx, { qty: 500 });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("one open shift per till", () => {
  it("opens with the person's own PIN and a count, and replays a resend of the same open", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const shiftId = randomUUID();
    const opened = await open(clerk, session.workSessionId, FIVE_THOUSAND, shiftId);
    expect(opened.shift).toMatchObject({
      workSessionId: shiftId,
      shiftNumber: expect.stringMatching(/^S-\d{4,}$/),
      staffUserId: clerk.userId,
      tillId: session.tillId,
      status: "open",
      openingCashMinor: 500_000,
      openingCount: FIVE_THOUSAND.lines,
      previousClosedWorkSessionId: null,
    });
    expect(opened.summary.expectedCashMinor).toBe(500_000);
    // A lost response, sent again: the same shift, not a second one.
    const again = await open(clerk, session.workSessionId, FIVE_THOUSAND, shiftId);
    expect(again.shift.workSessionId).toBe(shiftId);
    expect(await prisma.tillShift.count({ where: { tenantId: fx.tenantId, tillId: session.tillId } })).toBe(1);
    // The same ID with a different count is a different open, refused.
    await expect(code(open(clerk, session.workSessionId, rupees(10), shiftId))).resolves.toBe("SHIFT_ID_USED");
    await expect(code(open(clerk, session.workSessionId))).resolves.toBe("SHIFT_ALREADY_OPEN");

    // Someone else signing in at this till can't open a second shift on it.
    const ownerSession = await signIn(counter, owner);
    await expect(code(open(owner, ownerSession.workSessionId))).resolves.toBe("SHIFT_HELD_BY_OTHER");
    expect(await prisma.tillShift.count({ where: { tenantId: fx.tenantId, tillId: session.tillId, closedAt: null } })).toBe(1);
  });

  it("refuses a wrong PIN, counts it, and opens nothing", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    await expect(code(open(clerk, session.workSessionId, FIVE_THOUSAND, randomUUID(), "0000"))).resolves.toBe("PIN_INCORRECT");
    expect(await prisma.tillShift.count({ where: { tenantId: fx.tenantId, tillId: session.tillId } })).toBe(0);
    // tenant-scope: test fixture
    const account = await prisma.appUser.findUniqueOrThrow({ where: { id: clerk.userId }, select: { failedPosPinAttempts: true } });
    expect(account.failedPosPinAttempts).toBeGreaterThan(0);
    await prisma.appUser.update({ where: { id: clerk.userId }, data: { failedPosPinAttempts: 0 } });
  });

  it("refuses a count whose total doesn't match its notes and coins", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    await expect(
      code(open(clerk, session.workSessionId, { totalMinor: 500_100, lines: FIVE_THOUSAND.lines })),
    ).resolves.toBe("CASH_COUNT_INVALID");
  });

  it("concurrent opens on one till: exactly one shift opens", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => code(open(clerk, session.workSessionId))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r !== "ok")).toEqual(["SHIFT_ALREADY_OPEN", "SHIFT_ALREADY_OPEN", "SHIFT_ALREADY_OPEN"]);
    expect(await prisma.tillShift.count({ where: { tenantId: fx.tenantId, tillId: session.tillId } })).toBe(1);
  });

  it("the database itself refuses a second open shift on a till", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const first = await open(clerk, session.workSessionId);
    const row = await shiftRow(first.shift.workSessionId);
    await expect(
      prisma.tillShift.create({
        data: { ...row, id: randomUUID(), shiftNumber: `S-X${randomUUID().slice(0, 6)}`, openingCount: row.openingCount as Prisma.InputJsonValue, closingCount: Prisma.DbNull },
      }),
    ).rejects.toThrow();
  });

  it("opening follows checkout's hours rules; closing doesn't", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const opened = await open(clerk, session.workSessionId);
    const before = await prisma.branch.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: fx.mainBranchId },
      select: { operatingHours: true, operatingHoursOrigin: true },
    });
    await prisma.branch.updateMany({
      where: { tenantId: fx.tenantId, id: fx.mainBranchId },
      data: {
        operatingHours: {
          schemaVersion: 1,
          weekly: Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { mode: "open_24h" }])),
          exceptions: [],
          mandatory: [],
        },
        operatingHoursOrigin: "editor",
      },
    });
    try {
      await close(clerk, session.workSessionId, opened.shift.workSessionId, FIVE_THOUSAND);
      await expect(code(open(clerk, session.workSessionId))).resolves.toBe("OUTSIDE_OPERATING_HOURS");
    } finally {
      await prisma.branch.updateMany({
        where: { tenantId: fx.tenantId, id: fx.mainBranchId },
        data: { operatingHours: before.operatingHours ?? Prisma.DbNull, operatingHoursOrigin: before.operatingHoursOrigin },
      });
    }
  });
});

describe("selling needs an open shift on this till", () => {
  it("refuses a counter sale with no shift, or on someone else's, and sells nothing", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const soldHere = () => prisma.sale.count({ where: { tenantId: fx.tenantId, tillId: session.tillId } });
    await expect(code(sell(clerk, session.workSessionId))).resolves.toBe("SHIFT_REQUIRED");
    expect(await soldHere()).toBe(0);

    await open(clerk, session.workSessionId);
    const ownerSession = await signIn(counter, owner);
    await expect(code(sell(owner, ownerSession.workSessionId))).resolves.toBe("SHIFT_HELD_BY_OTHER");
    expect(await soldHere()).toBe(0);
  });

  it("puts each sale and its payments on the seller's shift; web sales stay off shifts", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const opened = await open(clerk, session.workSessionId);
    const sale = await sell(clerk, session.workSessionId);
    const row = await prisma.sale.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: sale!.id }, include: { payments: true } });
    expect(row.shiftId).toBe(opened.shift.workSessionId);
    expect(row.payments.every((p) => p.shiftId === opened.shift.workSessionId)).toBe(true);

    const web = await sales.checkout(fx.tenantId, fx.mainBranchId, clerk.userId, [],
      { items: [{ productId: fx.productId, batchId, qty: 1, unitPrice: "15.00" }] } as never, randomUUID());
    expect((await prisma.sale.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: web!.id } })).shiftId).toBeNull();
  });

  it("a sale racing a close either lands on the shift and in its expected cash, or is refused", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const opened = await open(clerk, session.workSessionId);
    const shiftId = opened.shift.workSessionId;
    const [sold, closed] = await Promise.allSettled([
      sell(clerk, session.workSessionId),
      close(clerk, session.workSessionId, shiftId, FIVE_THOUSAND),
    ]);
    expect(closed.status).toBe("fulfilled");
    const row = await shiftRow(shiftId);
    const onShift = await prisma.sale.count({ where: { tenantId: fx.tenantId, shiftId } });
    if (sold.status === "fulfilled") {
      expect(onShift).toBe(1);
      expect(row.expectedCashMinor).toBe(500_000 + 1_500);
    } else {
      expect((sold.reason as { response?: { code?: string } }).response?.code).toBe("SHIFT_REQUIRED");
      expect(onShift).toBe(0);
      expect(row.expectedCashMinor).toBe(500_000);
    }
  });
});

describe("expected cash", () => {
  it("is the opening count + cash taken − change − cash refunds − cash paid out", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const opened = await open(clerk, session.workSessionId);
    const shiftId = opened.shift.workSessionId;

    // Cash: Rs 20 tendered for Rs 15, Rs 5 change.
    const cashSale = await sell(clerk, session.workSessionId, [{ method: PaymentMethod.cash, amount: "20.00" }]);
    // Card: no cash in the drawer.
    await sell(clerk, session.workSessionId, [{ method: PaymentMethod.card, amount: "15.00" }]);
    // Split: Rs 10 card, Rs 10 cash for Rs 15, Rs 5 change.
    await sell(clerk, session.workSessionId, [
      { method: PaymentMethod.card, amount: "10.00" },
      { method: PaymentMethod.cash, amount: "10.00" },
    ]);
    // A cash refund of Rs 15 out of the drawer, and a card refund that isn't.
    await refundAtCounter(clerk, session.tillId, cashSale!.id, PaymentMethod.cash);
    const cardSale = await sell(clerk, session.workSessionId, [{ method: PaymentMethod.card, amount: "15.00" }]);
    await refundAtCounter(clerk, session.tillId, cardSale!.id, PaymentMethod.card);
    // A supplier cash payout of Rs 7 (P6's writer).
    await tx((c) =>
      shifts.recordCashMovement(c, {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        tillId: session.tillId,
        userId: clerk.userId,
        direction: "out",
        amountMinor: 700,
        reason: "Supplier cash payout",
        referenceType: "supplier_payment",
        referenceId: randomUUID(),
      }),
    );

    const live = await shifts.detail(clerk, fx.mainBranchId, session.workSessionId, shiftId);
    expect(live.summary).toMatchObject({
      openingCashMinor: 500_000,
      cashTakenMinor: 3_000,
      changeGivenMinor: 1_000,
      cashRefundsMinor: 1_500,
      cashPaidOutMinor: 700,
      cashPaidInMinor: 0,
      expectedCashMinor: 500_000 + 3_000 - 1_000 - 1_500 - 700,
      saleCount: 4,
    });
    expect(live.summary.takingsByMethod).toEqual([
      { method: "cash", saleCount: 2, takenMinor: 2_000, refundedMinor: 1_500 },
      { method: "card", saleCount: 3, takenMinor: 4_000, refundedMinor: 1_500 },
    ]);
    expect(live.summary.refunds).toMatchObject([
      { amountMinor: 1_500, paidBack: [{ method: "cash", amountMinor: 1_500 }], processedBy: { id: clerk.userId },
        items: [{ qty: 1, disposition: "restock" }] },
      { amountMinor: 1_500, paidBack: [{ method: "card", amountMinor: 1_500 }] },
    ]);
    expect(live.summary.firstSaleAt).not.toBeNull();
    expect(live.summary.cashMovements).toMatchObject([{ direction: "out", amountMinor: 700, reason: "Supplier cash payout" }]);
    expect(live.summary.takingsByHour.reduce((n, h) => n + h.saleCount, 0)).toBe(4);

    // Rs 3 short at the close: the variance is the count less the server's figure.
    const counted = 500_000 + 3_000 - 1_000 - 1_500 - 700 - 300;
    const closed = await close(clerk, session.workSessionId, shiftId, {
      totalMinor: counted,
      lines: [
        { denominationMinor: 200_000, count: 2 },
        { denominationMinor: 50_000, count: 1 },
        { denominationMinor: 10_000, count: 4 },
        { denominationMinor: 5_000, count: 1 },
        { denominationMinor: 2_000, count: 2 },
        { denominationMinor: 100, count: 5 },
      ],
    }, { counterExpectedCashMinor: 499_800, varianceNote: "Too much change around 12:10" });
    expect(closed.shift).toMatchObject({
      status: "closed",
      expectedCashMinor: 499_800,
      counterExpectedCashMinor: 499_800,
      closingCashCountMinor: counted,
      varianceMinor: -300,
      closeKind: "self",
      closedBy: { id: clerk.userId },
      varianceNote: "Too much change around 12:10",
    });

    // Nothing more lands on a closed shift: a sale or cash refund now needs a new shift.
    await expect(code(sell(clerk, session.workSessionId))).resolves.toBe("SHIFT_REQUIRED");
  });

  it("refuses a cash refund at a counter with no open shift, and refunds nothing", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const opened = await open(clerk, session.workSessionId);
    const sale = await sell(clerk, session.workSessionId);
    await close(clerk, session.workSessionId, opened.shift.workSessionId, rupees(5_015));
    await expect(code(refundAtCounter(clerk, session.tillId, sale!.id, PaymentMethod.cash))).resolves.toBe("SHIFT_REQUIRED");
    expect(await prisma.goodsReturn.count({ where: { tenantId: fx.tenantId, saleId: sale!.id } })).toBe(0);
  });
});

describe("handover and the end of the day", () => {
  it("keeps the outgoing variance whatever the incoming person counts", async () => {
    const counter = await enroll();
    const clerkSession = await signIn(counter, clerk);
    const first = await open(clerk, clerkSession.workSessionId);
    const firstId = first.shift.workSessionId;
    await sell(clerk, clerkSession.workSessionId);
    // Expected Rs 5,015; counted Rs 5,010 → Rs 5 short.
    const commandId = randomUUID();
    await close(clerk, clerkSession.workSessionId, firstId, rupees(5_010), { commandId });
    // A resend of the same close replays it; a second, different close is refused.
    const replay = await close(clerk, clerkSession.workSessionId, firstId, rupees(5_010), { commandId });
    expect(replay.shift.varianceMinor).toBe(-500);
    await expect(code(close(clerk, clerkSession.workSessionId, firstId, rupees(5_015)))).resolves.toBe("SHIFT_ALREADY_CLOSED");

    // The incoming person opens their own shift with their own count and PIN.
    const ownerSession = await signIn(counter, owner);
    const next = await shifts.open(owner, fx.mainBranchId, ownerSession.workSessionId, {
      shiftId: randomUUID(),
      pin: PIN,
      openingCount: rupees(5_015),
      previousClosedWorkSessionId: firstId,
    });
    expect(next.shift).toMatchObject({ staffUserId: owner.userId, openingCashMinor: 501_500, previousClosedWorkSessionId: firstId });
    expect(await shiftRow(firstId)).toMatchObject({ varianceMinor: -500, expectedCashMinor: 501_500, closingCashCountMinor: 501_000 });

    // A closed shift never changes, even directly in the database.
    await expect(
      prisma.$executeRaw`UPDATE till_shift SET variance_minor = 0, closing_cash_count_minor = expected_cash_minor WHERE id = ${firstId}::uuid`,
    ).rejects.toThrow(/immutable/);
    await expect(prisma.$executeRaw`DELETE FROM till_shift WHERE id = ${firstId}::uuid`).rejects.toThrow(/retained/);

    // End of day: the last shift closes without another opening.
    await close(owner, ownerSession.workSessionId, next.shift.workSessionId, rupees(5_015));
    const current = await shifts.current(owner, fx.mainBranchId, ownerSession.workSessionId);
    expect(current.current).toBeNull();
    expect(current.lastClosed?.workSessionId).toBe(next.shift.workSessionId);
    const listed = await shifts.list(owner, fx.mainBranchId, ownerSession.workSessionId);
    expect(listed.map((s) => s.workSessionId)).toEqual([next.shift.workSessionId, firstId]);
  });

  it("refuses an open that names a closed shift the till has moved on from", async () => {
    const counter = await enroll();
    const session = await signIn(counter, clerk);
    const first = await open(clerk, session.workSessionId);
    await close(clerk, session.workSessionId, first.shift.workSessionId, FIVE_THOUSAND);
    await expect(
      code(shifts.open(clerk, fx.mainBranchId, session.workSessionId, {
        shiftId: randomUUID(), pin: PIN, openingCount: FIVE_THOUSAND, previousClosedWorkSessionId: null,
      })),
    ).resolves.toBe("SHIFT_STATE_CHANGED");
  });
});

describe("a manager closing an absent cashier's shift", () => {
  it("needs the manager's own PIN, a reason and the count, and records both people", async () => {
    const counter = await enroll();
    const clerkSession = await signIn(counter, clerk);
    const opened = await open(clerk, clerkSession.workSessionId);
    const shiftId = opened.shift.workSessionId;
    await sell(clerk, clerkSession.workSessionId, [{ method: PaymentMethod.cash, amount: "15.00" }]);

    const managerSession = await signIn(counter, manager);
    // Without the assisted close's PIN and reason, someone else's shift doesn't close.
    await expect(code(close(manager, managerSession.workSessionId, shiftId, rupees(5_015)))).resolves.toBe(
      "SHIFT_ASSISTANCE_REQUIRED",
    );
    // A wrong PIN is counted and closes nothing.
    await expect(
      code(close(manager, managerSession.workSessionId, shiftId, rupees(5_015), { assistance: { pin: "0000", reason: "Went home ill" } })),
    ).resolves.toBe("PIN_INCORRECT");
    expect((await shiftRow(shiftId)).closedAt).toBeNull();
    await prisma.appUser.update({ where: { id: manager.userId }, data: { failedPosPinAttempts: 0 } });

    const closed = await close(manager, managerSession.workSessionId, shiftId, rupees(5_015), {
      assistance: { pin: PIN, reason: "Went home ill" },
    });
    expect(closed.shift).toMatchObject({
      staffUserId: clerk.userId,
      staff: { id: clerk.userId },
      closedBy: { id: manager.userId },
      closeKind: "assisted",
      assistanceReason: "Went home ill",
      varianceMinor: 0,
    });
    const audits = await prisma.auditEvent.findMany({
      where: { tenantId: fx.tenantId, eventName: "till_shift.closed", entityId: shiftId },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toMatchObject({ staffUserId: clerk.userId, closedByUserId: manager.userId, closeKind: "assisted" });
  });

  it("is refused to someone without shifts.close_others", async () => {
    const counter = await enroll();
    const ownerSession = await signIn(counter, owner);
    const opened = await open(owner, ownerSession.workSessionId);
    const clerkSession = await signIn(counter, clerk);
    await expect(
      code(close(clerk, clerkSession.workSessionId, opened.shift.workSessionId, FIVE_THOUSAND, {
        assistance: { pin: PIN, reason: "Owner left" },
      })),
    ).resolves.toBe("PERMISSION_DENIED");
    expect((await shiftRow(opened.shift.workSessionId)).closedAt).toBeNull();
  });
});
