import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { DesktopPosRollout, PaymentMethod, Prisma, RoleName } from "@prisma/client";
import type { LocalAttendanceAttestation, TerminalEnrollmentCommand, TerminalIdentity, TerminalSessionCommand } from "@pharmaceylon/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { SalesHistoryQueryDto } from "../../src/sales/dto/sales-history-query.dto";
import { SaleReadService } from "../../src/sales/sale-read.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import { PermissionsService } from "../../src/security/permissions.service";
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
const permissions = new PermissionsService(prisma as never);
const reads = new SaleReadService(prisma as never, permissions as never);

const PIN = "4826";
let fx: TenantFixture;
let other: TenantFixture;
let batchId: string;
let otherBatchId: string;
let registerId: string;
let tillId: string;
let terminalId: string;
let shiftId: string;
let counterSaleId: string;
let counterInvoice: string;
let webInvoice: string;
let offlineSaleId: string;
let otherTenantIds: { terminalId: string; registerId: string; tillId: string; shiftId: string; saleId: string };
let otherBranchIds: { terminalId: string; registerId: string; tillId: string; shiftId: string; saleId: string };

const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
type Device = ReturnType<typeof terminalDevice>;

const owner = (tenant: TenantFixture): RequestUser => ({
  userId: tenant.ownerId,
  tenantId: tenant.tenantId,
  tokenVersion: 0,
  email: "owner@it.test",
  fullName: "Owner",
  authMethod: "bearer",
  branchRoles: [{ branchId: tenant.mainBranchId, role: RoleName.owner }],
});

const mainBranchManager = (tenant: TenantFixture): RequestUser => ({
  userId: tenant.managerId,
  tenantId: tenant.tenantId,
  tokenVersion: 0,
  email: "mgr@it.test",
  fullName: "Manager",
  authMethod: "bearer",
  branchRoles: [{ branchId: tenant.mainBranchId, role: RoleName.manager }],
});

const staff = (tenant: TenantFixture, userId: string, branchId: string): RequestUser => ({
  userId,
  tenantId: tenant.tenantId,
  tokenVersion: 0,
  email: "staff@it.test",
  fullName: "Staff",
  authMethod: "bearer",
  branchRoles: [{ branchId, role: userId === tenant.clerkId ? RoleName.cashier : RoleName.owner }],
});

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

const record = (actor: RequestUser, branchId: string, device: Device, a: LocalAttendanceAttestation) =>
  proofs.record(actor, branchId, device.sign(a, a.identity.keyId, "attendance"));

async function enrollCounter(
  tenant: TenantFixture,
  branchId: string,
  ownerUser: RequestUser,
  clerkUser: RequestUser,
  invoiceNo?: string,
) {
  const device = terminalDevice();
  const created = await tx((c) => trust.createCounter(c, ownerUser, branchId, `Till ${randomUUID().slice(0, 4)}`));
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, ownerUser, branchId, {
      registerId: created.id,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Front desk",
    }),
  );
  const proof = await record(ownerUser, branchId, device, attestation(challenge, "enrollment", ownerUser));
  const identity = await tx((c) =>
    trust.finishEnrollment(c, ownerUser, branchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  const sessionChallenge = await tx((c) => trust.beginSession(c, clerkUser, branchId, identity));
  const sessionProof = await record(clerkUser, branchId, device, attestation(sessionChallenge, "session", clerkUser));
  const session = await tx((c) =>
    trust.finishSession(c, clerkUser, branchId, device.sign(sessionChallenge, identity.keyId), sessionProof.proofId),
  );
  const shift = randomUUID();
  await shifts.open(clerkUser, branchId, session.workSessionId, {
    shiftId: shift,
    pin: PIN,
    openingCount: { totalMinor: 500_000, lines: [{ denominationMinor: 100, count: 5000 }] },
  });
  const batch =
    tenant.tenantId === fx.tenantId && branchId === fx.mainBranchId
      ? batchId
      : tenant.tenantId === fx.tenantId
        ? await createStockedBatch(prisma, stock, tenant, { qty: 50, branchId })
        : otherBatchId;
  const sale = await sales.checkout(
    tenant.tenantId,
    branchId,
    clerkUser.userId,
    [],
    {
      items: [{ productId: tenant.productId, batchId: batch, qty: 1, unitPrice: "25.00" }],
      payments: [{ method: PaymentMethod.cash, amount: "25.00" }],
    } as never,
    randomUUID(),
    { user: clerkUser, workSessionId: session.workSessionId },
  );
  if (invoiceNo) {
    await prisma.sale.update({ where: { id: sale!.id }, data: { invoiceNo } });
  }
  const row = await prisma.sale.findFirstOrThrow({ where: { id: sale!.id } });
  return {
    registerId: created.id,
    tillId: created.tillId,
    terminalId: identity.terminalId,
    shiftId: shift,
    saleId: sale!.id,
    invoiceNo: row.invoiceNo,
  };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "sales-history-attr");
  other = await createTenant(prisma, "sales-history-attr-other");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
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
  otherBatchId = await createStockedBatch(prisma, stock, other, { qty: 50 });

  const web = await sales.checkout(
    fx.tenantId,
    fx.mainBranchId,
    fx.clerkId,
    [],
    {
      items: [{ productId: fx.productId, batchId, qty: 1, unitPrice: "10.00" }],
      payments: [{ method: PaymentMethod.cash, amount: "10.00" }],
    } as never,
    randomUUID(),
  );
  webInvoice = (await prisma.sale.findFirstOrThrow({ where: { id: web!.id } })).invoiceNo;

  const main = await enrollCounter(fx, fx.mainBranchId, owner(fx), staff(fx, fx.clerkId, fx.mainBranchId), "C1R-000186");
  registerId = main.registerId;
  tillId = main.tillId;
  terminalId = main.terminalId;
  shiftId = main.shiftId;
  counterSaleId = main.saleId;
  counterInvoice = main.invoiceNo;

  otherTenantIds = await enrollCounter(other, other.mainBranchId, owner(other), staff(other, other.clerkId, other.mainBranchId));
  otherBranchIds = await enrollCounter(
    fx,
    fx.otherBranchId,
    owner(fx),
    staff(fx, fx.clerkId, fx.otherBranchId),
  );

  const offline = await prisma.sale.create({
    data: {
      tenantId: fx.tenantId,
      branchId: fx.mainBranchId,
      invoiceNo: `C1R-OFF-${randomUUID().slice(0, 6)}`,
      offlineCommandId: randomUUID(),
      subtotal: "30",
      grandTotal: "30",
      amountPaid: "30",
      soldBy: fx.clerkId,
      items: {
        create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 1, unitPrice: "30", lineTotal: "30" },
      },
      payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "30" } },
    },
  });
  offlineSaleId = offline.id;
});

