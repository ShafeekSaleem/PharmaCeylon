import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { PaymentMethod, Prisma, RoleName } from "@prisma/client";
import type { LocalAttendanceAttestation, TerminalEnrollmentCommand, TerminalIdentity, TerminalSessionCommand } from "@pharmaceylon/shared";
import { addDays, businessDateKey, businessToday, startOfBusinessDay } from "../../src/common/business-date.util";
import { CategoryTaxonomyService } from "../../src/catalog/category-taxonomy.service";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { ReportsService } from "../../src/reports/reports.service";
import { SalesReportScopeService } from "../../src/reports/sales-report-scope.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import type { PinAlerts } from "../../src/terminals/pin-alerts.service";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

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
  undefined,
  shifts,
);
const taxonomy = new CategoryTaxonomyService(prisma as never);
const scope = new SalesReportScopeService(prisma as never);
const reports = new ReportsService(prisma as never, taxonomy, scope);

const TZ = "Asia/Colombo";
const PIN = "4826";
let fx: TenantFixture;
let other: TenantFixture;
let batchId: string;
let mainTerminalId: string;
let mainTillId: string;
let mainWorkSessionId: string;
let mainShiftId: string;
let mainSaleId: string;
let hiddenSaleId: string;
let hiddenTerminalId: string;
let otherTenantSaleId: string;
let offlineDaySaleId: string;
let offlineBusinessDay: string;
let syncBusinessDay: string;

const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
type Device = ReturnType<typeof terminalDevice>;

function requestUser(tenantId: string, userId: string): RequestUser {
  return {
    userId,
    tenantId,
    tokenVersion: 0,
    email: "t@it.test",
    fullName: "IT",
    authMethod: "bearer",
    branchRoles: [],
  };
}

function attestation(
  challenge: TerminalEnrollmentCommand | TerminalSessionCommand,
  purpose: "enrollment" | "session",
  actorUserId: string,
  identity: TerminalIdentity,
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
    identity,
    actorUserId,
    ...counter,
    payloadDigest: sha256(boundedCanonical(challenge)),
    windowsSession: { sessionId: 1, protocol: "console", remoteSession: false },
    appVersion: "0.0.1",
    observedAt: Date.now(),
  };
}

