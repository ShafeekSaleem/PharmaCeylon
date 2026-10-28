import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { TerminalEnrollmentCommand } from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { createTenantAwarePrismaProxy } from "../../src/prisma/tenant-aware-prisma.proxy";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { OfflineAssignmentService } from "../../src/terminals/offline-assignment.service";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, TenantFixture } from "./fixtures";

/** P1 #47 / revised D13: owner-controlled, remotely authorized offline-counter assignment. */
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
const assignments = new OfflineAssignmentService(proxy as never, access, audit);

let fx: TenantFixture;
let secondManagerId: string;
const user = (userId: string): RequestUser => ({
  userId,
  tenantId: fx.tenantId,
  tokenVersion: 0,
  branchRoles: [],
  email: "d13@it.test",
  fullName: "D13",
  authMethod: "bearer",
});
const tx = <T>(run: (c: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(run, { timeout: 15_000 });
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (e: { response?: { code?: string } }) => e.response?.code ?? String(e),
  );

async function enrolledTarget(branchId = fx.mainBranchId) {
  const owner = user(fx.ownerId);
  const device = terminalDevice();
  const counter = await tx((c) => trust.createCounter(c, owner, branchId, `Counter ${randomUUID().slice(0, 6)}`));
  const enrollment = await tx((c) =>
    trust.beginEnrollment(c, owner, branchId, { registerId: counter.id, label: "Desk", keyId: randomUUID(), publicKeyHex: device.publicKeyHex }),
  );
  return tx((c) =>
    trust.finishEnrollment(c, owner, branchId, device.sign(enrollment, enrollment.identity.keyId), attendance.allow(enrollment)),
  );
}
type Target = Awaited<ReturnType<typeof enrolledTarget>>;
const request = (target: Target, overrides: Record<string, unknown> = {}) => ({
  authorizationId: randomUUID(),
  targetTerminalId: target.terminalId,
  targetEnrollmentId: target.enrollmentId,
  expectedNominationVersion: 0,
  reason: "Front counter keeps selling during outages",
  ...overrides,
});
const rows = () =>
  prisma.offlineTerminalAssignmentAuthorization.findMany({
    where: { tenantId: fx.tenantId, branchId: fx.mainBranchId },
    orderBy: { authorizedAt: "asc" },
  });
async function resetBranch() {
  // Authorizations/delegations are retained by trigger; clear the outstanding state another test left.
  await prisma.offlineTerminalAssignmentAuthorization.updateMany({
    where: { tenantId: fx.tenantId, status: "authorized" },
    data: { status: "revoked", revokedAt: new Date(), revokedByUserId: fx.ownerId, revocationReason: "test reset" },
  });
  await prisma.offlineTerminalDelegation.updateMany({
    where: { tenantId: fx.tenantId, revokedAt: null },
    data: { revokedAt: new Date(), revokedByUserId: fx.ownerId, revocationReason: "test reset" },
  });
}

beforeAll(async () => {
  fx = await createTenant(prisma, "offline-assignment");
  const second = await prisma.appUser.create({
    data: { tenantId: fx.tenantId, email: `manager2-${randomUUID().slice(0, 8)}@it.test`, fullName: "Second manager", passwordHash: "x" },
  });
  secondManagerId = second.id;
  await prisma.tenantMembership.create({ data: { tenantId: fx.tenantId, userId: second.id } });
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: "owner" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: "manager" },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: secondManagerId, role: "manager" },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: "inventory_clerk" },
    ],
  });
});
beforeEach(resetBranch);
afterAll(() => prisma.$disconnect());

