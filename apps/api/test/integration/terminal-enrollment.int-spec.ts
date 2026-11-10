import { randomUUID } from "node:crypto";
import * as bcrypt from "bcrypt";
import { Prisma, RoleName } from "@prisma/client";
import type {
  LocalAttendanceAttestation,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalPinSessionCommand,
  TerminalSessionCommand,
  WindowsSessionEvidence,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { PharmacistRegistrationService } from "../../src/clinical/pharmacist-registration.service";
import { businessDateKey } from "../../src/common/business-date.util";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AuthService } from "../../src/auth/auth.service";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import type { PinAlerts } from "../../src/terminals/pin-alerts.service";
import { PinSignInService } from "../../src/terminals/pin-sign-in.service";
import { StaffCredentialsService } from "../../src/terminals/staff-credentials.service";
import { EnrollmentCodesService } from "../../src/terminals/enrollment-codes.service";
import { counterEvidence } from "../../src/terminals/counter-evidence";
import { TerminalEnrollmentService } from "../../src/terminals/terminal-enrollment.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { PharmacistApprovalService } from "../../src/sales/pharmacist-approval.service";
import { SalesService } from "../../src/sales/sales.service";
import { PermissionsService } from "../../src/security/permissions.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import {
  createPrisma,
  createStockedBatch,
  createTenant,
  openTestShift,
  type TenantFixture,
} from "./fixtures";
import { TillShiftsService } from "../../src/terminals/shifts/till-shifts.service";