async function enrollAndSell(
  tenant: TenantFixture,
  branchId: string,
  ownerId: string,
  clerkId: string,
  amount: string,
): Promise<{ terminalId: string; tillId: string; workSessionId: string; shiftId: string; saleId: string }> {
  const device = terminalDevice();
  const ownerUser = requestUser(tenant.tenantId, ownerId);
  const clerkUser = requestUser(tenant.tenantId, clerkId);
  const created = await tx((c) =>
    trust.createCounter(c, ownerUser, branchId, `Till ${randomUUID().slice(0, 4)}`),
  );
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, ownerUser, branchId, {
      registerId: created.id,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Desk",
    }),
  );
  const proof = await proofs.record(
    ownerUser,
    branchId,
    device.sign(attestation(challenge, "enrollment", ownerId, challenge.identity), challenge.identity.keyId, "attendance"),
  );
  const identity = await tx((c) =>
    trust.finishEnrollment(c, ownerUser, branchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  const sessionChallenge = await tx((c) => trust.beginSession(c, clerkUser, branchId, identity));
  const sessionProof = await proofs.record(
    clerkUser,
    branchId,
    device.sign(attestation(sessionChallenge, "session", clerkId, identity), identity.keyId, "attendance"),
  );
  const session = await tx((c) =>
    trust.finishSession(c, clerkUser, branchId, device.sign(sessionChallenge, identity.keyId), sessionProof.proofId),
  );
  const shiftId = randomUUID();
  await shifts.open(clerkUser, branchId, session.workSessionId, {
    shiftId,
    pin: PIN,
    openingCount: { totalMinor: 500_000, lines: [{ denominationMinor: 100, count: 5000 }] },
  });
  const batch =
    tenant.tenantId === fx.tenantId && branchId === fx.mainBranchId
      ? batchId
      : await createStockedBatch(prisma, stock, tenant, { qty: 50, branchId });
  const sale = await sales.checkout(
    tenant.tenantId,
    branchId,
    clerkId,
    [],
    {
      items: [{ productId: tenant.productId, batchId: batch, qty: 1, unitPrice: amount }],
      payments: [{ method: PaymentMethod.cash, amount }],
    } as never,
    randomUUID(),
    { user: clerkUser, workSessionId: session.workSessionId },
  );
  return {
    terminalId: identity.terminalId,
    tillId: session.tillId,
    workSessionId: session.workSessionId,
    shiftId,
    saleId: sale!.id,
  };
}

beforeAll(async () => {
  syncBusinessDay = businessDateKey(TZ);
  offlineBusinessDay = businessDateKey(TZ, addDays(businessToday(TZ), -1));

  fx = await createTenant(prisma, "sales-reports-dim");
  other = await createTenant(prisma, "sales-reports-dim-other");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: other.tenantId, branchId: other.mainBranchId, userId: other.clerkId, role: RoleName.cashier },
      { tenantId: other.tenantId, branchId: other.mainBranchId, userId: other.ownerId, role: RoleName.owner },
    ],
  });
  const posPinHash = await bcrypt.hash(PIN, 4);
  await prisma.appUser.updateMany({
    where: { id: { in: [fx.clerkId, other.clerkId] } },
    data: { posPinHash, posPinVersion: 1 },
  });
  batchId = await createStockedBatch(prisma, stock, fx, { qty: 200 });

  const main = await enrollAndSell(fx, fx.mainBranchId, fx.ownerId, fx.clerkId, "40.00");
  mainTerminalId = main.terminalId;
  mainTillId = main.tillId;
  mainWorkSessionId = main.workSessionId;
  mainShiftId = main.shiftId;
  mainSaleId = main.saleId;

  const hidden = await enrollAndSell(fx, fx.otherBranchId, fx.ownerId, fx.clerkId, "55.00");
  hiddenSaleId = hidden.saleId;
  hiddenTerminalId = hidden.terminalId;

  const foreign = await enrollAndSell(other, other.mainBranchId, other.ownerId, other.clerkId, "99.00");
  otherTenantSaleId = foreign.saleId;

  const enrollment = await prisma.terminalEnrollment.findFirstOrThrow({
    where: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      terminalId: mainTerminalId,
      revokedAt: null,
    },
  });
  const offlineCommandId = randomUUID();
  const occurredAt = startOfBusinessDay(TZ, offlineBusinessDay).getTime() + 4 * 3_600_000;
  const soldAt = startOfBusinessDay(TZ, syncBusinessDay).getTime() + 4 * 3_600_000;
  await prisma.terminalCommandReceipt.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      terminalId: enrollment.terminalId,
      enrollmentId: enrollment.id,
      keyId: enrollment.keyId,
      commandId: offlineCommandId,
      operation: "offline_journal.command",
      requestDigest: "b".repeat(64),
      actorUserId: fx.clerkId,
      command: {
        payload: { kind: "ordinary_sale", occurredAt, receiptNumber: "OFF-1", totalMinor: 2000 },
      },
      result: { status: "accepted" },
      recordedAt: new Date(soldAt),
    },
  });
  const offlineSale = await prisma.sale.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      invoiceNo: `OFF-${randomUUID().slice(0, 6)}`,
      status: "posted",
      soldAt: new Date(soldAt),
      offlineCommandId,
      terminalId: mainTerminalId,
      tillId: mainTillId,
      workSessionId: mainWorkSessionId,
      shiftId: mainShiftId,
      soldBy: fx.clerkId,
      subtotal: "20",
      grandTotal: "20",
      amountPaid: "20",
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
  });
  offlineDaySaleId = offlineSale.id;

  await prisma.sale.update({
    where: { id: mainSaleId },
    data: { soldAt: new Date() },
  });
  await prisma.sale.update({
    where: { id: hiddenSaleId },
    data: { soldAt: new Date() },
  });
});

