import { randomUUID } from "node:crypto";
import { Prisma, RoleName } from "@prisma/client";
import type {
  OnlineTerminalCommand,
  TerminalIdentity,
  TerminalEnrollmentCommand,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AuditService } from "../../src/audit/audit.service";
import {
  LocalAttendanceVerifier,
  type AttendanceExpectation,
} from "../../src/terminals/local-attendance.verifier";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import {
  boundedCanonical,
  object,
  sha256,
} from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
let fx: TenantFixture;
let owner: RequestUser;
let clerk: RequestUser;

/** Test-only independent attendance authority. No permissive adapter ships in application code. */
class FixtureAttendance extends LocalAttendanceVerifier {
  readonly proofs = new Map<string, AttendanceExpectation>();
  allow(
    p:
      | TerminalEnrollmentCommand
      | TerminalSessionCommand
      | OnlineTerminalCommand<unknown>,
    purpose: AttendanceExpectation["purpose"],
  ) {
    const id = randomUUID();
    this.proofs.set(id, {
      purpose,
      identity: p.identity,
      actorUserId:
        "requestedByUserId" in p ? p.requestedByUserId : p.session.staffUserId,
      registerId: "registerId" in p ? p.registerId : p.session.registerId,
      tillId: "tillId" in p ? p.tillId : p.session.tillId,
      payloadDigest: sha256(boundedCanonical(p)),
    });
    return id;
  }
  override async verify(
    _tx: Prisma.TransactionClient,
    proofId: string,
    expected: AttendanceExpectation,
  ) {
    if (
      boundedCanonical(this.proofs.get(proofId) ?? {}) !==
      boundedCanonical(expected)
    )
      throw new Error("Unverified attendance");
    return proofId;
  }
}
const attendance = new FixtureAttendance();
const trust = new TerminalTrustService(access, audit, attendance);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });
const descriptor = {
  operation: "POST /api/v1/inventory/adjustments",
  permission: "inventory.manage",
  parseBody(raw: unknown) {
    const body = object(raw, ["quantity"]);
    if (!Number.isSafeInteger(body.quantity) || (body.quantity as number) <= 0)
      throw new Error("Invalid quantity");
    return body as { quantity: number };
  },
};
async function deviceSetup() {
  const device = terminalDevice();
  const counter = await tx((c) =>
    trust.createCounter(c, owner, fx.mainBranchId, "Counter"),
  );
  const enrollment = await tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId: counter.id,
      label: "Terminal",
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
    }),
  );
  const identity = await tx((c) =>
    trust.finishEnrollment(
      c,
      owner,
      fx.mainBranchId,
      device.sign(enrollment, enrollment.identity.keyId),
      attendance.allow(enrollment, "enrollment"),
    ),
  );
  const sessionPayload = await tx((c) =>
    trust.beginSession(c, owner, fx.mainBranchId, identity),
  );
  const session = await tx((c) =>
    trust.finishSession(
      c,
      owner,
      fx.mainBranchId,
      device.sign(sessionPayload, identity.keyId),
      attendance.allow(sessionPayload, "session"),
    ),
  );
  return { device, counter, identity, session };
}
async function prepared() {
  const setup = await deviceSetup();
  const payload = await tx((c) =>
    trust.prepareCommand(
      c,
      owner,
      fx.mainBranchId,
      setup.session.workSessionId,
      descriptor,
      { quantity: 1 },
    ),
  );
  return {
    ...setup,
    payload,
    signed: setup.device.sign(payload, setup.identity.keyId),
    proof: attendance.allow(payload, "command"),
  };
}
function user(userId: string): RequestUser {
  // Deliberately empty cached branch roles: live authorization must query the database.
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

/** Prove PostgreSQL has blocked the operation behind this enrollment before changing
 * authority on another connection. No mocked access/lock responses or timing sleeps.
 */
async function changeAuthorityWhileWaiting<T>(
  identity: TerminalIdentity,
  operation: (client: Prisma.TransactionClient) => Promise<T>,
  changeAuthority: () => Promise<unknown>,
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lockReady!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => {
    lockReady = resolve;
  });
  const blocker = tx(async (c) => {
    const [{ pid }] = await c.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    await c.$queryRaw`SELECT id FROM terminal_enrollment WHERE tenant_id = ${identity.tenantId}::uuid
      AND branch_id = ${identity.branchId}::uuid AND id = ${identity.enrollmentId}::uuid FOR UPDATE`;
    lockReady(pid);
    await gate;
  });
  let pending: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    const blockerPid = await Promise.race([
      ready,
      blocker.then(() => {
        throw new Error("Lock holder exited before ready");
      }),
    ]);
    let operationReady!: (pid: number) => void;
    const operationPid = new Promise<number>((resolve) => {
      operationReady = resolve;
    });
    pending = Promise.allSettled([
      tx(async (c) => {
        const [{ pid }] = await c.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        operationReady(pid);
        return operation(c);
      }),
    ]);
    const pid = await operationPid;
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [{ blocked }] = await prisma.$queryRaw<{ blocked: boolean }[]>`
        SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${pid}::int)) AS blocked`;
      if (blocked) break;
      if (Date.now() >= deadline)
        throw new Error("Operation did not wait on the enrollment lock");
    }
    await changeAuthority();
  } finally {
    release();
    await blocker;
    // Drain even on a failed assertion/change so fixture cleanup cannot race the operation.
    if (pending) await pending;
  }
  return (await pending!)[0];
}

