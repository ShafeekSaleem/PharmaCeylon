import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Prisma, RoleName } from "@prisma/client";
import {
  defaultCounterPolicy,
  type BranchHours,
  type ExternalCardAttemptRecord,
  type LocalAttendanceAttestation,
  type OfflineBusinessHoursAcknowledgement,
  type OfflineGrant,
  type OfflineSaleIncident,
  type OfflineStaffSignIn,
  type OnlineTerminalCommand,
  type TerminalEnrollmentCommand,
  type TerminalIdentity,
  type TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { BusinessHoursAcknowledgements } from "../../src/terminals/business-hours-acknowledgements.service";
import { HeldEvidenceVerifier } from "../../src/terminals/held-evidence-verifier.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import {
  OfflineActivationClearance,
  OfflineActivationService,
} from "../../src/terminals/offline-activation.service";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { emptyJournalState, issueOfflineAuthority } from "../../src/terminals/offline-authority-issuance";
import { OfflineSupportRecords } from "../../src/terminals/offline-support-records.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/**
 * P3 #49: held offline evidence verified against grants issued through `issueOfflineAuthority`,
 * and P3's half of D11 replacement clearance, against PostgreSQL.
 */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const assignments = new OfflineAssignmentService(prisma as never, access, audit);
const activation = new OfflineActivationService(
  prisma as never, trust, assignments, new OfflineActivationClearance(), audit,
);
const support = new OfflineSupportRecords(access, audit, new BusinessHoursAcknowledgements(access, audit));
const verifier = new HeldEvidenceVerifier(access, audit);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

const server = generateKeyPairSync("ed25519");
const signer = { keyId: "held-evidence-it", privateKey: server.privateKey };
type Device = ReturnType<typeof terminalDevice>;
type Counter = { device: Device; identity: TerminalIdentity; grant: OfflineGrant };

let fx: TenantFixture;
let owner: RequestUser;
let manager: RequestUser;
let cashier: RequestUser;

function user(userId: string): RequestUser {
  return {
    userId, tenantId: fx.tenantId, tokenVersion: 0, email: "t@example.test",
    fullName: "T", authMethod: "bearer", branchRoles: [],
  };
}

function attest(
  challenge: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
  purpose: LocalAttendanceAttestation["purpose"],
  actor: RequestUser,
): LocalAttendanceAttestation {
  const counter = challenge.kind === "terminal_enrollment"
    ? { registerId: challenge.registerId, tillId: challenge.tillId }
    : { registerId: challenge.session.registerId, tillId: challenge.session.tillId };
  return {
    contractVersion: 1, kind: "local_attendance", proofId: randomUUID(), purpose,
    identity: challenge.identity, actorUserId: actor.userId, ...counter,
    payloadDigest: sha256(boundedCanonical(challenge)),
    windowsSession: { sessionId: 1, protocol: "console", remoteSession: false },
    appVersion: "0.0.1", observedAt: Date.now(),
  };
}
const proof = (device: Device, a: LocalAttendanceAttestation, actor: RequestUser) =>
  proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));

async function enroll() {
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, `Counter ${randomUUID().slice(0, 4)}`));
  const challenge = await tx((c) => trust.beginEnrollment(c, owner, fx.mainBranchId, {
    registerId: counter.id, keyId: randomUUID(), publicKeyHex: device.publicKeyHex, label: "PC",
  }));
  const p = await proof(device, attest(challenge, "enrollment", owner), owner);
  const identity = await tx((c) => trust.finishEnrollment(
    c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), p.proofId,
  ));
  return { device, identity };
}

/** The branch's first offline counter, through a real revised-D13 activation. */
async function firstNomination() {
  const { device, identity } = await enroll();
  const challenge = await tx((c) => trust.beginSession(c, manager, fx.mainBranchId, identity));
  const p = await proof(device, attest(challenge, "session", manager), manager);
  const { workSessionId } = await tx((c) => trust.finishSession(
    c, manager, fx.mainBranchId, device.sign(challenge, identity.keyId), p.proofId,
  ));
  const authorizationId = randomUUID();
  await assignments.authorize(owner, fx.mainBranchId, {
    authorizationId, targetTerminalId: identity.terminalId, targetEnrollmentId: identity.enrollmentId,
    expectedNominationVersion: 0, reason: "Front counter keeps selling during outages",
  });
  const command = await activation.prepare(manager, fx.mainBranchId, {
    workSessionId, authorizationId, expectedNominationVersion: 0,
  });
  const ap = await proof(device, attest(command, "command", manager), manager);
  await activation.activate(manager, fx.mainBranchId, {
    envelope: device.sign(command, identity.keyId), attendanceProofId: ap.proofId,
  });
  return { device, identity };
}

