import { randomBytes, randomUUID } from "node:crypto";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
let fx: TenantFixture;
let other: TenantFixture;

async function enrolled() {
  const terminal = await prisma.operationalTerminal.create({ data: {
    tenantId: fx.tenantId, branchId: fx.mainBranchId, label: "P1 test counter",
  } });
  const enrollment = await prisma.terminalEnrollment.create({ data: {
    tenantId: fx.tenantId, branchId: fx.mainBranchId, terminalId: terminal.id,
    keyId: randomUUID(), publicKeyHex: randomBytes(32).toString("hex"), enrolledByUserId: fx.ownerId,
  } });
  return { terminal, enrollment };
}

function receipt(enrollment: Awaited<ReturnType<typeof enrolled>>["enrollment"]) {
  return {
    tenantId: enrollment.tenantId, branchId: enrollment.branchId,
    terminalId: enrollment.terminalId, enrollmentId: enrollment.id, keyId: enrollment.keyId,
    commandId: randomUUID(), operation: "sale", requestDigest: randomBytes(32).toString("hex"),
    actorUserId: fx.clerkId, command: { contractVersion: 1 }, result: { status: "accepted" },
  };
}

beforeAll(async () => {
  fx = await createTenant(prisma, "terminal");
  other = await createTenant(prisma, "terminal-other");
});
afterAll(async () => { await prisma.$disconnect(); });

