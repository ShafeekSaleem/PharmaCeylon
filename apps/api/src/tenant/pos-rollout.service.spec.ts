import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { DesktopPosRollout, RoleName } from "@prisma/client";
import { AuditService } from "../audit/audit.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";
import {
  buildGoLiveChecklist,
  goLiveBlocked,
  type GoLiveCheck,
  resolvePosRollout,
} from "./pos-rollout";
import { PosRolloutService } from "./pos-rollout.service";

const tenantId = "tenant-1";
const branchId = "11111111-1111-4111-8111-111111111111";
const HOUR = 3_600_000;

function user(role: RoleName, onBranch = branchId): RequestUser {
  return {
    userId: "user-1",
    tenantId,
    email: "u@example.com",
    fullName: "U",
    authMethod: "cookie",
    branchRoles: [{ branchId: onBranch, role }],
  };
}

const owner = user(RoleName.owner);
const manager = user(RoleName.manager);

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: branchId,
    name: "Colombo 03",
    desktopPosRollout: DesktopPosRollout.not_live,
    desktopPosLiveAt: null,
    posFallbackStartedAt: null,
    posFallbackEndsAt: null,
    ...overrides,
  };
}

function liveRow(overrides: Partial<Record<string, unknown>> = {}) {
  return row({
    desktopPosRollout: DesktopPosRollout.live,
    desktopPosLiveAt: new Date("2026-10-01T00:00:00Z"),
    ...overrides,
  });
}

describe("resolvePosRollout", () => {
  const now = new Date("2026-10-27T10:00:00Z");

  it("reads a branch that isn't live as not live, whatever else is stored", () => {
    expect(resolvePosRollout(row(), now)).toEqual({
      state: "not_live",
      liveSince: null,
      fallback: null,
    });
  });

  it("reads a live branch with no fallback as live", () => {
    expect(resolvePosRollout(liveRow(), now)).toEqual({
      state: "live",
      liveSince: "2026-10-01T00:00:00.000Z",
      fallback: null,
    });
  });

  it("reads a running fallback with both ends", () => {
    const view = resolvePosRollout(
      liveRow({
        posFallbackStartedAt: new Date("2026-10-27T08:00:00Z"),
        posFallbackEndsAt: new Date("2026-10-27T18:00:00Z"),
      }),
      now,
    );
    expect(view.state).toBe("fallback");
    expect(view.fallback).toEqual({
      startedAt: "2026-10-27T08:00:00.000Z",
      endsAt: "2026-10-27T18:00:00.000Z",
    });
  });

  it("ends a fallback on its own at the time the owner set", () => {
    const view = resolvePosRollout(
      liveRow({
        posFallbackStartedAt: new Date("2026-10-26T08:00:00Z"),
        posFallbackEndsAt: new Date("2026-10-27T10:00:00Z"),
      }),
      now,
    );
    expect(view).toEqual({ state: "live", liveSince: "2026-10-01T00:00:00.000Z", fallback: null });
  });
});

describe("go-live checklist", () => {
  it("passes the counter check only with an active enrollment", () => {
    expect(buildGoLiveChecklist({ activeEnrollments: 0 })[0]).toMatchObject({
      key: "counter_enrolled",
      status: "missing",
    });
    expect(buildGoLiveChecklist({ activeEnrollments: 2 })[0]).toMatchObject({
      key: "counter_enrolled",
      status: "passed",
    });
  });

  it("reports the checks P2 records as pending, and pending blocks going live", () => {
    const checklist = buildGoLiveChecklist({ activeEnrollments: 1 });
    expect(checklist.filter((check) => check.status === "pending").map((c) => c.key)).toEqual([
      "staff_prepared",
      "test_receipt",
    ]);
    expect(goLiveBlocked(checklist)).toBe(true);
  });

  it("does not block once every check has passed", () => {
    const passed = buildGoLiveChecklist({ activeEnrollments: 1 }).map((check) => ({
      ...check,
      status: "passed" as const,
    }));
    expect(goLiveBlocked(passed)).toBe(false);
  });
});

