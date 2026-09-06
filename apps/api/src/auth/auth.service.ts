import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { AppUser, Prisma, RoleName, Session } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { UploadsService } from "../uploads/uploads.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { UpdateMyProfileDto } from "./dto/update-my-profile.dto";
import {
  AccessTokenPayload,
  RefreshTokenPayload,
} from "./types/auth-token-payload.type";
import {
  SESSION_REVOKED_REASONS,
  SessionStore,
} from "./session.store";
import { UserContextService } from "./user-context.service";

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export type LoginResult = IssuedTokens & {
  user: AuthUserView;
};

export type AuthUserView = {
  id: string;
  tenantId: string;
  tenantCode?: string;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  roles: RoleName[];
  branchRoles: Array<{ branchId: string; role: RoleName }>;
};

export type RequestMeta = {
  userAgent?: string | null;
  ipAddress?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly sessions: SessionStore,
    private readonly userContext: UserContextService,
    private readonly auditService: AuditService,
    private readonly uploadsService: UploadsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Public flows
  // ---------------------------------------------------------------------------

  private static readonly MAX_FAILED_ATTEMPTS = 5;
  private static readonly LOCKOUT_MINUTES = 15;

  async login(dto: LoginDto, meta: RequestMeta = {}): Promise<LoginResult> {
    const emailNorm = dto.email.trim().toLowerCase();

    const userInclude = {
      tenantMemberships: {
        where: { isActive: true },
        include: { tenant: { select: { code: true, isActive: true } } },
        orderBy: { joinedAt: "asc" as const },
      },
      userBranchRoles: { select: { tenantId: true, branchId: true, role: true } },
    } satisfies Prisma.AppUserInclude;

    const user = await this.prisma.appUser.findUnique({
      where: { email: emailNorm },
      include: userInclude,
    });

    const activeMemberships =
      user?.tenantMemberships.filter((membership) => membership.tenant.isActive) ?? [];
    if (!user || !user.isActive || activeMemberships.length === 0) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const membership =
      activeMemberships.find((entry) => entry.tenantId === user.lastTenantId) ??
      activeMemberships.find((entry) => entry.tenantId === user.tenantId) ??
      activeMemberships[0];
    const branchRoles = user.userBranchRoles.filter(
      (entry) => entry.tenantId === membership.tenantId,
    );

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const remainingMs = user.lockedUntil.getTime() - Date.now();
      const remainingMin = Math.ceil(remainingMs / 60_000);
      throw new UnauthorizedException(
        `Account temporarily locked. Try again in ${remainingMin} minute${remainingMin === 1 ? "" : "s"}.`,
      );
    }

    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      const attempts = user.failedLoginAttempts + 1;
      const lockout =
        attempts >= AuthService.MAX_FAILED_ATTEMPTS
          ? new Date(Date.now() + AuthService.LOCKOUT_MINUTES * 60_000)
          : null;

      // tenant-scope: system-auth — the globally unique login identity was verified by password.
      await this.prisma.appUser.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          ...(lockout ? { lockedUntil: lockout } : {}),
        },
      });

      await this.auditService.log({
        tenantId: membership.tenantId,
        actorUserId: user.id,
        eventName: "auth.login_failed",
        entityName: "app_user",
        entityId: user.id,
        payload: { attempts, locked: !!lockout, ipAddress: meta.ipAddress ?? null },
      });

      throw new UnauthorizedException("Invalid credentials");
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      // tenant-scope: system-auth — the globally unique login identity was verified by password.
      await this.prisma.appUser.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    return this.issueAndPersist({
      user,
      tenantId: membership.tenantId,
      tenantCode: membership.tenant.code,
      branchRoles,
      previousSession: null,
      meta,
    });
  }


  /** Starts the owner's first authenticated session after workspace provisioning. */
  async issueProvisionedSession(
    userId: string,
    meta: RequestMeta = {},
  ): Promise<LoginResult> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      select: { tenantId: true },
    });
    if (!user) {
      throw new UnauthorizedException("Unable to start workspace session");
    }
    return this.issueTenantSession(userId, user.tenantId, meta);
  }

  /** Starts a session in one verified active tenant membership (used after invitation acceptance). */
  async issueTenantSession(
    userId: string,
    tenantId: string,
    meta: RequestMeta = {},
  ): Promise<LoginResult> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      include: {
        tenantMemberships: {
          where: { tenantId, isActive: true },
          include: { tenant: { select: { code: true, isActive: true } } },
        },
        userBranchRoles: {
          where: { tenantId },
          select: { branchId: true, role: true },
        },
      },
    });
    const membership = user?.tenantMemberships[0];
    if (!user || !user.isActive || !membership?.tenant.isActive) {
      throw new UnauthorizedException("Unable to start workspace session");
    }
    return this.issueAndPersist({
      user,
      tenantId,
      tenantCode: membership.tenant.code,
      branchRoles: user.userBranchRoles,
      previousSession: null,
      meta,
    });
  }

  /**
   * Stateless step 1: verify JWT signature/type + sessionId/familyId match.
   * Stateful step 2: look up the session row.
   *
   * Reuse detection: if the row exists but is `revokedAt != null`, the same
   * refresh token was used twice → wipe the entire family + bump tokenVersion
   * so any outstanding access tokens are also invalidated.
   */
  async refresh(presentedRefreshToken: string, meta: RequestMeta = {}): Promise<LoginResult> {
    const payload = await this.verifyRefreshTokenSignature(presentedRefreshToken);
    const session = await this.sessions.findActiveById(payload.sessionId);

    if (!session || session.familyId !== payload.familyId || session.userId !== payload.sub) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    // --- Reuse detection -----------------------------------------------------
    if (session.revokedAt !== null) {
      this.logger.warn(
        `Refresh-token reuse detected for user=${session.userId} family=${session.familyId}`,
      );
      await this.sessions.revokeFamily(session.familyId, SESSION_REVOKED_REASONS.reuseDetected);
      await this.bumpTokenVersion(session.userId);
      throw new UnauthorizedException("Refresh token reuse detected");
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    // Defence in depth: even if the JWT verifies, ensure the presented raw
    // token still matches the stored bcrypt hash.
    const tokenValid = await this.sessions.matchToken(session, presentedRefreshToken);
    if (!tokenValid) {
      this.logger.warn(
        `Refresh-token hash mismatch for session=${session.id} — revoking family`,
      );
      await this.sessions.revokeFamily(session.familyId, SESSION_REVOKED_REASONS.reuseDetected);
      await this.bumpTokenVersion(session.userId);
      throw new UnauthorizedException("Invalid refresh token");
    }

    const user = await this.prisma.appUser.findUnique({
      where: { id: session.userId },
      include: {
        tenantMemberships: {
          where: { tenantId: session.tenantId, isActive: true },
          include: { tenant: { select: { code: true, isActive: true } } },
        },
        userBranchRoles: {
          where: { tenantId: session.tenantId },
          select: { branchId: true, role: true },
        },
      },
    });
    const membership = user?.tenantMemberships[0];
    if (!user || !user.isActive || !membership?.tenant.isActive) {
      await this.sessions.revokeById(session.id, SESSION_REVOKED_REASONS.adminInvalidated);
      throw new UnauthorizedException("Invalid refresh token");
    }

    return this.issueAndPersist({
      user,
      tenantId: session.tenantId,
      tenantCode: membership.tenant.code,
      branchRoles: user.userBranchRoles,
      previousSession: session,
      meta,
    });
  }

  /**
   * Single-device logout.
   *
   * The access token doesn't carry `sessionId` (intentional — keep it lean and
   * make access tokens cheaper to verify offline). To identify which session
   * to kill we read the refresh token (cookie or body), verify its signature,
   * and revoke the corresponding row. If the refresh token is missing or
   * invalid we silently no-op so the caller's "clear cookies" path is still
   * idempotent.
   */
  async logout(presentedRefreshToken: string | null): Promise<void> {
    if (!presentedRefreshToken) return;
    let payload: RefreshTokenPayload;
    try {
      payload = await this.verifyRefreshTokenSignature(presentedRefreshToken);
    } catch {
      return; // expired/invalid — nothing to revoke
    }
    await this.sessions.revokeById(payload.sessionId, SESSION_REVOKED_REASONS.logout);
  }

  /**
   * Revoke all sessions and bump tokenVersion. After this call:
   *   - every refresh token issued to the user is dead, and
   *   - every still-live access token fails the tokenVersion check.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // tenant-scope: system-auth — userId is a verified globally unique identity.
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: SESSION_REVOKED_REASONS.logoutAll },
      });
      // tenant-scope: system-auth — the same verified user identity scopes this token bump.
      // tenant-scope: verified-parent — the caller verified this tenant membership first.
      await tx.appUser.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
    });
    this.userContext.invalidate(userId);
  }

  /**
   * SOFT invalidation. Bump `tokenVersion` only — existing access tokens fail
   * their version check on the next request, the client transparently
   * refreshes (the refresh session is still alive), and the new access token
   * is signed with the user's *current* roles and branch assignments.
   *
   * Use this for normal authorization changes where the user should stay
   * logged in: role grant/revoke, branch assignment changes, etc.
   *
   * Worst-case staleness window = JWT_ACCESS_TTL_SECONDS (per-request cost)
   * OR USER_CONTEXT_TTL_SECONDS (cached lookup); whichever bites first.
   */
  async invalidateUserContext(userId: string): Promise<void> {
    // tenant-scope: verified-parent — callers tenant-check the target before invalidating its cache.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    this.userContext.invalidate(userId);
    this.logger.log(`Soft-invalidated access tokens for user=${userId}`);
  }

  /**
   * HARD invalidation. Revoke every session AND bump tokenVersion → the user
   * must log in again on every device.
   *
   * Use this for password changes, account suspensions, detected token theft,
   * or any "kick them out NOW" scenario.
   */
  async revokeAllSessions(
    userId: string,
    reason: "password_changed" | "suspended" | "admin_invalidated",
  ): Promise<void> {
    const sessionReason =
      reason === "password_changed"
        ? SESSION_REVOKED_REASONS.passwordChanged
        : SESSION_REVOKED_REASONS.adminInvalidated;
    await this.prisma.$transaction(async (tx) => {
      // tenant-scope: system-auth — userId is a verified globally unique identity.
      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: sessionReason },
      });
      // tenant-scope: system-auth — the same verified user identity scopes this token bump.
      // tenant-scope: system-auth — session issuance already verified the active membership.
      await tx.appUser.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
    });
    this.userContext.invalidate(userId);
    this.logger.log(`Hard-revoked all sessions for user=${userId} reason=${reason}`);
  }

  /** Revokes sessions for one pharmacy membership without signing the person out of others. */
  async revokeTenantSessions(tenantId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { tenantId, userId, revokedAt: null },
        data: {
          revokedAt: new Date(),
          revokedReason: SESSION_REVOKED_REASONS.adminInvalidated,
        },
      });
      // Existing access tokens do not carry a membership version. Bumping the
      // identity version expires them immediately; sessions in other pharmacies
      // remain refreshable and receive a fresh access token transparently.
      // tenant-scope: verified-parent — the caller verified this tenant membership first.
      await tx.appUser.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
    });
    this.userContext.invalidate(userId);
  }

  async getMe(userId: string, tenantId: string): Promise<AuthUserView> {
    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      include: {
        tenantMemberships: {
          where: { tenantId, isActive: true },
          include: { tenant: { select: { code: true, isActive: true } } },
        },
        userBranchRoles: {
          where: { tenantId },
          select: { branchId: true, role: true },
        },
      },
    });
    const membership = user?.tenantMemberships[0];
    if (!user || !membership?.tenant.isActive) {
      throw new UnauthorizedException("User not found");
    }
    return this.mapUser(user, tenantId, membership.tenant.code, user.userBranchRoles);
  }

  /** Settings → General → My Profile — read the caller's own editable + read-only fields. */
  async getMyProfile(userId: string) {
    const user = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, fullName: true, phone: true, avatarUrl: true, createdAt: true },
    });
    return user;
  }

  async updateMyProfile(userId: string, dto: UpdateMyProfileDto) {
    // tenant-scope: system-auth — userId is a verified globally unique identity.
    const user = await this.prisma.appUser.update({
      where: { id: userId },
      data: {
        ...(dto.fullName != null ? { fullName: dto.fullName.trim() } : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
      },
      select: { id: true, email: true, fullName: true, phone: true, avatarUrl: true, createdAt: true },
    });
    return user;
  }

  /** Uploads directly via UploadsService rather than the permission-gated POST /uploads/image
   *  route — that endpoint's `uploads.image` permission excludes `cashier`, and every role
   *  needs to be able to set their own profile photo. */
  async updateMyAvatar(userId: string, file: Express.Multer.File) {
    const { url } = await this.uploadsService.uploadImage(file, "avatars");
    const existing = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    // tenant-scope: system-auth — userId is a verified globally unique identity.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { avatarUrl: url },
    });
    if (existing.avatarUrl && existing.avatarUrl !== url) {
      await this.uploadsService.deleteImage(existing.avatarUrl);
    }
    return { url };
  }

  async removeMyAvatar(userId: string): Promise<void> {
    const existing = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { avatarUrl: true },
    });
    // tenant-scope: system-auth — userId is a verified globally unique identity.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { avatarUrl: null },
    });
    if (existing.avatarUrl) {
      await this.uploadsService.deleteImage(existing.avatarUrl);
    }
  }

  async listMySessions(userId: string) {
    const now = new Date();
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
      orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  async revokeMySession(tenantId: string, userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, tenantId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: SESSION_REVOKED_REASONS.logout },
    });
    if (result.count === 0) {
      throw new BadRequestException("Session was not found or is already signed out");
    }
    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      eventName: "auth.session_revoked",
      entityName: "session",
      entityId: sessionId,
    });
  }

  /** Self-service password change. Verifies the current password, enforces the tenant's
   *  password policy, then hard-revokes every session (already-built hook, see
   *  `revokeAllSessions`) so the user must sign back in everywhere — including this device. */
  async changePassword(tenantId: string, userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.appUser.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });

    const currentValid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!currentValid) {
      throw new UnauthorizedException("Current password is incorrect");
    }

    const policy = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { passwordMinLength: true },
    });
    const minLength = policy?.passwordMinLength ?? 8;

    if (dto.newPassword.length < minLength) {
      throw new BadRequestException(`Password must be at least ${minLength} characters`);
    }
    const newHash = await bcrypt.hash(dto.newPassword, 10);
    // tenant-scope: system-auth — userId is a verified globally unique identity.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { passwordHash: newHash },
    });

    await this.revokeAllSessions(userId, "password_changed");

    await this.auditService.log({
      tenantId,
      actorUserId: userId,
      eventName: "auth.password_changed",
      entityName: "app_user",
      entityId: userId,
    });
  }

  // ---------------------------------------------------------------------------
  // Token TTL accessors (used by the controller for cookie maxAge)
  // ---------------------------------------------------------------------------

  getAccessTtlSeconds(): number {
    return Number(this.configService.get("JWT_ACCESS_TTL_SECONDS", 900));
  }

  getRefreshTtlSeconds(): number {
    return Number(this.configService.get("JWT_REFRESH_TTL_SECONDS", 1209600));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async issueAndPersist(args: {
    user: AppUser;
    tenantId: string;
    tenantCode?: string;
    branchRoles: Array<{ branchId: string; role: RoleName }>;
    previousSession: Session | null;
    meta: RequestMeta;
  }): Promise<LoginResult> {
    const refreshTtl = this.getRefreshTtlSeconds();
    const accessTtl = this.getAccessTtlSeconds();

    // Pre-sign a placeholder refresh token using the eventual session id.
    // We must know the session id *before* signing because it's in the payload.
    // Strategy: create session first with a temporary hash, then sign the real
    // refresh token, then update the row with the real hash — all in one tx.
    const result = await this.prisma.$transaction(async (tx) => {
      const familyId = args.previousSession?.familyId;
      const placeholder = randomBytes(32).toString("hex");
      const tempHash = await bcrypt.hash(placeholder, 4); // low cost — replaced immediately

      const session = await tx.session.create({
        data: {
          tenantId: args.tenantId,
          userId: args.user.id,
          familyId: familyId ?? cryptoRandomUuid(),
          refreshTokenHash: tempHash,
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
          userAgent: args.meta.userAgent ?? null,
          ipAddress: args.meta.ipAddress ?? null,
        },
      });

      const refreshPayload: RefreshTokenPayload = {
        sub: args.user.id,
        tenantId: args.tenantId,
        sessionId: session.id,
        familyId: session.familyId,
        type: "refresh",
      };
      const refreshToken = await this.jwtService.signAsync(refreshPayload, {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
        expiresIn: refreshTtl,
      });

      const realHash = await bcrypt.hash(refreshToken, 10);
      await tx.session.update({
        where: { id: session.id, tenantId: args.tenantId },
        data: { refreshTokenHash: realHash, lastUsedAt: new Date() },
      });

      if (args.previousSession) {
        await tx.session.update({
          where: { id: args.previousSession.id, tenantId: args.previousSession.tenantId },
          data: {
            revokedAt: new Date(),
            revokedReason: SESSION_REVOKED_REASONS.rotated,
            replacedById: session.id,
            lastUsedAt: new Date(),
          },
        });
      }

      const accessPayload: AccessTokenPayload = {
        sub: args.user.id,
        tenantId: args.tenantId,
        tokenVersion: args.user.tokenVersion,
        type: "access",
      };
      const accessToken = await this.jwtService.signAsync(accessPayload, {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
        expiresIn: accessTtl,
      });

      // tenant-scope: system-auth — session issuance already verified the active membership.
      await tx.appUser.update({
        where: { id: args.user.id },
        data: { lastTenantId: args.tenantId },
      });

      return { accessToken, refreshToken };
    });

    // Invalidate the in-process user-context cache so the next request sees
    // the freshly-loaded user (e.g. in case roles were just changed).
    this.userContext.invalidate(args.user.id);

    const csrfToken = randomBytes(32).toString("hex");

    return {
      ...result,
      csrfToken,
      accessTtlSeconds: accessTtl,
      refreshTtlSeconds: refreshTtl,
      user: this.mapUser(args.user, args.tenantId, args.tenantCode, args.branchRoles),
    };
  }

  private async verifyRefreshTokenSignature(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwtService.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.configService.getOrThrow<string>("JWT_REFRESH_SECRET"),
      });
      if (payload.type !== "refresh" || !payload.sessionId || !payload.familyId) {
        throw new UnauthorizedException("Invalid refresh token");
      }
      return payload;
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }

  private async bumpTokenVersion(userId: string): Promise<void> {
    // tenant-scope: system-auth — only refresh-session reuse detection calls this with a verified userId.
    await this.prisma.appUser.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });
    this.userContext.invalidate(userId);
  }

  private mapUser(
    user: AppUser,
    tenantId: string,
    tenantCode: string | undefined,
    branchRoles: Array<{ branchId: string; role: RoleName }>,
  ): AuthUserView {
    const roleSet = new Set<RoleName>(branchRoles.map((entry) => entry.role));
    return {
      id: user.id,
      tenantId,
      tenantCode,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      roles: Array.from(roleSet),
      branchRoles,
    };
  }
}

function cryptoRandomUuid(): string {
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return randomUUID();
}
