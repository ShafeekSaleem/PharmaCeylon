import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { Prisma, RoleName } from "@prisma/client";
import type {
  LocalAttendanceAttestation,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalSessionCommand,
  WindowsSessionEvidence,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { StaffCredentialsService } from "../../src/terminals/staff-credentials.service";
import { EnrollmentCodesService } from "../../src/terminals/enrollment-codes.service";
import { counterEvidence } from "../../src/terminals/counter-evidence";
import { TerminalEnrollmentService } from "../../src/terminals/terminal-enrollment.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/** P2: enrollment and staff sessions with the PRODUCTION attendance verifier. Proofs are real
 * signed attestations recorded through AttendanceProofsService; nothing is stubbed. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const credentials = new StaffCredentialsService(prisma as never, trust, audit);
const codes = new EnrollmentCodesService(prisma as never, access, trust, audit);
const enrollmentService = new TerminalEnrollmentService(prisma as never, access, trust, proofs, audit);
const PASSWORD = "correct horse battery";
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });
const CONSOLE: WindowsSessionEvidence = { sessionId: 1, protocol: "console", remoteSession: false };

let fx: TenantFixture;
let owner: RequestUser;
let clerk: RequestUser;

function user(userId: string): RequestUser {
  return {
    userId,
    tenantId: fx.tenantId,
    tokenVersion: 0,
    email: "test@example.test",
    fullName: "Test",
    authMethod: "bearer",
    branchRoles: [],
  };
}

type Device = ReturnType<typeof terminalDevice>;
type Challenge = TerminalEnrollmentCommand | TerminalSessionCommand;

function attestation(
  challenge: Challenge,
  purpose: "enrollment" | "session",
  actor: RequestUser,
  overrides: Partial<LocalAttendanceAttestation> = {},
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
    windowsSession: CONSOLE,
    appVersion: "0.0.1",
    observedAt: Date.now(),
    ...overrides,
  };
}

const record = (device: Device, a: LocalAttendanceAttestation, actor = owner, branchId = fx.mainBranchId) =>
  proofs.record(actor, branchId, device.sign(a, a.identity.keyId, "attendance"));

async function counter(label = "Counter") {
  return tx((c) => trust.createCounter(c, owner, fx.mainBranchId, label));
}

async function beginEnrollment(device: Device, registerId: string) {
  return tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Front desk",
    }),
  );
}