/** P2: enrollment and staff sessions with the PRODUCTION attendance verifier. Proofs are real
 * signed attestations recorded through AttendanceProofsService; nothing is stubbed. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(
  access,
  audit,
  new LocalAttendanceVerifier(),
);
const proofs = new AttendanceProofsService(prisma as never, access);
// The branch alert is NotificationsService's (unit-tested there); these tests cover when it fires.
const pinAlerts = { switchedOff: jest.fn(async () => undefined) };
const credentials = new StaffCredentialsService(
  prisma as never,
  trust,
  audit,
  pinAlerts as unknown as PinAlerts,
);
const codes = new EnrollmentCodesService(prisma as never, access, trust, audit);
const enrollmentService = new TerminalEnrollmentService(
  prisma as never,
  access,
  trust,
  proofs,
  audit,
);
const offlineAssignments = new OfflineAssignmentService(prisma as never, access, audit);
// Token issuing is AuthService's (unit-tested there); these tests cover what a PIN must prove.
const issueCounterSession = jest.fn(
  async (
    _tx: Prisma.TransactionClient,
    userId: string,
    tenantId: string,
    workSessionId: string,
  ) => ({
    accessToken: `access:${workSessionId}`,
    refreshToken: "refresh",
    user: { id: userId, tenantId, email: "", fullName: "", roles: [], branchRoles: [] },
  }),
);
const pinSignIn = new PinSignInService(
  prisma as never,
  trust,
  proofs,
  { issueCounterSession } as unknown as AuthService,
  pinAlerts as unknown as PinAlerts,
);
// Only its password check is used here, which needs nothing but the database and the audit log.
const passwords = new AuthService(
  prisma as never,
  {} as never,
  {} as never,
  {} as never,
  {} as never,
  audit,
  {} as never,
);
const PASSWORD = "correct horse battery";
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });
const CONSOLE: WindowsSessionEvidence = {
  sessionId: 1,
  protocol: "console",
  remoteSession: false,
};

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
type Challenge =
  | TerminalEnrollmentCommand
  | TerminalSessionCommand
  | TerminalPinSessionCommand;

function attestation(
  challenge: Challenge,
  purpose: "enrollment" | "session" | "pin_session",
  actor: RequestUser,
  overrides: Partial<LocalAttendanceAttestation> = {},
): LocalAttendanceAttestation {
  const counter =
    "registerId" in challenge
      ? { registerId: challenge.registerId, tillId: challenge.tillId }
      : {
          registerId: challenge.session.registerId,
          tillId: challenge.session.tillId,
        };
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

const record = (
  device: Device,
  a: LocalAttendanceAttestation,
  actor = owner,
  branchId = fx.mainBranchId,
) =>
  proofs.record(
    actor,
    branchId,
    device.sign(a, a.identity.keyId, "attendance"),
  );

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
  const proof = await record(
    device,
    attestation(challenge, "enrollment", owner),
  );
  const identity = await tx((c) =>
    trust.finishEnrollment(
      c,
      owner,
      fx.mainBranchId,
      device.sign(challenge, challenge.identity.keyId),
      proof.proofId,
    ),
  );
  return { device, identity, registerId };
}

async function openSession(
  device: Device,
  identity: TerminalIdentity,
  actor: RequestUser,
) {
  const challenge = await tx((c) =>
    trust.beginSession(c, actor, fx.mainBranchId, identity),
  );
  const proof = await record(
    device,
    attestation(challenge, "session", actor),
    actor,
  );
  return tx((c) =>
    trust.finishSession(
      c,
      actor,
      fx.mainBranchId,
      device.sign(challenge, identity.keyId),
      proof.proofId,
    ),
  );
}

beforeAll(async () => {
  fx = await createTenant(prisma, "terminal-enrollment");
  // tenant-scope: test fixture — the cashier's login password, for PIN changes.
  await prisma.appUser.update({
    where: { id: fx.clerkId },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
  owner = user(fx.ownerId);
  clerk = user(fx.clerkId);
  await prisma.userBranchRole.createMany({
    data: [
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.ownerId,
        role: RoleName.owner,
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.otherBranchId,
        userId: fx.ownerId,
        role: RoleName.owner,
      },
      {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        userId: fx.clerkId,
        role: RoleName.cashier,
      },
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
    [
      "a Remote Desktop session",
      { sessionId: 3, protocol: "rdp", remoteSession: true },
    ],
    [
      "the remote flag on a console session",
      { sessionId: 1, protocol: "console", remoteSession: true },
    ],
    [
      "an unidentified session",
      { sessionId: 1, protocol: "unknown", remoteSession: false },
    ],
  ])("refuses %s", async (_label, windowsSession) => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(
      record(
        device,
        attestation(challenge, "enrollment", owner, { windowsSession }),
      ),
    ).rejects.toMatchObject({ response: { code: "REMOTE_SESSION_DENIED" } });
  });

  it("refuses an attestation signed by a key other than the one being enrolled", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(
      record(terminalDevice(), attestation(challenge, "enrollment", owner)),
    ).rejects.toMatchObject({
      response: { code: "INVALID_SIGNATURE" },
    });
  });

  it("refuses an attestation for a different challenge, counter, actor or branch", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    await expect(
      record(
        device,
        attestation(challenge, "enrollment", owner, {
          payloadDigest: "a".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "CHALLENGE_INVALID" } });
    await expect(
      record(
        device,
        attestation(challenge, "enrollment", owner, {
          registerId: randomUUID(),
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(
      record(
        device,
        attestation(challenge, "enrollment", owner, {
          actorUserId: clerk.userId,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    await expect(
      record(
        device,
        attestation(challenge, "enrollment", owner),
        owner,
        fx.otherBranchId,
      ),
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
    const [first, concurrent] = await Promise.all([
      record(device, a),
      record(device, a),
    ]);
    expect(concurrent).toEqual(first);
    expect(await record(device, a)).toEqual(first);
    await expect(
      record(device, { ...a, appVersion: "0.0.2" }),
    ).rejects.toMatchObject({
      response: { code: "REPLAY_CONFLICT" },
    });
  });

  it("consumes a proof once and leaves it usable when the operation rolls back", async () => {
    const device = terminalDevice();
    const { id } = await counter();
    const challenge = await beginEnrollment(device, id);
    const proof = await record(
      device,
      attestation(challenge, "enrollment", owner),
    );
    const signed = device.sign(challenge, challenge.identity.keyId);

    await expect(
      tx(async (c) => {
        await trust.finishEnrollment(
          c,
          owner,
          fx.mainBranchId,
          signed,
          proof.proofId,
        );
        throw new Error("downstream failure");
      }),
    ).rejects.toThrow("downstream failure");
    expect(
      (
        await prisma.terminalAttendanceProof.findFirstOrThrow({
          where: { tenantId: fx.tenantId, id: proof.proofId },
        })
      ).consumedAt,
    ).toBeNull();

    await tx((c) =>
      trust.finishEnrollment(c, owner, fx.mainBranchId, signed, proof.proofId),
    );
    expect(
      (
        await prisma.terminalAttendanceProof.findFirstOrThrow({
          where: { tenantId: fx.tenantId, id: proof.proofId },
        })
      ).consumedAt,
    ).not.toBeNull();
  });

  it("does not accept an enrollment proof for a session, or a used proof twice", async () => {
    const { device, identity } = await enroll();
    const sessionChallenge = await tx((c) =>
      trust.beginSession(c, clerk, fx.mainBranchId, identity),
    );
    const enrollmentDevice = terminalDevice();
    const { id } = await counter();
    const enrollmentChallenge = await beginEnrollment(enrollmentDevice, id);
    const wrongPurpose = await record(
      enrollmentDevice,
      attestation(enrollmentChallenge, "enrollment", owner),
    );
    await expect(
      tx((c) =>
        trust.finishSession(
          c,
          clerk,
          fx.mainBranchId,
          device.sign(sessionChallenge, identity.keyId),
          wrongPurpose.proofId,
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: "LOCAL_ATTENDANCE_UNAVAILABLE" },
    });

    const proof = await record(
      device,
      attestation(sessionChallenge, "session", clerk),
      clerk,
    );
    await tx((c) =>
      trust.finishSession(
        c,
        clerk,
        fx.mainBranchId,
        device.sign(sessionChallenge, identity.keyId),
        proof.proofId,
      ),
    );
    const next = await tx((c) =>
      trust.beginSession(c, clerk, fx.mainBranchId, identity),
    );
    await expect(
      tx((c) =>
        trust.finishSession(
          c,
          clerk,
          fx.mainBranchId,
          device.sign(next, identity.keyId),
          proof.proofId,
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: "LOCAL_ATTENDANCE_UNAVAILABLE" },
    });
  });

  it("a colleague signing in at the till supersedes the previous open binding", async () => {
    const { device, identity } = await enroll();
    const first = await openSession(device, identity, clerk);
    const second = await openSession(device, identity, owner);
    const sessions = await prisma.terminalStaffSession.findMany({
      where: { tenantId: fx.tenantId, enrollmentId: identity.enrollmentId },
    });
    expect(
      sessions.find((s) => s.id === first.workSessionId)?.closedAt,
    ).not.toBeNull();
    expect(
      sessions.find((s) => s.id === second.workSessionId)?.closedAt,
    ).toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: fx.tenantId,
          eventName: "terminal.session_superseded",
          entityId: first.workSessionId,
        },
      }),
    ).toBe(1);
  });

  it("refuses session attestations from a revoked device", async () => {
    const { device, identity } = await enroll();
    const challenge = await tx((c) =>
      trust.beginSession(c, clerk, fx.mainBranchId, identity),
    );
    await tx((c) =>
      trust.revokeEnrollment(
        c,
        owner,
        fx.mainBranchId,
        identity.enrollmentId,
        "Lost",
      ),
    );
    await expect(
      record(device, attestation(challenge, "session", clerk), clerk),
    ).rejects.toMatchObject({
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
      prisma.terminalAttendanceProof.deleteMany({
        where: { tenantId: fx.tenantId, id: proof.id },
      }),
    ).rejects.toThrow();
  });
});

describe("D-W5 personal PINs prepared per counter", () => {
  const preparation = (enrollmentId: string) =>
    prisma.terminalStaffPreparation.findFirst({
      where: { tenantId: fx.tenantId, enrollmentId, staffUserId: clerk.userId },
    });

  it("sets the PIN at the counter, prepares that counter and makes older counters stale", async () => {
    const a = await enroll();
    const b = await enroll();
    const sessionA = await openSession(a.device, a.identity, clerk);
    const sessionB = await openSession(b.device, b.identity, clerk);

    await expect(
      credentials.setPin(clerk, fx.mainBranchId, sessionA.workSessionId, {
        pin: "4821",
        password: "wrong password",
      }),
    ).rejects.toMatchObject({ response: { code: "PASSWORD_INCORRECT" } });

    const set = await credentials.setPin(
      clerk,
      fx.mainBranchId,
      sessionA.workSessionId,
      { pin: "4821", password: PASSWORD },
    );
    expect(set).toMatchObject({
      pinSet: true,
      preparedVersion: set.pinVersion,
    });
    expect((await preparation(a.identity.enrollmentId))?.pinVersion).toBe(
      set.pinVersion,
    );

    const before = await credentials.credential(
      clerk,
      fx.mainBranchId,
      sessionB.workSessionId,
    );
    expect(before.preparedVersion).toBeNull();
    const prepared = await credentials.prepare(
      clerk,
      fx.mainBranchId,
      sessionB.workSessionId,
      "4821",
    );
    expect(prepared.preparedVersion).toBe(set.pinVersion);

    // A change on counter A leaves counter B prepared at the old version until the person signs in there again.
    const changed = await credentials.setPin(
      clerk,
      fx.mainBranchId,
      sessionA.workSessionId,
      { pin: "7310", password: PASSWORD },
    );
    expect(changed.pinVersion).toBe(set.pinVersion + 1);
    const stale = await credentials.credential(
      clerk,
      fx.mainBranchId,
      sessionB.workSessionId,
    );
    expect(stale.preparedVersion).toBe(set.pinVersion);
    expect(stale.pinVersion).toBe(changed.pinVersion);
    await expect(
      credentials.prepare(
        clerk,
        fx.mainBranchId,
        sessionB.workSessionId,
        "4821",
      ),
    ).rejects.toMatchObject({
      response: { code: "PIN_INCORRECT" },
    });
  });

  it("locks the PIN after repeated wrong entries and never stores it in plain text", async () => {
    const { device, identity } = await enroll();
    const session = await openSession(device, identity, clerk);
    await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, {
      pin: "5555",
      password: PASSWORD,
    });
    for (let i = 0; i < 5; i++)
      await expect(
        credentials.prepare(
          clerk,
          fx.mainBranchId,
          session.workSessionId,
          "1234",
        ),
      ).rejects.toMatchObject({
        response: { code: "PIN_INCORRECT" },
      });
    await expect(
      credentials.prepare(
        clerk,
        fx.mainBranchId,
        session.workSessionId,
        "5555",
      ),
    ).rejects.toMatchObject({
      response: { code: "PIN_LOCKED" },
    });
    // tenant-scope: test fixture — reading the hash to prove no plain-text PIN is kept.
    const account = await prisma.appUser.findUniqueOrThrow({
      where: { id: clerk.userId },
    });
    expect(account.posPinHash).not.toContain("5555");
    // tenant-scope: test fixture — unlock for the following tests.
    await prisma.appUser.update({
      where: { id: clerk.userId },
      data: {
        posPinLockedUntil: null,
        failedPosPinAttempts: 0,
        posPinLockouts: 0,
      },
    });
  });

  it("only works through the caller's own open session on an active counter", async () => {
    const { device, identity } = await enroll();
    const session = await openSession(device, identity, clerk);
    await expect(
      credentials.credential(owner, fx.mainBranchId, session.workSessionId),
    ).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    await tx((c) =>
      trust.revokeEnrollment(
        c,
        owner,
        fx.mainBranchId,
        identity.enrollmentId,
        "Lost",
      ),
    );
    await expect(
      credentials.prepare(
        clerk,
        fx.mainBranchId,
        session.workSessionId,
        "5555",
      ),
    ).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
  });
});

describe("D-W5 PIN sign-in at a counter", () => {
  const PIN = "2468";

  /** A counter the cashier has set (and so prepared) their PIN on. */
  async function preparedCounter() {
    const { device, identity } = await enroll();
    const session = await openSession(device, identity, clerk);
    await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, {
      pin: PIN,
      password: PASSWORD,
    });
    return { device, identity, session };
  }

  const askFor = (device: Device, identity: TerminalIdentity, staffUserId: string) =>
    pinSignIn.begin(
      device.sign(
        {
          contractVersion: 1,
          kind: "terminal_pin_session_request",
          identity,
          staffUserId,
        },
        identity.keyId,
      ),
    );

  const answer = (
    device: Device,
    challenge: TerminalPinSessionCommand,
    pin: string,
    overrides: Partial<LocalAttendanceAttestation> = {},
  ) =>
    pinSignIn.finish(
      {
        envelope: device.sign(challenge, challenge.identity.keyId),
        attendance: device.sign(
          attestation(
            challenge,
            "pin_session",
            user(challenge.session.staffUserId),
            overrides,
          ),
          challenge.identity.keyId,
          "attendance",
        ),
        pin,
      },
      {},
    );

  const openPinChallenges = (enrollmentId: string) =>
    prisma.terminalChallenge.count({
      where: {
        tenantId: fx.tenantId,
        purpose: "pin_session",
        consumedAt: null,
        payload: { path: ["identity", "enrollmentId"], equals: enrollmentId },
      },
    });

  const request = (identity: TerminalIdentity, staffUserId: string) => ({
    contractVersion: 1 as const,
    kind: "terminal_pin_session_request" as const,
    identity,
    staffUserId,
  });

  beforeEach(() => pinAlerts.switchedOff.mockClear());

  afterEach(async () => {
    // tenant-scope: test fixture — each test starts with the cashier's PIN unlocked.
    await prisma.appUser.update({
      where: { id: clerk.userId },
      data: {
        posPinLockedUntil: null,
        failedPosPinAttempts: 0,
        posPinLockouts: 0,
      },
    });
  });

  it("signs a prepared person in with their PIN and supersedes whoever was signed in", async () => {
    const { device, identity, session: earlier } = await preparedCounter();
    const challenge = await askFor(device, identity, clerk.userId);
    expect(challenge).toMatchObject({
      kind: "terminal_pin_session",
      identity,
      session: { staffUserId: clerk.userId },
    });

    const result = await answer(device, challenge, PIN);

    expect(result.session).toEqual(challenge.session);
    expect(issueCounterSession).toHaveBeenLastCalledWith(
      expect.anything(),
      clerk.userId,
      fx.tenantId,
      challenge.session.workSessionId,
      {},
    );
    const sessions = await prisma.terminalStaffSession.findMany({
      where: { tenantId: fx.tenantId, enrollmentId: identity.enrollmentId },
    });
    expect(
      sessions.find((s) => s.id === earlier.workSessionId)?.closedAt,
    ).not.toBeNull();
    expect(
      sessions.find((s) => s.id === challenge.session.workSessionId),
    ).toMatchObject({ staffUserId: clerk.userId, closedAt: null });
    const authorized = await prisma.auditEvent.findFirst({
      where: {
        tenantId: fx.tenantId,
        eventName: "terminal.session_authorized",
        entityId: challenge.session.workSessionId,
      },
    });
    expect(authorized?.payload).toMatchObject({ via: "pin" });
  });

  it("spends one challenge per guess and locks the PIN after five wrong ones", async () => {
    const { device, identity } = await preparedCounter();
    for (let i = 0; i < 5; i++) {
      const challenge = await askFor(device, identity, clerk.userId);
      await expect(answer(device, challenge, "1357")).rejects.toMatchObject({
        response: { code: "PIN_INCORRECT" },
      });
    }
    // The refusals committed: every challenge is spent and each failure is on record.
    expect(await openPinChallenges(identity.enrollmentId)).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: {
          tenantId: fx.tenantId,
          eventName: "terminal.pin_sign_in_refused",
          entityId: identity.enrollmentId,
        },
      }),
    ).toBe(5);

    // tenant-scope: test fixture — reading the lock.
    const { posPinLockedUntil, posPinLockouts } =
      await prisma.appUser.findUniqueOrThrow({ where: { id: clerk.userId } });
    expect(posPinLockouts).toBe(1);
    // A locked PIN gets no challenge to spend, and the counter is told when the lock ends rather
    // than guessing at the server's policy.
    await expect(
      askFor(device, identity, clerk.userId),
    ).rejects.toMatchObject({
      response: {
        code: "PIN_LOCKED",
        lockedUntil: posPinLockedUntil!.toISOString(),
      },
    });
    expect(await openPinChallenges(identity.enrollmentId)).toBe(0);
    expect(pinAlerts.switchedOff).not.toHaveBeenCalled();
  });

  it("refuses a challenge issued before a lock that started elsewhere, and spends it", async () => {
    const { device, identity } = await preparedCounter();
    const challenge = await askFor(device, identity, clerk.userId);
    const lockedUntil = new Date(Date.now() + 10 * 60_000);
    // tenant-scope: test fixture — wrong PINs at another counter locked it meanwhile.
    await prisma.appUser.update({
      where: { id: clerk.userId },
      data: { posPinLockedUntil: lockedUntil },
    });
    await expect(answer(device, challenge, PIN)).rejects.toMatchObject({
      response: { code: "PIN_LOCKED", lockedUntil: lockedUntil.toISOString() },
    });
    await expect(answer(device, challenge, PIN)).rejects.toMatchObject({
      response: { code: "CHALLENGE_INVALID" },
    });
  });

  it("switches the PIN off at the third lock until a password sign-in, and alerts the branch once", async () => {
    const { device, identity } = await preparedCounter();
    // tenant-scope: test fixture — two timed locks already, the last one over.
    await prisma.appUser.update({
      where: { id: clerk.userId },
      data: { posPinLockouts: 2 },
    });
    for (let i = 0; i < 5; i++) {
      const challenge = await askFor(device, identity, clerk.userId);
      await expect(answer(device, challenge, "1357")).rejects.toMatchObject({
        response: { code: "PIN_INCORRECT" },
      });
    }
    expect(pinAlerts.switchedOff).toHaveBeenCalledTimes(1);
    expect(pinAlerts.switchedOff).toHaveBeenCalledWith(
      fx.tenantId,
      fx.mainBranchId,
      clerk.userId,
    );

    // Its timed lock running out doesn't turn it back on.
    // tenant-scope: test fixture — the fifteen minutes have passed.
    await prisma.appUser.update({
      where: { id: clerk.userId },
      data: { posPinLockedUntil: null },
    });
    await expect(
      askFor(device, identity, clerk.userId),
    ).rejects.toMatchObject({ response: { code: "PIN_SWITCHED_OFF" } });
    expect(await openPinChallenges(identity.enrollmentId)).toBe(0);

    // tenant-scope: test fixture — the account the login form would have found.
    const account = await prisma.appUser.findUniqueOrThrow({
      where: { id: clerk.userId },
    });
    await passwords.verifyAccountPassword(account, PASSWORD, fx.tenantId);
    const challenge = await askFor(device, identity, clerk.userId);
    await expect(answer(device, challenge, PIN)).resolves.toMatchObject({
      session: { staffUserId: clerk.userId },
    });
    expect(pinAlerts.switchedOff).toHaveBeenCalledTimes(1);
  });

  it("answers a replayed request with the challenge it already issued, until too little of it is left", async () => {
    const { device, identity } = await preparedCounter();
    const signed = device.sign(request(identity, clerk.userId), identity.keyId);
    const first = await pinSignIn.begin(signed);
    for (let i = 0; i < 3; i++)
      await expect(pinSignIn.begin(signed)).resolves.toEqual(first);
    expect(await openPinChallenges(identity.enrollmentId)).toBe(1);

    // Seventy seconds on, the first has too little left to finish. Challenge rows are immutable,
    // so the clock moves rather than the row.
    const realNow = Date.now.bind(Date);
    const clock = jest.spyOn(Date, "now").mockImplementation(() => realNow() + 70_000);
    try {
      const second = await pinSignIn.begin(signed);
      expect(second.serverNonce).not.toBe(first.serverNonce);
      await expect(pinSignIn.begin(signed)).resolves.toEqual(second);
    } finally {
      clock.mockRestore();
    }
    expect(await openPinChallenges(identity.enrollmentId)).toBe(2);

    // Spent, it is never handed out again.
    await expect(answer(device, first, PIN)).resolves.toMatchObject({
      session: { staffUserId: clerk.userId },
    });
    const next = await pinSignIn.begin(signed);
    expect(next.serverNonce).not.toBe(first.serverNonce);
  });

  it("checks the device signature before waiting on the counter's lock", async () => {
    const { identity } = await preparedCounter();
    const stranger = terminalDevice();
    let locked!: () => void;
    let release!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    // Something legitimate holds the counter's row: a revocation, say, or a command in flight.
    const holder = tx(async (c) => {
      await c.$queryRaw`SELECT id FROM terminal_enrollment WHERE id = ${identity.enrollmentId}::uuid FOR UPDATE`;
      locked();
      await released;
    });
    await lockTaken;
    try {
      const unsigned = (): Promise<unknown> =>
        Promise.race([
          pinSignIn.begin(
            stranger.sign(request(identity, clerk.userId), identity.keyId),
          ),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("waited on the counter's lock")), 3_000),
          ),
        ]);
      await expect(unsigned()).rejects.toMatchObject({
        response: { code: "INVALID_SIGNATURE" },
      });
    } finally {
      release();
      await holder;
    }
  });

  it("keeps whoever was signed in when the login can't be issued", async () => {
    const { device, identity, session: earlier } = await preparedCounter();
    const challenge = await askFor(device, identity, clerk.userId);
    issueCounterSession.mockRejectedValueOnce(new Error("token store down"));

    await expect(answer(device, challenge, PIN)).rejects.toThrow(
      "token store down",
    );

    // The binding rolled back with the login: the earlier session is still open and the new one
    // never existed.
    const sessions = await prisma.terminalStaffSession.findMany({
      where: { tenantId: fx.tenantId, enrollmentId: identity.enrollmentId },
    });
    expect(
      sessions.find((s) => s.id === earlier.workSessionId)?.closedAt,
    ).toBeNull();
    expect(
      sessions.find((s) => s.id === challenge.session.workSessionId),
    ).toBeUndefined();
  });

  it("refuses people who aren't prepared here, or are prepared at an older PIN", async () => {
    const a = await preparedCounter();
    await expect(
      askFor(a.device, a.identity, owner.userId),
    ).rejects.toMatchObject({ response: { code: "PIN_NOT_PREPARED" } });

    // Setting the PIN again on another counter makes this counter's preparation stale.
    const b = await preparedCounter();
    await expect(
      askFor(a.device, a.identity, clerk.userId),
    ).rejects.toMatchObject({ response: { code: "PIN_NOT_PREPARED" } });
    const challenge = await askFor(b.device, b.identity, clerk.userId);
    await expect(answer(b.device, challenge, PIN)).resolves.toMatchObject({
      session: { staffUserId: clerk.userId },
    });
  });

  it("refuses a PIN that changed after the challenge was issued", async () => {
    const { device, identity, session } = await preparedCounter();
    const challenge = await askFor(device, identity, clerk.userId);
    await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, {
      pin: PIN,
      password: PASSWORD,
    });
    await expect(answer(device, challenge, PIN)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
  });

  it("needs this counter's key and a console proof, and counts no guess without them", async () => {
    const { device, identity } = await preparedCounter();
    const stranger = terminalDevice();
    await expect(
      pinSignIn.begin(
        stranger.sign(
          {
            contractVersion: 1,
            kind: "terminal_pin_session_request",
            identity,
            staffUserId: clerk.userId,
          },
          identity.keyId,
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "INVALID_SIGNATURE" } });

    const challenge = await askFor(device, identity, clerk.userId);
    await expect(
      answer(device, challenge, "1357", {
        windowsSession: { sessionId: 3, protocol: "rdp", remoteSession: true },
      }),
    ).rejects.toMatchObject({ response: { code: "REMOTE_SESSION_DENIED" } });
    await expect(
      answer(device, challenge, "1357", { actorUserId: owner.userId }),
    ).rejects.toMatchObject({ response: { code: "IDENTITY_MISMATCH" } });
    // Neither attempt reached the PIN: the challenge is still open and nothing was counted.
    expect(await openPinChallenges(identity.enrollmentId)).toBe(1);
    // tenant-scope: test fixture — reading the failure count.
    const account = await prisma.appUser.findUniqueOrThrow({
      where: { id: clerk.userId },
    });
    expect(account.failedPosPinAttempts).toBe(0);
    await expect(answer(device, challenge, PIN)).resolves.toMatchObject({
      session: { staffUserId: clerk.userId },
    });
  });

  it("refuses someone who lost their role at the branch, and a switched-off counter", async () => {
    const { device, identity } = await preparedCounter();
    const roles = await prisma.userBranchRole.findMany({
      where: {
        tenantId: fx.tenantId,
        userId: clerk.userId,
        branchId: fx.mainBranchId,
      },
    });
    await prisma.userBranchRole.deleteMany({
      where: { tenantId: fx.tenantId, id: { in: roles.map((r) => r.id) } },
    });
    try {
      // The counter gets one code for every way of losing access, so it can stop offering them.
      await expect(
        askFor(device, identity, clerk.userId),
      ).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });
    } finally {
      await prisma.userBranchRole.createMany({
        data: roles.map(({ id: _id, ...role }) => role),
      });
    }
    await tx((c) =>
      trust.revokeEnrollment(
        c,
        owner,
        fx.mainBranchId,
        identity.enrollmentId,
        "Lost",
      ),
    );
    await expect(
      askFor(device, identity, clerk.userId),
    ).rejects.toMatchObject({ response: { code: "TERMINAL_REVOKED" } });
  });
});

