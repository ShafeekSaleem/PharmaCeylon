import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type {
  BranchHours,
  OfflineBusinessHoursAcknowledgement,
  OnlineTerminalCommand,
  TerminalEnrollmentCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { MandatoryOperationEvidence } from "../../src/security/mandatory-operation-evidence";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

/** P1 #47 / revised D8: real operating-hours evidence and after-hours acknowledgement records. */
const prisma = createPrisma();
const proxy = createTenantAwarePrismaProxy(prisma);
const audit = new AuditService(proxy as never);
const access = new AccessService(proxy as never, {} as never);

class FixtureAttendance extends LocalAttendanceVerifier {
  readonly proofs = new Map<string, AttendanceExpectation>();
  allow(p: TerminalEnrollmentCommand) {
    const id = randomUUID();
    this.proofs.set(id, {
      purpose: "enrollment",
      identity: p.identity,
      actorUserId: p.requestedByUserId,
      registerId: p.registerId,
      tillId: p.tillId,
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
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const acknowledgements = new BusinessHoursAcknowledgements(access, audit);

let fx: TenantFixture;
const user = (userId: string): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion: 0,
  branchRoles: [],
  email: "hours@it.test",
  fullName: "Hours",
  authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

const nineToSix = { mode: "hours", ranges: [{ opens: "09:00", closes: "18:00" }] } as const;
const weekly: BranchHours = {
  schemaVersion: 1,
  weekly: { mon: nineToSix, tue: nineToSix, wed: nineToSix, thu: nineToSix, fri: nineToSix, sat: nineToSix, sun: { mode: "closed" } },
  exceptions: [
    { date: "2026-11-24", label: "Il Full Moon Poya Day", hours: { mode: "closed" }, source: "holiday_suggestion", holidayKey: "lk:2026-11-24" },
  ],
  mandatory: [{ day: "mon", opens: "08:00", closes: "22:00" }, { day: "tue", opens: "08:00", closes: "22:00" }],
};
const at = (local: string) => new Date(`${local}:00+05:30`); // Asia/Colombo
async function setHours(hours: BranchHours | null) {
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: { operatingHours: (hours ?? Prisma.DbNull) as never, operatingHoursOrigin: hours ? "editor" : null },
  });
}

class FixedClockHours extends OperatingHoursEvidence {
  constructor(private readonly clock: Date) {
    super();
  }
  protected override now() {
    return this.clock;
  }
}
/** The port exactly as OperationAuthorizationService calls it, with the real provider installed. */
const hoursPort = (when: string) => new MandatoryOperationEvidence(new FixedClockHours(at(when)));
const sellingCommand = (overrides: Partial<OnlineTerminalCommand<unknown>> = {}) =>
  ({
    operation: "POST /api/v1/sales/checkout",
    identity: { tenantId: fx.tenantId, branchId: fx.mainBranchId, terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: "k" },
    operatingHoursExceptionId: null,
    ...overrides,
  }) as OnlineTerminalCommand<unknown>;
const outcome = (when: string, command = sellingCommand()) =>
  tx((c) => hoursPort(when).hours(c, command)).then(
    () => "allowed",
    (e: { response?: { code?: string } }) => e.response?.code ?? String(e),
  );

beforeAll(async () => {
  fx = await createTenant(prisma, "hours-evidence");
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "cashier" },
    ],
  });
});
afterAll(() => prisma.$disconnect());

