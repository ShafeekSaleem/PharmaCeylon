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
const reads = new SaleReadService(prisma as never, access);

const PIN = "4826";
let fx: TenantFixture;
let other: TenantFixture;
let batchId: string;
let registerId: string;
let tillId: string;
let terminalId: string;
let shiftId: string;
let counterSaleId: string;
let counterInvoice: string;
let webInvoice: string;

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

const staff = (tenant: TenantFixture, userId: string): RequestUser => ({
  userId,
  tenantId: tenant.tenantId,
  tokenVersion: 0,
  email: "staff@it.test",
  fullName: "Staff",
  authMethod: "bearer",
  branchRoles: [{ branchId: tenant.mainBranchId, role: userId === tenant.clerkId ? RoleName.cashier : RoleName.owner }],
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

const record = (device: Device, a: LocalAttendanceAttestation, actor: RequestUser) =>
  proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));

async function enroll(ownerUser: RequestUser, clerkUser: RequestUser) {
  const device = terminalDevice();
  const created = await tx((c) => trust.createCounter(c, ownerUser, fx.mainBranchId, `Till ${randomUUID().slice(0, 4)}`));
  registerId = created.id;
  tillId = created.tillId;
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, ownerUser, fx.mainBranchId, {
      registerId,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Front desk",
    }),
  );
  const proof = await record(device, attestation(challenge, "enrollment", ownerUser), ownerUser);
  const identity = await tx((c) =>
    trust.finishEnrollment(c, ownerUser, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  terminalId = identity.terminalId;

  const sessionChallenge = await tx((c) => trust.beginSession(c, clerkUser, fx.mainBranchId, identity));
  const sessionProof = await record(device, attestation(sessionChallenge, "session", clerkUser), clerkUser);
  const session = await tx((c) =>
    trust.finishSession(c, clerkUser, fx.mainBranchId, device.sign(sessionChallenge, identity.keyId), sessionProof.proofId),
  );

  shiftId = randomUUID();
  await shifts.open(clerkUser, fx.mainBranchId, session.workSessionId, {
    shiftId,
    pin: PIN,
    openingCount: { totalMinor: 500_000, lines: [{ denominationMinor: 100, count: 5000 }] },
  });

  const sale = await sales.checkout(
    fx.tenantId,
    fx.mainBranchId,
    clerkUser.userId,
    [],
    {
      items: [{ productId: fx.productId, batchId, qty: 1, unitPrice: "25.00" }],
      payments: [{ method: PaymentMethod.cash, amount: "25.00" }],
    } as never,
    randomUUID(),
    { user: clerkUser, workSessionId: session.workSessionId },
  );
  counterSaleId = sale!.id;
  const row = await prisma.sale.findFirstOrThrow({ where: { id: counterSaleId } });
  counterInvoice = row.invoiceNo;
}

beforeAll(async () => {
  fx = await createTenant(prisma, "sales-history-attr");
  other = await createTenant(prisma, "sales-history-attr-other");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
    ],
  });
  const posPinHash = await bcrypt.hash(PIN, 4);
  await prisma.appUser.update({ where: { id: fx.clerkId }, data: { posPinHash, posPinVersion: 1 } });
  batchId = await createStockedBatch(prisma, stock, fx, { qty: 200 });

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

  await enroll(owner(fx), staff(fx, fx.clerkId));

  const otherBatch = await createStockedBatch(prisma, stock, other, { qty: 5 });
  await sales.checkout(other.tenantId, other.mainBranchId, other.clerkId, [], {
    items: [{ productId: other.productId, batchId: otherBatch, qty: 1, unitPrice: "5.00" }],
    payments: [{ method: PaymentMethod.cash, amount: "5.00" }],
  } as never, randomUUID());
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

  it("labels web checkout as web_legacy", async () => {
    const listed = await reads.history(owner(fx), fx.mainBranchId, { invoiceNo: webInvoice });
    expect(listed.items.some((row) => row.invoiceNo === webInvoice)).toBe(true);
    expect(listed.items.find((row) => row.invoiceNo === webInvoice)).toMatchObject({
      channel: "web_legacy",
      terminal: null,
      register: null,
    });
  });

  it("filters by register and per-counter invoice", async () => {
    const only = await reads.history(owner(fx), fx.mainBranchId, { registerId, invoiceNo: counterInvoice });
    expect(only.items).toHaveLength(1);
    expect(only.items[0]!.id).toBe(counterSaleId);

    const wrongRegister = await reads.history(owner(fx), fx.mainBranchId, {
      registerId: randomUUID(),
      invoiceNo: counterInvoice,
    });
    expect(wrongRegister.total).toBe(0);
  });

  it("isolates another tenant's terminal, register and shift", async () => {
    const foreign = await prisma.sale.findFirstOrThrow({ where: { tenantId: other.tenantId } });
    for (const filters of [
      { terminalId: foreign.terminalId ?? randomUUID() },
      { registerId: randomUUID() },
      { shiftId: foreign.shiftId ?? randomUUID() },
    ]) {
      const result = await reads.history(owner(fx), fx.mainBranchId, filters);
      expect(result.total).toBe(0);
    }
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

  it("labels fallback web sales from branch rollout windows", async () => {
    const started = new Date(Date.now() - 1_800_000);
    const ends = new Date(Date.now() + 3_600_000);
    await prisma.branch.update({
      where: { id: fx.mainBranchId },
      data: {
        desktopPosRollout: DesktopPosRollout.live,
        desktopPosLiveAt: new Date(Date.now() - 86_400_000),
        posFallbackStartedAt: started,
        posFallbackEndsAt: ends,
      },
    });
    const fallbackInvoice = `INV-FB-${randomUUID().slice(0, 8)}`;
    await prisma.sale.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        invoiceNo: fallbackInvoice,
        soldAt: new Date(Date.now() - 600_000),
        subtotal: "40",
        grandTotal: "40",
        amountPaid: "40",
        soldBy: fx.clerkId,
        items: {
          create: {
            tenantId: fx.tenantId,
            productId: fx.productId,
            batchId,
            qty: 1,
            unitPrice: "40",
            lineTotal: "40",
          },
        },
        payments: { create: { tenantId: fx.tenantId, method: PaymentMethod.cash, amount: "40" } },
      },
    });
    const byChannel = await reads.history(owner(fx), fx.mainBranchId, { channel: "fallback" });
    expect(byChannel.items.some((row) => row.invoiceNo === fallbackInvoice)).toBe(true);
    const row = byChannel.items.find((item) => item.invoiceNo === fallbackInvoice)!;
    expect(row.channel).toBe("fallback");
  });
});