describe("one-time enrollment codes", () => {
  async function redeem(code: string, actor = clerk) {
    const device = terminalDevice();
    const keyId = randomUUID();
    const { command, counterLabel } = await codes.redeemChallenge(
      actor,
      fx.mainBranchId,
      {
        code,
        keyId,
        publicKeyHex: device.publicKeyHex,
        label: "Code PC",
      },
    );
    return { device, command, counterLabel };
  }

  it("lets a cashier enroll the counter a manager issued a code for, once", async () => {
    const { id: registerId } = await counter("Code counter");
    const issued = await codes.issue(owner, fx.mainBranchId, { registerId });
    expect(issued.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/,
    );
    expect(issued.view.status).toBe("outstanding");
    const stored = await prisma.terminalEnrollmentCode.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: issued.view.codeId },
    });
    expect(stored.codeHash).not.toContain(issued.code.replace("-", ""));

    // Typed loosely at the counter: lower case and a space instead of the dash.
    const { device, command, counterLabel } = await redeem(
      issued.code.toLowerCase().replace("-", " "),
    );
    expect(counterLabel).toBe("Code counter");
    expect(command.registerId).toBe(registerId);
    const proof = await record(
      device,
      attestation(command, "enrollment", clerk),
      clerk,
    );
    const identity = await tx((c) =>
      trust.finishEnrollment(
        c,
        clerk,
        fx.mainBranchId,
        device.sign(command, command.identity.keyId),
        proof.proofId,
      ),
    );
    const enrollment = await prisma.terminalEnrollment.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: identity.enrollmentId },
    });
    expect(enrollment.enrolledByUserId).toBe(clerk.userId);
    const [listed] = (await codes.list(owner, fx.mainBranchId)).filter(
      (c) => c.codeId === issued.view.codeId,
    );
    expect(listed).toMatchObject({
      status: "used",
      usedByUserId: clerk.userId,
      enrollmentId: identity.enrollmentId,
    });

    await expect(redeem(issued.code)).rejects.toMatchObject({
      response: { code: "ENROLLMENT_CODE_INVALID" },
    });
  });

  it("409s a code finished after a manager enrolled another computer there, and enrolls nothing", async () => {
    const { id: registerId } = await counter("Raced counter");
    const issued = await codes.issue(owner, fx.mainBranchId, { registerId });
    const { device, command } = await redeem(issued.code);
    const proof = await record(
      device,
      attestation(command, "enrollment", clerk),
      clerk,
    );
    // Meanwhile a manager enrolls a different computer directly on the same counter.
    const other = terminalDevice();
    const direct = await beginEnrollment(other, registerId);
    const directProof = await record(
      other,
      attestation(direct, "enrollment", owner),
    );
    await tx((c) =>
      trust.finishEnrollment(
        c,
        owner,
        fx.mainBranchId,
        other.sign(direct, direct.identity.keyId),
        directProof.proofId,
      ),
    );
    await expect(
      tx((c) =>
        trust.finishEnrollment(
          c,
          clerk,
          fx.mainBranchId,
          device.sign(command, command.identity.keyId),
          proof.proofId,
        ),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "COUNTER_OCCUPIED" } });
    expect(
      await prisma.operationalTerminal.count({
        where: { tenantId: fx.tenantId, id: command.identity.terminalId },
      }),
    ).toBe(0);
    // And a fresh challenge for the occupied counter is refused up front.
    await expect(beginEnrollment(terminalDevice(), registerId)).rejects.toMatchObject({
      status: 409,
      response: { code: "COUNTER_OCCUPIED" },
    });
  });

  it("refuses a code revoked between redeeming and finishing, and enrolls nothing", async () => {
    const { id: registerId } = await counter("Revoked code counter");
    const issued = await codes.issue(owner, fx.mainBranchId, {
      registerId,
      expiresInMinutes: 5,
    });
    const { device, command } = await redeem(issued.code);
    const proof = await record(
      device,
      attestation(command, "enrollment", clerk),
      clerk,
    );
    await codes.revoke(owner, fx.mainBranchId, issued.view.codeId);
    await expect(
      tx((c) =>
        trust.finishEnrollment(
          c,
          clerk,
          fx.mainBranchId,
          device.sign(command, command.identity.keyId),
          proof.proofId,
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "ENROLLMENT_CODE_INVALID" } });
    expect(
      await prisma.operationalTerminal.count({
        where: { tenantId: fx.tenantId, id: command.identity.terminalId },
      }),
    ).toBe(0);
  });

  it("only managers issue codes, and never for an occupied counter or at another branch", async () => {
    const { registerId } = await enroll();
    await expect(
      codes.issue(owner, fx.mainBranchId, { registerId }),
    ).rejects.toMatchObject({
      response: { code: "COUNTER_OCCUPIED" },
    });
    const { id: free } = await counter("Free counter");
    await expect(
      codes.issue(clerk, fx.mainBranchId, { registerId: free }),
    ).rejects.toMatchObject({
      response: { code: "PERMISSION_DENIED" },
    });
    const issued = await codes.issue(owner, fx.mainBranchId, {
      registerId: free,
    });
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
          {
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            userId: fx.ownerId,
            role: RoleName.owner,
          },
          {
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            userId: fx.clerkId,
            role: RoleName.cashier,
          },
        ],
      });
      // tenant-scope: test fixture — the cashier's login password, for PIN changes.
      await prisma.appUser.update({
        where: { id: fx.clerkId },
        data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
      });
      expect(
        await counterEvidence(prisma, fx.tenantId, fx.mainBranchId),
      ).toEqual({ preparedStaff: 0, testReceipts: 0 });

      const { device, identity } = await enroll();
      const session = await openSession(device, identity, clerk);
      await credentials.setPin(clerk, fx.mainBranchId, session.workSessionId, {
        pin: "2580",
        password: PASSWORD,
      });
      await enrollmentService.recordTestReceipt(
        clerk,
        fx.mainBranchId,
        session.workSessionId,
        "Receipt printer",
      );
      expect(
        await counterEvidence(prisma, fx.tenantId, fx.mainBranchId),
      ).toEqual({ preparedStaff: 1, testReceipts: 1 });

      // An admin PIN reset makes the preparation stale; a revoked counter's receipt stops counting.
      // tenant-scope: test fixture — simulating the admin reset's version bump.
      await prisma.appUser.update({
        where: { id: fx.clerkId },
        data: { posPinVersion: { increment: 1 } },
      });
      await tx((c) =>
        trust.revokeEnrollment(
          c,
          owner,
          fx.mainBranchId,
          identity.enrollmentId,
          "Replaced",
        ),
      );
      expect(
        await counterEvidence(prisma, fx.tenantId, fx.mainBranchId),
      ).toEqual({ preparedStaff: 0, testReceipts: 0 });
    } finally {
      ({ fx, owner, clerk } = saved);
    }
  });
});

