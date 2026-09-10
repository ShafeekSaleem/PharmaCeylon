import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";
import {
  ConfirmPasswordResetDto,
  RequestPasswordResetDto,
} from "./dto/password-reset.dto";
import { VerificationEmailService } from "./verification-email.service";

/** Short by design — a reset link is a bearer credential sitting in an inbox. */
const RESET_TTL_MINUTES = 30;
const RESET_TTL_MS = RESET_TTL_MINUTES * 60 * 1000;

/**
 * Self-service password recovery.
 *
 * Two properties drive the whole design:
 *
 *  - **The request endpoint never reveals whether an account exists.** It returns
 *    the same acknowledgement for a real address, an unknown one, and a suspended
 *    one. Anything else turns this into an account-enumeration oracle, and it is
 *    unauthenticated and rate-limited only by IP.
 *  - **The stored token is a hash.** The raw value exists only in the email, so a
 *    leaked database backup cannot be replayed into account takeover — the same
 *    reasoning as `StaffInvitation`.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: VerificationEmailService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  /** Always resolves to the same shape. See the class note on enumeration. */
  async request(
    dto: RequestPasswordResetDto,
    requestIp?: string | null,
  ): Promise<{ ok: true }> {
    const email = dto.email.trim().toLowerCase();
    const user = await this.prisma.appUser.findUnique({
      where: { email },
      select: { id: true, email: true, fullName: true, isActive: true },
    });

    // A suspended account must not be recoverable by its former holder — an
    // administrator reactivates first. Silent, for the same enumeration reason.
    if (!user || !user.isActive) {
      this.logger.log(
        `Password reset requested for a ${user ? "suspended" : "unknown"} address — no email sent`,
      );
      return { ok: true };
    }

    const rawToken = randomBytes(32).toString("base64url");

    // Issuing a new link retires any outstanding ones, so a forwarded or
    // shoulder-surfed older email stops working the moment the real owner asks
    // again.
    await this.prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + RESET_TTL_MS),
          requestIp: requestIp ?? null,
        },
      });
    });

    await this.email.sendPasswordReset({
      email: user.email,
      fullName: user.fullName,
      token: rawToken,
      expiresInMinutes: RESET_TTL_MINUTES,
    });

    return { ok: true };
  }

  /**
   * Checks a link before showing the form, so a stale link produces a clear page
   * rather than a rejected submission after the person has typed a new password.
   * Returns the masked address only — enough to confirm "this is my account"
   * without handing a full address to whoever holds the link.
   */
  async inspect(token: string): Promise<{ email: string; expiresAt: Date }> {
    const record = await this.findUsable(token);
    return {
      email: maskEmail(record.user.email),
      expiresAt: record.expiresAt,
    };
  }

  async confirm(dto: ConfirmPasswordResetDto): Promise<{ ok: true }> {
    const record = await this.findUsable(dto.token);
    const { user } = record;

    await this.assertMeetsPolicy(user.tenantId, dto.newPassword);
    const passwordHash = await bcrypt.hash(dto.newPassword, 10);

    // Claim the token inside the same transaction that writes the password: two
    // concurrent submissions of one link must not both succeed.
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new BadRequestException(
          "This reset link has already been used. Request a new one.",
        );
      }
      // tenant-scope: system-auth — the token established this verified identity.
      await tx.appUser.update({
        where: { id: user.id },
        data: {
          passwordHash,
          // Someone who has just proven inbox control should not still be held
          // out by the lockout that likely sent them here in the first place.
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      });
    });

    // Same hard invalidation as a self-service password change: if the reset was
    // triggered by a compromise, every existing session dies with it.
    await this.auth.revokeAllSessions(user.id, "password_changed");

    await this.audit.log({
      tenantId: user.tenantId,
      actorUserId: user.id,
      eventName: "auth.password_reset_completed",
      entityName: "app_user",
      entityId: user.id,
    });

    return { ok: true };
  }

  /** Applies the tenant's configured policy on top of the DTO's 8-character floor. */
  private async assertMeetsPolicy(
    tenantId: string,
    password: string,
  ): Promise<void> {
    const policy = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { passwordMinLength: true, passwordRequireNumberOrSymbol: true },
    });
    const minLength = policy?.passwordMinLength ?? 8;
    if (password.length < minLength) {
      throw new BadRequestException(
        `Password must be at least ${minLength} characters`,
      );
    }
    // Default true matches the column default, so a tenant with no settings row
    // still gets the stronger rule.
    const requireMix = policy?.passwordRequireNumberOrSymbol ?? true;
    if (requireMix && !/\d/.test(password) && !/[^A-Za-z0-9]/.test(password)) {
      throw new BadRequestException(
        "Password must include at least one number or symbol",
      );
    }
  }

  private async findUsable(token: string) {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            tenantId: true,
            isActive: true,
          },
        },
      },
    });
    // One message for every failure mode — expired, spent, forged — so the
    // endpoint cannot be probed for which tokens ever existed.
    if (
      !record ||
      record.usedAt ||
      record.expiresAt.getTime() <= Date.now() ||
      !record.user.isActive
    ) {
      throw new BadRequestException(
        "This password reset link is invalid or has expired. Request a new one.",
      );
    }
    return record;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `priya.fernando@example.com` → `p••••••••••o@example.com` */
function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return "••••";
  if (local.length <= 2) return `${local[0]}••@${domain}`;
  return `${local[0]}${"•".repeat(Math.min(local.length - 2, 10))}${local[local.length - 1]}@${domain}`;
}
