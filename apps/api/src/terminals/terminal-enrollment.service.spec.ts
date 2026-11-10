import { NotFoundException } from "@nestjs/common";
import { TerminalEnrollmentService } from "./terminal-enrollment.service";

describe("TerminalEnrollmentService.enrollmentStatus offline backup lookup", () => {
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const branchId = "00000000-0000-4000-8000-000000000002";
  const enrollmentId = "00000000-0000-4000-8000-000000000010";
  const user = {
    userId: "00000000-0000-4000-8000-000000000099",
    tenantId,
    tokenVersion: 0,
    email: "owner@test",
    fullName: "Owner",
    authMethod: "bearer" as const,
    branchRoles: [],
  };

  function service(tx: object) {
    const prisma = {
      $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return new TerminalEnrollmentService(
      prisma as never,
      { resolveLive: jest.fn().mockResolvedValue({ has: () => true }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  const enrollmentRow = {
    id: enrollmentId,
    terminalId: "00000000-0000-4000-8000-000000000020",
    terminal: {
      registerId: "00000000-0000-4000-8000-000000000030",
      tillId: "till-1",
      label: "Device",
      retiredAt: null,
    },
    revokedAt: null,
  };

  function mockTx(overrides: {
    nomination?: {
      enrollmentId: string;
      authorizationId: string;
      activatedAt: Date;
      activatedByUserId: string;
      version: number;
    } | null;
    outstanding?: { authorizedAt: Date; authorizedByUserId: string } | null;
    nominationAuthorization?: { authorizedAt: Date; authorizedByUserId: string } | null;
  }) {
    const outstandingFind = jest.fn().mockResolvedValue(overrides.outstanding ?? null);
    const nominationAuthFind = jest.fn().mockResolvedValue(overrides.nominationAuthorization ?? null);
    const tx = {
      terminalEnrollment: {
        findFirst: jest.fn().mockResolvedValue(enrollmentRow),
      },
      terminalCounter: {
        findFirst: jest.fn().mockResolvedValue({ label: "Till" }),
      },
      offlineTerminalNomination: {
        findUnique: jest.fn().mockResolvedValue(overrides.nomination ?? null),
      },
      offlineTerminalAssignmentAuthorization: {
        findFirst: jest
          .fn()
          .mockImplementation((args: { where: { status?: string; expectedNominationVersion?: number; targetEnrollmentId?: string } }) => {
            if (args.where.status === "authorized") return outstandingFind();
            if (args.where.status === "consumed") return nominationAuthFind();
            return null;
          }),
      },
      appUser: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { tx, outstandingFind, nominationAuthFind };
  }

  it("queries outstanding authorization at the branch nomination version so stale rows are not surfaced", async () => {
    const { tx } = mockTx({
      nomination: {
        enrollmentId: "other",
        authorizationId: "a-nom",
        activatedAt: new Date(),
        activatedByUserId: "u-act",
        version: 2,
      },
      outstanding: null,
    });
    const svc = service(tx);

    const status = await svc.enrollmentStatus(user, branchId, enrollmentId);

    expect(tx.offlineTerminalAssignmentAuthorization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "authorized",
          expectedNominationVersion: 2,
          targetEnrollmentId: enrollmentId,
        }),
      }),
    );
    expect(status.offlineBackup.authorizedAt).toBeNull();
  });

  it("surfaces outstanding authorization when expectedNominationVersion matches branch nomination", async () => {
    const { tx } = mockTx({
      nomination: null,
      outstanding: {
        authorizedAt: new Date("2021-01-01T00:00:00.000Z"),
        authorizedByUserId: "u-auth",
      },
    });
    const svc = service(tx);

    const status = await svc.enrollmentStatus(user, branchId, enrollmentId);

    expect(tx.offlineTerminalAssignmentAuthorization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          expectedNominationVersion: 0,
        }),
      }),
    );
    expect(status.offlineBackup.authorizedAt).toBe(Date.parse("2021-01-01T00:00:00.000Z"));
  });

  it("omits nomination authorization facts when the consumed row targets another enrollment", async () => {
    const nomAuthId = "00000000-0000-4000-8000-0000000000aa";
    const { tx } = mockTx({
      nomination: {
        enrollmentId,
        authorizationId: nomAuthId,
        activatedAt: new Date("2022-01-01T00:00:00.000Z"),
        activatedByUserId: "u-act",
        version: 1,
      },
      nominationAuthorization: null,
    });
    const svc = service(tx);

    const status = await svc.enrollmentStatus(user, branchId, enrollmentId);

    expect(tx.offlineTerminalAssignmentAuthorization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "consumed",
          targetEnrollmentId: enrollmentId,
          id: nomAuthId,
        }),
      }),
    );
    expect(status.offlineBackup).toMatchObject({
      authorizedAt: null,
      activatedAt: Date.parse("2022-01-01T00:00:00.000Z"),
    });
  });

  it("throws when the enrollment is not found", async () => {
    const tx = {
      terminalEnrollment: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = service(tx);
    await expect(svc.enrollmentStatus(user, branchId, enrollmentId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
