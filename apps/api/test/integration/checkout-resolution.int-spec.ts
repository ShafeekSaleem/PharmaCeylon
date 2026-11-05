import { randomUUID } from "node:crypto";
import { Prisma, RoleName } from "@prisma/client";
import type {
  LocalAttendanceAttestation,
  TerminalEnrollmentCommand,
  TerminalIdentity,
  TerminalSessionCommand,
} from "@pharmaceylon/shared";
import { AuditService } from "../../src/audit/audit.service";
import { StockService } from "../../src/inventory/stock/stock.service";
import { TaxService } from "../../src/pricing/tax.service";
import { lockCheckoutKey } from "../../src/sales/checkout-lock";
import { CheckoutResolutionService } from "../../src/sales/checkout-resolution.service";
import { SalesService } from "../../src/sales/sales.service";
import { AccessService } from "../../src/security/access.service";
import type { RequestUser } from "../../src/security/interfaces/authenticated-request.interface";
import { AttendanceProofsService } from "../../src/terminals/attendance-proofs.service";
import { LocalAttendanceVerifier } from "../../src/terminals/local-attendance.verifier";
import { OperatingHoursEvidence } from "../../src/terminals/operating-hours.evidence";
import { TerminalTrustService } from "../../src/terminals/terminal-trust.service";
import { boundedCanonical, sha256 } from "../../src/terminals/terminal-wire";
import { terminalDevice } from "../fixtures/terminal-device";
import { createPrisma, createStockedBatch, createTenant, type TenantFixture } from "./fixtures";

/**
 * P2: someone else signed in at the same enrolled counter confirms a checkout its seller left
 * unconfirmed. Real enrollment, sessions and attendance proofs; real checkout and locks.
 */