describe("assignment authorization", () => {
  it("lets an owner authorize one exact enrolled target, remotely and idempotently", async () => {
    const target = await enrolledTarget();
    const body = request(target);
    const view = await assignments.authorize(user(fx.ownerId), fx.mainBranchId, body);
    expect(view.nominationVersion).toBe(0);
    expect(view.authorizations[0]).toMatchObject({
      authorizationId: body.authorizationId,
      status: "authorized",
      authority: "owner",
      delegationId: null,
      targetEnrollmentId: target.enrollmentId,
      expectedNominationVersion: 0,
      authorizedByUserId: fx.ownerId,
    });
    await assignments.authorize(user(fx.ownerId), fx.mainBranchId, body);
    expect((await rows()).filter((r) => r.id === body.authorizationId)).toHaveLength(1);
    expect(
      await prisma.auditEvent.count({ where: { tenantId: fx.tenantId, entityId: body.authorizationId, eventName: "terminal.offline_assignment_authorized" } }),
    ).toBe(1);
    // Nothing is nominated by authorizing.
    expect(await prisma.offlineTerminalNomination.count({ where: { tenantId: fx.tenantId } })).toBe(0);
    await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, { ...body, reason: "Different" }))).resolves.toBe(
      "AUTHORIZATION_ID_CONFLICT",
    );
  });

  it("refuses a manager whose role allows branch management but who has no delegation", async () => {
    const target = await enrolledTarget();
    await expect(code(assignments.authorize(user(fx.managerId), fx.mainBranchId, request(target)))).resolves.toBe(
      "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
    );
    expect((await rows()).filter((r) => r.status === "authorized")).toHaveLength(0);
  });

  it("allows a delegated manager, records the delegation used, and supersedes the older authorization", async () => {
    const first = await enrolledTarget();
    const second = await enrolledTarget();
    const owners = request(first);
    await assignments.authorize(user(fx.ownerId), fx.mainBranchId, owners);
    const delegated = await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
    const delegation = delegated.delegations.find((d) => d.managerUserId === fx.managerId && d.revokedAt === null)!;
    expect(delegation.delegatedByOwnerUserId).toBe(fx.ownerId);
    const managers = request(second);
    const view = await assignments.authorize(user(fx.managerId), fx.mainBranchId, managers);
    expect(view.authorizations.filter((a) => a.status === "authorized")).toEqual([
      expect.objectContaining({ authorizationId: managers.authorizationId, authority: "delegated_manager", delegationId: delegation.delegationId }),
    ]);
    expect(view.authorizations.find((a) => a.authorizationId === owners.authorizationId)).toMatchObject({
      status: "revoked",
      revocationReason: `Superseded by ${managers.authorizationId}`,
    });
  });

  it("binds the expected nomination version and refuses re-authorizing the nominated counter", async () => {
    const target = await enrolledTarget();
    const enrollment = await prisma.terminalEnrollment.findUniqueOrThrow({ where: { id: target.enrollmentId } });
    await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, request(target, { expectedNominationVersion: 1 })))).resolves.toBe(
      "NOMINATION_VERSION_CHANGED",
    );
    const nominated = await prisma.offlineTerminalNomination.create({
      data: {
        tenantId: fx.tenantId,
        branchId: fx.mainBranchId,
        terminalId: target.terminalId,
        enrollmentId: target.enrollmentId,
        keyId: enrollment.keyId,
        version: 1,
        authorizationId: randomUUID(),
        activatedAt: new Date(),
        activatedByUserId: fx.managerId,
      },
    });
    try {
      await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, request(target)))).resolves.toBe("NOMINATION_VERSION_CHANGED");
      await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, request(target, { expectedNominationVersion: 1 })))).resolves.toBe(
        "OFFLINE_TARGET_ALREADY_NOMINATED",
      );
    } finally {
      await prisma.offlineTerminalNomination.delete({ where: { id: nominated.id } });
    }
  });

  it("refuses a revoked target and another branch's terminal", async () => {
    const revoked = await enrolledTarget();
    await tx((c) => trust.revokeEnrollment(c, user(fx.ownerId), fx.mainBranchId, revoked.enrollmentId, "Lost"));
    await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, request(revoked)))).resolves.toBe("OFFLINE_TARGET_INVALID");
    const elsewhere = await enrolledTarget(fx.otherBranchId);
    await expect(code(assignments.authorize(user(fx.ownerId), fx.mainBranchId, request(elsewhere)))).resolves.toBe("OFFLINE_TARGET_INVALID");
  });

  it("requires a live sign-in: a changed token version cannot authorize", async () => {
    const target = await enrolledTarget();
    await expect(
      code(assignments.authorize({ ...user(fx.ownerId), tokenVersion: 7 }, fx.mainBranchId, request(target))),
    ).resolves.toMatch(/Live branch authentication required/);
  });
});

describe("delegation", () => {
  it("is owner-only, per branch, and never onward", async () => {
    await expect(code(assignments.delegate(user(fx.managerId), fx.mainBranchId, secondManagerId))).resolves.toBe("OFFLINE_ASSIGNMENT_OWNER_ONLY");
    // A manager at another branch is not eligible here; a clerk without branch management is not.
    await expect(code(assignments.delegate(user(fx.ownerId), fx.mainBranchId, secondManagerId))).resolves.toBe("OFFLINE_DELEGATE_INELIGIBLE");
    await expect(code(assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.clerkId))).resolves.toBe("OFFLINE_DELEGATE_INELIGIBLE");
    // Delegated at one branch only.
    await assignments.delegate(user(fx.ownerId), fx.otherBranchId, secondManagerId);
    const target = await enrolledTarget();
    await expect(code(assignments.authorize(user(secondManagerId), fx.mainBranchId, request(target)))).resolves.toMatch(
      /No current branch assignment|OFFLINE_ASSIGNMENT_NOT_DELEGATED/,
    );
  });

  it("is idempotent and recorded once", async () => {
    await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
    const view = await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
    expect(view.delegations.filter((d) => d.managerUserId === fx.managerId && d.revokedAt === null)).toHaveLength(1);
  });

  it("revoking it revokes the delegate's outstanding authorization", async () => {
    const view = await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
    const delegationId = view.delegations.find((d) => d.revokedAt === null)!.delegationId;
    const body = request(await enrolledTarget());
    await assignments.authorize(user(fx.managerId), fx.mainBranchId, body);
    const after = await assignments.revokeDelegation(user(fx.ownerId), fx.mainBranchId, delegationId, "Left the branch");
    expect(after.authorizations.find((a) => a.authorizationId === body.authorizationId)).toMatchObject({
      status: "revoked",
      revocationReason: "Delegation revoked",
    });
    await expect(code(assignments.authorize(user(fx.managerId), fx.mainBranchId, request(await enrolledTarget())))).resolves.toBe(
      "OFFLINE_ASSIGNMENT_NOT_DELEGATED",
    );
  });
});