async function enroll() {
  const device = terminalDevice();
  const { id: registerId } = await counter();
  const challenge = await beginEnrollment(device, registerId);
  const proof = await record(device, attestation(challenge, "enrollment", owner));
  const identity = await tx((c) =>
    trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  return { device, identity, registerId };
}

async function openSession(device: Device, identity: TerminalIdentity, actor: RequestUser) {
  const challenge = await tx((c) => trust.beginSession(c, actor, fx.mainBranchId, identity));
  const proof = await record(device, attestation(challenge, "session", actor), actor);
  return tx((c) =>
    trust.finishSession(c, actor, fx.mainBranchId, device.sign(challenge, identity.keyId), proof.proofId),
  );
}

beforeAll(async () => {
  fx = await createTenant(prisma, "terminal-enrollment");
  // tenant-scope: test fixture — the cashier's login password, for PIN changes.
  await prisma.appUser.update({ where: { id: fx.clerkId }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  owner = user(fx.ownerId);
  clerk = user(fx.clerkId);
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
    ],
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("P2 enrollment and sessions with recorded local attendance", () => {
  it("enrolls a console-attended device and opens a staff session on it", async () => {
    const { device, identity, registerId } = await enroll();
    const enrollment = await prisma.terminalEnrollment.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: identity.enrollmentId },
      include: { terminal: true },
    });
    expect(enrollment.publicKeyHex).toBe(device.publicKeyHex);
    expect(enrollment.terminal.registerId).toBe(registerId);

    const session = await openSession(device, identity, clerk);
    expect(session.staffUserId).toBe(clerk.userId);
    const used = await prisma.terminalAttendanceProof.findMany({
      where: { tenantId: fx.tenantId, terminalId: identity.terminalId },
    });
    expect(used).toHaveLength(2);
    expect(used.every((p) => p.consumedAt !== null)).toBe(true);
  });

  it.each<[string, WindowsSessionEvidence]>([
    ["a Remote Desktop session", { sessionId: 3, protocol: "rdp", remoteSession: true }],
    ["the remote flag on a console session", { sessionId: 1, protocol: "console", remoteSession: true }],
    ["an unidentified session", { sessionId: 1, protocol: "unknown", remoteSession: false }],
  ])("refuses %s", async (_label, windowsSession) => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(
      record(device, attestation(challenge, "enrollment", owner, { windowsSession })),
    ).rejects.toMatchObject({ response: { code: "REMOTE_SESSION_DENIED" } });
  });

  it("refuses an attestation signed by a key other than the one being enrolled", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(record(terminalDevice(), attestation(challenge, "enrollment", owner))).rejects.toMatchObject({
      response: { code: "INVALID_SIGNATURE" },
    });
  });

  it("refuses an attestation for a different challenge, counter, actor or branch", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(
      record(device, attestation(challenge, "enrollment", owner, { payloadDigest: "a".repeat(64) })),
    ).rejects.toMatchObject({ response: { code: "CHALLENGE_INVALID" } });
    await expect(
      record(device, attestation(challenge, "enrollment", owner, { registerId: randomUUID() })),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(
      record(device, attestation(challenge, "enrollment", owner, { actorUserId: clerk.userId })),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(
      record(device, attestation(challenge, "enrollment", owner), owner, fx.otherBranchId),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(
      record(device, attestation(challenge, "session", owner)),
    ).rejects.toMatchObject({ response: { code: "CHALLENGE_INVALID" } });
  });

  it("returns the same proof for an identical retry and 409 for a reused ID", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    const a = attestation(challenge, "enrollment", owner);
    const [first, concurrent] = await Promise.all([record(device, a), record(device, a)]);
    expect(concurrent).toEqual(first);
    expect(await record(device, a)).toEqual(first);
    await expect(record(device, { ...a, appVersion: "0.0.2" })).rejects.toMatchObject({
      response: { code: "REPLAY_CONFLICT" },
    });
  });

  it("consumes a proof once and leaves it usable when the operation rolls back", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    const proof = await record(device, attestation(challenge, "enrollment", owner));
    const signed = device.sign(challenge, challenge.identity.keyId);

    await expect(
      tx(async (c) => {
        await trust.finishEnrollment(c, owner, fx.mainBranchId, signed, proof.proofId);
        throw new Error("downstream failure");
      }),
    ).rejects.toThrow("downstream failure");
    expect(
      (await prisma.terminalAttendanceProof.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: proof.proofId } }))
        .consumedAt,
    ).toBeNull();

    await tx((c) => trust.finishEnrollment(c, owner, fx.mainBranchId, signed, proof.proofId));
    expect(
      (await prisma.terminalAttendanceProof.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: proof.proofId } }))
        .consumedAt,
    ).not.toBeNull();
  });

  it("does not accept an enrollment proof for a session, or a used proof twice", async () => {
    const { device, identity } = await enroll();
    const sessionChallenge = await tx((c) => trust.beginSession(c, clerk, fx.mainBranchId, identity));
    const enrollmentDevice = terminalDevice();
    const { id } = await counter();
    const enrollmentChallenge = await beginEnrollment(enrollmentDevice, id);
    const wrongPurpose = await record(enrollmentDevice, attestation(enrollmentChallenge, "enrollment", owner));
    await expect(
      tx((c) =>
        trust.finishSession(c, clerk, fx.mainBranchId, device.sign(sessionChallenge, identity.keyId), wrongPurpose.proofId),
      ),
    ).rejects.toMatchObject({ response: { code: "LOCAL_ATTENDANCE_UNAVAILABLE" } });

    const proof = await record(device, attestation(sessionChallenge, "session", clerk), clerk);
    await tx((c) =>
      trust.finishSession(c, clerk, fx.mainBranchId, device.sign(sessionChallenge, identity.keyId), proof.proofId),
    );
    const next = await tx((c) => trust.beginSession(c, clerk, fx.mainBranchId, identity));
    await expect(
      tx((c) => trust.finishSession(c, clerk, fx.mainBranchId, device.sign(next, identity.keyId), proof.proofId)),
    ).rejects.toMatchObject({ response: { code: "LOCAL_ATTENDANCE_UNAVAILABLE" } });
  });

  it("a colleague signing in at the till supersedes the previous open binding", async () => {
    const { device, identity } = await enroll();
    const first = await openSession(device, identity, clerk);
    const second = await openSession(device, identity, owner);
    const sessions = await prisma.terminalStaffSession.findMany({
      where: { tenantId: fx.tenantId, enrollmentId: identity.enrollmentId },
    });
    expect(sessions.find((s) => s.id === first.workSessionId)?.closedAt).not.toBeNull();
    expect(sessions.find((s) => s.id === second.workSessionId)?.closedAt).toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId, eventName: "terminal.session_superseded", entityId: first.workSessionId },
      }),
    ).toBe(1);
  });

  it("refuses session attestations from a revoked device", async () => {
    const { device, identity } = await enroll();
    const challenge = await tx((c) => trust.beginSession(c, clerk, fx.mainBranchId, identity));
    await tx((c) => trust.revokeEnrollment(c, owner, fx.mainBranchId, identity.enrollmentId, "Lost"));
    await expect(record(device, attestation(challenge, "session", clerk), clerk)).rejects.toMatchObject({
      response: { code: "TERMINAL_REVOKED" },
    });
  });

  it("keeps proof content immutable and never deletes it", async () => {
    const { identity } = await enroll();
    const proof = await prisma.terminalAttendanceProof.findFirstOrThrow({
      where: { tenantId: fx.tenantId, terminalId: identity.terminalId },
    });
    await expect(
      prisma.terminalAttendanceProof.updateMany({
        where: { tenantId: fx.tenantId, id: proof.id },
        data: { appVersion: "9.9.9" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalAttendanceProof.deleteMany({ where: { tenantId: fx.tenantId, id: proof.id } }),
    ).rejects.toThrow();
  });
});

describe("D-W5 personal PINs prepared per counter", () => {
  const preparation = (enrollmentId: string) =>
    prisma.terminalStaffPreparation.findFirst({ where: { tenantId: fx.tenantId, enrollmentId, staffUserId: clerk.userId } });

  it("sets the PIN at the counter, prepares that counter and makes older counters stale", async () => {
    const a = await enroll();
    const b = await enroll();
    const sessionA = await openSession(a.device, a.identity, clerk);
    const sessionB = await openSession(b.device, b.identity, clerk);

    await expect(
      credentials.setPin(clerk, fx.mainBranchId, sessionA.workSessionId, { pin: "4821", password: "wrong password" }),
    ).rejects.toMatchObject({ response: { code: "PASSWORD_INCORRECT" } });

    const set = await credentials.setPin(clerk, fx.mainBranchId, sessionA.workSessionId, { pin: "4821", password: PASSWORD });
    expect(set).toMatchObject({ pinSet: true, preparedVersion: set.pinVersion });
    expect((await preparation(a.identity.enrollmentId))?.pinVersion).toBe(set.pinVersion);

    const before = await credentials.credential(clerk, fx.mainBranchId, sessionB.workSessionId);
    expect(before.preparedVersion).toBeNull();
    const prepared = await credentials.prepare(clerk, fx.mainBranchId, sessionB.workSessionId, "4821");
    expect(prepared.preparedVersion).toBe(set.pinVersion);

    // A change on counter A leaves counter B prepared at the old version until the person signs in there again.
    const changed = await credentials.setPin(clerk, fx.mainBranchId, sessionA.workSessionId, { pin: "7310", password: PASSWORD });
    expect(changed.pinVersion).toBe(set.pinVersion + 1);
    const stale = await credentials.credential(clerk, fx.mainBranchId, sessionB.workSessionId);
    expect(stale.preparedVersion).toBe(set.pinVersion);
    expect(stale.pinVersion).toBe(changed.pinVersion);
    await expect(credentials.prepare(clerk, fx.mainBranchId, sessionB.workSessionId, "4821")).rejects.toMatchObject({
      response: { code: "PIN_INCORRECT" },
    });
  });

  it("locks the PIN after repeated wrong entries and never stores it in plain text", async () => {
    const { device, identity } = await enroll();
    const session = await openSession(device, identity, clerk);
    await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, { pin: "5555", password: PASSWORD });
    for (let i = 0; i < 5; i++)
      await expect(credentials.prepare(clerk, fx.mainBranchId, session.workSessionId, "1234")).rejects.toMatchObject({
        response: { code: "PIN_INCORRECT" },
      });
    await expect(credentials.prepare(clerk, fx.mainBranchId, session.workSessionId, "5555")).rejects.toMatchObject({
      response: { code: "PIN_LOCKED" },
    });
    // tenant-scope: test fixture — reading the hash to prove no plain-text PIN is kept.
    const account = await prisma.appUser.findUniqueOrThrow({ where: { id: clerk.userId } });
    expect(account.posPinHash).not.toContain("5555");
    // tenant-scope: test fixture — unlock for the following tests.
    await prisma.appUser.update({ where: { id: clerk.userId }, data: { posPinLockedUntil: null, failedPosPinAttempts: 0 } });
  });

  it("only works through the caller's own open session on an active counter", async () => {
    const { device, identity } = await enroll();
    const session = await openSession(device, identity, clerk);
    await expect(credentials.credential(owner, fx.mainBranchId, session.workSessionId)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    await tx((c) => trust.revokeEnrollment(c, owner, fx.mainBranchId, identity.enrollmentId, "Lost"));
    await expect(credentials.prepare(clerk, fx.mainBranchId, session.workSessionId, "5555")).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
  });
});

describe("one-time enrollment codes", () => {
  async function redeem(code: string, actor = clerk) {
    const device = terminalDevice();
    const keyId = randomUUID();
    const { command, counterLabel } = await codes.redeemChallenge(actor, fx.mainBranchId, {
      code,
      keyId,
      publicKeyHex: device.publicKeyHex,
      label: "Code PC",
    });
    return { device, command, counterLabel };
  }

  it("lets a cashier enroll the counter a manager issued a code for, once", async () => {
    const { id: registerId } = await counter("Code counter");
    const issued = await codes.issue(owner, fx.mainBranchId, { registerId });
    expect(issued.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(issued.view.status).toBe("outstanding");
    const stored = await prisma.terminalEnrollmentCode.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: issued.view.codeId } });
    expect(stored.codeHash).not.toContain(issued.code.replace("-", ""));

    // Typed loosely at the counter: lower case and a space instead of the dash.
    const { device, command, counterLabel } = await redeem(issued.code.toLowerCase().replace("-", " "));
    expect(counterLabel).toBe("Code counter");
    expect(command.registerId).toBe(registerId);
    const proof = await record(device, attestation(command, "enrollment", clerk), clerk);
    const identity = await tx((c) =>
      trust.finishEnrollment(c, clerk, fx.mainBranchId, device.sign(command, command.identity.keyId), proof.proofId),
    );
    const enrollment = await prisma.terminalEnrollment.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: identity.enrollmentId } });
    expect(enrollment.enrolledByUserId).toBe(clerk.userId);
    const [listed] = (await codes.list(owner, fx.mainBranchId)).filter((c) => c.codeId === issued.view.codeId);
    expect(listed).toMatchObject({ status: "used", usedByUserId: clerk.userId, enrollmentId: identity.enrollmentId });

    await expect(redeem(issued.code)).rejects.toMatchObject({ response: { code: "ENROLLMENT_CODE_INVALID" } });
  });

  it("refuses a code revoked between redeeming and finishing, and enrolls nothing", async () => {
    const { id: registerId } = await counter("Revoked code counter");
    const issued = await codes.issue(owner, fx.mainBranchId, { registerId, expiresInMinutes: 5 });
    const { device, command } = await redeem(issued.code);
    const proof = await record(device, attestation(command, "enrollment", clerk), clerk);
    await codes.revoke(owner, fx.mainBranchId, issued.view.codeId);
    await expect(
      tx((c) => trust.finishEnrollment(c, clerk, fx.mainBranchId, device.sign(command, command.identity.keyId), proof.proofId)),
    ).rejects.toMatchObject({ response: { code: "ENROLLMENT_CODE_INVALID" } });
    expect(await prisma.operationalTerminal.count({ where: { tenantId: fx.tenantId, id: command.identity.terminalId } })).toBe(0);
  });

  it("only managers issue codes, and never for an occupied counter or at another branch", async () => {
    const { registerId } = await enroll();
    await expect(codes.issue(owner, fx.mainBranchId, { registerId })).rejects.toMatchObject({
      response: { code: "COUNTER_OCCUPIED" },
    });
    const { id: free } = await counter("Free counter");
    await expect(codes.issue(clerk, fx.mainBranchId, { registerId: free })).rejects.toMatchObject({
      response: { code: "PERMISSION_DENIED" },
    });
    const issued = await codes.issue(owner, fx.mainBranchId, { registerId: free });
    await expect(
      codes.redeemChallenge(owner, fx.otherBranchId, {
        code: issued.code,
        keyId: randomUUID(),
        publicKeyHex: terminalDevice().publicKeyHex,
        label: "Elsewhere",
      }),
    ).rejects.toMatchObject({ response: { code: "ENROLLMENT_CODE_INVALID" } });
  });
});