/** Later counters: replacement waits on D11, so tests point the nomination row at them directly. */
async function nominateDirectly() {
  const { device, identity } = await enroll();
  const current = await prisma.offlineTerminalNomination.findFirstOrThrow({
    where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
  });
  await prisma.offlineTerminalNomination.update({
    where: { id: current.id },
    data: {
      terminalId: identity.terminalId, enrollmentId: identity.enrollmentId,
      keyId: identity.keyId, version: current.version + 1,
    },
  });
  return { device, identity };
}

/** Prepares a personal PIN on this counter, as signing in there once online does. */
async function prepare(identity: TerminalIdentity, staffUserId: string) {
  await prisma.appUser.update({ where: { id: staffUserId }, data: { posPinHash: "prepared-in-test", posPinVersion: 1 } });
  await prisma.terminalStaffPreparation.create({
    data: {
      tenantId: identity.tenantId, branchId: identity.branchId, terminalId: identity.terminalId,
      enrollmentId: identity.enrollmentId, keyId: identity.keyId, staffUserId, pinVersion: 1,
    },
  });
}

/** A nominated counter with the manager and the cashier prepared, and its issued grant. */
async function grantedCounter(first = false): Promise<Counter> {
  const { device, identity } = first ? await firstNomination() : await nominateDirectly();
  await prepare(identity, manager.userId);
  await prepare(identity, cashier.userId);
  const { grant } = await issueOfflineAuthority(prisma as never, access, {
    signer,
    defaultVatRatePercent: 18,
    // Command signing and attendance are covered in terminal-execution; this is what follows.
    authenticate: async () => ({ identity, commandId: randomUUID() }),
    readState: emptyJournalState,
  });
  return { device, identity, grant: grant.payload };
}

const hours = (opens: string, closes: string) => ({ mode: "hours" as const, ranges: [{ opens, closes }] });
const allWeek = (day: BranchHours["weekly"]["mon"]) =>
  ({ mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day });
const setHours = (mandatory: BranchHours["mandatory"]) =>
  prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: {
      operatingHours: { schemaVersion: 1, weekly: allWeek(hours("08:00", "22:00")), exceptions: [], mandatory } as unknown as Prisma.InputJsonValue,
      operatingHoursOrigin: "editor",
    },
  });

function signIn(counter: Counter, staffUserId: string, overrides: Partial<OfflineStaffSignIn> = {}): OfflineStaffSignIn {
  const { grant } = counter;
  const staff = grant.authorizedStaff.find((s) => s.staffUserId === staffUserId);
  return {
    contractVersion: 1, kind: "offline_staff_sign_in", staffSignInId: randomUUID(),
    identity: counter.identity,
    session: { registerId: grant.registerId, tillId: grant.tillId, workSessionId: randomUUID(), staffUserId },
    grantId: grant.grantId, grantVersion: grant.grantVersion,
    staffAuthorizationId: staff?.staffAuthorizationId ?? randomUUID(),
    credentialVersion: staff?.credentialVersion ?? 1,
    method: "personal_pin", authenticatedAt: grant.issuedAt + 1_000,
    ...overrides,
  };
}