describe("P1 terminal database foundation (real migrations)", () => {
  it("rejects a terminal at another tenant's branch", async () => {
    await expect(prisma.operationalTerminal.create({ data: {
      tenantId: other.tenantId, branchId: fx.mainBranchId, label: "wrong tenant",
    } })).rejects.toThrow();
  });

  it("binds enrollments to the exact tenant, branch and terminal", async () => {
    const { terminal } = await enrolled();
    for (const mismatch of [{ branchId: fx.otherBranchId }, { tenantId: other.tenantId, branchId: other.mainBranchId }]) {
      await expect(prisma.terminalEnrollment.create({ data: {
        tenantId: fx.tenantId, terminalId: terminal.id,
        ...mismatch, keyId: randomUUID(), publicKeyHex: "a".repeat(64), enrolledByUserId: fx.ownerId,
      } })).rejects.toThrow();
    }
  });

  it("allows only one active enrollment and retains revoked keys for history", async () => {
    const { enrollment } = await enrolled();
    const next = { tenantId: enrollment.tenantId, branchId: enrollment.branchId,
      terminalId: enrollment.terminalId, keyId: randomUUID(), publicKeyHex: "b".repeat(64), enrolledByUserId: fx.ownerId };
    await expect(prisma.terminalEnrollment.create({ data: next })).rejects.toThrow();
    await prisma.terminalEnrollment.update({ where: { id: enrollment.id }, data: { revokedAt: new Date(), revocationReason: "Key rotation" } });
    await prisma.terminalEnrollment.create({ data: next });
    await expect(prisma.terminalEnrollment.update({ where: { id: enrollment.id }, data: { revokedAt: null, revocationReason: null } })).rejects.toThrow();
    await expect(prisma.terminalEnrollment.update({ where: { id: enrollment.id }, data: { publicKeyHex: "c".repeat(64) } })).rejects.toThrow();
    // Storage allows historical recovery after revocation; authorization remains future verifier work.
    await prisma.terminalCommandReceipt.create({ data: receipt(enrollment) });
  });

  it("rejects malformed keys, digests and journal sequences", async () => {
    const { enrollment } = await enrolled();
    for (const override of [{ requestDigest: "invalid" }, { offlineSequence: 0n }, { offlineSequence: -1n }, { offlineSequence: 9007199254740992n }]) {
      await expect(prisma.terminalCommandReceipt.create({ data: { ...receipt(enrollment), ...override } })).rejects.toThrow();
    }
    const terminal = await prisma.operationalTerminal.create({ data: { tenantId: fx.tenantId, branchId: fx.mainBranchId, label: "invalid key" } });
    await expect(prisma.terminalEnrollment.create({ data: { tenantId: fx.tenantId, branchId: fx.mainBranchId,
      terminalId: terminal.id, keyId: randomUUID(), publicKeyHex: "z".repeat(64), enrolledByUserId: fx.ownerId,
    } })).rejects.toThrow();
  });

  it("rejects mismatched receipt identity including the signing key", async () => {
    const { enrollment } = await enrolled();
    for (const override of [{ keyId: randomUUID() }, { branchId: fx.otherBranchId }, { terminalId: randomUUID() }, { tenantId: other.tenantId }]) {
      await expect(prisma.terminalCommandReceipt.create({ data: { ...receipt(enrollment), ...override } })).rejects.toThrow();
    }
  });

  it("permits only one concurrent insert for a command, regardless of actor or content", async () => {
    const { enrollment } = await enrolled();
    const data = receipt(enrollment);
    const results = await Promise.allSettled([
      prisma.terminalCommandReceipt.create({ data }),
      prisma.terminalCommandReceipt.create({ data: { ...data, actorUserId: fx.managerId, requestDigest: "f".repeat(64) } }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.code).toBe("P2002");
  });

  it("rejects reused offline sequence but allows multiple online receipts", async () => {
    const { enrollment } = await enrolled();
    await prisma.terminalCommandReceipt.create({ data: { ...receipt(enrollment), offlineSequence: 1n } });
    await expect(prisma.terminalCommandReceipt.create({ data: { ...receipt(enrollment), offlineSequence: 1n } })).rejects.toThrow();
    await prisma.terminalCommandReceipt.create({ data: receipt(enrollment) });
    await prisma.terminalCommandReceipt.create({ data: receipt(enrollment) });
  });

  it("allows the same command UUID in a different enrollment", async () => {
    const a = await enrolled();
    const b = await enrolled();
    const commandId = randomUUID();
    await prisma.terminalCommandReceipt.create({ data: { ...receipt(a.enrollment), commandId } });
    await prisma.terminalCommandReceipt.create({ data: { ...receipt(b.enrollment), commandId } });
  });

  it("preserves original receipt and identity against edits/deletion", async () => {
    const { terminal, enrollment } = await enrolled();
    const row = await prisma.terminalCommandReceipt.create({ data: receipt(enrollment) });
    await expect(prisma.terminalCommandReceipt.update({ where: { id: row.id }, data: { result: { status: "changed" } } })).rejects.toThrow();
    await expect(prisma.terminalCommandReceipt.delete({ where: { id: row.id } })).rejects.toThrow();
    await expect(prisma.terminalEnrollment.delete({ where: { id: enrollment.id } })).rejects.toThrow();
    await expect(prisma.operationalTerminal.update({ where: { id: terminal.id }, data: { branchId: fx.otherBranchId } })).rejects.toThrow();
    expect((await prisma.terminalCommandReceipt.findUniqueOrThrow({ where: { id: row.id } })).result).toEqual({ status: "accepted" });
  });

  it("rolls back receipt and audit together when their transaction fails", async () => {
    const { enrollment } = await enrolled();
    const data = receipt(enrollment);
    const auditId = randomUUID();
    await expect(prisma.$transaction(async tx => {
      await tx.terminalCommandReceipt.create({ data });
      await tx.auditEvent.create({ data: { id: auditId, tenantId: fx.tenantId, branchId: fx.mainBranchId,
        actorUserId: fx.clerkId, eventName: "test.terminal", entityName: "terminal", entityId: enrollment.terminalId } });
      throw new Error("Injected failure");
    })).rejects.toThrow("Injected failure");
    expect(await prisma.terminalCommandReceipt.count({ where: { tenantId: fx.tenantId, commandId: data.commandId } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { id: auditId, tenantId: fx.tenantId } })).toBe(0);
  });
});
