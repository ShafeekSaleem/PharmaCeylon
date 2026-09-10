import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "./auth.service";
import { PasswordResetService } from "./password-reset.service";
import { VerificationEmailService } from "./verification-email.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

describe("PasswordResetService", () => {
  let prisma: any;
  let email: jest.Mocked<VerificationEmailService>;
  let auth: jest.Mocked<AuthService>;
  let audit: jest.Mocked<AuditService>;
  let service: PasswordResetService;

  const user = {
    id: "user-1",
    tenantId: "tenant-1",
    email: "priya@pharma.lk",
    fullName: "Priya Fernando",
    isActive: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      appUser: { findUnique: jest.fn(), update: jest.fn() },
      passwordResetToken: {
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tenantSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) =>
        fn({
          appUser: { update: prisma.appUser.update },
          passwordResetToken: {
            create: prisma.passwordResetToken.create,
            updateMany: prisma.passwordResetToken.updateMany,
          },
        }),
      ),
    };
    email = { sendPasswordReset: jest.fn() } as unknown as jest.Mocked<VerificationEmailService>;
    auth = { revokeAllSessions: jest.fn() } as unknown as jest.Mocked<AuthService>;
    audit = { log: jest.fn() } as unknown as jest.Mocked<AuditService>;
    mockedBcrypt.hash.mockResolvedValue("new-hash" as never);

    service = new PasswordResetService(prisma, email, auth, audit);
  });

  describe("request", () => {
    it("sends a reset email and stores only the token hash", async () => {
      prisma.appUser.findUnique.mockResolvedValue(user);

      await service.request({ email: "Priya@Pharma.LK" }, "203.0.113.9");

      // Address is normalised before lookup — login does the same.
      expect(prisma.appUser.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: "priya@pharma.lk" } }),
      );
      expect(email.sendPasswordReset).toHaveBeenCalledTimes(1);

      const sentToken = email.sendPasswordReset.mock.calls[0]![0]!.token;
      const stored = prisma.passwordResetToken.create.mock.calls[0]![0]!.data;
      expect(stored.tokenHash).toBe(hashToken(sentToken));
      // The raw token must never be persisted.
      expect(JSON.stringify(stored)).not.toContain(sentToken);
      expect(stored.requestIp).toBe("203.0.113.9");
    });

    it("retires outstanding tokens so an older emailed link stops working", async () => {
      prisma.appUser.findUnique.mockResolvedValue(user);

      await service.request({ email: user.email });

      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: user.id, usedAt: null },
        }),
      );
    });

    it("answers identically for an unknown address and sends nothing", async () => {
      prisma.appUser.findUnique.mockResolvedValue(null);

      await expect(service.request({ email: "nobody@pharma.lk" })).resolves.toEqual({
        ok: true,
      });
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it("does not let a suspended account recover itself", async () => {
      prisma.appUser.findUnique.mockResolvedValue({ ...user, isActive: false });

      await expect(service.request({ email: user.email })).resolves.toEqual({
        ok: true,
      });
      expect(email.sendPasswordReset).not.toHaveBeenCalled();
    });
  });

  describe("inspect", () => {
    it("masks the address so the link alone does not disclose it", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "tok-1",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user,
      });

      const result = await service.inspect("raw-token");

      expect(result.email).not.toBe(user.email);
      expect(result.email).toMatch(/^p•+a@pharma\.lk$/);
    });

    it("rejects an expired link", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "tok-1",
        usedAt: null,
        expiresAt: new Date(Date.now() - 1),
        user,
      });

      await expect(service.inspect("raw-token")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a link that was already spent", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "tok-1",
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        user,
      });

      await expect(service.inspect("raw-token")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("rejects a forged token", async () => {
      prisma.passwordResetToken.findUnique.mockResolvedValue(null);

      await expect(service.inspect("made-up")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("confirm", () => {
    beforeEach(() => {
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: "tok-1",
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user,
      });
    });

    it("sets the new password, clears the lockout, and signs the user out everywhere", async () => {
      await service.confirm({ token: "raw-token", newPassword: "Sunrise99!" });

      expect(prisma.appUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: user.id },
          data: expect.objectContaining({
            passwordHash: "new-hash",
            failedLoginAttempts: 0,
            lockedUntil: null,
          }),
        }),
      );
      expect(auth.revokeAllSessions).toHaveBeenCalledWith(
        user.id,
        "password_changed",
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "auth.password_reset_completed" }),
      );
    });

    it("claims the token in the same transaction as the password write", async () => {
      await service.confirm({ token: "raw-token", newPassword: "Sunrise99!" });

      expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "tok-1", usedAt: null }),
        }),
      );
    });

    it("fails when a concurrent submission already claimed the token", async () => {
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.confirm({ token: "raw-token", newPassword: "Sunrise99!" }),
      ).rejects.toThrow(/already been used/);
      expect(auth.revokeAllSessions).not.toHaveBeenCalled();
    });

    it("enforces the tenant's configured minimum length", async () => {
      prisma.tenantSettings.findUnique.mockResolvedValue({
        passwordMinLength: 12,
        passwordRequireNumberOrSymbol: true,
      });

      await expect(
        service.confirm({ token: "raw-token", newPassword: "Short1!" }),
      ).rejects.toThrow(/at least 12 characters/);
      expect(prisma.appUser.update).not.toHaveBeenCalled();
    });

    it("requires a number or symbol by default", async () => {
      await expect(
        service.confirm({ token: "raw-token", newPassword: "onlyletters" }),
      ).rejects.toThrow(/number or symbol/);
    });

    it("accepts letters-only when the tenant has relaxed the rule", async () => {
      prisma.tenantSettings.findUnique.mockResolvedValue({
        passwordMinLength: 8,
        passwordRequireNumberOrSymbol: false,
      });

      await expect(
        service.confirm({ token: "raw-token", newPassword: "onlyletters" }),
      ).resolves.toEqual({ ok: true });
    });
  });
});
