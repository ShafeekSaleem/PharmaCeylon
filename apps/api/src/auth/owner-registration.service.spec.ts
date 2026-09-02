import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { OwnerRegistrationStatus } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { OwnerRegistrationService } from "./owner-registration.service";
import { VerificationEmailService } from "./verification-email.service";

jest.mock("bcrypt");
const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

describe("OwnerRegistrationService", () => {
  let prisma: any;
  let jwt: jest.Mocked<JwtService>;
  let config: jest.Mocked<ConfigService>;
  let email: jest.Mocked<VerificationEmailService>;
  let service: OwnerRegistrationService;

  const verifiedRegistration = {
    id: "registration-id",
    email: "owner@example.com",
    firstName: "Shafeek",
    lastName: "Saleem",
    phone: "+94 77 123 4567",
    passwordHash: "password-hash",
    status: OwnerRegistrationStatus.verified,
    verificationTokenHash: null,
    verificationExpiresAt: null,
    verifiedAt: new Date(),
    onboardingSessionVersion: 1,
    onboardingDraft: null,
    completedTenantId: null,
    completedUserId: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      appUser: { findUnique: jest.fn() },
      ownerRegistration: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    jwt = {
      signAsync: jest.fn(),
      verifyAsync: jest.fn(),
    } as unknown as jest.Mocked<JwtService>;
    config = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          OWNER_VERIFICATION_TTL_MINUTES: "30",
          JWT_ONBOARDING_TTL_SECONDS: "86400",
        };
        return values[key];
      }),
      getOrThrow: jest.fn(() => "onboarding-secret"),
    } as unknown as jest.Mocked<ConfigService>;
    email = {
      sendOwnerVerification: jest.fn(),
    } as unknown as jest.Mocked<VerificationEmailService>;
    service = new OwnerRegistrationService(prisma, jwt, config, email);
  });

  it("stores only hashes and sends the raw verification token", async () => {
    prisma.appUser.findUnique.mockResolvedValue(null);
    prisma.ownerRegistration.findUnique.mockResolvedValue(null);
    mockedBcrypt.hash.mockResolvedValue("password-hash" as never);
    prisma.ownerRegistration.create.mockImplementation(async ({ data }: any) => ({
      email: data.email,
      firstName: data.firstName,
    }));

    const result = await service.create({
      firstName: " Shafeek ",
      lastName: " Saleem ",
      email: " Owner@Example.com ",
      phone: "+94 77 123 4567",
      password: "Owner123!",
    });

    const createData = prisma.ownerRegistration.create.mock.calls[0][0].data;
    const deliveredToken = email.sendOwnerVerification.mock.calls[0][0].token;

    expect(result).toEqual({
      status: "verification_required",
      email: "owner@example.com",
    });
    expect(createData.passwordHash).toBe("password-hash");
    expect(createData.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(createData.verificationTokenHash).not.toBe(deliveredToken);
    expect(deliveredToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns the same response for an existing account without sending email", async () => {
    prisma.appUser.findUnique.mockResolvedValue({ id: "existing-user" });
    prisma.ownerRegistration.findUnique.mockResolvedValue(null);

    await expect(
      service.create({
        firstName: "Existing",
        lastName: "Owner",
        email: "owner@example.com",
        password: "Owner123!",
      }),
    ).resolves.toEqual({
      status: "verification_required",
      email: "owner@example.com",
    });
    expect(prisma.ownerRegistration.create).not.toHaveBeenCalled();
    expect(email.sendOwnerVerification).not.toHaveBeenCalled();
  });

  it("verifies once, rotates the onboarding session version, and signs a session", async () => {
    const pending = {
      ...verifiedRegistration,
      status: OwnerRegistrationStatus.pending_email,
      verificationTokenHash: "stored-hash",
      verificationExpiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      onboardingSessionVersion: 0,
    };
    prisma.ownerRegistration.findUnique.mockResolvedValue(pending);
    prisma.ownerRegistration.update.mockResolvedValue(verifiedRegistration);
    jwt.signAsync.mockResolvedValue("signed-onboarding-token");

    const result = await service.verify("raw-verification-token");

    expect(prisma.ownerRegistration.update).toHaveBeenCalledWith({
      where: { id: pending.id },
      data: expect.objectContaining({
        status: OwnerRegistrationStatus.verified,
        verificationTokenHash: null,
        verificationExpiresAt: null,
        onboardingSessionVersion: { increment: 1 },
      }),
    });
    expect(jwt.signAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: pending.id,
        email: pending.email,
        type: "onboarding",
        version: 1,
      }),
      expect.objectContaining({ secret: "onboarding-secret", expiresIn: 86400 }),
    );
    expect(result.onboardingToken).toBe("signed-onboarding-token");
    expect(result.session.nextPath).toBe("/onboarding/pharmacy");
  });

  it("expires an old verification link without issuing a session", async () => {
    prisma.ownerRegistration.findUnique.mockResolvedValue({
      ...verifiedRegistration,
      status: OwnerRegistrationStatus.pending_email,
      verificationTokenHash: "stored-hash",
      verificationExpiresAt: new Date(Date.now() - 1),
      verifiedAt: null,
    });
    prisma.ownerRegistration.update.mockResolvedValue({});

    await expect(service.verify("expired-token-value-with-enough-length")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(jwt.signAsync).not.toHaveBeenCalled();
    expect(prisma.ownerRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OwnerRegistrationStatus.expired }),
      }),
    );
  });

  it("rejects an onboarding token after its version is superseded", async () => {
    jwt.verifyAsync.mockResolvedValue({
      sub: verifiedRegistration.id,
      email: verifiedRegistration.email,
      type: "onboarding",
      version: 0,
    });
    prisma.ownerRegistration.findUnique.mockResolvedValue(verifiedRegistration);

    await expect(service.status("old-token")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