beforeAll(async () => {
  fx = await createTenant(prisma, "terminal-trust");
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
        role: RoleName.inventory_clerk,
      },
    ],
  });
});
afterAll(async () => {
  await prisma.$disconnect();
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("P1 terminal verification with real PostgreSQL and Ed25519 devices", () => {
  it.each([
    "beginSession",
    "finishSession",
    "prepareCommand",
    "verifyCommand",
    "endSession",
    "revokeEnrollment",
    "retireTerminal",
  ] as const)(
    "%s rejects a token-version bump committed during its enrollment lock wait",
    async (method) => {
      const p = await prepared();
      let sessionPayload: TerminalSessionCommand | undefined;
      if (method === "finishSession") {
        await tx((c) =>
          trust.endSession(c, owner, fx.mainBranchId, p.session.workSessionId),
        );
        sessionPayload = await tx((c) =>
          trust.beginSession(c, owner, fx.mainBranchId, p.identity),
        );
      }
      const beforeChallenges = await prisma.terminalChallenge.count({
        where: { tenantId: fx.tenantId },
      });
      const beforeSessions = await prisma.terminalStaffSession.count({
        where: { tenantId: fx.tenantId },
      });
      const beforeAudits = await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId },
      });
      try {
        const result = await changeAuthorityWhileWaiting(
          p.identity,
          async (c) => {
            if (method === "beginSession")
              return trust.beginSession(c, owner, fx.mainBranchId, p.identity);
            if (method === "finishSession")
              return trust.finishSession(
                c,
                owner,
                fx.mainBranchId,
                p.device.sign(sessionPayload!, p.identity.keyId),
                attendance.allow(sessionPayload!, "session"),
              );
            if (method === "prepareCommand")
              return trust.prepareCommand(
                c,
                owner,
                fx.mainBranchId,
                p.session.workSessionId,
                descriptor,
                { quantity: 1 },
              );
            if (method === "endSession")
              return trust.endSession(
                c,
                owner,
                fx.mainBranchId,
                p.session.workSessionId,
              );
            if (method === "revokeEnrollment")
              return trust.revokeEnrollment(
                c,
                owner,
                fx.mainBranchId,
                p.identity.enrollmentId,
                "Authority race",
              );
            if (method === "retireTerminal")
              return trust.retireTerminal(
                c,
                owner,
                fx.mainBranchId,
                p.identity.terminalId,
                "Authority race",
              );
            return trust.verifyCommand(
              c,
              owner,
              fx.mainBranchId,
              descriptor,
              p.signed,
              p.proof,
            );
          },
          () =>
            prisma.appUser.update({
              where: { id: fx.ownerId },
              data: { tokenVersion: { increment: 1 } },
            }),
        );
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason.message).toBe(
            "Live branch authentication required",
          );
        expect(
          await prisma.terminalChallenge.count({
            where: { tenantId: fx.tenantId },
          }),
        ).toBe(beforeChallenges);
        expect(
          await prisma.terminalStaffSession.count({
            where: { tenantId: fx.tenantId },
          }),
        ).toBe(beforeSessions);
        expect(
          await prisma.auditEvent.count({ where: { tenantId: fx.tenantId } }),
        ).toBe(beforeAudits);
        expect(
          (
            await prisma.terminalStaffSession.findUniqueOrThrow({
              where: { id: p.session.workSessionId },
            })
          ).closedAt !== null,
        ).toBe(method === "finishSession");
        const nonce = sessionPayload?.serverNonce ?? p.payload.serverNonce;
        expect(
          (
            await prisma.terminalChallenge.findUniqueOrThrow({
              where: { nonceHash: sha256(nonce) },
            })
          ).consumedAt,
        ).toBeNull();
      } finally {
        await prisma.appUser.update({
          where: { id: fx.ownerId },
          data: { tokenVersion: owner.tokenVersion },
        });
      }
    },
  );

  it("rejects an empty server permission descriptor rather than skipping authorization", async () => {
    const p = await prepared();
    await expect(
      tx((c) =>
        trust.prepareCommand(
          c,
          owner,
          fx.mainBranchId,
          p.session.workSessionId,
          { ...descriptor, permission: "" },
          { quantity: 1 },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          { ...descriptor, permission: "" },
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
  });

  it("enrolls, binds the authenticated staff/counter/drawer and verifies one scoped command", async () => {
    const p = await prepared();
    const verified = await tx((c) =>
      trust.verifyCommand(
        c,
        owner,
        fx.mainBranchId,
        descriptor,
        p.signed,
        p.proof,
      ),
    );
    expect(verified.command.identity).toEqual(p.identity);
    expect(verified.command.session.registerId).toBe(p.counter.id);
    expect(verified.command.session.tillId).toBe(p.counter.tillId);
    expect(verified.digest).toBe(sha256(boundedCanonical(p.payload)));
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
  });

  it("default production attendance denies owner enrollment and preserves the unconsumed challenge", async () => {
    const device = terminalDevice();
    const counter = await tx((c) =>
      trust.createCounter(c, owner, fx.mainBranchId, "Blocked"),
    );
    const p = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counter.id,
        label: "Blocked",
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
      }),
    );
    const closed = new TerminalTrustService(
      access,
      audit,
      new LocalAttendanceVerifier(),
    );
    await expect(
      tx((c) =>
        closed.finishEnrollment(
          c,
          owner,
          fx.mainBranchId,
          device.sign(p, p.identity.keyId),
          "local=true",
        ),
      ),
    ).rejects.toThrow();
    expect(
      await prisma.operationalTerminal.count({
        where: { tenantId: fx.tenantId, id: p.identity.terminalId },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.terminalChallenge.findUniqueOrThrow({
          where: { nonceHash: sha256(p.serverNonce) },
        })
      ).consumedAt,
    ).toBeNull();
  });

  it("requires possession of the challenge's candidate enrollment key", async () => {
    const candidate = terminalDevice();
    const attacker = terminalDevice();
    const counter = await tx((c) =>
      trust.createCounter(c, owner, fx.mainBranchId, "Candidate"),
    );
    const p = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counter.id,
        label: "Candidate",
        keyId: randomUUID(),
        publicKeyHex: candidate.publicKeyHex,
      }),
    );
    await expect(
      tx((c) =>
        trust.finishEnrollment(
          c,
          owner,
          fx.mainBranchId,
          attacker.sign(p, p.identity.keyId),
          attendance.allow(p, "enrollment"),
        ),
      ),
    ).rejects.toThrow();
    expect(
      await prisma.terminalEnrollment.count({
        where: { tenantId: fx.tenantId, id: p.identity.enrollmentId },
      }),
    ).toBe(0);
  });

  it("rejects another key, another branch, another authenticated staff member and another operation", async () => {
    const p = await prepared();
    const attacker = terminalDevice();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          attacker.sign(p.payload, p.identity.keyId),
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.otherBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          clerk,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          { ...descriptor, operation: "POST /api/v1/transfers" },
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects identity, drawer, staff, nonce, evidence and payload substitutions even when re-signed", async () => {
    const p = await prepared();
    const changes = [
      { ...p.payload, identity: { ...p.identity, tenantId: randomUUID() } },
      { ...p.payload, session: { ...p.payload.session, tillId: randomUUID() } },
      {
        ...p.payload,
        session: { ...p.payload.session, staffUserId: fx.clerkId },
      },
      { ...p.payload, serverNonce: "f".repeat(64) },
      { ...p.payload, body: { quantity: 2 } },
      { ...p.payload, approvalEvidenceId: randomUUID() },
    ];
    for (const changed of changes)
      await expect(
        tx((c) =>
          trust.verifyCommand(
            c,
            owner,
            fx.mainBranchId,
            descriptor,
            p.device.sign(changed, p.identity.keyId),
            p.proof,
          ),
        ),
      ).rejects.toThrow();
    // Rejected substitutions do not burn the original nonce.
    await tx((c) =>
      trust.verifyCommand(
        c,
        owner,
        fx.mainBranchId,
        descriptor,
        p.signed,
        p.proof,
      ),
    );
  });

  it("rejects unknown/remote attendance evidence including for an owner", async () => {
    const p = await prepared();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          "remote-desktop",
        ),
      ),
    ).rejects.toThrow("Unverified attendance");
    const q = await prepared();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          q.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow("Unverified attendance");
  });

  it("rejects expiry and a caller-selected time window", async () => {
    const p = await prepared();
    jest.spyOn(Date, "now").mockReturnValue(p.payload.expiresAt + 1);
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    jest.restoreAllMocks();
    const changed = { ...p.payload, expiresAt: p.payload.expiresAt + 1 };
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.device.sign(changed, p.identity.keyId),
          attendance.allow(changed, "command"),
        ),
      ),
    ).rejects.toThrow();
  });

  it("consumes a challenge only once under concurrent verification", async () => {
    const p = await prepared();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        tx((c) =>
          trust.verifyCommand(
            c,
            owner,
            fx.mainBranchId,
            descriptor,
            p.signed,
            p.proof,
          ),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("rolls back consumed nonce and success audit with a downstream failure", async () => {
    const p = await prepared();
    const auditId = randomUUID();
    await expect(
      tx(async (c) => {
        await trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        );
        await c.auditEvent.create({
          data: {
            id: auditId,
            tenantId: fx.tenantId,
            branchId: fx.mainBranchId,
            actorUserId: fx.ownerId,
            eventName: "test.command",
            entityName: "terminal",
            entityId: p.identity.terminalId,
          },
        });
        throw new Error("Downstream execution failed");
      }),
    ).rejects.toThrow("Downstream execution failed");
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId, id: auditId },
      }),
    ).toBe(0);
    await tx((c) =>
      trust.verifyCommand(
        c,
        owner,
        fx.mainBranchId,
        descriptor,
        p.signed,
        p.proof,
      ),
    );
  });

  it("rolls back enrollment and nonce if its success audit fails", async () => {
    const device = terminalDevice();
    const counter = await tx((c) =>
      trust.createCounter(c, owner, fx.mainBranchId, "Audit rollback"),
    );
    const p = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: counter.id,
        label: "Rollback",
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
      }),
    );
    const failingAudit = new AuditService(prisma as never);
    jest
      .spyOn(failingAudit, "log")
      .mockRejectedValue(new Error("Audit unavailable"));
    const failing = new TerminalTrustService(access, failingAudit, attendance);
    await expect(
      tx((c) =>
        failing.finishEnrollment(
          c,
          owner,
          fx.mainBranchId,
          device.sign(p, p.identity.keyId),
          attendance.allow(p, "enrollment"),
        ),
      ),
    ).rejects.toThrow("Audit unavailable");
    expect(
      await prisma.operationalTerminal.count({
        where: { tenantId: fx.tenantId, id: p.identity.terminalId },
      }),
    ).toBe(0);
    await tx((c) =>
      trust.finishEnrollment(
        c,
        owner,
        fx.mainBranchId,
        device.sign(p, p.identity.keyId),
        attendance.allow(p, "enrollment"),
      ),
    );
  });

  it("revocation closes staff bindings and blocks previously prepared commands without deleting history", async () => {
    const p = await prepared();
    await tx((c) =>
      trust.revokeEnrollment(
        c,
        owner,
        fx.mainBranchId,
        p.identity.enrollmentId,
        "Lost device",
      ),
    );
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    expect(
      (
        await prisma.terminalStaffSession.findFirstOrThrow({
          where: { tenantId: fx.tenantId, id: p.session.workSessionId },
        })
      ).closedAt,
    ).not.toBeNull();
    expect(
      await prisma.terminalEnrollment.count({
        where: { tenantId: fx.tenantId, id: p.identity.enrollmentId },
      }),
    ).toBe(1);
    await expect(
      tx((c) => trust.beginSession(c, owner, fx.mainBranchId, p.identity)),
    ).rejects.toThrow();
  });

  it("enrollment lock makes a revocation that wins the race block verification", async () => {
    const p = await prepared();
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = tx(async (c) => {
      await trust.revokeEnrollment(
        c,
        owner,
        fx.mainBranchId,
        p.identity.enrollmentId,
        "Race test",
      );
      locked();
      await gate;
    });
    await hasLock;
    const verification = expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    release();
    await revoke;
    await verification;
  });

  it("rejects a closed staff session and permits a new binding on the same counter", async () => {
    const p = await prepared();
    await tx((c) =>
      trust.endSession(c, owner, fx.mainBranchId, p.session.workSessionId),
    );
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          owner,
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    const next = await tx((c) =>
      trust.beginSession(c, owner, fx.mainBranchId, p.identity),
    );
    await tx((c) =>
      trust.finishSession(
        c,
        owner,
        fx.mainBranchId,
        p.device.sign(next, p.identity.keyId),
        attendance.allow(next, "session"),
      ),
    );
  });

  it("retirement frees the online counter for replacement without issuing offline authority", async () => {
    const p = await deviceSetup();
    await tx((c) =>
      trust.retireTerminal(
        c,
        owner,
        fx.mainBranchId,
        p.identity.terminalId,
        "Replace device",
      ),
    );
    const device = terminalDevice();
    const next = await tx((c) =>
      trust.beginEnrollment(c, owner, fx.mainBranchId, {
        registerId: p.counter.id,
        label: "Replacement",
        keyId: randomUUID(),
        publicKeyHex: device.publicKeyHex,
      }),
    );
    await tx((c) =>
      trust.finishEnrollment(
        c,
        owner,
        fx.mainBranchId,
        device.sign(next, next.identity.keyId),
        attendance.allow(next, "enrollment"),
      ),
    );
    expect(
      await prisma.operationalTerminal.count({
        where: { tenantId: fx.tenantId, registerId: p.counter.id },
      }),
    ).toBe(2);
  });

  it("database constraints preserve counter, staff and exact challenge history", async () => {
    const p = await prepared();
    await expect(
      prisma.operationalTerminal.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          label: "Duplicate",
          registerId: p.counter.id,
          tillId: p.counter.tillId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.operationalTerminal.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.otherBranchId,
          label: "Wrong branch",
          registerId: p.counter.id,
          tillId: p.counter.tillId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalCounter.update({
        where: { id: p.counter.id },
        data: { tillId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalStaffSession.update({
        where: { id: p.session.workSessionId },
        data: { staffUserId: fx.clerkId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalStaffSession.create({
        data: {
          tenantId: fx.tenantId,
          branchId: fx.mainBranchId,
          terminalId: p.identity.terminalId,
          enrollmentId: p.identity.enrollmentId,
          keyId: p.identity.keyId,
          registerId: p.counter.id,
          tillId: p.counter.tillId,
          staffUserId: fx.clerkId,
          tokenVersion: 0,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalChallenge.update({
        where: { nonceHash: sha256(p.payload.serverNonce) },
        data: { payloadDigest: "a".repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.terminalChallenge.delete({
        where: { nonceHash: sha256(p.payload.serverNonce) },
      }),
    ).rejects.toThrow();
    // Rejected ordinary database writes cannot poison the original authorization.
    await tx((c) =>
      trust.verifyCommand(
        c,
        owner,
        fx.mainBranchId,
        descriptor,
        p.signed,
        p.proof,
      ),
    );
  });

  it("rechecks membership, token version and branch roles rather than cached owner claims", async () => {
    const p = await prepared();
    await expect(
      tx((c) =>
        trust.verifyCommand(
          c,
          { ...owner, tokenVersion: 999 },
          fx.mainBranchId,
          descriptor,
          p.signed,
          p.proof,
        ),
      ),
    ).rejects.toThrow();
    const staleOwner = {
      ...clerk,
      branchRoles: [{ branchId: fx.mainBranchId, role: RoleName.owner }],
    };
    await expect(
      tx((c) =>
        trust.createCounter(c, staleOwner, fx.mainBranchId, "Unauthorized"),
      ),
    ).rejects.toThrow();
    await prisma.tenantMembership.updateMany({
      where: { tenantId: fx.tenantId, userId: fx.ownerId },
      data: { isActive: false },
    });
    try {
      await expect(
        tx((c) =>
          trust.verifyCommand(
            c,
            owner,
            fx.mainBranchId,
            descriptor,
            p.signed,
            p.proof,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await prisma.tenantMembership.updateMany({
        where: { tenantId: fx.tenantId, userId: fx.ownerId },
        data: { isActive: true },
      });
    }
  });

  it("rejects a custom permission removed during verification's enrollment lock wait", async () => {
    const p = await deviceSetup();
    await tx((c) =>
      trust.endSession(c, owner, fx.mainBranchId, p.session.workSessionId),
    );
    await prisma.permission.upsert({
      where: { key: "inventory.manage" },
      update: {},
      create: {
        key: "inventory.manage",
        module: "inventory",
        label: "Manage inventory",
        description: "Test permission",
      },
    });
    const role = await prisma.role.create({
      data: {
        tenantId: fx.tenantId,
        key: randomUUID(),
        name: "Custom inventory operator",
        permissions: {
          create: { tenantId: fx.tenantId, permissionKey: "inventory.manage" },
        },
      },
    });
    await prisma.userBranchRole.updateMany({
      where: {
        tenantId: fx.tenantId,
        userId: fx.clerkId,
        branchId: fx.mainBranchId,
      },
      data: { role: RoleName.custom, roleId: role.id },
    });
    try {
      const next = await tx((c) =>
        trust.beginSession(c, clerk, fx.mainBranchId, p.identity),
      );
      const session = await tx((c) =>
        trust.finishSession(
          c,
          clerk,
          fx.mainBranchId,
          p.device.sign(next, p.identity.keyId),
          attendance.allow(next, "session"),
        ),
      );
      const command = await tx((c) =>
        trust.prepareCommand(
          c,
          clerk,
          fx.mainBranchId,
          session.workSessionId,
          descriptor,
          { quantity: 1 },
        ),
      );
      const proof = attendance.allow(command, "command");
      const result = await changeAuthorityWhileWaiting(
        p.identity,
        (c) =>
          trust.verifyCommand(
            c,
            clerk,
            fx.mainBranchId,
            descriptor,
            p.device.sign(command, p.identity.keyId),
            proof,
          ),
        () =>
          prisma.rolePermission.deleteMany({
            where: {
              tenantId: fx.tenantId,
              roleId: role.id,
              permissionKey: "inventory.manage",
            },
          }),
      );
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason.getResponse()).toMatchObject({
          code: "PERMISSION_DENIED",
        });
      expect(
        (
          await prisma.terminalChallenge.findUniqueOrThrow({
            where: { nonceHash: sha256(command.serverNonce) },
          })
        ).consumedAt,
      ).toBeNull();
      // Restoring the grant allows the unchanged command; rejection did not burn its nonce.
      await prisma.rolePermission.create({
        data: {
          tenantId: fx.tenantId,
          roleId: role.id,
          permissionKey: "inventory.manage",
        },
      });
      await tx((c) =>
        trust.verifyCommand(
          c,
          clerk,
          fx.mainBranchId,
          descriptor,
          p.device.sign(command, p.identity.keyId),
          proof,
        ),
      );
    } finally {
      await prisma.userBranchRole.updateMany({
        where: {
          tenantId: fx.tenantId,
          userId: fx.clerkId,
          branchId: fx.mainBranchId,
        },
        data: { role: RoleName.inventory_clerk, roleId: null },
      });
    }
  });
});