afterAll(() => prisma.$disconnect());

describe("sales report dimensions (W10 #72)", () => {
  it("scopes terminal filter to the selected branch — other tenant and hidden branch sales stay out", async () => {
    const base = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365);
    const filtered = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: { terminalId: mainTerminalId },
    });
    expect(filtered.count).toBeGreaterThan(0);
    expect(filtered.count).toBe(base.count);
    expect(Number(filtered.grandTotal)).toBeCloseTo(Number(base.grandTotal), 2);
    const otherBranchTerminalOnMain = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: { terminalId: hiddenTerminalId },
    });
    expect(otherBranchTerminalOnMain.count).toBe(0);
    const otherTenantSummary = await reports.salesSummary(other.tenantId, other.mainBranchId, 365, {
      filters: { terminalId: mainTerminalId },
    });
    expect(otherTenantSummary.count).toBe(0);
    expect(otherTenantSummary.grandTotal).toBe("0");
  });

  it("shift filter matches exact counter shift rows only", async () => {
    const filtered = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: { shiftId: mainShiftId },
    });
    expect(filtered.count).toBeGreaterThanOrEqual(2);
    const hiddenShiftSummary = await reports.salesSummary(fx.tenantId, fx.otherBranchId, 365, {
      filters: { shiftId: mainShiftId },
    });
    expect(hiddenShiftSummary.count).toBe(0);
  });

  it("channel=desktop_online excludes the handcrafted offline sale", async () => {
    const online = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: { channel: "desktop_online" },
    });
    const offline = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: { channel: "offline" },
    });
    expect(offline.count).toBeGreaterThanOrEqual(1);
    expect(Number(online.grandTotal) + Number(offline.grandTotal)).toBeLessThanOrEqual(
      Number((await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365)).grandTotal) + 0.01,
    );
  });

  it("breakdown by channel sums to the unfiltered report total", async () => {
    const base = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365);
    const split = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 365, {
      filters: {},
      groupBy: "channel",
    });
    const sum = split.breakdown!.reduce((acc, row) => acc + Number(row.grandTotal), 0);
    expect(sum).toBeCloseTo(Number(base.grandTotal), 2);
    expect(split.breakdown!.reduce((acc, row) => acc + row.count, 0)).toBe(base.count);
  });

  it("counts an offline sale on the counter business day, not the sync day", async () => {
    const daily = await reports.salesDaily(fx.tenantId, fx.mainBranchId, 60);
    const occurredRow = daily.rows.find((row) => row.date === offlineBusinessDay);
    const syncRow = daily.rows.find((row) => row.date === syncBusinessDay);
    expect(occurredRow?.transactions).toBeGreaterThanOrEqual(1);
    const soldAtKey = scope.businessDateKey(
      TZ,
      {
        soldAt: new Date(startOfBusinessDay(TZ, syncBusinessDay).getTime() + 4 * 3_600_000),
        offlineCommandId: (
          await prisma.sale.findFirstOrThrow({
            where: { id: offlineDaySaleId },
            select: { offlineCommandId: true },
          })
        ).offlineCommandId,
      },
      new Map(),
    );
    expect(soldAtKey).toBe(syncBusinessDay);
    const window = await scope.reportWindow(fx.tenantId, fx.mainBranchId, 60);
    const { occurredAtByCommandId } = await scope.loadPostedSales(
      fx.tenantId,
      fx.mainBranchId,
      window,
      {},
    );
    const offline = (await prisma.sale.findFirstOrThrow({ where: { id: offlineDaySaleId } })) as {
      soldAt: Date;
      offlineCommandId: string | null;
    };
    expect(scope.businessDateKey(TZ, offline, occurredAtByCommandId)).toBe(offlineBusinessDay);
  });

  it("includes freshness on sales-summary", async () => {
    const summary = await reports.salesSummary(fx.tenantId, fx.mainBranchId, 30);
    expect(summary.freshness).toMatchObject({
      generatedAt: expect.any(String),
      latestSyncedAt: null,
      pendingOfflineCount: expect.any(Number),
    });
  });
});