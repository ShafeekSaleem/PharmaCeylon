import { randomBytes, randomUUID } from "node:crypto";
import { DesktopPosRollout, RoleName } from "@prisma/client";
import { AuditService } from "../../src/audit/audit.service";
import { PosRolloutService } from "../../src/tenant/pos-rollout.service";
import { createPrisma, createTenant, type TenantFixture } from "./fixtures";

const prisma = createPrisma();
let fx: TenantFixture;
let service: PosRolloutService;

function owner() {
  return {
    userId: fx.ownerId,
    tenantId: fx.tenantId,
    email: "owner@it.test",
    fullName: "Owner",
    authMethod: "cookie" as const,
    branchRoles: [{ branchId: fx.mainBranchId, role: RoleName.owner }],
  };
}

async function enroll(branchId: string, opts: { revoked?: boolean; retired?: boolean } = {}) {
  const terminal = await prisma.operationalTerminal.create({
    data: { tenantId: fx.tenantId, branchId, label: "W1 counter" },
  });
  const enrollment = await prisma.terminalEnrollment.create({
    data: {
      tenantId: fx.tenantId,
      branchId,
      terminalId: terminal.id,
      keyId: randomUUID(),
      publicKeyHex: randomBytes(32).toString("hex"),
      enrolledByUserId: fx.ownerId,
    },
  });
  // Revoked or retired after creation, as the database requires.
  if (opts.revoked) {
    await prisma.terminalEnrollment.update({
      where: { id: enrollment.id },
      data: { revokedAt: new Date(enrollment.createdAt.getTime() + 1), revocationReason: "lost" },
    });
  }
  if (opts.retired) {
    await prisma.operationalTerminal.update({
      where: { id: terminal.id },
      data: { retiredAt: new Date(terminal.createdAt.getTime() + 1) },
    });
  }
}

beforeAll(async () => {
  fx = await createTenant(prisma, "rollout");
  service = new PosRolloutService(
    prisma as never,
    new AuditService(prisma as never),
    { notifyByPermission: async () => 0 } as never,
  );
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("W1 branch POS rollout (real migrations)", () => {
  it("starts every branch not live", async () => {
    const branch = await prisma.branch.findUniqueOrThrow({ where: { id: fx.mainBranchId } });
    expect(branch.desktopPosRollout).toBe(DesktopPosRollout.not_live);
    expect(branch.posFallbackEndsAt).toBeNull();
  });

  it("counts only enrollments that are neither revoked nor on a retired terminal", async () => {
    await enroll(fx.otherBranchId, { revoked: true });
    await enroll(fx.otherBranchId, { retired: true });
    let view = await service.get(owner(), fx.otherBranchId);
    expect(view.checklist[0]).toMatchObject({ key: "counter_enrolled", status: "missing" });

    await enroll(fx.otherBranchId);
    view = await service.get(owner(), fx.otherBranchId);
    expect(view.checklist[0]).toMatchObject({ key: "counter_enrolled", status: "passed" });
    // P2's checks are still pending, and they block going live.
    expect(view.canGoLive).toBe(false);
    await expect(service.goLive(owner(), fx.otherBranchId)).rejects.toThrow(/checklist/);
    const audit = await prisma.auditEvent.count({
      where: { tenantId: fx.tenantId, eventName: { startsWith: "branch.pos_" } },
    });
    expect(audit).toBe(0);
  });

  it("refuses a fallback on a branch that isn't live, at the database too", async () => {
    await expect(
      prisma.branch.update({
        where: { id: fx.mainBranchId },
        data: { posFallbackStartedAt: new Date(), posFallbackEndsAt: new Date(Date.now() + 3_600_000) },
      }),
    ).rejects.toThrow();
  });

  it("refuses a live branch without the time it went live", async () => {
    await expect(
      prisma.branch.update({
        where: { id: fx.mainBranchId },
        data: { desktopPosRollout: DesktopPosRollout.live },
      }),
    ).rejects.toThrow();
  });

  it("runs a fallback on a live branch and audits each change with the branch", async () => {
    await prisma.branch.update({
      where: { id: fx.mainBranchId },
      data: { desktopPosRollout: DesktopPosRollout.live, desktopPosLiveAt: new Date() },
    });
    const endsAt = new Date(Date.now() + 4 * 3_600_000).toISOString();
    const started = await service.startFallback(owner(), fx.mainBranchId, endsAt, "Counter PC failed");
    expect(started.state).toBe("fallback");
    expect(started.fallback?.endsAt).toBe(endsAt);

    const ended = await service.endFallback(owner(), fx.mainBranchId);
    expect(ended.state).toBe("live");

    const back = await service.goNotLive(owner(), fx.mainBranchId);
    expect(back.state).toBe("not_live");

    const events = await prisma.auditEvent.findMany({
      where: { tenantId: fx.tenantId, branchId: fx.mainBranchId, entityName: "branch" },
      orderBy: { createdAt: "asc" },
      select: { eventName: true, actorUserId: true },
    });
    expect(events.map((event) => event.eventName)).toEqual([
      "branch.pos_fallback_started",
      "branch.pos_fallback_ended",
      "branch.pos_rollout_not_live",
    ]);
    expect(events.every((event) => event.actorUserId === fx.ownerId)).toBe(true);
  });
});
