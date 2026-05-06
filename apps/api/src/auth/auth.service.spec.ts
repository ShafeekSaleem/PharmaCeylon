import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { AuthService } from "./auth.service";

jest.mock("bcrypt");

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("AuthService", () => {
  const prisma = {
    appUser: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };

  const jwtService = {
    signAsync: jest.fn(),
    verifyAsync: jest.fn(),
  } as unknown as JwtService;

  const configService = {
    getOrThrow: jest.fn((key: string) => {
      const map: Record<string, string> = {
        JWT_ACCESS_SECRET: "access-secret",
        JWT_REFRESH_SECRET: "refresh-secret",
      };
      return map[key];
    }),
    get: jest.fn((_key: string, defaultValue: number) => defaultValue),
  } as unknown as ConfigService;

  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AuthService(prisma as any, jwtService, configService);
  });

  it("logs in with valid credentials", async () => {
    prisma.appUser.findFirst.mockResolvedValue({
      id: "user-id",
      tenantId: "tenant-id",
      email: "demo@pharma.com",
      fullName: "Demo User",
      passwordHash: "hash",
      isActive: true,
      refreshTokenHash: null,
      tenant: { code: "demo" },
      userBranchRoles: [{ branchId: "branch-1", role: RoleName.manager }],
    });
    mockedBcrypt.compare.mockResolvedValue(true as never);
    mockedBcrypt.hash.mockResolvedValue("new-refresh-hash" as never);
    (jwtService.signAsync as jest.Mock)
      .mockResolvedValueOnce("access-token")
      .mockResolvedValueOnce("refresh-token");

    const result = await service.login({
      tenantCode: "demo",
      email: "demo@pharma.com",
      password: "password123",
    });

    expect(result.accessToken).toBe("access-token");
    expect(result.refreshToken).toBe("refresh-token");
    expect(result.user.tenantCode).toBe("demo");
    expect(prisma.appUser.update).toHaveBeenCalledWith({
      where: { id: "user-id" },
      data: { refreshTokenHash: "new-refresh-hash" },
    });
  });

  it("rejects login with invalid password", async () => {
    prisma.appUser.findFirst.mockResolvedValue({
      id: "user-id",
      tenantId: "tenant-id",
      email: "demo@pharma.com",
      fullName: "Demo User",
      passwordHash: "hash",
      isActive: true,
      refreshTokenHash: null,
      tenant: { code: "demo" },
      userBranchRoles: [],
    });
    mockedBcrypt.compare.mockResolvedValue(false as never);

    await expect(
      service.login({ tenantCode: "demo", email: "demo@pharma.com", password: "wrongpass" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects login when tenant, user, or tenant active flag does not match", async () => {
    prisma.appUser.findFirst.mockResolvedValue(null);

    await expect(
      service.login({ tenantCode: "unknown", email: "demo@pharma.com", password: "password123" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refreshes token with valid refresh token", async () => {
    (jwtService.verifyAsync as jest.Mock).mockResolvedValue({
      sub: "user-id",
      tenantId: "tenant-id",
      email: "demo@pharma.com",
      branchRoles: [{ branchId: "branch-1", role: RoleName.cashier }],
      type: "refresh",
    });
    prisma.appUser.findUnique.mockResolvedValue({
      id: "user-id",
      tenantId: "tenant-id",
      email: "demo@pharma.com",
      fullName: "Demo User",
      passwordHash: "hash",
      isActive: true,
      refreshTokenHash: "stored-hash",
      tenant: { code: "demo" },
      userBranchRoles: [{ branchId: "branch-1", role: RoleName.cashier }],
    });
    mockedBcrypt.compare.mockResolvedValue(true as never);
    mockedBcrypt.hash.mockResolvedValue("rotated-hash" as never);
    (jwtService.signAsync as jest.Mock)
      .mockResolvedValueOnce("new-access-token")
      .mockResolvedValueOnce("new-refresh-token");

    const result = await service.refresh({ refreshToken: "refresh-token" });

    expect(result.accessToken).toBe("new-access-token");
    expect(result.user.tenantCode).toBe("demo");
    expect(prisma.appUser.update).toHaveBeenCalled();
  });
});