afterAll(() => prisma.$disconnect());

describe("sales history attribution and filters (#66 Phase B)", () => {
  it("returns counter, register, shift and channel on list and detail", async () => {
    const listed = await reads.history(owner(fx), fx.mainBranchId, { terminalId });
    const row = listed.items.find((item) => item.id === counterSaleId)!;
    expect(row).toMatchObject({
      channel: "desktop_online",
      terminal: { id: terminalId, label: expect.any(String) },
      register: { id: registerId, tillId, label: expect.any(String) },
      shift: expect.objectContaining({ id: shiftId, shiftNumber: expect.stringMatching(/^S-/) }),
    });

    const detail = await reads.detail(owner(fx), counterSaleId);
    expect(detail).toMatchObject({
      channel: "desktop_online",
      terminal: { id: terminalId },
      register: { id: registerId, tillId },
      shift: expect.objectContaining({ id: shiftId }),
    });
  });

  it("finds a counter sale by short receipt number when the register is selected", async () => {
    const byShort = await reads.history(owner(fx), fx.mainBranchId, { registerId, invoiceNo: "186" });
    expect(byShort.items.map((row) => row.id)).toEqual([counterSaleId]);

    const byPadded = await reads.history(owner(fx), fx.mainBranchId, { registerId, invoiceNo: "000186" });
    expect(byPadded.items.map((row) => row.id)).toEqual([counterSaleId]);

    const partial = await reads.history(owner(fx), fx.mainBranchId, { registerId, invoiceNo: "C1R-0001" });
    expect(partial.items.map((row) => row.id)).toEqual([counterSaleId]);
  });

  it("labels web checkout as web_legacy and filters channel=web_legacy", async () => {
    const listed = await reads.history(owner(fx), fx.mainBranchId, { invoiceNo: webInvoice });
    expect(listed.items.find((row) => row.invoiceNo === webInvoice)).toMatchObject({
      channel: "web_legacy",
      terminal: null,
      register: null,
    });
    const filtered = await reads.history(owner(fx), fx.mainBranchId, { channel: "web_legacy" });
    expect(filtered.items.every((row) => row.channel === "web_legacy")).toBe(true);
    expect(filtered.items.some((row) => row.invoiceNo === webInvoice)).toBe(true);
  });

  it("filters offline sales and labels channel=offline", async () => {
    const filtered = await reads.history(owner(fx), fx.mainBranchId, { channel: "offline" });
    expect(filtered.items.some((row) => row.id === offlineSaleId)).toBe(true);
    expect(filtered.items.every((row) => row.channel === "offline")).toBe(true);
  });

  it("keeps channel filters aligned with row labels across go-live and fallback history", async () => {
    const liveAt = new Date("2026-08-01T00:00:00.000Z");
    const preLiveSale = await prisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `PRE-LIVE-${randomUUID().slice(0, 6)}`,
        soldAt: new Date("2026-07-01T12:00:00.000Z"),
        subtotal: "11",
        grandTotal: "11",
        amountPaid: "11",
        soldBy: fx.clerkId,
        items: {
          create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 1, unitPrice: "11", lineTotal: "11" },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "11" } },
      },
    });
    await prisma.auditEvent.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        eventName: "branch.pos_fallback_started",
        entityName: "branch",
        entityId: fx.mainBranchId,
        payload: { endsAt: "2026-07-15T00:00:00.000Z" },
        createdAt: new Date("2026-07-10T00:00:00.000Z"),
      },
    });
    const fallbackSale = await prisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: `FB-${randomUUID().slice(0, 6)}`,
        soldAt: new Date("2026-09-01T12:00:00.000Z"),
        subtotal: "40",
        grandTotal: "40",
        amountPaid: "40",
        soldBy: fx.clerkId,
        items: {
          create: { tenantId: fx.tenantId, productId: fx.productId, batchId, qty: 1, unitPrice: "40", lineTotal: "40" },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "40" } },
      },
    });
    await prisma.branch.update({
      where: { id: fx.mainBranchId },
      data: {
        desktopPosRollout: DesktopPosRollout.live,
        desktopPosLiveAt: liveAt,
        posFallbackStartedAt: new Date("2026-09-01T08:00:00.000Z"),
        posFallbackEndsAt: new Date("2026-09-01T20:00:00.000Z"),
      },
    });

    for (const channel of ["web_legacy", "fallback", "desktop_online", "offline"] as const) {
      const filtered = await reads.history(owner(fx), fx.mainBranchId, { channel, branchId: "all" });
      expect(filtered.items.every((row) => row.channel === channel)).toBe(true);
    }

    const legacyList = await reads.history(owner(fx), fx.mainBranchId, { channel: "web_legacy", invoiceNo: preLiveSale.invoiceNo });
    expect(legacyList.items[0]?.channel).toBe("web_legacy");
    const fallbackList = await reads.history(owner(fx), fx.mainBranchId, { channel: "fallback", invoiceNo: fallbackSale.invoiceNo });
    expect(fallbackList.items[0]?.channel).toBe("fallback");

    const wronglyFiltered = await reads.history(owner(fx), fx.mainBranchId, { channel: "fallback", invoiceNo: preLiveSale.invoiceNo });
    expect(wronglyFiltered.total).toBe(0);
  });

  it("isolates another tenant's real terminal, register, till and shift ids", async () => {
    const ids = otherTenantIds;
    for (const filters of [
      { terminalId: ids.terminalId },
      { registerId: ids.registerId },
      { tillId: ids.tillId },
      { shiftId: ids.shiftId },
    ]) {
      const result = await reads.history(owner(fx), fx.mainBranchId, filters);
      expect(result.total).toBe(0);
    }
    const options = await reads.historyOptions(owner(fx));
    expect(options.registers?.some((row) => row.registerId === ids.registerId)).toBe(false);
    expect(options.terminals?.some((row) => row.terminalId === ids.terminalId)).toBe(false);
  });

  it("hides another branch's sale and attribution from a manager scoped to main only", async () => {
    const ids = otherBranchIds;
    const viewer = mainBranchManager(fx);
    for (const filters of [
      { terminalId: ids.terminalId },
      { registerId: ids.registerId },
      { tillId: ids.tillId },
      { shiftId: ids.shiftId },
    ]) {
      const result = await reads.history(viewer, fx.mainBranchId, filters);
      expect(result.total).toBe(0);
    }
    const options = await reads.historyOptions(viewer);
    expect(options.registers?.some((row) => row.registerId === ids.registerId)).toBe(false);
    await expect(reads.detail(viewer, ids.saleId)).rejects.toMatchObject({ status: 404 });
  });

  it("combines channel and shift filters", async () => {
    const result = await reads.history(owner(fx), fx.mainBranchId, { channel: "desktop_online", shiftId });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((row) => row.channel === "desktop_online" && row.shift?.id === shiftId)).toBe(true);
  });

  it("rejects invalid filter params with validation errors", async () => {
    const errors = await validate(plainToInstance(SalesHistoryQueryDto, { channel: "bogus", terminalId: "x" }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((e) => e.property).sort()).toEqual(["channel", "terminalId"]);
  });

  it("options lists registers and terminals for the branch", async () => {
    const options = await reads.historyOptions(owner(fx));
    expect(options.registers?.some((row) => row.registerId === registerId)).toBe(true);
    expect(options.terminals?.some((row) => row.terminalId === terminalId)).toBe(true);
  });
});