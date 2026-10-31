import { randomUUID } from "node:crypto";
import { Prisma, RoleName } from "@prisma/client";
import type {
  LocalAttendanceAttestation,
  OnlineTerminalCommand,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OfflineActivationClearance, OfflineActivationService } from "../../src/terminals/offline-activation.service";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

/** Revised D13 end to end with the production attendance verifier and real Ed25519 devices. */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
const assignments = new OfflineAssignmentService(prisma as never, access, audit);
const activation = new OfflineActivationService(prisma as never, trust, assignments, new OfflineActivationClearance(), audit);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });

let fx: TenantFixture;
let owner: RequestUser;
let manager: RequestUser;
let cashier: RequestUser;
type Device = ReturnType<typeof terminalDevice>;

function user(userId: string): RequestUser {
  return { userId, tenantId: fx.tenantId, tokenVersion: 0, email: "t@example.test", fullName: "T", authMethod: "bearer", branchRoles: [] };
}

function attest(
  challenge: TerminalEnrollmentCommand | TerminalSessionCommand | OnlineTerminalCommand<unknown>,
  purpose: LocalAttendanceAttestation["purpose"],
  actor: RequestUser,
): LocalAttendanceAttestation {
  const counter =
    challenge.kind === "terminal_enrollment"
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
const proof = (device: Device, a: LocalAttendanceAttestation, actor: RequestUser) =>
  proofs.record(actor, fx.mainBranchId, device.sign(a, a.identity.keyId, "attendance"));

async function enroll() {
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, "Counter"));
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId: counter.id,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "PC",
    }),
  );
  const p = await proof(device, attest(challenge, "enrollment", owner), owner);
  const identity = await tx((c) =>
    trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), p.proofId),
  );
  return { device, identity };
}

async function session(device: Device, identity: TerminalIdentity, actor: RequestUser) {
  const challenge = await tx((c) => trust.beginSession(c, actor, fx.mainBranchId, identity));
  const p = await proof(device, attest(challenge, "session", actor), actor);
  return tx((c) => trust.finishSession(c, actor, fx.mainBranchId, device.sign(challenge, identity.keyId), p.proofId));
}

async function authorize(identity: TerminalIdentity, expectedNominationVersion: number) {
  const authorizationId = randomUUID();
  await assignments.authorize(owner, fx.mainBranchId, {
    authorizationId,
    targetTerminalId: identity.terminalId,
    targetEnrollmentId: identity.enrollmentId,
    expectedNominationVersion,
    reason: "Front counter keeps selling during outages",
  });
  return authorizationId;
}

async function signedActivation(
  device: Device,
  identity: TerminalIdentity,
  workSessionId: string,
  authorizationId: string,
  expectedNominationVersion: number,
  actor = manager,
) {
  const command = await activation.prepare(actor, fx.mainBranchId, { workSessionId, authorizationId, expectedNominationVersion });
  const p = await proof(device, attest(command, "command", actor), actor);
  return { envelope: device.sign(command, identity.keyId), attendanceProofId: p.proofId };
}

const nomination = () => prisma.offlineTerminalNomination.findFirst({ where: { tenantId: fx.tenantId, branchId: fx.mainBranchId } });