/** A held acknowledgement uploaded through P1's intake, plus the evidence P5 would hand over. */
async function heldAcknowledgement(
  counter: Counter,
  manager: OfflineStaffSignIn,
  overrides: Partial<OfflineBusinessHoursAcknowledgement> = {},
) {
  const { grant } = counter;
  const outage = { offlineSessionId: randomUUID(), offlineStartedAt: grant.issuedAt + 2_000 };
  const recordedAt = grant.issuedAt + 3_000;
  const ack: OfflineBusinessHoursAcknowledgement = {
    contractVersion: 1, kind: "business_hours_acknowledgement", recordId: randomUUID(),
    identity: counter.identity, grantId: grant.grantId, grantVersion: grant.grantVersion,
    nominationVersion: grant.nominationVersion, offlineSessionId: outage.offlineSessionId,
    managerSignInId: manager.staffSignInId, recordedAt,
    startsAt: recordedAt + 1_000, endsAt: recordedAt + 3_600_000,
    reason: "Late delivery of insulin, staying open for collection",
    ...overrides,
  };
  const receipt = await tx((c) => support.record(
    c, cashier, fx.mainBranchId, counter.device.sign(ack, counter.identity.keyId), grant.issuedAt + 60_000,
  ));
  expect(receipt).toMatchObject({ status: "held", heldReason: "grant_unverified" });
  return { ack, outage, managerSignIn: manager };
}

const verifyAck = (
  identity: TerminalIdentity,
  held: { ack: OfflineBusinessHoursAcknowledgement; outage: unknown; managerSignIn: unknown },
) =>
  tx((c) => verifier.verifyHoursAcknowledgement(c, cashier, fx.mainBranchId, {
    enrollmentId: identity.enrollmentId, recordId: held.ack.recordId,
    managerSignIn: held.managerSignIn, outage: held.outage,
  }));
const storedAck = (recordId: string) =>
  prisma.businessHoursAcknowledgement.findFirstOrThrow({
    where: { tenantId: fx.tenantId, recordId }, select: { status: true, heldReason: true, verifiedAt: true },
  });

