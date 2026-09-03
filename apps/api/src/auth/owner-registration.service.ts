import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { OwnerRegistrationStatus } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
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
  status: "verified" | "completed";
  completedTenantId: string | null;
  completedUserId: string | null;
  nextPath: "/onboarding/pharmacy" | "/get-started";
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
      this.prisma.appUser.findUnique({
        where: { email },
        select: { id: true },
      }),
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
    const code = newVerificationCode();
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
        verificationTokenHash: hashVerificationCode(email, code),
        verificationExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
      },
      select: { email: true, firstName: true },
    });

    await this.verificationEmail.sendOwnerVerification({
      email: registration.email,
      firstName: registration.firstName,
      code,
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

    const code = newVerificationCode();
    const ttlMinutes = positiveNumber(
      this.config.get<string>("OWNER_VERIFICATION_TTL_MINUTES"),
      30,
    );
    await this.prisma.ownerRegistration.update({
      where: { id: registration.id },
      data: {
        status: OwnerRegistrationStatus.pending_email,
        verifiedAt: null,
        verificationTokenHash: hashVerificationCode(email, code),
        verificationExpiresAt: new Date(Date.now() + ttlMinutes * 60_000),
        onboardingSessionVersion: { increment: 1 },
      },
    });
    await this.verificationEmail.sendOwnerVerification({
      email: registration.email,
      firstName: registration.firstName,
      code,
    });
    return { status: "verification_required", email };
  }

  async verify(
    emailInput: string,
    code: string,
  ): Promise<{
    onboardingToken: string;
    ttlSeconds: number;
    session: VerifiedOwnerSession;
  }> {
    const email = normalizeEmail(emailInput);
    const registration = await this.prisma.ownerRegistration.findUnique({
      where: { email },
    });

    if (
      !registration ||
      registration.status !== OwnerRegistrationStatus.pending_email ||
      !registration.verificationExpiresAt ||
      !registration.verificationTokenHash ||
      !matchesVerificationCredential(
        registration.verificationTokenHash,
        email,
        code,
      )
    ) {
      throw new BadRequestException(
        "This verification code is invalid or has already been used",
      );
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
      throw new BadRequestException("This verification code has expired");
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
      (registration.status !== OwnerRegistrationStatus.verified &&
        registration.status !== OwnerRegistrationStatus.completed) ||
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
    status: OwnerRegistrationStatus;
    completedTenantId?: string | null;
    completedUserId?: string | null;
  }): VerifiedOwnerSession {
    const completed = registration.status === OwnerRegistrationStatus.completed;
    return {
      registrationId: registration.id,
      email: registration.email,
      firstName: registration.firstName,
      lastName: registration.lastName,
      phone: registration.phone,
      status: completed ? "completed" : "verified",
      completedTenantId: registration.completedTenantId ?? null,
      completedUserId: registration.completedUserId ?? null,
      nextPath: completed ? "/get-started" : "/onboarding/pharmacy",
    };
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function newVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashVerificationCode(email: string, code: string): string {
  return hashToken(`${normalizeEmail(email)}:${code}`);
}

function matchesVerificationCredential(
  storedHash: string,
  email: string,
  credential: string,
): boolean {
  // The second value keeps already-sent Phase 1 magic links usable during the rollout.
  return [hashVerificationCode(email, credential), hashToken(credential)].some(
    (candidate) => {
      const stored = Buffer.from(storedHash, "hex");
      const supplied = Buffer.from(candidate, "hex");
      return (
        stored.length === supplied.length && timingSafeEqual(stored, supplied)
      );
    },
  );
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
