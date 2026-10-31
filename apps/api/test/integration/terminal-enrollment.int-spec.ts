import { randomUUID } from "node:crypto";
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