describe("operating-hours evidence provider", () => {
  it("fails closed while the branch has no structured hours", async () => {
    await setHours(null);
    await expect(outcome("2026-10-26T10:00")).resolves.toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("allows selling inside the routine schedule and refuses outside it", async () => {
    await setHours(weekly);
    await expect(outcome("2026-10-26T10:00")).resolves.toBe("allowed");
    await expect(outcome("2026-10-26T19:00")).resolves.toBe("BUSINESS_HOURS_ACK_REQUIRED");
  });

  it("applies a confirmed gazette holiday exception", async () => {
    await setHours(weekly);
    await expect(outcome("2026-11-24T10:00")).resolves.toBe("BUSINESS_HOURS_ACK_REQUIRED");
  });

  it("counts an approved business extension, but never a revoked one or one past the mandatory limit", async () => {
    await setHours(weekly);
    const extension = await prisma.branchHoursExtension.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        startsAt: at("2026-10-27T18:00"),
        endsAt: at("2026-10-27T23:00"),
        reason: "Late delivery",
        approvedByUserId: fx.ownerId,
        approvedAt: at("2026-10-27T12:00"),
      },
    });
    await expect(outcome("2026-10-27T19:00")).resolves.toBe("allowed");
    await expect(outcome("2026-10-27T22:30")).resolves.toBe("OUTSIDE_OPERATING_HOURS");
    await prisma.branchHoursExtension.update({
      where: { id: extension.id },
      data: { revokedAt: at("2026-10-27T12:30"), revokedByUserId: fx.ownerId, revocationReason: "Cancelled" },
    });
    await expect(outcome("2026-10-27T19:00")).resolves.toBe("BUSINESS_HOURS_ACK_REQUIRED");
  });

  it("treats a branch-wide no-selling limit as a hard refusal", async () => {
    await setHours({ ...weekly, mandatory: [] });
    await expect(outcome("2026-10-26T10:00")).resolves.toBe("OUTSIDE_OPERATING_HOURS");
  });

  it("does not hours-restrict back-room stock posting", async () => {
    await setHours(null);
    await expect(
      outcome("2026-10-26T23:30", sellingCommand({ operation: "POST /api/v1/stocktakes/:id/post" })),
    ).resolves.toBe("allowed");
  });

  it("refuses another tenant's branch identity as unknown hours", async () => {
    await setHours(weekly);
    const other = await createTenant(prisma, "hours-foreign");
    await expect(
      outcome("2026-10-26T10:00", sellingCommand({
        identity: { tenantId: other.tenantId, branchId: fx.mainBranchId, terminalId: randomUUID(), enrollmentId: randomUUID(), keyId: "k" },
      })),
    ).resolves.toBe("TEMPORARILY_UNAVAILABLE");
  });
});