describe("GET enrollment status for This counter", () => {
  const branchNominationVersion = async (): Promise<number> => {
    const row = await prisma.offlineTerminalNomination.findUnique({
      where: { tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.mainBranchId } },
      select: { version: true },
    });
    return row?.version ?? 0;
  };

  const resetOfflineAssignment = async () => {
    // Assignment authorizations are retained (immutable evidence); revoke outstanding rows only.
    // Nomination rows are not cleared here; each test arranges branch nomination state (upsert or
    // read branchNominationVersion before authorize).
    await prisma.offlineTerminalAssignmentAuthorization.updateMany({
      where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, status: "authorized" },
      data: {
        status: "revoked",
        revokedAt: new Date(),
        revokedByUserId: fx.ownerId,
        revocationReason: "test reset",
      },
    });
  };

  beforeEach(resetOfflineAssignment);

  it("exposes counterLabel from TerminalCounter while label stays the device label", async () => {
    const device = terminalDevice();
    const tillHumanLabel = `Till display ${randomUUID().slice(0, 6)}`;
    const counterRow = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, tillHumanLabel));
    const challenge = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counterRow.id,
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
        label: "POS device name",
      }),
    );
    const proof = await record(device, attestation(challenge, "enrollment", owner));
    const identity = await tx((c) =>
      trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
    );
    const status = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId);
    expect(status.label).toBe("POS device name");
    expect(status.counterLabel).toBe(tillHumanLabel);
    expect(status.offlineBackup).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });

  it("does not leak another tenant's enrollment through enrollment status", async () => {
    const foreign = await createTenant(prisma, `foreign-${randomUUID().slice(0, 6)}`);
    await prisma.userBranchRole.create({
      data: {
        tenantId: foreign.tenantId,
        branchId: foreign.mainBranchId,
        userId: foreign.ownerId,
        role: RoleName.owner,
      },
    });
    const foreignOwner = user(foreign.ownerId);
    foreignOwner.tenantId = foreign.tenantId;
    const device = terminalDevice();
    const counterRow = await tx((c) => trust.createCounter(c, foreignOwner, foreign.mainBranchId, "Foreign"));
    const challenge = await tx((c) =>
      trust.beginEnrollment(c, foreignOwner, foreign.mainBranchId, {
        registerId: counterRow.id,
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
        label: "Foreign device",
      }),
    );
    const proof = await record(device, attestation(challenge, "enrollment", foreignOwner), foreignOwner, foreign.mainBranchId);
    const identity = await tx((c) =>
      trust.finishEnrollment(
        c,
        foreignOwner,
        foreign.mainBranchId,
        device.sign(challenge, challenge.identity.keyId),
        proof.proofId,
      ),
    );
    await expect(
      enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId),
    ).rejects.toThrow("Enrollment not found.");
  });

  it("returns offline backup authorization, activation, and full names for this enrollment only", async () => {
    const device = terminalDevice();
    const counterRow = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, "Desk A"));
    const challenge = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counterRow.id,
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
        label: "Unit under test",
      }),
    );
    const proof = await record(device, attestation(challenge, "enrollment", owner));
    const identity = await tx((c) =>
      trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
    );
    const other = await enroll();
    const authId = randomUUID();

    await prisma.offlineTerminalAssignmentAuthorization.create({
      data: {
        id: authId,
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        targetTerminalId: other.identity.terminalId,
        targetEnrollmentId: other.identity.enrollmentId,
        targetKeyId: other.identity.keyId,
        expectedNominationVersion: 0,
        reason: "Nomination auth",
        authorizedByUserId: fx.managerId,
        authority: "owner",
        authorizedAt: new Date("2019-06-01T00:00:00.000Z"),
        status: "consumed",
        consumedAt: new Date("2019-06-02T00:00:00.000Z"),
        consumedByUserId: fx.ownerId,
      },
    });

    await prisma.offlineTerminalNomination.upsert({
      where: {
        tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      },
      create: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        terminalId: other.identity.terminalId,
        enrollmentId: other.identity.enrollmentId,
        keyId: other.identity.keyId,
        version: 1,
        authorizationId: authId,
        activatedAt: new Date("2020-01-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
      update: {
        terminalId: other.identity.terminalId,
        enrollmentId: other.identity.enrollmentId,
        keyId: other.identity.keyId,
        version: 1,
        authorizationId: authId,
        activatedAt: new Date("2020-01-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
    });

    await offlineAssignments.authorize(owner, fx.mainBranchId, {
      authorizationId: randomUUID(),
      targetTerminalId: identity.terminalId,
      targetEnrollmentId: identity.enrollmentId,
      expectedNominationVersion: 1,
      reason: "Fixture authorization",
    });

    const ownerRow = await prisma.appUser.findUniqueOrThrow({ where: { id: fx.ownerId } });
    const managerRow = await prisma.appUser.findUniqueOrThrow({ where: { id: fx.managerId } });

    const assignmentView = await offlineAssignments.view(owner, fx.mainBranchId);
    expect(assignmentView.nomination).toMatchObject({
      enrollmentId: other.identity.enrollmentId,
      activatedByUserId: fx.ownerId,
      activatedByFullName: ownerRow.fullName,
    });

    const nominated = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, other.identity.enrollmentId);
    expect(nominated.offlineBackup).toEqual({
      authorizedAt: Date.parse("2019-06-01T00:00:00.000Z"),
      authorizedByUserId: fx.managerId,
      authorizedByFullName: managerRow.fullName,
      activatedAt: Date.parse("2020-01-01T00:00:00.000Z"),
      activatedByUserId: fx.ownerId,
      activatedByFullName: ownerRow.fullName,
    });

    const pending = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId);
    expect(pending.offlineBackup).toMatchObject({
      authorizedByUserId: fx.ownerId,
      authorizedByFullName: ownerRow.fullName,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
    expect(typeof pending.offlineBackup.authorizedAt).toBe("number");
  });

  it("does not surface a revoked outstanding authorization on enrollment status", async () => {
    const { identity } = await enroll();
    const authorizationId = randomUUID();
    const nominationVersion = await branchNominationVersion();
    await offlineAssignments.authorize(owner, fx.mainBranchId, {
      authorizationId,
      targetTerminalId: identity.terminalId,
      targetEnrollmentId: identity.enrollmentId,
      expectedNominationVersion: nominationVersion,
      reason: "Will revoke",
    });
    await offlineAssignments.revokeAuthorization(owner, fx.mainBranchId, authorizationId, "No longer needed");

    const status = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId);
    expect(status.offlineBackup).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });

  it("does not surface an outstanding authorization pinned to a stale nomination version", async () => {
    const nominated = await enroll();
    const { identity } = await enroll();
    const consumedAuthId = randomUUID();

    await prisma.offlineTerminalAssignmentAuthorization.create({
      data: {
        id: consumedAuthId,
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        targetTerminalId: nominated.identity.terminalId,
        targetEnrollmentId: nominated.identity.enrollmentId,
        targetKeyId: nominated.identity.keyId,
        expectedNominationVersion: 0,
        reason: "Consumed for nomination",
        authorizedByUserId: fx.ownerId,
        authority: "owner",
        authorizedAt: new Date("2019-01-01T00:00:00.000Z"),
        status: "consumed",
        consumedAt: new Date("2019-01-02T00:00:00.000Z"),
        consumedByUserId: fx.ownerId,
      },
    });

    await prisma.offlineTerminalNomination.upsert({
      where: {
        tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      },
      create: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        terminalId: nominated.identity.terminalId,
        enrollmentId: nominated.identity.enrollmentId,
        keyId: nominated.identity.keyId,
        version: 1,
        authorizationId: consumedAuthId,
        activatedAt: new Date("2019-06-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
      update: {
        terminalId: nominated.identity.terminalId,
        enrollmentId: nominated.identity.enrollmentId,
        keyId: nominated.identity.keyId,
        version: 1,
        authorizationId: consumedAuthId,
        activatedAt: new Date("2019-06-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
    });

    const staleAuthId = randomUUID();
    await prisma.offlineTerminalAssignmentAuthorization.create({
      data: {
        id: staleAuthId,
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        targetTerminalId: identity.terminalId,
        targetEnrollmentId: identity.enrollmentId,
        targetKeyId: identity.keyId,
        expectedNominationVersion: 0,
        reason: "Stale after nomination moved",
        authorizedByUserId: fx.ownerId,
        authority: "owner",
        authorizedAt: new Date("2020-01-01T00:00:00.000Z"),
        status: "authorized",
      },
    });

    const status = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId);
    expect(status.offlineBackup).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: null,
      activatedByUserId: null,
      activatedByFullName: null,
    });
  });

  it("omits authorization on the nomination path when the linked row is not consumed", async () => {
    const { identity } = await enroll();
    const authId = randomUUID();

    await prisma.offlineTerminalAssignmentAuthorization.create({
      data: {
        id: authId,
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        targetTerminalId: identity.terminalId,
        targetEnrollmentId: identity.enrollmentId,
        targetKeyId: identity.keyId,
        expectedNominationVersion: 0,
        reason: "Still authorized, not consumed",
        authorizedByUserId: fx.managerId,
        authority: "owner",
        authorizedAt: new Date("2018-06-01T00:00:00.000Z"),
        status: "authorized",
      },
    });

    await prisma.offlineTerminalNomination.upsert({
      where: {
        tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      },
      create: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        version: 1,
        authorizationId: authId,
        activatedAt: new Date("2018-07-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
      update: {
        terminalId: identity.terminalId,
        enrollmentId: identity.enrollmentId,
        keyId: identity.keyId,
        version: 1,
        authorizationId: authId,
        activatedAt: new Date("2018-07-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
    });

    const ownerRow = await prisma.appUser.findUniqueOrThrow({ where: { id: fx.ownerId } });

    const status = await enrollmentService.enrollmentStatus(owner, fx.mainBranchId, identity.enrollmentId);
    expect(status.offlineBackup).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: Date.parse("2018-07-01T00:00:00.000Z"),
      activatedByUserId: fx.ownerId,
      activatedByFullName: ownerRow.fullName,
    });
  });

  it("omits authorization on the nomination path when the linked consumed row targets another enrollment", async () => {
    const nominated = await enroll();
    const other = await enroll();
    const consumedForOther = randomUUID();

    await prisma.offlineTerminalAssignmentAuthorization.create({
      data: {
        id: consumedForOther,
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        targetTerminalId: other.identity.terminalId,
        targetEnrollmentId: other.identity.enrollmentId,
        targetKeyId: other.identity.keyId,
        expectedNominationVersion: 0,
        reason: "Belongs to another counter",
        authorizedByUserId: fx.managerId,
        authority: "owner",
        authorizedAt: new Date("2017-06-01T00:00:00.000Z"),
        status: "consumed",
        consumedAt: new Date("2017-06-02T00:00:00.000Z"),
        consumedByUserId: fx.ownerId,
      },
    });

    await prisma.offlineTerminalNomination.upsert({
      where: {
        tenantId_branchId: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
      },
      create: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        terminalId: nominated.identity.terminalId,
        enrollmentId: nominated.identity.enrollmentId,
        keyId: nominated.identity.keyId,
        version: 1,
        authorizationId: consumedForOther,
        activatedAt: new Date("2017-07-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
      update: {
        terminalId: nominated.identity.terminalId,
        enrollmentId: nominated.identity.enrollmentId,
        keyId: nominated.identity.keyId,
        version: 1,
        authorizationId: consumedForOther,
        activatedAt: new Date("2017-07-01T00:00:00.000Z"),
        activatedByUserId: fx.ownerId,
      },
    });

    const ownerRow = await prisma.appUser.findUniqueOrThrow({ where: { id: fx.ownerId } });

    const status = await enrollmentService.enrollmentStatus(
      owner,
      fx.mainBranchId,
      nominated.identity.enrollmentId,
    );
    expect(status.offlineBackup).toEqual({
      authorizedAt: null,
      authorizedByUserId: null,
      authorizedByFullName: null,
      activatedAt: Date.parse("2017-07-01T00:00:00.000Z"),
      activatedByUserId: fx.ownerId,
      activatedByFullName: ownerRow.fullName,
    });
  });
});