describe("activation-time revalidation (requireCurrent)", () => {
  const current = (body: ReturnType<typeof request>) =>
    tx((c) =>
      assignments.requireCurrent(c, fx.tenantId, fx.mainBranchId, {
        authorizationId: body.authorizationId,
        targetEnrollmentId: body.targetEnrollmentId,
        expectedNominationVersion: body.expectedNominationVersion,
      }),
    );

  it("accepts a current authorization and refuses another target or version", async () => {
    const body = request(await enrolledTarget());
    await assignments.authorize(user(fx.ownerId), fx.mainBranchId, body);
    await expect(current(body)).resolves.toMatchObject({ id: body.authorizationId });
    await expect(code(current({ ...body, targetEnrollmentId: randomUUID() }))).resolves.toBe("OFFLINE_AUTHORIZATION_NOT_CURRENT");
    await expect(code(current({ ...body, expectedNominationVersion: 1 }))).resolves.toBe("OFFLINE_AUTHORIZATION_NOT_CURRENT");
  });

  it("stops honouring a delegated authorization when the delegate's role edit removes branch management", async () => {
    await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
    const body = request(await enrolledTarget());
    await assignments.authorize(user(fx.managerId), fx.mainBranchId, body);
    const role = await prisma.userBranchRole.findFirstOrThrow({
      where: { tenantId: fx.tenantId, userId: fx.managerId, branchId: fx.mainBranchId },
    });
    await prisma.userBranchRole.update({ where: { id: role.id }, data: { role: "cashier" } });
    try {
      await expect(code(current(body))).resolves.toBe("OFFLINE_AUTHORIZATION_NOT_CURRENT");
    } finally {
      await prisma.userBranchRole.update({ where: { id: role.id }, data: { role: "manager" } });
    }
    await expect(current(body)).resolves.toMatchObject({ id: body.authorizationId });
  });

  it("refuses a revoked authorization and a target revoked after authorization", async () => {
    const body = request(await enrolledTarget());
    await assignments.authorize(user(fx.ownerId), fx.mainBranchId, body);
    await tx((c) => trust.revokeEnrollment(c, user(fx.ownerId), fx.mainBranchId, body.targetEnrollmentId, "Stolen"));
    await expect(code(current(body))).resolves.toBe("OFFLINE_AUTHORIZATION_NOT_CURRENT");
    const other = request(await enrolledTarget());
    await assignments.authorize(user(fx.ownerId), fx.mainBranchId, other);
    await assignments.revokeAuthorization(user(fx.ownerId), fx.mainBranchId, other.authorizationId, "Changed our mind");
    await expect(code(current(other))).resolves.toBe("OFFLINE_AUTHORIZATION_NOT_CURRENT");
  });
});

it("retains authority evidence: content is immutable and nothing is deleted", async () => {
  const view = await assignments.delegate(user(fx.ownerId), fx.mainBranchId, fx.managerId);
  const delegationId = view.delegations.find((d) => d.revokedAt === null)!.delegationId;
  await expect(prisma.offlineTerminalDelegation.delete({ where: { id: delegationId } })).rejects.toThrow(/retained/);
  await expect(
    prisma.offlineTerminalDelegation.update({ where: { id: delegationId }, data: { managerUserId: fx.clerkId } }),
  ).rejects.toThrow(/immutable/);
  const body = request(await enrolledTarget());
  await assignments.authorize(user(fx.ownerId), fx.mainBranchId, body);
  await expect(
    prisma.offlineTerminalAssignmentAuthorization.update({ where: { id: body.authorizationId }, data: { reason: "Edited" } }),
  ).rejects.toThrow(/immutable/);
  await assignments.revokeAuthorization(user(fx.ownerId), fx.mainBranchId, body.authorizationId, "Done");
  await expect(
    prisma.offlineTerminalAssignmentAuthorization.update({
      where: { id: body.authorizationId },
      data: { status: "authorized", revokedAt: null, revokedByUserId: null, revocationReason: null },
    }),
  ).rejects.toThrow(/immutable/);
});
