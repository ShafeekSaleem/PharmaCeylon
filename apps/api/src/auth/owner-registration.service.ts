import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { OwnerRegistrationStatus } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateOwnerRegistrationDto } from "./dto/create-owner-registration.dto";
import { OnboardingTokenPayload } from "./types/onboarding-token-payload.type";
import { VerificationEmailService } from "./verification-email.service";

type VerificationRequired = {
  status: "verification_required";
  email: string;
};

export type VerifiedOwnerSession = {
  registrationId: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  nextPath: "/onboarding/pharmacy";
};

@Injectable()
export class OwnerRegistrationService {
  private static readonly PASSWORD_ROUNDS = 12;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly verificationEmail: VerificationEmailService,
  ) {}

  async create(dto: CreateOwnerRegistrationDto): Promise<VerificationRequired> {
    const email = normalizeEmail(dto.email);
    const [existingUser, existingRegistration] = await Promise.all([
      this.prisma.appUser.findUnique({ where: { email }, select: { id: true } }),
      this.prisma.ownerRegistration.findUnique({
        where: { email },
        select: { id: true, status: true },
      }),
    ]);

    // Keep this response deliberately indistinguishable. An existing pending
    // registration can use the resend endpoint; existing users should sign in.
    if (existingUser || existingRegistration) {
      return { status: "verification_required", email };
    }

    const passwordHash = await bcrypt.hash(
      dto.password,
      OwnerRegistrationService.PASSWORD_ROUNDS,
    );
    const token = newVerificationToken();
    const ttlMinutes = positiveNumber(
      this.config.get<string>("OWNER_VERIFICATION_TTL_MINUTES"),
      30,
    );

    const registration = await this.prisma.ownerRegistration.create({
      data: {
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        phone: dto.phone?.trim() || null,
        passwordHash,
        status: OwnerRegistrationStatus.pending_email,
        verificationTokenHash: hashToken(token),
        verificationExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
      select: { email: true, firstName: true },
    });

    await this.verificationEmail.sendOwnerVerification({
      email: registration.email,
      firstName: registration.firstName,
      token,
    });

    return { status: "verification_required", email };
  }

  async resend(emailInput: string): Promise<VerificationRequired> {
    const email = normalizeEmail(emailInput);
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        firstName: true,
        status: true,
      },
    });

    if (
      !registration ||
      registration.status === OwnerRegistrationStatus.completed ||
      registration.status === OwnerRegistrationStatus.cancelled
    ) {
      return { status: "verification_required", email };
    }

    const token = newVerificationToken();
    const ttlMinutes = positiveNumber(
      this.config.get<string>("OWNER_VERIFICATION_TTL_MINUTES"),
      30,
    );
    await this.prisma.ownerRegistration.update({
      where: { id: registration.id },
      data: {
        status: OwnerRegistrationStatus.pending_email,
        verifiedAt: null,
        verificationTokenHash: hashToken(token),
        verificationExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        onboardingSessionVersion: { increment: 1 },
      },
    });
    await this.verificationEmail.sendOwnerVerification({
      email: registration.email,
      firstName: registration.firstName,
      token,
    });
    return { status: "verification_required", email };
  }

  async verify(rawToken: string): Promise<{
    onboardingToken: string;
    ttlSeconds: number;
    session: VerifiedOwnerSession;
  }> {
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { verificationTokenHash: hashToken(rawToken) },
    });

    if (
      !registration ||
      registration.status !== OwnerRegistrationStatus.pending_email ||
      !registration.verificationExpiresAt
    ) {
      throw new BadRequestException("This verification link is invalid or has already been used");
    }

    if (registration.verificationExpiresAt <= new Date()) {
      await this.prisma.ownerRegistration.update({
        where: { id: registration.id },
        data: {
          status: OwnerRegistrationStatus.expired,
          verificationTokenHash: null,
          verificationExpiresAt: null,
        },
      });
      throw new BadRequestException("This verification link has expired");
    }

    const verified = await this.prisma.ownerRegistration.update({
      where: { id: registration.id },
      data: {
        status: OwnerRegistrationStatus.verified,
        verifiedAt: new Date(),
        verificationTokenHash: null,
        verificationExpiresAt: null,
        onboardingSessionVersion: { increment: 1 },
      },
    });

    const ttlSeconds = positiveNumber(
      this.config.get<string>("JWT_ONBOARDING_TTL_SECONDS"),
      86_400,
    );
    const payload: OnboardingTokenPayload = {
      sub: verified.id,
      email: verified.email,
      type: "onboarding",
      version: verified.onboardingSessionVersion,
    };
    const onboardingToken = await this.jwt.signAsync(payload, {
      secret: this.config.getOrThrow<string>("JWT_ONBOARDING_SECRET"),
      expiresIn: ttlSeconds,
    });

    return {
      onboardingToken,
      ttlSeconds,
      session: this.toSession(verified),
    };
  }

  async status(token: string): Promise<VerifiedOwnerSession> {
    let payload: OnboardingTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<OnboardingTokenPayload>(token, {
        secret: this.config.getOrThrow<string>("JWT_ONBOARDING_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid onboarding session");
    }
    if (payload.type !== "onboarding") {
      throw new UnauthorizedException("Invalid onboarding session");
    }

    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { id: payload.sub },
    });
    if (
      !registration ||
      registration.email !== payload.email ||
      registration.status !== OwnerRegistrationStatus.verified ||
      registration.onboardingSessionVersion !== payload.version
    ) {
      throw new UnauthorizedException("Onboarding session is no longer valid");
    }
    return this.toSession(registration);
  }

  private toSession(registration: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string | null;
  }): VerifiedOwnerSession {
    return {
      registrationId: registration.id,
      email: registration.email,
      firstName: registration.firstName,
      lastName: registration.lastName,
      phone: registration.phone,
      nextPath: "/onboarding/pharmacy",
    };
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function newVerificationToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