/** P2b #103: counter sales need the seller's open till shift; these suites open one directly. */
const shifts = new TillShiftsService(prisma as never, trust, new OperatingHoursEvidence(), access, audit, pinAlerts as unknown as PinAlerts);
async function openSellingSession(device: Device, identity: TerminalIdentity, actor: RequestUser) {
  const session = await openSession(device, identity, actor);
  await openTestShift(prisma, fx.tenantId, session.workSessionId);
  return session;
}

describe("online checkout attributed to the counter, till and staff session", () => {
  const stock = new StockService();
  const sales = new SalesService(
    prisma as never,
    audit,
    new TaxService({ get: () => "0" } as never),
    {} as never,
    { assertCanSell: async () => undefined } as never,
    stock,
    trust,
    new OperatingHoursEvidence(),
    undefined,
    undefined,
    shifts,
  );
  const sell = (
    actor: RequestUser,
    workSessionId: string | undefined,
    key: string,
  ) =>
    sales.checkout(
      fx.tenantId,
      fx.mainBranchId,
      actor.userId,
      [],
      {
        items: [{ productId: fx.productId, qty: 1, unitPrice: "15.00" }],
      } as never,
      key,
      workSessionId ? { user: actor, workSessionId } : undefined,
    );

  it("two counters race for the last unit: it sells once, on the counter and till that won", async () => {
    const batchId = await createStockedBatch(prisma, stock, fx, { qty: 1 });
    const a = await enroll();
    const b = await enroll();
    const sessionA = await openSellingSession(a.device, a.identity, clerk);
    const sessionB = await openSellingSession(b.device, b.identity, owner);
    const results = await Promise.allSettled([
      sell(clerk, sessionA.workSessionId, randomUUID()),
      sell(owner, sessionB.workSessionId, randomUUID()),
    ]);
    const won = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof sell>>> =>
        r.status === "fulfilled",
    );
    expect(won).toHaveLength(1);
    const sale = await prisma.sale.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: won[0]!.value!.id },
    });
    const expected =
      sale.soldBy === clerk.userId ? { a, s: sessionA } : { a: b, s: sessionB };
    expect(sale).toMatchObject({
      terminalId: expected.a.identity.terminalId,
      workSessionId: expected.s.workSessionId,
      tillId: expected.s.tillId,
    });
    const onHand = await prisma.batchStock.findFirst({
      where: { tenantId: fx.tenantId, batchId },
    });
    expect(onHand?.onHandQty).toBe(0);
  });

  it("a resend overlapping its first attempt replays that sale instead of failing on its stock", async () => {
    await createStockedBatch(prisma, stock, fx, { qty: 1 });
    const a = await enroll();
    const session = await openSellingSession(a.device, a.identity, clerk);
    const key = randomUUID();
    // Both start before either commits: without the in-transaction recheck the second would wait
    // on the batch lock and then fail on the unit the first just sold.
    const [first, second] = await Promise.all([
      sell(clerk, session.workSessionId, key),
      sell(clerk, session.workSessionId, key),
    ]);
    expect(second!.id).toBe(first!.id);
    expect(
      await prisma.sale.count({ where: { tenantId: fx.tenantId, soldBy: clerk.userId, workSessionId: session.workSessionId } }),
    ).toBe(1);
  });

  it("refuses a counter sale outside the branch's mandatory selling windows", async () => {
    await createStockedBatch(prisma, stock, fx, { qty: 5 });
    const a = await enroll();
    const session = await openSellingSession(a.device, a.identity, clerk);
    const before = await prisma.branch.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: fx.mainBranchId },
      select: { operatingHours: true, operatingHoursOrigin: true },
    });
    // `mandatory: []` means no selling at all, whatever the clock says. The row's shape check
    // requires an origin with any stored hours, and only editor-made hours may carry a limit.
    await prisma.branch.updateMany({
      where: { tenantId: fx.tenantId, id: fx.mainBranchId },
      data: {
        operatingHours: {
          schemaVersion: 1,
          weekly: Object.fromEntries(
            ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { mode: "open_24h" }]),
          ),
          exceptions: [],
          mandatory: [],
        },
        operatingHoursOrigin: "editor",
      },
    });
    try {
      await expect(sell(clerk, session.workSessionId, randomUUID())).rejects.toMatchObject({
        response: { code: "OUTSIDE_OPERATING_HOURS" },
      });
      expect(
        await prisma.sale.count({ where: { tenantId: fx.tenantId, workSessionId: session.workSessionId } }),
      ).toBe(0);
    } finally {
      await prisma.branch.updateMany({
        where: { tenantId: fx.tenantId, id: fx.mainBranchId },
        data: {
          operatingHours: before.operatingHours ?? Prisma.DbNull,
          operatingHoursOrigin: before.operatingHoursOrigin,
        },
      });
    }
  });

  it("refuses someone else's or a closed session, and sells nothing", async () => {
    await createStockedBatch(prisma, stock, fx, { qty: 5 });
    const { device, identity } = await enroll();
    const session = await openSellingSession(device, identity, clerk);
    await expect(
      sell(owner, session.workSessionId, randomUUID()),
    ).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    await tx((c) =>
      trust.endSession(c, clerk, fx.mainBranchId, session.workSessionId),
    );
    await expect(
      sell(clerk, session.workSessionId, randomUUID()),
    ).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    // Web POS sales stay unattributed.
    const web = await sell(clerk, undefined, randomUUID());
    expect(
      await prisma.sale.findFirstOrThrow({
        where: { tenantId: fx.tenantId, id: web!.id },
      }),
    ).toMatchObject({
      terminalId: null,
      tillId: null,
      workSessionId: null,
    });
  });
});