describe("PosRolloutService", () => {
  let prisma: {
    branch: { findFirst: jest.Mock; updateMany: jest.Mock };
    terminalEnrollment: { count: jest.Mock };
    $transaction: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let notifications: { notifyByPermission: jest.Mock };
  let service: PosRolloutService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-27T10:00:00Z") });
    prisma = {
      branch: { findFirst: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      terminalEnrollment: { count: jest.fn().mockResolvedValue(1) },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    notifications = { notifyByPermission: jest.fn().mockResolvedValue(0) };
    service = new PosRolloutService(
      prisma as never,
      audit as unknown as AuditService,
      notifications as unknown as NotificationsService,
    );
  });

  afterEach(() => jest.useRealTimers());

  function passEveryCheck() {
    jest
      .spyOn(service as unknown as { checklist: () => Promise<GoLiveCheck[]> }, "checklist")
      .mockResolvedValue(
        buildGoLiveChecklist({ activeEnrollments: 1 }).map((check) => ({
          ...check,
          status: "passed" as const,
        })),
      );
  }

  describe("get", () => {
    it("returns the state with the checklist", async () => {
      prisma.branch.findFirst.mockResolvedValue(row());
      const view = await service.get(owner, branchId);
      expect(view).toMatchObject({ branchId, state: "not_live", canGoLive: false });
      expect(view.checklist.map((check) => check.key)).toEqual([
        "counter_enrolled",
        "staff_prepared",
        "test_receipt",
      ]);
      expect(prisma.terminalEnrollment.count).toHaveBeenCalledWith({
        where: { tenantId, branchId, revokedAt: null, terminal: { retiredAt: null } },
      });
    });

    it("hides a branch the caller doesn't work at", async () => {
      await expect(service.get(user(RoleName.manager, "other-branch"), branchId)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.branch.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("only owners change it", () => {
    it.each([
      ["goLive", () => service.goLive(manager, branchId)],
      ["goNotLive", () => service.goNotLive(manager, branchId)],
      [
        "startFallback",
        () => service.startFallback(manager, branchId, new Date(Date.now() + HOUR).toISOString()),
      ],
      ["endFallback", () => service.endFallback(manager, branchId)],
    ])("%s refuses a manager", async (_name, call) => {
      await expect(call()).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe("goLive", () => {
    it("refuses with the checklist while no counter is enrolled", async () => {
      prisma.branch.findFirst.mockResolvedValue(row());
      prisma.terminalEnrollment.count.mockResolvedValue(0);
      const error = await service.goLive(owner, branchId).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as {
        code: string;
        checklist: GoLiveCheck[];
      };
      expect(body.code).toBe("GO_LIVE_CHECKLIST_INCOMPLETE");
      expect(body.checklist[0]).toMatchObject({ key: "counter_enrolled", status: "missing" });
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it("still refuses with a counter enrolled while P2's checks are pending", async () => {
      prisma.branch.findFirst.mockResolvedValue(row());
      await expect(service.goLive(owner, branchId)).rejects.toThrow(ConflictException);
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
    });

    it("goes live once the checklist passes, conditionally and audited in the same transaction", async () => {
      passEveryCheck();
      prisma.branch.findFirst.mockResolvedValueOnce(row()).mockResolvedValue(liveRow());
      const view = await service.goLive(owner, branchId);

      expect(prisma.branch.updateMany).toHaveBeenCalledWith({
        where: {
          id: branchId,
          tenantId,
          desktopPosRollout: DesktopPosRollout.not_live,
          posFallbackEndsAt: null,
        },
        data: expect.objectContaining({
          desktopPosRollout: DesktopPosRollout.live,
          desktopPosLiveAt: new Date("2026-10-27T10:00:00Z"),
        }),
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          branchId,
          actorUserId: "user-1",
          eventName: "branch.pos_rollout_live",
          entityName: "branch",
          entityId: branchId,
        }),
        prisma,
      );
      expect(view.state).toBe("live");
    });

    it("refuses a branch that is already live", async () => {
      prisma.branch.findFirst.mockResolvedValue(liveRow());
      await expect(service.goLive(owner, branchId)).rejects.toThrow(
        "Desktop POS is already live at this branch",
      );
    });

    it("refuses when another change landed first", async () => {
      passEveryCheck();
      prisma.branch.findFirst.mockResolvedValue(row());
      prisma.branch.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.goLive(owner, branchId)).rejects.toThrow(/just changed/);
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe("goNotLive", () => {
    it("returns a live branch to the web POS and clears any fallback", async () => {
      prisma.branch.findFirst.mockResolvedValueOnce(liveRow()).mockResolvedValue(row());
      const view = await service.goNotLive(owner, branchId);
      expect(prisma.branch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            desktopPosRollout: DesktopPosRollout.not_live,
            desktopPosLiveAt: null,
            posFallbackStartedAt: null,
            posFallbackEndsAt: null,
          },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "branch.pos_rollout_not_live" }),
        prisma,
      );
      expect(view.state).toBe("not_live");
    });

    it("refuses a branch that isn't live", async () => {
      prisma.branch.findFirst.mockResolvedValue(row());
      await expect(service.goNotLive(owner, branchId)).rejects.toThrow(ConflictException);
    });
  });

  describe("startFallback", () => {
    const inFourHours = () => new Date(Date.now() + 4 * HOUR).toISOString();

    it("refuses an end time that has passed or is too far away", async () => {
      await expect(
        service.startFallback(owner, branchId, new Date(Date.now() - HOUR).toISOString()),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.startFallback(owner, branchId, new Date(Date.now() + 8 * 24 * HOUR).toISOString()),
      ).rejects.toThrow(/at most 7 days/);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses a branch that isn't live", async () => {
      prisma.branch.findFirst.mockResolvedValue(row());
      await expect(service.startFallback(owner, branchId, inFourHours())).rejects.toThrow(
        ConflictException,
      );
    });

    it("starts a fallback with its reason in the audit event", async () => {
      const endsAt = inFourHours();
      prisma.branch.findFirst.mockResolvedValueOnce(liveRow()).mockResolvedValue(
        liveRow({ posFallbackStartedAt: new Date(), posFallbackEndsAt: new Date(endsAt) }),
      );
      const view = await service.startFallback(owner, branchId, endsAt, "  Counter PC failed  ");
      expect(prisma.branch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { posFallbackStartedAt: new Date("2026-10-27T10:00:00Z"), posFallbackEndsAt: new Date(endsAt) },
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "branch.pos_fallback_started",
          payload: { endsAt, reason: "Counter PC failed" },
        }),
        prisma,
      );
      expect(view.state).toBe("fallback");
      expect(notifications.notifyByPermission).toHaveBeenCalled();
    });

    it("moves the end of a running fallback and keeps when it started", async () => {
      const startedAt = new Date("2026-10-27T09:00:00Z");
      const previousEnd = new Date("2026-10-27T12:00:00Z");
      const endsAt = inFourHours();
      prisma.branch.findFirst.mockResolvedValue(
        liveRow({ posFallbackStartedAt: startedAt, posFallbackEndsAt: previousEnd }),
      );
      await service.startFallback(owner, branchId, endsAt);
      expect(prisma.branch.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ posFallbackEndsAt: previousEnd }),
        data: { posFallbackStartedAt: startedAt, posFallbackEndsAt: new Date(endsAt) },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventName: "branch.pos_fallback_extended",
          payload: { endsAt, previousEndsAt: previousEnd.toISOString(), reason: null },
        }),
        prisma,
      );
    });
  });

  describe("endFallback", () => {
    it("ends a running fallback early", async () => {
      prisma.branch.findFirst.mockResolvedValueOnce(
        liveRow({
          posFallbackStartedAt: new Date("2026-10-27T09:00:00Z"),
          posFallbackEndsAt: new Date("2026-10-27T12:00:00Z"),
        }),
      ).mockResolvedValue(liveRow());
      const view = await service.endFallback(owner, branchId);
      expect(prisma.branch.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { posFallbackStartedAt: null, posFallbackEndsAt: null } }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "branch.pos_fallback_ended" }),
        prisma,
      );
      expect(view.state).toBe("live");
    });

    it("refuses when the fallback has already run out", async () => {
      prisma.branch.findFirst.mockResolvedValue(
        liveRow({
          posFallbackStartedAt: new Date("2026-10-26T09:00:00Z"),
          posFallbackEndsAt: new Date("2026-10-27T09:00:00Z"),
        }),
      );
      await expect(service.endFallback(owner, branchId)).rejects.toThrow(ConflictException);
      expect(prisma.branch.updateMany).not.toHaveBeenCalled();
    });
  });
});