describe("go-live evidence from counters", () => {
  it("counts people prepared at their current PIN and confirmed test receipts, on active counters only", async () => {
    const fresh = await createTenant(prisma, "counter-evidence");
    const saved = { fx, owner, clerk };
    fx = fresh;
    owner = user(fx.ownerId);
    clerk = user(fx.clerkId);
    try {
      await prisma.userBranchRole.createMany({
        data: [
          { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
          { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
        ],
      });
      // tenant-scope: test fixture — the cashier's login password, for PIN changes.
      await prisma.appUser.update({ where: { id: fx.clerkId }, data: { passwordHash: await bcrypt.hash(PASSWORD, 4) } });
      expect(await counterEvidence(prisma, fx.tenantId, fx.mainBranchId)).toEqual({ preparedStaff: 0, testReceipts: 0 });

      const { device, identity } = await enroll();
      const session = await openSession(device, identity, clerk);
      await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, { pin: "2580", password: PASSWORD });
      await enrollmentService.recordTestReceipt(clerk, fx.mainBranchId, session.workSessionId, "Receipt printer");
      expect(await counterEvidence(prisma, fx.tenantId, fx.mainBranchId)).toEqual({ preparedStaff: 1, testReceipts: 1 });

      // An admin PIN reset makes the preparation stale; a revoked counter's receipt stops counting.
      // tenant-scope: test fixture — simulating the admin reset's version bump.
      await prisma.appUser.update({ where: { id: fx.clerkId }, data: { posPinVersion: { increment: 1 } } });
      await tx((c) => trust.revokeEnrollment(c, owner, fx.mainBranchId, identity.enrollmentId, "Replaced"));
      expect(await counterEvidence(prisma, fx.tenantId, fx.mainBranchId)).toEqual({ preparedStaff: 0, testReceipts: 0 });
    } finally {
      ({ fx, owner, clerk } = saved);
    }
  });
});
