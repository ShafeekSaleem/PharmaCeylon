import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { AuditService } from "../audit/audit.service";
import { PermissionsService } from "../security/permissions.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("PharmacistApprovalService", () => {
  const tenantId = "t1";
  const branchId = "b1";
  const actorUserId = "cashier-1";
  const approverId = "pharm-1";

  let prisma: {
    appUser: { findFirst: jest.Mock; update: jest.Mock };
    userBranchRole: { findMany: jest.Mock };
  };
  let audit: AuditService;
  let service: PharmacistApprovalService;

  beforeEach(() => {
    prisma = {
      appUser: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      userBranchRole: { findMany: jest.fn() },
    };
    audit = { log: jest.fn() } as unknown as AuditService;
    const permissions = new PermissionsService(
      prisma as never,
      { get: () => 30 } as unknown as ConfigService,
    );
    service = new PharmacistApprovalService(prisma as never, audit, permissions);
    mockedBcrypt.compare.mockReset();
  });

  it("accepts till PIN for branch pharmacist", async () => {
    prisma.appUser.findFirst.mockResolvedValue({
      id: approverId,
      fullName: "Dr. Anjali",
      passwordHash: "pwd",
      posPinHash: "pinhash",
      failedPosPinAttempts: 0,
      posPinLockedUntil: null,
      userBranchRoles: [{ role: RoleName.pharmacist, branchId }],
    });
    mockedBcrypt.compare.mockImplementation(async () => true);

    const result = await service.verifyApproverPin(
      tenantId,
      branchId,
      approverId,
      "1234",
      actorUserId,
    );
    expect(result.approverUserId).toBe(approverId);
    expect(mockedBcrypt.compare).toHaveBeenCalledWith("1234", "pinhash");
  });

  it("rejects wrong PIN and increments failures", async () => {
    prisma.appUser.findFirst.mockResolvedValue({
      id: approverId,
      fullName: "Dr. Anjali",
      passwordHash: "pwd",
      posPinHash: "pinhash",
      failedPosPinAttempts: 0,
      posPinLockedUntil: null,
      userBranchRoles: [{ role: RoleName.pharmacist, branchId }],
    });
    mockedBcrypt.compare.mockImplementation(async () => false);

    await expect(
      service.verifyApproverPin(tenantId, branchId, approverId, "0000", actorUserId),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.appUser.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: approverId, tenantId },
        data: expect.objectContaining({ failedPosPinAttempts: 1 }),
      }),
    );
  });

  it("rejects cashier as approver", async () => {
    prisma.appUser.findFirst.mockResolvedValue({
      id: approverId,
      fullName: "Cashier",
      passwordHash: "pwd",
      posPinHash: null,
      failedPosPinAttempts: 0,
      posPinLockedUntil: null,
      userBranchRoles: [{ role: RoleName.cashier, branchId }],
    });

    await expect(
      service.verifyApproverPin(tenantId, branchId, approverId, "password", actorUserId),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
