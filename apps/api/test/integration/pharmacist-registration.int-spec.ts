import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import type { Prisma } from "@prisma/client";
import type { OnlineTerminalCommand } from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { PharmacistRegistrationService } from "../../src/clinical/pharmacist-registration.service";
import { businessDateKey } from "../../src/common/business-date.util";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { PharmacistApprovalService } from "../../src/sales/pharmacist-approval.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { OperationAuthorizationService } from "../../src/security/operation-authorization.service";
import { PERMISSION_KEYS } from "../../src/security/permission-catalog";
import { PermissionsService } from "../../src/security/permissions.service";
import { object } from "../../src/terminals/terminal-wire";
import { createPrisma, createStockedBatch, createTenant, TenantFixture } from "./fixtures";

/** P1 #47: owner-recorded SLMC registrations are the only clinical qualification. */
const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);
const registrations = new PharmacistRegistrationService(proxy as never, access, audit);

let fx: TenantFixture;
let pharmacistId: string;
let secondPharmacistId: string;
const user = (userId: string): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion: 0,
  branchRoles: [],
  email: "clinical@it.test",
  fullName: "Clinical",
  authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (e: { response?: { code?: string } }) => e.response?.code ?? String(e),
  );
const dayKey = (days: number) => businessDateKey("Asia/Colombo", new Date(Date.now() + days * 86_400_000));
const qualified = (userId: string, branchId = fx.mainBranchId) =>
  code(tx((c) => registrations.assertQualified(c, { tenantId: fx.tenantId, branchId, userId })));
const record = (userId: string, slmcNumber: string, expiresOn = dayKey(365), by = fx.ownerId) =>
  registrations.record(user(by), fx.mainBranchId, { userId, slmcNumber, expiresOn });
async function clear() {
  // Registrations are retained by trigger; revoke whatever another test left current.
  await prisma.pharmacistRegistration.updateMany({
    where: { tenantId: fx.tenantId, revokedAt: null },
    // An hour ahead: a test may leave a row recorded by a clock that runs fast.
    data: { revokedAt: new Date(Date.now() + 3_600_000), revokedByUserId: fx.ownerId, revocationReason: "test reset" },
  });
}
function command(staffUserId: string, overrides: Partial<OnlineTerminalCommand<unknown>> = {}): OnlineTerminalCommand<unknown> {
  return {
    contractVersion: 1,
    kind: "online_operation",
    commandId: randomUUID(),
    identity: { tenantId: fx.tenantId, branchId: fx.mainBranchId, terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: "k" },
    session: { registerId: randomUUID(), tillId: randomUUID(), workSessionId: randomUUID(), staffUserId },
    operation: "POST /api/v1/prescriptions",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    serverNonce: "n",
    body: {},
    approvalEvidenceId: null,
    pharmacistEvidenceId: null,
    operatingHoursExceptionId: null,
    ...overrides,
  };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "clinical");
  const [first, second] = await Promise.all(
    ["pharmacist", "pharmacist2"].map((who) =>
      prisma.appUser.create({
        data: { tenantId: fx.tenantId, email: `${who}-${randomUUID().slice(0, 8)}@it.test`, fullName: who, passwordHash: "x" },
      }),
    ),
  );
  pharmacistId = first!.id;
  secondPharmacistId = second!.id;
  await prisma.tenantMembership.createMany({
    data: [pharmacistId, secondPharmacistId].map((userId) => ({ tenantId: fx.tenantId, userId })),
  });
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: pharmacistId, role: "pharmacist" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: secondPharmacistId, role: "pharmacist" },
    ],
  });
});
beforeEach(clear);
afterAll(() => prisma.$disconnect());