beforeAll(async () => {
  fx = await createTenant(prisma, "held-evidence");
  owner = user(fx.ownerId);
  manager = user(fx.managerId);
  cashier = user(fx.clerkId);
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
    ],
  });
  await prisma.branch.update({
    where: { id: fx.mainBranchId },
    data: { counterPolicy: { ...defaultCounterPolicy(), offlineEnabled: true } as unknown as Prisma.InputJsonValue },
  });
  await setHours(null);
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("D8 acknowledgements against the issued grant", () => {
  let a: Counter;
  let b: Counter;

  beforeAll(async () => {
    a = await grantedCounter(true);
    b = await grantedCounter();
  });

  it("signs the manager's capability and credential version into the grant", () => {
    expect(a.grant.authorizedStaff).toEqual(expect.arrayContaining([
      expect.objectContaining({ staffUserId: manager.userId, credentialVersion: 1, offlineManagerActions: expect.arrayContaining(["acknowledge_business_hours"]) }),
      expect.objectContaining({ staffUserId: cashier.userId, offlineManagerActions: [] }),
    ]));
  });

  it("accepts an acknowledgement bound to the issued grant, its manager and the outage, once", async () => {
    const held = await heldAcknowledgement(a, signIn(a, manager.userId));
    await expect(verifyAck(a.identity, held)).resolves.toEqual({
      recordId: held.ack.recordId, status: "accepted", reason: null, decided: true,
    });
    expect(await storedAck(held.ack.recordId)).toMatchObject({ status: "accepted", heldReason: null, verifiedAt: expect.any(Date) });

    // Decided is decided: another verification, even with other evidence, returns what is stored.
    await expect(verifyAck(a.identity, { ...held, managerSignIn: signIn(a, cashier.userId) }))
      .resolves.toMatchObject({ status: "accepted", decided: false });
    await expect(prisma.businessHoursAcknowledgement.updateMany({
      where: { tenantId: fx.tenantId, recordId: held.ack.recordId }, data: { status: "rejected" },
    })).rejects.toThrow(/immutable/);
    const events = await prisma.auditEvent.findMany({
      where: { tenantId: fx.tenantId, eventName: "terminal.hours_acknowledgement_accepted" },
    });
    expect(events).toHaveLength(1);
  });

  it.each([
    ["an unknown grant", () => ({ grantId: randomUUID() }), "grant_not_issued"],
    ["another enrollment's grant", () => ({ grantId: b.grant.grantId, grantVersion: b.grant.grantVersion }), "grant_not_issued"],
    ["another grant version", () => ({ grantVersion: a.grant.grantVersion + 1 }), "grant_binding_mismatch"],
    ["another nomination version", () => ({ nominationVersion: a.grant.nominationVersion + 1 }), "grant_binding_mismatch"],
    ["a window past the grant's expiry", () => ({
      startsAt: a.grant.expiresAt - 1_800_000, endsAt: a.grant.expiresAt + 1_800_000,
    }), "outside_grant_window"],
  ] as const)("rejects an acknowledgement citing %s", async (_case, overrides, reason) => {
    const held = await heldAcknowledgement(a, signIn(a, manager.userId), overrides());
    await expect(verifyAck(a.identity, held)).resolves.toMatchObject({ status: "rejected", reason, decided: true });
    expect(await storedAck(held.ack.recordId)).toMatchObject({ status: "rejected", heldReason: reason });
  });

  it.each([
    ["the owner, who was not prepared on this counter", () => signIn(a, owner.userId), "staff_not_prepared"],
    ["the cashier, prepared without the capability", () => signIn(a, cashier.userId), "manager_lacks_capability"],
    ["another PIN version", () => signIn(a, manager.userId, { credentialVersion: 2 }), "credential_version_mismatch"],
    ["another preparation", () => signIn(a, manager.userId, { staffAuthorizationId: randomUUID() }), "credential_version_mismatch"],
    ["another counter's sign-in", () => signIn(a, manager.userId, { identity: b.identity }), "sign_in_mismatch"],
    ["a sign-in before the grant began", () => signIn(a, manager.userId, { authenticatedAt: a.grant.issuedAt - 1 }), "outside_grant_window"],
  ] as const)("rejects an acknowledgement by %s", async (_case, managerSignIn, reason) => {
    const held = await heldAcknowledgement(a, managerSignIn());
    await expect(verifyAck(a.identity, held)).resolves.toMatchObject({ status: "rejected", reason });
  });

  it("rejects an acknowledgement not bound to the original outage", async () => {
    const held = await heldAcknowledgement(a, signIn(a, manager.userId));
    await expect(verifyAck(a.identity, { ...held, outage: { ...held.outage, offlineSessionId: randomUUID() } }))
      .resolves.toMatchObject({ status: "rejected", reason: "outage_mismatch" });
  });

  it("refuses malformed evidence and a record of another branch without deciding anything", async () => {
    const held = await heldAcknowledgement(a, signIn(a, manager.userId));
    await expect(verifyAck(a.identity, { ...held, managerSignIn: { ...held.managerSignIn, extra: 1 } }))
      .rejects.toMatchObject({ response: { code: "INVALID_COMMAND" } });
    await expect(tx((c) => verifier.verifyHoursAcknowledgement(c, owner, fx.otherBranchId, {
      enrollmentId: a.identity.enrollmentId, recordId: held.ack.recordId,
      managerSignIn: held.managerSignIn, outage: held.outage,
    }))).rejects.toBeDefined();
    expect(await storedAck(held.ack.recordId)).toMatchObject({ status: "held", verifiedAt: null });
  });
});

describe("mandatory windows are never overridden", () => {
  let c: Counter;

  beforeAll(async () => {
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
    await setHours(days.map((day) => ({ day, opens: "06:00", closes: "23:00" })));
    try {
      c = await grantedCounter();
    } finally {
      await setHours(null);
    }
    expect(c.grant.mandatoryOperatingWindows?.length).toBeGreaterThan(0);
  });

  /** The first mandatory window still open at, or after, issuance. */
  const firstMandatory = () => c.grant.mandatoryOperatingWindows!.find((w) => w.endsAt > c.grant.issuedAt + 120_000)!;

  it("accepts after-hours time inside the mandatory limit", async () => {
    const w = firstMandatory();
    const endsAt = w.endsAt;
    const startsAt = Math.max(c.grant.issuedAt + 4_000, endsAt - 1_800_000);
    const held = await heldAcknowledgement(c, signIn(c, manager.userId), { startsAt, endsAt });
    await expect(verifyAck(c.identity, held)).resolves.toMatchObject({ status: "accepted" });
  });

  it("rejects an acknowledgement reaching past the mandatory limit", async () => {
    const w = firstMandatory();
    const held = await heldAcknowledgement(c, signIn(c, manager.userId), {
      startsAt: Math.max(c.grant.issuedAt + 4_000, w.endsAt - 900_000), endsAt: w.endsAt + 900_000,
    });
    await expect(verifyAck(c.identity, held))
      .resolves.toMatchObject({ status: "rejected", reason: "mandatory_window_overridden" });
  });
});