beforeAll(async () => {
  fx = await createTenant(prisma, "offline-activation");
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
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("revised D13: remote authorization, local activation on the exact target", () => {
  let first: { device: Device; identity: TerminalIdentity };

  it("activates the authorized counter once, recording authorizer and activator separately", async () => {
    first = await enroll();
    const { workSessionId } = await session(first.device, first.identity, manager);
    const authorizationId = await authorize(first.identity, 0);

    await expect(
      activation.prepare(cashier, fx.mainBranchId, { workSessionId, authorizationId, expectedNominationVersion: 0 }),
    ).rejects.toMatchObject({ response: { code: "PERMISSION_DENIED" } });

    const request = await signedActivation(first.device, first.identity, workSessionId, authorizationId, 0);
    const result = await activation.activate(manager, fx.mainBranchId, request);
    expect(result).toMatchObject({
      enrollmentId: first.identity.enrollmentId,
      nominationVersion: 1,
      authorizedByUserId: owner.userId,
      activatedByUserId: manager.userId,
    });
    expect(await nomination()).toMatchObject({ enrollmentId: first.identity.enrollmentId, version: 1, activatedByUserId: manager.userId });
    const authorization = await prisma.offlineTerminalAssignmentAuthorization.findFirstOrThrow({
      where: { tenantId: fx.tenantId, id: authorizationId },
    });
    expect(authorization).toMatchObject({ status: "consumed", consumedByUserId: manager.userId });
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: fx.tenantId, eventName: "terminal.offline_activated" },
    });
    expect(event.actorUserId).toBe(manager.userId);
    expect(event.payload).toMatchObject({ authorizedByUserId: owner.userId, activatedByUserId: manager.userId, clearance: "initial_nomination" });

    // The same authorization cannot activate again.
    const again = await signedActivation(first.device, first.identity, workSessionId, authorizationId, 0);
    await expect(activation.activate(manager, fx.mainBranchId, again)).rejects.toMatchObject({
      response: { code: "OFFLINE_AUTHORIZATION_NOT_CURRENT" },
    });
  });

  it("refuses activation from a counter other than the authorized target", async () => {
    const other = await enroll();
    const authorizationId = await authorize(other.identity, 1);
    const { workSessionId } = await session(first.device, first.identity, manager);
    const request = await signedActivation(first.device, first.identity, workSessionId, authorizationId, 1);
    await expect(activation.activate(manager, fx.mainBranchId, request)).rejects.toMatchObject({
      response: { code: "OFFLINE_AUTHORIZATION_NOT_CURRENT" },
    });
    expect((await nomination())?.version).toBe(1);
  });

  it("will not replace the offline counter until D11 clearance exists, and fails closed without recovery evidence", async () => {
    const replacement = await enroll();
    const { workSessionId } = await session(replacement.device, replacement.identity, manager);
    const authorizationId = await authorize(replacement.identity, 1);
    let request = await signedActivation(replacement.device, replacement.identity, workSessionId, authorizationId, 1);
    await expect(activation.activate(manager, fx.mainBranchId, request)).rejects.toMatchObject({
      response: { code: "D11_CLEARANCE_REQUIRED", reason: "PREVIOUS_STILL_ACTIVE" },
    });

    await tx((c) => trust.revokeEnrollment(c, owner, fx.mainBranchId, first.identity.enrollmentId, "Lost"));
    const reopened = await session(replacement.device, replacement.identity, manager);
    request = await signedActivation(replacement.device, replacement.identity, reopened.workSessionId, authorizationId, 1);
    await expect(activation.activate(manager, fx.mainBranchId, request)).rejects.toMatchObject({
      response: { code: "D11_CLEARANCE_REQUIRED", reason: "OFFLINE_RECOVERY_EVIDENCE_REQUIRED" },
    });
    expect((await nomination())?.enrollmentId).toBe(first.identity.enrollmentId);

    // With recovery evidence (P3/P5's job), the replacement takes over at the next version.
    class Cleared extends OfflineActivationClearance {
      protected override async recoveryEvidence() {
        return true;
      }
    }
    const withEvidence = new OfflineActivationService(prisma as never, trust, assignments, new Cleared(), audit);
    request = await signedActivation(replacement.device, replacement.identity, reopened.workSessionId, authorizationId, 1);
    await expect(withEvidence.activate(manager, fx.mainBranchId, request)).resolves.toMatchObject({ nominationVersion: 2 });
  });

  it("concurrent activations produce one nomination", async () => {
    const fresh = await createTenant(prisma, "offline-activation-race");
    const saved = fx;
    fx = fresh;
    try {
      owner = user(fx.ownerId);
      manager = user(fx.managerId);
      await prisma.userBranchRole.createMany({
        data: [
          { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
          { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
        ],
      });
      const target = await enroll();
      const { workSessionId } = await session(target.device, target.identity, manager);
      const authorizationId = await authorize(target.identity, 0);
      const a = await signedActivation(target.device, target.identity, workSessionId, authorizationId, 0);
      const b = await signedActivation(target.device, target.identity, workSessionId, authorizationId, 0);
      const results = await Promise.allSettled([
        activation.activate(manager, fx.mainBranchId, a),
        activation.activate(manager, fx.mainBranchId, b),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await nomination())?.version).toBe(1);
    } finally {
      fx = saved;
      owner = user(fx.ownerId);
      manager = user(fx.managerId);
    }
  });
});