describe("recording", () => {
  it("lets an owner record a registration, normalized and audited in the same transaction", async () => {
    const row = await record(pharmacistId, "  ph/1234 ");
    expect(row).toMatchObject({ userId: pharmacistId, slmcNumber: "PH/1234", status: "current", expiresOn: dayKey(365) });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "pharmacist_registration.recorded", entityId: row.id },
    });
    expect(event.actorUserId).toBe(fx.ownerId);
    expect(event.payload).toMatchObject({ userId: pharmacistId, slmcNumber: "PH/1234", replacesRegistrationId: null });
    expect((await registrations.list(user(fx.managerId))).map((r) => r.id)).toContain(row.id);
    await expect(qualified(pharmacistId)).resolves.toBe("ok");
  });

  it("refuses managers, whatever their permissions", async () => {
    await expect(code(record(pharmacistId, "PH-1", dayKey(30), fx.managerId))).resolves.toBe("PHARMACIST_REGISTRATION_OWNER_ONLY");
    const anyRow = await record(pharmacistId, "PH-1");
    await expect(code(registrations.revoke(user(fx.managerId), fx.mainBranchId, anyRow.id, "No"))).resolves.toBe(
      "PHARMACIST_REGISTRATION_OWNER_ONLY",
    );
    expect(await prisma.pharmacistRegistration.count({ where: { tenantId: fx.tenantId, recordedByUserId: fx.managerId } })).toBe(0);
  });

  it("refuses bad numbers, expired or implausible dates, and staff outside the tenant", async () => {
    await expect(record(pharmacistId, "PH 12")).rejects.toThrow(/SLMC registration number/);
    await expect(record(pharmacistId, "PH-1", dayKey(-1))).rejects.toThrow(/already expired/);
    await expect(record(pharmacistId, "PH-1", dayKey(366 * 11))).rejects.toThrow(/10 years/);
    await expect(record(pharmacistId, "PH-1", "2026-02-30")).rejects.toThrow(/YYYY-MM-DD/);
    await expect(record(randomUUID(), "PH-1")).rejects.toThrow(/Staff member not found/);
    // Today is still valid: expiry is inclusive.
    await expect(record(pharmacistId, "PH-1", dayKey(0))).resolves.toMatchObject({ status: "current" });
  });

  it("renews by revoking the row it replaces; the same values again change nothing", async () => {
    const first = await record(pharmacistId, "PH-77", dayKey(10));
    const again = await record(pharmacistId, "PH-77", dayKey(10));
    expect(again.id).toBe(first.id);
    const renewed = await record(pharmacistId, "PH-77", dayKey(400));
    expect(renewed.id).not.toBe(first.id);
    const old = await prisma.pharmacistRegistration.findUniqueOrThrow({ where: { id: first.id } });
    expect(old).toMatchObject({ revokedByUserId: fx.ownerId, revocationReason: "Replaced by a newer registration" });
    expect(await prisma.pharmacistRegistration.count({ where: { tenantId: fx.tenantId, userId: pharmacistId, revokedAt: null } })).toBe(1);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "pharmacist_registration.recorded", entityId: renewed.id },
    });
    expect(event.payload).toMatchObject({ replacesRegistrationId: first.id });
  });

  it("keeps one person per current registration number", async () => {
    await record(pharmacistId, "PH-900");
    await expect(code(record(secondPharmacistId, "ph-900"))).resolves.toBe("SLMC_NUMBER_IN_USE");
    // Concurrent recordings for one person serialize on their membership; one current row results.
    await Promise.all([record(secondPharmacistId, "PH-901"), record(secondPharmacistId, "PH-902")]);
    expect(await prisma.pharmacistRegistration.count({ where: { tenantId: fx.tenantId, userId: secondPharmacistId, revokedAt: null } })).toBe(1);
  });

  it("never records a revocation before the recording, whatever the API clock says", async () => {
    // Recorded by an instance whose clock runs a minute ahead.
    const ahead = new Date(Date.now() + 60_000);
    const skewed = await prisma.pharmacistRegistration.create({
      data: { tenantId: fx.tenantId, userId: pharmacistId, slmcNumber: "PH-15", expiresOn: new Date(`${dayKey(30)}T00:00:00Z`),
        recordedByUserId: fx.ownerId, recordedAt: ahead },
    });
    const renewed = await record(pharmacistId, "PH-15", dayKey(300));
    const old = await prisma.pharmacistRegistration.findUniqueOrThrow({ where: { id: skewed.id } });
    expect(old.revokedAt!.getTime()).toBeGreaterThanOrEqual(ahead.getTime());
    const again = await prisma.pharmacistRegistration.create({
      data: { tenantId: fx.tenantId, userId: secondPharmacistId, slmcNumber: "PH-16", expiresOn: new Date(`${dayKey(30)}T00:00:00Z`),
        recordedByUserId: fx.ownerId, recordedAt: ahead },
    });
    await expect(registrations.revoke(user(fx.ownerId), fx.mainBranchId, again.id, "Typo")).resolves.toMatchObject({ status: "revoked" });
    expect(renewed.status).toBe("current");
  });

  it("retains evidence: content is immutable, revocation is recorded once, nothing is deleted", async () => {
    const row = await record(pharmacistId, "PH-5");
    await expect(prisma.pharmacistRegistration.update({ where: { id: row.id }, data: { slmcNumber: "PH-6" } })).rejects.toThrow(/immutable/);
    await expect(prisma.pharmacistRegistration.delete({ where: { id: row.id } })).rejects.toThrow(/retained/);
    const revoked = await registrations.revoke(user(fx.ownerId), fx.mainBranchId, row.id, "Left the pharmacy");
    expect(revoked).toMatchObject({ status: "revoked", revocationReason: "Left the pharmacy" });
    await expect(
      prisma.pharmacistRegistration.update({ where: { id: row.id }, data: { revokedAt: null, revokedByUserId: null, revocationReason: null } }),
    ).rejects.toThrow(/immutable/);
    // Revoking again is a no-op, not a second audit.
    await registrations.revoke(user(fx.ownerId), fx.mainBranchId, row.id, "Again");
    expect(await prisma.auditEvent.count({ where: { tenantId: fx.tenantId, eventName: "pharmacist_registration.revoked", entityId: row.id } })).toBe(1);
    // A membership with registrations on record cannot be deleted.
    await expect(
      prisma.tenantMembership.delete({ where: { tenantId_userId: { tenantId: fx.tenantId, userId: pharmacistId } } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });
});

describe("the clinical check", () => {
  it("is not satisfied by any role, an owner's included", async () => {
    await expect(qualified(fx.ownerId)).resolves.toBe("PHARMACIST_REQUIRED");
    await expect(qualified(pharmacistId)).resolves.toBe("PHARMACIST_REQUIRED");
    await record(fx.ownerId, "OWN-1");
    await expect(qualified(fx.ownerId)).resolves.toBe("ok");
  });

  it("refuses expired and revoked registrations", async () => {
    // Recorded earlier and now past its date: the check reads expiry at execution.
    await prisma.pharmacistRegistration.create({
      data: { tenantId: fx.tenantId, userId: pharmacistId, slmcNumber: "OLD-1", expiresOn: new Date(`${dayKey(-1)}T00:00:00Z`),
        recordedByUserId: fx.ownerId, recordedAt: new Date(Date.now() - 86_400_000 * 30) },
    });
    await expect(qualified(pharmacistId)).resolves.toBe("PHARMACIST_REQUIRED");
    await clear();
    const row = await record(pharmacistId, "PH-8");
    await registrations.revoke(user(fx.ownerId), fx.mainBranchId, row.id, "Suspended");
    await expect(qualified(pharmacistId)).resolves.toBe("PHARMACIST_REQUIRED");
  });

  it("needs an active account assigned to the branch", async () => {
    const row = await record(pharmacistId, "PH-9");
    expect(row.accountActive).toBe(true);
    await expect(qualified(pharmacistId, fx.otherBranchId)).resolves.toBe("PHARMACIST_REQUIRED");
    await prisma.tenantMembership.update({
      where: { tenantId_userId: { tenantId: fx.tenantId, userId: pharmacistId } },
      data: { isActive: false },
    });
    try {
      await expect(qualified(pharmacistId)).resolves.toBe("PHARMACIST_REQUIRED");
      // The list says so beside the registration's own status.
      const listed = (await registrations.list(user(fx.ownerId))).find((r) => r.id === row.id);
      expect(listed).toMatchObject({ status: "current", accountActive: false });
    } finally {
      await prisma.tenantMembership.update({
        where: { tenantId_userId: { tenantId: fx.tenantId, userId: pharmacistId } },
        data: { isActive: true },
      });
    }
    await expect(qualified(pharmacistId)).resolves.toBe("ok");
  });

  it("sees a revocation that commits while it waits for the registration lock", async () => {
    const row = await record(pharmacistId, "PH-10");
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const revoking = tx(async (c) => {
      await c.pharmacistRegistration.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: fx.ownerId, revocationReason: "Struck off" },
      });
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    const outcome = qualified(pharmacistId);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pharmacist_registration%'`;
      waiting = Number(rows[0]?.count) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await revoking;
    expect(waiting).toBe(true);
    await expect(outcome).resolves.toBe("PHARMACIST_REQUIRED");
  });

  it("sees the new registration when a renewal commits while it waits", async () => {
    const old = await record(pharmacistId, "PH-14", dayKey(5));
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    let renewedId = "";
    const renewing = tx(async (c) => {
      await c.pharmacistRegistration.updateMany({
        where: { id: old.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: fx.ownerId, revocationReason: "Replaced by a newer registration" },
      });
      renewedId = (await c.pharmacistRegistration.create({
        data: { tenantId: fx.tenantId, userId: pharmacistId, slmcNumber: "PH-14", expiresOn: new Date(`${dayKey(400)}T00:00:00Z`),
          recordedByUserId: fx.ownerId },
      })).id;
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    const outcome = tx((c) => registrations.assertQualified(c, { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: pharmacistId }));
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pharmacist_registration%'`;
      waiting = Number(rows[0]?.count) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await renewing;
    expect(waiting).toBe(true);
    await expect(outcome).resolves.toMatchObject({ registrationId: renewedId, slmcNumber: "PH-14" });
  });

  it("makes a revocation wait for a clinical transaction already relying on the registration", async () => {
    const row = await record(pharmacistId, "PH-11");
    let release!: () => void;
    let checked!: () => void;
    const isChecked = new Promise<void>((resolve) => (checked = resolve));
    const clinical = tx(async (c) => {
      await registrations.assertQualified(c, { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: pharmacistId });
      checked();
      await new Promise<void>((resolve) => (release = resolve));
      return "dispensed";
    });
    await isChecked;
    let revoked = false;
    const revoking = registrations.revoke(user(fx.ownerId), fx.mainBranchId, row.id, "Struck off").then(() => (revoked = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(revoked).toBe(false);
    release();
    await expect(clinical).resolves.toBe("dispensed");
    await revoking;
    await expect(qualified(pharmacistId)).resolves.toBe("PHARMACIST_REQUIRED");
  });
});

describe("MandatoryOperationEvidence.clinical", () => {
  const evidence = new MandatoryOperationEvidence(undefined, undefined, registrations);

  it("checks the signed session's staff member", async () => {
    const row = await record(pharmacistId, "PH-12");
    await expect(tx((c) => evidence.clinical(c, command(pharmacistId)))).resolves.toEqual({ registrationId: row.id, slmcNumber: "PH-12" });
    await expect(code(tx((c) => evidence.clinical(c, command(fx.ownerId))))).resolves.toBe("PHARMACIST_REQUIRED");
  });

  it("does not accept co-sign evidence online yet, and fails closed without a provider", async () => {
    await record(pharmacistId, "PH-13");
    await expect(
      code(tx((c) => evidence.clinical(c, command(pharmacistId, { pharmacistEvidenceId: randomUUID() })))),
    ).resolves.toBe("INVALID_COMMAND");
    await expect(code(tx((c) => new MandatoryOperationEvidence().clinical(c, command(pharmacistId))))).resolves.toBe(
      "PHARMACIST_REQUIRED",
    );
  });
});

describe("no clinical bypass through ownership or role administration", () => {
  it("a custom role holding every permission key is still not qualified, and cannot record its own registration", async () => {
    // Migrations seed only migration-added keys; the catalog rows come from the app seed.
    await prisma.permission.createMany({
      skipDuplicates: true,
      data: PERMISSION_KEYS.map((key) => ({ key, module: key.split(".")[0]!, label: key, description: key })),
    });
    const role = await prisma.role.create({
      data: {
        tenantId: fx.tenantId,
        key: `everything-${randomUUID().slice(0, 8)}`,
        name: "Everything",
        permissions: { create: PERMISSION_KEYS.map((permissionKey) => ({ tenantId: fx.tenantId, permissionKey })) },
      },
    });
    const assignment = { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId };
    await prisma.userBranchRole.updateMany({ where: assignment, data: { role: "custom", roleId: role.id } });
    try {
      const live = await tx((c) => access.resolveLive(user(fx.managerId), fx.mainBranchId, c));
      expect(PERMISSION_KEYS.filter((key) => !live.has(key))).toEqual([]);
      await expect(qualified(fx.managerId)).resolves.toBe("PHARMACIST_REQUIRED");
      await expect(code(record(fx.managerId, "SELF-1", dayKey(30), fx.managerId))).resolves.toBe(
        "PHARMACIST_REGISTRATION_OWNER_ONLY",
      );
    } finally {
      await prisma.userBranchRole.updateMany({ where: assignment, data: { role: "manager", roleId: null } });
    }
  });

  it("the operation boundary demands a registration for clinical work even from an owner on a verified counter", async () => {
    class OpenHours extends MandatoryOperationEvidence {
      override async hours() {}
    }
    const signed = command(fx.ownerId, { operation: "POST /api/v1/sales/checkout" });
    // The counter proof itself is covered by terminal-execution.int-spec.ts; this pins the clinical port.
    const verifiedCounter = { verifyCommand: async () => ({ command: signed, digest: "d".repeat(64), attendanceId: randomUUID() }) };
    const boundary = new OperationAuthorizationService(
      access,
      verifiedCounter as never,
      new OpenHours(undefined, undefined, registrations),
      {} as never,
    );
    const checkout = {
      method: "POST" as const,
      routeTemplate: "/api/v1/sales/checkout",
      permission: "sales.pos_use",
      parseBody: (raw: unknown) => object(raw, []),
      resolveFacts: async () => ({ clinicalSale: true, cashMovement: true }),
    };
    const authorize = () =>
      tx((c) =>
        boundary.authorize(c, user(fx.ownerId), fx.mainBranchId, checkout, {
          body: {},
          signedCommand: {},
          attendanceProofId: randomUUID(),
        }),
      );
    await expect(code(authorize())).resolves.toBe("PHARMACIST_REQUIRED");
    const row = await record(fx.ownerId, "OWN-CLIN-1");
    await expect(authorize()).resolves.toMatchObject({ clinical: { registrationId: row.id, slmcNumber: "OWN-CLIN-1" } });
  });
});

describe("controlled checkout co-sign (P1 #47 with P2 #93)", () => {
  const PIN = "4321";
  const stock = new StockService();
  const approval = new PharmacistApprovalService(
    proxy as never,
    audit,
    new PermissionsService(proxy as never, { get: () => 30 } as never),
    registrations,
  );
  const sales = new SalesService(
    proxy as never,
    audit,
    new TaxService({ get: () => "0" } as never),
    approval,
    { assertCanSell: async () => undefined } as never,
    stock,
    undefined,
    undefined,
    registrations,
  );
  let prescriptionId: string;
  let batchId: string;

  beforeAll(async () => {
    await prisma.product.update({ where: { id: fx.productId }, data: { isControlled: true, requiresPrescription: true } });
    await prisma.userBranchRole.create({
      data: { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "cashier" },
    });
    const posPinHash = await bcrypt.hash(PIN, 4);
    await prisma.appUser.updateMany({ where: { id: { in: [pharmacistId, secondPharmacistId] } }, data: { posPinHash } });
    prescriptionId = (
      await prisma.prescription.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          rxNumber: `RX-IT-${randomUUID().slice(0, 6)}`,
          patientName: "Kamal Silva",
          doctorName: "Perera",
          issuedOn: new Date(`${dayKey(-1)}T00:00:00Z`),
          createdBy: fx.ownerId,
        },
      })
    ).id;
    batchId = await createStockedBatch(prisma, stock, fx, { qty: 50 });
  });

  const sell = (approverUserId = pharmacistId) =>
    sales.checkout(
      fx.tenantId,
      fx.mainBranchId,
      fx.clerkId,
      [{ branchId: fx.mainBranchId, role: "cashier" }],
      {
        items: [{ productId: fx.productId, batchId, qty: 1, unitPrice: "15.00" }],
        prescriptionId,
        pharmacistApproval: { approverUserId, pin: PIN },
      },
      randomUUID(),
    );
  const soldByClerk = () => prisma.sale.count({ where: { tenantId: fx.tenantId, soldBy: fx.clerkId } });
  const onHand = async () => (await prisma.batchStock.findUniqueOrThrow({ where: { batchId } })).onHandQty;
  const listed = async () => (await approval.listApprovers(fx.tenantId, fx.mainBranchId)).map((a) => a.id);

  it("refuses a co-signer with no registration, an expired one or a revoked one, and sells nothing", async () => {
    const [salesBefore, stockBefore] = [await soldByClerk(), await onHand()];
    // A correct PIN and the approval permission are not enough on their own.
    await expect(code(sell())).resolves.toBe("APPROVER_NOT_QUALIFIED");
    await expect(listed()).resolves.toEqual([]);

    await prisma.pharmacistRegistration.create({
      data: { tenantId: fx.tenantId, userId: pharmacistId, slmcNumber: "OLD-CS-1", expiresOn: new Date(`${dayKey(-1)}T00:00:00Z`),
        recordedByUserId: fx.ownerId, recordedAt: new Date(Date.now() - 86_400_000 * 30) },
    });
    await expect(code(sell())).resolves.toBe("APPROVER_NOT_QUALIFIED");
    await expect(listed()).resolves.toEqual([]);

    await clear();
    const row = await record(pharmacistId, "PH-CS-2");
    await registrations.revoke(user(fx.ownerId), fx.mainBranchId, row.id, "Suspended");
    await expect(sell()).rejects.toMatchObject({
      status: 403,
      response: { code: "APPROVER_NOT_QUALIFIED", message: expect.stringContaining("pharmacist has no current SLMC registration") },
    });
    await expect(listed()).resolves.toEqual([]);

    expect(await soldByClerk()).toBe(salesBefore);
    expect(await onHand()).toBe(stockBefore);
  });

  it("accepts a registered co-signer and keeps the registration it relied on with the sale", async () => {
    const row = await record(pharmacistId, "PH-CS-3");
    // Only the registered pharmacist is offered: not the unregistered one, not the owner.
    await expect(listed()).resolves.toEqual([pharmacistId]);
    await expect(code(sell(secondPharmacistId))).resolves.toBe("APPROVER_NOT_QUALIFIED");

    const sale = await sell();
    const stored = await prisma.sale.findUniqueOrThrow({ where: { id: sale!.id } });
    expect(stored).toMatchObject({ soldBy: fx.clerkId, dispensedBy: pharmacistId, dispenserRegistrationId: row.id });
    const approved = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "sale.pharmacist_approved", entityId: sale!.id },
    });
    expect(approved.actorUserId).toBe(pharmacistId);
    expect(approved.payload).toMatchObject({ pharmacistRegistrationId: row.id, slmcNumber: "PH-CS-3" });
  });

  it("waits for a revocation in progress and is refused once it commits", async () => {
    const row = await record(pharmacistId, "PH-CS-4");
    const salesBefore = await soldByClerk();
    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const revoking = tx(async (c) => {
      await c.pharmacistRegistration.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: fx.ownerId, revocationReason: "Struck off" },
      });
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await isLocked;
    const outcome = code(sell());
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`SELECT count(*) AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pharmacist_registration%'`;
      waiting = Number(rows[0]?.count) > 0;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await revoking;
    expect(waiting).toBe(true);
    await expect(outcome).resolves.toBe("APPROVER_NOT_QUALIFIED");
    expect(await soldByClerk()).toBe(salesBefore);
  });

  it("pins a sale's registration to its dispenser in the database", async () => {
    const mine = await record(pharmacistId, "PH-CS-5");
    const theirs = await record(secondPharmacistId, "PH-CS-6");
    const sale = await sell();
    await expect(
      prisma.$executeRaw`UPDATE sale SET dispenser_registration_id = ${theirs.id}::uuid WHERE id = ${sale!.id}::uuid`,
    ).rejects.toThrow(/sale_tenant_id_dispensed_by_dispenser_registration_id_fkey/);
    await expect(
      prisma.$executeRaw`UPDATE sale SET dispensed_by = NULL WHERE id = ${sale!.id}::uuid`,
    ).rejects.toThrow(/sale_dispenser_registration_check/);
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale!.id } })).dispenserRegistrationId).toBe(mine.id);
  });
});