describe("support records against the issued grant", () => {
  let d: Counter;
  const counts = () => Promise.all([
    prisma.sale.count({ where: { tenantId: fx.tenantId } }),
    prisma.salePayment.count({ where: { tenantId: fx.tenantId } }),
    prisma.stockLedger.count({ where: { tenantId: fx.tenantId } }),
    prisma.goodsReturn.count({ where: { tenantId: fx.tenantId } }),
  ]);

  beforeAll(async () => {
    d = await grantedCounter();
  });

  async function upload(counter: Counter, record: OfflineSaleIncident | ExternalCardAttemptRecord) {
    return tx((c) => support.record(
      c, cashier, fx.mainBranchId, counter.device.sign(record, counter.identity.keyId), counter.grant.issuedAt + 60_000,
    ));
  }
  const incident = (staff: OfflineStaffSignIn, overrides: Partial<OfflineSaleIncident> = {}): OfflineSaleIncident => ({
    contractVersion: 1, kind: "sale_incident", recordId: randomUUID(), identity: d.identity,
    saleCommandId: randomUUID(), recordedByUserId: staff.session.staffUserId,
    staffSignInId: staff.staffSignInId, workSessionId: staff.session.workSessionId,
    recordedAt: d.grant.issuedAt + 5_000, category: "quantity_error",
    description: "Handed over two units, three were entered", ...overrides,
  });
  const verify = (recordId: string, staffSignIn: OfflineStaffSignIn, counter = d) =>
    tx((c) => verifier.verifySupportRecord(c, cashier, fx.mainBranchId, {
      enrollmentId: counter.identity.enrollmentId, recordId, staffSignIn,
    }));

  it("keeps a record whose sign-in the grant backs held for P5, with no business effect", async () => {
    const before = await counts();
    const staff = signIn(d, cashier.userId);
    const note = incident(staff);
    await upload(d, note);
    const card: ExternalCardAttemptRecord = {
      contractVersion: 1, kind: "external_card_attempt", recordId: randomUUID(), identity: d.identity,
      attemptId: randomUUID(), checkoutDraftId: randomUUID(), reviewedSaleDigest: sha256(randomUUID()),
      amountMinor: 245_000, staffSignInId: staff.staffSignInId, workSessionId: staff.session.workSessionId,
      recordedAt: d.grant.issuedAt + 6_000, state: "declined", providerReference: "RRN 610012345678",
      verifiedByUserId: manager.userId,
    };
    await upload(d, card);

    await expect(verify(note.recordId, staff)).resolves.toEqual({
      recordId: note.recordId, status: "held", reason: "sale_unverified", decided: false,
    });
    await expect(verify(card.recordId, staff)).resolves.toMatchObject({ status: "held", reason: "payment_unverified" });
    expect(await counts()).toEqual(before);
  });

  it.each([
    ["names someone the grant did not authorize", (s: OfflineStaffSignIn) => ({ note: { recordedByUserId: owner.userId }, s }), "staff_not_prepared"],
    ["cites another work session", (s: OfflineStaffSignIn) => ({ note: { workSessionId: randomUUID() }, s }), "work_session_mismatch"],
    ["was recorded before its sign-in", (s: OfflineStaffSignIn) => ({ note: { recordedAt: s.authenticatedAt - 1 }, s }), "outside_grant_window"],
    ["cites a grant this counter was never issued", (s: OfflineStaffSignIn) => ({ note: {}, s: { ...s, grantId: randomUUID() } }), "grant_not_issued"],
    ["cites a stale PIN version", (s: OfflineStaffSignIn) => ({ note: {}, s: { ...s, credentialVersion: 2 } }), "credential_version_mismatch"],
  ] as const)("rejects a record that %s", async (_case, build, reason) => {
    const staff = signIn(d, cashier.userId);
    const { note, s } = build(staff);
    const record = incident(staff, note);
    await upload(d, record);
    await expect(verify(record.recordId, s)).resolves.toMatchObject({ status: "rejected", reason, decided: true });
    const stored = await prisma.offlineSupportRecord.findFirstOrThrow({ where: { tenantId: fx.tenantId, recordId: record.recordId } });
    expect(stored).toMatchObject({ status: "rejected", heldReason: reason });
    await expect(verify(record.recordId, staff)).resolves.toMatchObject({ status: "rejected", decided: false });
  });
});