describe("D8 after-hours acknowledgement records", () => {
  async function enrolledDevice() {
    const owner = user(fx.ownerId);
    const device = terminalDevice();
    const counter = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, `Counter ${randomUUID().slice(0, 6)}`));
    const enrollment = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counter.id,
        label: "Desk",
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
      }),
    );
    const identity = await tx((c) =>
      trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment)),
    );
    return { device, identity };
  }
  const now = Date.now();
  const acknowledgement = (
    identity: OfflineBusinessHoursAcknowledgement["identity"],
    overrides: Partial<OfflineBusinessHoursAcknowledgement> = {},
  ): OfflineBusinessHoursAcknowledgement => ({
    contractVersion: 1,
    kind: "business_hours_acknowledgement",
    recordId: randomUUID(),
    identity,
    grantId: randomUUID(),
    grantVersion: 3,
    nominationVersion: 1,
    offlineSessionId: randomUUID(),
    managerSignInId: randomUUID(),
    recordedAt: now - 60_000,
    startsAt: now - 60_000,
    endsAt: now + 2 * 60 * 60_000,
    reason: "Queue at closing time",
    ...overrides,
  });
  const record = (raw: unknown, who = fx.clerkId, branchId = fx.mainBranchId) =>
    tx((c) => acknowledgements.record(c, user(who), branchId, raw, now));
  const code = (promise: Promise<unknown>) =>
    promise.then(() => "recorded", (e: { response?: { code?: string } }) => e.response?.code ?? String(e));

  it("persists the signed envelope and digest as held evidence, and replays identical uploads", async () => {
    const { device, identity } = await enrolledDevice();
    const payload = acknowledgement(identity);
    const signed = device.sign(payload, identity.keyId);
    const first = await record(signed);
    expect(first).toMatchObject({ recordId: payload.recordId, status: "held", heldReason: "grant_unverified", replayed: false });
    expect(first.recordHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await record(JSON.parse(JSON.stringify(signed)));
    expect(again).toEqual({ ...first, replayed: true });
    const rows = await prisma.businessHoursAcknowledgement.findMany({ where: { tenantId: fx.tenantId, recordId: payload.recordId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ recordHash: first.recordHash, receivedByUserId: fx.clerkId, reason: payload.reason });
    expect(rows[0]!.envelope).toEqual(signed);
    expect(await prisma.auditEvent.count({ where: { tenantId: fx.tenantId, entityId: rows[0]!.id } })).toBe(1);
  });

  it("refuses a replayed record ID with different content", async () => {
    const { device, identity } = await enrolledDevice();
    const payload = acknowledgement(identity);
    await record(device.sign(payload, identity.keyId));
    await expect(code(record(device.sign({ ...payload, endsAt: payload.endsAt + 60_000 }, identity.keyId)))).resolves.toBe("REPLAY_CONFLICT");
  });

  it("serializes concurrent identical uploads into one record", async () => {
    const { device, identity } = await enrolledDevice();
    const signed = device.sign(acknowledgement(identity), identity.keyId);
    const results = await Promise.all([record(signed), record(signed), record(signed)]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.businessHoursAcknowledgement.count({ where: { recordId: signed.payload.recordId } })).toBe(1);
  });

  it("rejects another device's signature, a wrong branch and an untrusted clock", async () => {
    const { device, identity } = await enrolledDevice();
    const other = terminalDevice();
    await expect(code(record(other.sign(acknowledgement(identity), identity.keyId)))).resolves.toBe("INVALID_SIGNATURE");
    await expect(code(record(device.sign(acknowledgement(identity), identity.keyId), fx.clerkId, fx.otherBranchId))).resolves.toBe("IDENTITY_MISMATCH");
    const future = now + 60 * 60_000;
    await expect(
      code(record(device.sign(acknowledgement(identity, { recordedAt: future, startsAt: future, endsAt: future + 60_000 }), identity.keyId))),
    ).resolves.toBe("CLOCK_UNTRUSTED");
    await expect(
      code(record(device.sign(acknowledgement(identity, { endsAt: now + 25 * 60 * 60_000 }), identity.keyId))),
    ).resolves.toBe("INVALID_COMMAND");
    expect(await prisma.businessHoursAcknowledgement.count({ where: { enrollmentId: identity.enrollmentId } })).toBe(0);
  });

  it("retains a revoked device's upload for reconciliation, still held", async () => {
    const { device, identity } = await enrolledDevice();
    await tx((c) => trust.revokeEnrollment(c, user(fx.ownerId), fx.mainBranchId, identity.enrollmentId, "Lost"));
    await expect(record(device.sign(acknowledgement(identity), identity.keyId))).resolves.toMatchObject({
      status: "held",
      heldReason: "enrollment_revoked",
    });
  });

  it("keeps signed content immutable and the verification outcome final", async () => {
    const { device, identity } = await enrolledDevice();
    const payload = acknowledgement(identity);
    await record(device.sign(payload, identity.keyId));
    const row = await prisma.businessHoursAcknowledgement.findFirstOrThrow({ where: { recordId: payload.recordId } });
    await expect(prisma.businessHoursAcknowledgement.update({ where: { id: row.id }, data: { reason: "Edited" } })).rejects.toThrow(/immutable/);
    await expect(prisma.businessHoursAcknowledgement.delete({ where: { id: row.id } })).rejects.toThrow(/retained/);
    await prisma.businessHoursAcknowledgement.update({
      where: { id: row.id },
      data: { status: "accepted", heldReason: null, verifiedAt: new Date() },
    });
    await expect(
      prisma.businessHoursAcknowledgement.update({ where: { id: row.id }, data: { status: "rejected" } }),
    ).rejects.toThrow(/immutable/);
  });
});
