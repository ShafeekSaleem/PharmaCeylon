import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { RoleName } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { AuditService } from "../audit/audit.service";
import { UploadsService } from "../uploads/uploads.service";
import { AuthService } from "./auth.service";
import { SESSION_REVOKED_REASONS, SessionStore } from "./session.store";
import { UserContextService } from "./user-context.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("AuthService", () => {
  let prisma: any;
  let jwtService: JwtService;
  let configService: ConfigService;
  let sessionStore: jest.Mocked<SessionStore>;
  let userContext: jest.Mocked<UserContextService>;
  let auditService: jest.Mocked<AuditService>;
  let uploadsService: jest.Mocked<UploadsService>;
  let service: AuthService;

  const baseUser = {
    id: "user-id",
    tenantId: "tenant-id",
    lastTenantId: "tenant-id",
    email: "demo@pharma.com",
    fullName: "Demo User",
    passwordHash: "hash",
    tokenVersion: 3,
    isActive: true,
    tenant: { code: "demo", isActive: true },
    tenantMemberships: [
      { tenantId: "tenant-id", isActive: true, tenant: { code: "demo", isActive: true } },
    ],
    userBranchRoles: [
      { tenantId: "tenant-id", branchId: "branch-1", role: RoleName.manager },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      appUser: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      session: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      // The service uses $transaction(callback) — pass a tx mock through.
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          session: {
            create: prisma.session.create,
            update: prisma.session.update,
            updateMany: prisma.session.updateMany,
          },
          appUser: { update: prisma.appUser.update },
        }),
      ),
    };

    jwtService = {
      signAsync: jest.fn(),
      verifyAsync: jest.fn(),
    } as unknown as JwtService;

    configService = {
      getOrThrow: jest.fn((key: string) => {
        const map: Record<string, string> = {
          JWT_ACCESS_SECRET: "access-secret",
          JWT_REFRESH_SECRET: "refresh-secret",
        };
        return map[key];
      }),
      get: jest.fn((_key: string, defaultValue: number) => defaultValue),
    } as unknown as ConfigService;

    sessionStore = {
      findActiveById: jest.fn(),
      matchToken: jest.fn(),
      revokeFamily: jest.fn().mockResolvedValue(0),
      revokeById: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<SessionStore>;

    userContext = {
      invalidate: jest.fn(),
      load: jest.fn(),
      clearAll: jest.fn(),
    } as unknown as jest.Mocked<UserContextService>;

    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditService>;

    uploadsService = {
      uploadImage: jest.fn(),
    } as unknown as jest.Mocked<UploadsService>;

    service = new AuthService(
      prisma,
      jwtService,
      configService,
      sessionStore,
      userContext,
      auditService,
      uploadsService,
    );
  });

  describe("login", () => {
    it("issues an access+refresh token pair, creates a session, and clears the user-context cache", async () => {
      prisma.appUser.findUnique.mockResolvedValue(baseUser);
      mockedBcrypt.compare.mockResolvedValue(true as never);
      mockedBcrypt.hash.mockResolvedValue("hashed" as never);
      prisma.session.create.mockResolvedValue({ id: "session-1", familyId: "family-1" });
      (jwtService.signAsync as jest.Mock)
        .mockResolvedValueOnce("signed-refresh")
        .mockResolvedValueOnce("signed-access");

      const result = await service.login({
        email: "demo@pharma.com",
        password: "password123",
      });

      expect(result.accessToken).toBe("signed-access");
      expect(result.refreshToken).toBe("signed-refresh");
      expect(result.user.tenantCode).toBe("demo");
      expect(result.csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(prisma.appUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: "demo@pharma.com" },
        }),
      );
      expect(prisma.session.create).toHaveBeenCalledTimes(1);
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session-1", tenantId: "tenant-id" },
          data: expect.objectContaining({ refreshTokenHash: "hashed" }),
        }),
      );
      expect(userContext.invalidate).toHaveBeenCalledWith("user-id");
    });

    it("rejects an invalid password", async () => {
      prisma.appUser.findUnique.mockResolvedValue(baseUser);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(
        service.login({ email: "demo@pharma.com", password: "wrong" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.session.create).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "auth.login_failed", entityId: baseUser.id }),
      );
    });

    it("rejects an unknown email or inactive user/tenant", async () => {
      prisma.appUser.findUnique.mockResolvedValue(null);
      await expect(
        service.login({ email: "nobody@pharma.com", password: "password123" }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("refresh", () => {
    const session = {
      id: "session-1",
      tenantId: "tenant-id",
      userId: "user-id",
      familyId: "family-1",
      refreshTokenHash: "stored-hash",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
      revokedReason: null,
      replacedById: null,
      createdAt: new Date(),
      lastUsedAt: null,
      userAgent: null,
      ipAddress: null,
    };

    function mockRefreshVerify(payload: Partial<{ sub: string; familyId: string; sessionId: string }> = {}) {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValue({
        sub: payload.sub ?? "user-id",
        tenantId: "tenant-id",
        sessionId: payload.sessionId ?? "session-1",
        familyId: payload.familyId ?? "family-1",
        type: "refresh",
      });
    }

    it("rotates the session and issues a new pair on a valid refresh", async () => {
      mockRefreshVerify();
      sessionStore.findActiveById.mockResolvedValue(session as any);
      sessionStore.matchToken.mockResolvedValue(true);
      prisma.appUser.findUnique.mockResolvedValue(baseUser);
      mockedBcrypt.hash.mockResolvedValue("hashed" as never);
      prisma.session.create.mockResolvedValue({ id: "session-2", familyId: "family-1" });
      (jwtService.signAsync as jest.Mock)
        .mockResolvedValueOnce("rotated-refresh")
        .mockResolvedValueOnce("rotated-access");

      const result = await service.refresh("presented-token");

      expect(result.accessToken).toBe("rotated-access");
      expect(result.refreshToken).toBe("rotated-refresh");
      // old session marked revoked → rotated
      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session-1", tenantId: "tenant-id" },
          data: expect.objectContaining({
            revokedReason: SESSION_REVOKED_REASONS.rotated,
            replacedById: "session-2",
          }),
        }),
      );
    });

    it("detects refresh-token reuse, revokes the family, and bumps tokenVersion", async () => {
      mockRefreshVerify();
      sessionStore.findActiveById.mockResolvedValue({ ...session, revokedAt: new Date() } as any);

      await expect(service.refresh("presented-token")).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sessionStore.revokeFamily).toHaveBeenCalledWith(
        "family-1",
        SESSION_REVOKED_REASONS.reuseDetected,
      );
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: "user-id" },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(userContext.invalidate).toHaveBeenCalledWith("user-id");
    });

    it("rejects a refresh token whose hash no longer matches the session (theft / replay)", async () => {
      mockRefreshVerify();
      sessionStore.findActiveById.mockResolvedValue(session as any);
      sessionStore.matchToken.mockResolvedValue(false);

      await expect(service.refresh("presented-token")).rejects.toBeInstanceOf(UnauthorizedException);
      expect(sessionStore.revokeFamily).toHaveBeenCalledWith(
        "family-1",
        SESSION_REVOKED_REASONS.reuseDetected,
      );
    });

    it("rejects when the refresh JWT signature is invalid", async () => {
      (jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error("bad"));
      await expect(service.refresh("garbage")).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects when family/userId in the JWT doesn't match the stored session", async () => {
      mockRefreshVerify({ familyId: "other-family" });
      sessionStore.findActiveById.mockResolvedValue(session as any);
      await expect(service.refresh("presented-token")).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("rejects when the session has expired", async () => {
      mockRefreshVerify();
      sessionStore.findActiveById.mockResolvedValue({
        ...session,
        expiresAt: new Date(Date.now() - 1_000),
      } as any);
      await expect(service.refresh("presented-token")).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("logout", () => {
    it("revokes the session identified by a valid refresh token", async () => {
      (jwtService.verifyAsync as jest.Mock).mockResolvedValue({
        sub: "user-id",
        tenantId: "tenant-id",
        sessionId: "session-99",
        familyId: "family-7",
        type: "refresh",
      });

      await service.logout("valid-refresh");
      expect(sessionStore.revokeById).toHaveBeenCalledWith(
        "session-99",
        SESSION_REVOKED_REASONS.logout,
      );
    });

    it("is a silent no-op when no refresh token is provided", async () => {
      await service.logout(null);
      expect(sessionStore.revokeById).not.toHaveBeenCalled();
    });

    it("is a silent no-op when the refresh token is malformed/expired (so clearing cookies is still idempotent)", async () => {
      (jwtService.verifyAsync as jest.Mock).mockRejectedValue(new Error("bad"));
      await service.logout("garbage");
      expect(sessionStore.revokeById).not.toHaveBeenCalled();
    });
  });

  describe("logoutAll", () => {
    it("revokes every active session and bumps tokenVersion", async () => {
      await service.logoutAll("user-id");

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-id", revokedAt: null },
        data: expect.objectContaining({ revokedReason: SESSION_REVOKED_REASONS.logoutAll }),
      });
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: "user-id" },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(userContext.invalidate).toHaveBeenCalledWith("user-id");
    });
  });

  describe("invalidateUserContext (soft, for role/branch changes)", () => {
    it("bumps tokenVersion WITHOUT revoking sessions — refresh transparently re-issues with fresh roles", async () => {
      await service.invalidateUserContext("user-id");

      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: "user-id" },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
      expect(userContext.invalidate).toHaveBeenCalledWith("user-id");
    });
  });

  describe("revokeAllSessions (hard, for password change / suspension)", () => {
    it("revokes every session AND bumps tokenVersion", async () => {
      await service.revokeAllSessions("user-id", "password_changed");

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-id", revokedAt: null },
        data: expect.objectContaining({ revokedReason: SESSION_REVOKED_REASONS.passwordChanged }),
      });
      expect(prisma.appUser.update).toHaveBeenCalledWith({
        where: { id: "user-id" },
        data: { tokenVersion: { increment: 1 } },
      });
      expect(userContext.invalidate).toHaveBeenCalledWith("user-id");
    });
  });
});