describe("a controlled sale dispensed by the seller alone at a counter (P1 #47)", () => {
  const stock = new StockService();
  const registrations = new PharmacistRegistrationService(prisma as never, access, audit);
  const sales = new SalesService(
    prisma as never,
    audit,
    new TaxService({ get: () => "0" } as never),
    new PharmacistApprovalService(
      prisma as never,
      audit,
      new PermissionsService(prisma as never, { get: () => 30 } as never),
      registrations,
      pinAlerts as unknown as PinAlerts,
    ),
    { assertCanSell: async () => undefined } as never,
    stock,
    trust,
    new OperatingHoursEvidence(),
    registrations,
    undefined,
    shifts,
  );

  it("needs the seller's own SLMC registration, checked on the counter's checkout transaction", async () => {
    const product = await prisma.product.create({
      data: {
        tenantId: fx.tenantId,
        sku: `CTRL-${randomUUID().slice(0, 6)}`,
        name: "Tramadol 50mg",
        rangeStatus: "RANGED",
        isControlled: true,
        requiresPrescription: true,
      },
    });
    const batchId = await createStockedBatch(prisma, stock, { ...fx, productId: product.id }, { qty: 5 });
    const prescription = await prisma.prescription.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        rxNumber: `RX-CTR-${randomUUID().slice(0, 6)}`,
        patientName: "Kamal Silva",
        doctorName: "Perera",
        issuedOn: new Date(),
        createdBy: fx.ownerId,
      },
    });
    const { device, identity } = await enroll();
    const session = await openSellingSession(device, identity, owner);
    // An owner dispenses alone by role; no role stands in for the registration.
    const sellAlone = () =>
      sales.checkout(
        fx.tenantId,
        fx.mainBranchId,
        owner.userId,
        [{ branchId: fx.mainBranchId, role: RoleName.owner }],
        { items: [{ productId: product.id, batchId, qty: 1, unitPrice: "15.00" }], prescriptionId: prescription.id },
        randomUUID(),
        { user: owner, workSessionId: session.workSessionId },
      );

    await expect(sellAlone()).rejects.toMatchObject({
      status: 403,
      response: { code: "SELLER_NOT_QUALIFIED", message: expect.stringContaining("no current SLMC registration") },
    });
    expect(await prisma.sale.count({ where: { tenantId: fx.tenantId, workSessionId: session.workSessionId } })).toBe(0);

    const row = await registrations.record(owner, fx.mainBranchId, {
      userId: owner.userId,
      slmcNumber: `OWN-CTR-${randomUUID().slice(0, 4)}`,
      expiresOn: businessDateKey("Asia/Colombo", new Date(Date.now() + 365 * 86_400_000)),
    });
    const sale = await sellAlone();
    expect(await prisma.sale.findFirstOrThrow({ where: { tenantId: fx.tenantId, id: sale!.id } })).toMatchObject({
      soldBy: owner.userId,
      dispensedBy: owner.userId,
      dispenserRegistrationId: row.id,
      terminalId: identity.terminalId,
      workSessionId: session.workSessionId,
    });
  });
});