describe("D11: P3's authority cutoff", () => {
  class P5Supplied extends OfflineActivationClearance {
    protected override async journalRecoveryEvidence() {
      return true;
    }
  }
  const clearance = new OfflineActivationClearance();
  const check = (at: number, provider: OfflineActivationClearance = clearance) =>
    tx(async (c) => {
      const previous = await c.offlineTerminalNomination.findFirstOrThrow({
        where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      });
      return provider.check(c, previous, at);
    });
  let e: Counter;

  beforeAll(async () => {
    e = await grantedCounter();
  });

  it("stays closed while the old counter's latest grant can still sell", async () => {
    await expect(check(e.grant.expiresAt - 1)).resolves.toMatchObject({
      cleared: false, reason: "PREVIOUS_STILL_ACTIVE",
      cutoff: { kind: "grants_expire", at: e.grant.expiresAt },
    });
    // Even with P5's half, the cutoff comes first.
    await expect(check(e.grant.expiresAt - 1, new P5Supplied())).resolves.toMatchObject({
      cleared: false, reason: "PREVIOUS_STILL_ACTIVE",
    });
  });

  it("after expiry, still stays closed until P5 supplies journal recovery", async () => {
    await expect(check(e.grant.expiresAt)).resolves.toMatchObject({
      cleared: false, reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED",
      cutoff: { kind: "grants_expire", at: e.grant.expiresAt },
    });
    await expect(check(e.grant.expiresAt, new P5Supplied())).resolves.toMatchObject({
      cleared: true, basis: "recovery_evidence",
    });
  });

  it("a revoked old counter is cut off before its grant expires, and still waits for P5", async () => {
    await tx((c) => trust.revokeEnrollment(c, owner, fx.mainBranchId, e.identity.enrollmentId, "Stolen"));
    const now = Date.now();
    expect(now).toBeLessThan(e.grant.expiresAt);
    await expect(check(now)).resolves.toMatchObject({
      cleared: false, reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED",
      cutoff: { kind: "device_disabled", lastGrantExpiresAt: e.grant.expiresAt },
    });
    await expect(check(now, new P5Supplied())).resolves.toMatchObject({ cleared: true });
  });

  it("an issuance racing an activation is refused once the nomination moves", async () => {
    const { identity: next } = await enroll();
    const { identity: late } = await enroll();
    await prisma.offlineTerminalNomination.updateMany({
      where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      data: { terminalId: late.terminalId, enrollmentId: late.enrollmentId, keyId: late.keyId },
    });
    await prepare(late, cashier.userId);
    let issuance: Promise<unknown> | undefined;
    // Activation holds the nomination lock; an issuance for the old counter waits, then must not
    // mint a grant on the nomination it read before the move.
    await prisma.$transaction(async (c) => {
      await c.$queryRaw`SELECT id FROM offline_terminal_nomination WHERE tenant_id = ${fx.tenantId}::uuid AND branch_id = ${fx.mainBranchId}::uuid FOR UPDATE`;
      issuance = issueOfflineAuthority(prisma as never, access, {
        signer, defaultVatRatePercent: 18,
        authenticate: async () => ({ identity: late, commandId: randomUUID() }),
        readState: emptyJournalState,
      });
      issuance.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await c.offlineTerminalNomination.updateMany({
        where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
        data: { terminalId: next.terminalId, enrollmentId: next.enrollmentId, keyId: next.keyId },
      });
    }, { timeout: 15_000 });
    await expect(issuance).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    expect(await prisma.offlineAuthorityIssuance.count({ where: { enrollmentId: late.enrollmentId } })).toBe(0);
  });
});