const prisma = createPrisma();
const audit = new AuditService(prisma as never);
const access = new AccessService(prisma as never, {} as never);
const trust = new TerminalTrustService(access, audit, new LocalAttendanceVerifier());
const proofs = new AttendanceProofsService(prisma as never, access);
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
);
const resolution = new CheckoutResolutionService(prisma as never, trust, audit);
const tx = <T>(run: (client: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(run, { timeout: 15_000 });

let fx: TenantFixture;
let owner: RequestUser;
let clerk: RequestUser;
let manager: RequestUser;

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

async function enroll() {
  const device = terminalDevice();
  const { id: registerId } = await tx((c) => trust.createCounter(c, owner, fx.mainBranchId, "Counter"));
  const challenge = await tx((c) =>
    trust.beginEnrollment(c, owner, fx.mainBranchId, {
      registerId,
      keyId: randomUUID(),
      publicKeyHex: device.publicKeyHex,
      label: "Front desk",
    }),
  );
  const proof = await record(device, attestation(challenge, "enrollment", owner), owner);
  const identity = await tx((c) =>
    trust.finishEnrollment(c, owner, fx.mainBranchId, device.sign(challenge, challenge.identity.keyId), proof.proofId),
  );
  return { device, identity };
}

async function openSession(device: Device, identity: TerminalIdentity, actor: RequestUser) {
  const challenge = await tx((c) => trust.beginSession(c, actor, fx.mainBranchId, identity));
  const proof = await record(device, attestation(challenge, "session", actor), actor);
  return tx((c) =>
    trust.finishSession(c, actor, fx.mainBranchId, device.sign(challenge, identity.keyId), proof.proofId),
  );
}

const sell = (actor: RequestUser, workSessionId: string, key: string) =>
  sales.checkout(
    fx.tenantId,
    fx.mainBranchId,
    actor.userId,
    [],
    { items: [{ productId: fx.productId, qty: 1, unitPrice: "15.00" }] } as never,
    key,
    { user: actor, workSessionId },
  );

const resolve = (
  actor: RequestUser,
  workSessionId: string,
  original: { idempotencyKey: string; workSessionId: string },
  branchId = fx.mainBranchId,
) => resolution.resolve(actor, branchId, workSessionId, original);

const salesBy = (soldBy: string) => prisma.sale.count({ where: { tenantId: fx.tenantId, soldBy } });

/** Waits until Postgres shows `count` advisory locks in the given state. */
async function advisoryLocks(granted: boolean, count = 1) {
  for (let i = 0; i < 200; i += 1) {
    const [row] = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND granted = ${granted}`;
    if (Number(row!.n) >= count) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`No ${granted ? "held" : "waiting"} advisory lock appeared`);
}

beforeAll(async () => {
  fx = await createTenant(prisma, "checkout-resolution");
  owner = user(fx.ownerId);
  clerk = user(fx.clerkId);
  manager = user(fx.managerId);
  await prisma.userBranchRole.createMany({
    data: [
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.otherBranchId, userId: fx.ownerId, role: RoleName.owner },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.clerkId, role: RoleName.cashier },
      { tenantId: fx.tenantId, branchId: fx.mainBranchId, userId: fx.managerId, role: RoleName.manager },
    ],
  });
  await createStockedBatch(prisma, stock, fx, { qty: 50 });
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("confirming another seller's unconfirmed checkout at the same counter", () => {
  it("returns the committed sale, still the seller's, and posts nothing new", async () => {
    const counter = await enroll();
    const seller = await openSession(counter.device, counter.identity, clerk);
    const key = randomUUID();
    // The reply to this was lost at the counter.
    const original = await sell(clerk, seller.workSessionId, key);
    const before = await salesBy(clerk.userId);
    // The manager signs in at the same till, which closes the cashier's session.
    const colleague = await openSession(counter.device, counter.identity, manager);

    const answer = await resolve(manager, colleague.workSessionId, {
      idempotencyKey: key,
      workSessionId: seller.workSessionId,
    });
    expect(answer).toMatchObject({ outcome: "landed", sale: { id: original!.id, soldBy: clerk.userId } });
    expect(await salesBy(clerk.userId)).toBe(before);
    expect(await salesBy(manager.userId)).toBe(0);
    expect(
      await prisma.auditEvent.count({
        where: { tenantId: fx.tenantId, eventName: "sale.checkout_resolved", actorUserId: manager.userId, entityId: original!.id },
      }),
    ).toBe(1);
  });

  it("says never landed only by sealing the key, so the original can't land afterwards", async () => {
    const counter = await enroll();
    const seller = await openSession(counter.device, counter.identity, clerk);
    const colleague = await openSession(counter.device, counter.identity, manager);
    const key = randomUUID();
    const before = await salesBy(clerk.userId);

    const original = { idempotencyKey: key, workSessionId: seller.workSessionId };
    await expect(resolve(manager, colleague.workSessionId, original)).resolves.toEqual({ outcome: "never_landed" });
    // Asked again, the same answer.
    await expect(resolve(manager, colleague.workSessionId, original)).resolves.toEqual({ outcome: "never_landed" });

    // The original request finally arrives (the seller is back at the counter with a new session).
    const back = await openSession(counter.device, counter.identity, clerk);
    await expect(sell(clerk, back.workSessionId, key)).rejects.toMatchObject({
      status: 409,
      response: { code: "CHECKOUT_SEALED" },
    });
    expect(await salesBy(clerk.userId)).toBe(before);
    // A new key still sells normally.
    await expect(sell(clerk, back.workSessionId, randomUUID())).resolves.toMatchObject({ soldBy: clerk.userId });
  });

  it("a slow first attempt still running commits first, and the lookup then returns its sale", async () => {
    const counter = await enroll();
    const seller = await openSession(counter.device, counter.identity, clerk);
    const key = randomUUID();

    // Hold every batch of the product, so the original takes its locks and then stalls on stock.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const blocker = prisma.$transaction(
      async (c) => {
        await c.$queryRaw`SELECT id FROM batch WHERE tenant_id = ${fx.tenantId}::uuid FOR UPDATE`;
        holding();
        await released;
      },
      { timeout: 30_000 },
    );
    await held;
    const first = sell(clerk, seller.workSessionId, key);
    await advisoryLocks(true);
    // The manager signs in at the same till meanwhile: that waits on the counter the original holds.
    let signedIn = false;
    const colleagueSigningIn = openSession(counter.device, counter.identity, manager).then((s) => {
      signedIn = true;
      return s;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(signedIn).toBe(false);
    release();
    await blocker;
    const sale = await first;
    const colleague = await colleagueSigningIn;
    await expect(
      resolve(manager, colleague.workSessionId, { idempotencyKey: key, workSessionId: seller.workSessionId }),
    ).resolves.toMatchObject({ outcome: "landed", sale: { id: sale!.id, soldBy: clerk.userId } });
  });

  it("waits on the checkout's key lock, and answers from what the attempt holding it committed", async () => {
    const counter = await enroll();
    const seller = await openSession(counter.device, counter.identity, clerk);
    // A sale from that session, for the attempt holding the lock to commit its key against.
    const sale = await sell(clerk, seller.workSessionId, randomUUID());
    const colleague = await openSession(counter.device, counter.identity, manager);
    const original = (idempotencyKey: string) => ({ idempotencyKey, workSessionId: seller.workSessionId });

    async function holdKey(key: string, commit: boolean) {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const attempt = prisma
        .$transaction(
          async (c) => {
            // What checkout does first: the key's lock. It then commits its record, or rolls back.
            await lockCheckoutKey(c, fx.tenantId, clerk.userId, key);
            await released;
            if (commit)
              await c.idempotencyRecord.create({
                data: { tenantId: fx.tenantId, userId: clerk.userId, scope: "checkout", idempotencyKey: key, resourceId: sale!.id },
              });
            else throw new Error("refused");
          },
          { timeout: 30_000 },
        )
        .catch(() => undefined);
      await advisoryLocks(true);
      const lookup = resolve(manager, colleague.workSessionId, original(key));
      await advisoryLocks(false);
      release();
      await attempt;
      return lookup;
    }

    await expect(holdKey(randomUUID(), true)).resolves.toMatchObject({ outcome: "landed", sale: { id: sale!.id } });
    const failed = randomUUID();
    await expect(holdKey(failed, false)).resolves.toEqual({ outcome: "never_landed" });
    expect(
      await prisma.idempotencyRecord.count({
        where: { tenantId: fx.tenantId, idempotencyKey: failed, scope: "checkout_sealed" },
      }),
    ).toBe(1);
  });

  it("refuses a sale from another counter or branch, and seals nothing", async () => {
    const a = await enroll();
    const b = await enroll();
    const seller = await openSession(a.device, a.identity, clerk);
    const key = randomUUID();
    await sell(clerk, seller.workSessionId, key);
    const elsewhere = await openSession(b.device, b.identity, manager);
    const original = { idempotencyKey: key, workSessionId: seller.workSessionId };

    await expect(resolve(manager, elsewhere.workSessionId, original)).rejects.toMatchObject({
      response: { code: "CHECKOUT_OTHER_COUNTER" },
    });
    // A key that never landed is refused at another counter too: it can't be sealed from there.
    const unsent = { idempotencyKey: randomUUID(), workSessionId: seller.workSessionId };
    await expect(resolve(manager, elsewhere.workSessionId, unsent)).rejects.toMatchObject({
      response: { code: "CHECKOUT_OTHER_COUNTER" },
    });
    // Asked at another branch, the original session isn't there at all.
    await expect(resolve(owner, elsewhere.workSessionId, unsent, fx.otherBranchId)).rejects.toMatchObject({
      response: { code: "CHECKOUT_OTHER_COUNTER" },
    });
    expect(
      await prisma.idempotencyRecord.count({
        where: { tenantId: fx.tenantId, idempotencyKey: unsent.idempotencyKey },
      }),
    ).toBe(0);
  });

  it("needs the caller's own open session at the counter", async () => {
    const counter = await enroll();
    const seller = await openSession(counter.device, counter.identity, clerk);
    const colleague = await openSession(counter.device, counter.identity, manager);
    const original = { idempotencyKey: randomUUID(), workSessionId: seller.workSessionId };
    // Someone else's session, or one that has closed.
    await expect(resolve(owner, colleague.workSessionId, original)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    await tx((c) => trust.endSession(c, manager, fx.mainBranchId, colleague.workSessionId));
    await expect(resolve(manager, colleague.workSessionId, original)).rejects.toMatchObject({
      response: { code: "SESSION_INVALID" },
    });
    expect(
      await prisma.idempotencyRecord.count({ where: { tenantId: fx.tenantId, idempotencyKey: original.idempotencyKey } }),
    ).toBe(0);
  });
});
