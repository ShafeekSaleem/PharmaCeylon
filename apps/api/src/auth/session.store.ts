import { Injectable, Logger } from "@nestjs/common";
import { Prisma, Session } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";

export const SESSION_REVOKED_REASONS = {
  rotated: "rotated",
  logout: "logout",
  logoutAll: "logout_all",
  reuseDetected: "reuse_detected",
  adminInvalidated: "admin_invalidated",
  passwordChanged: "password_changed",
} as const;

export type SessionRevokeReason =
  (typeof SESSION_REVOKED_REASONS)[keyof typeof SESSION_REVOKED_REASONS];

export type CreateSessionInput = {
  tenantId: string;
  userId: string;
  /** If omitted, a new family is started (first session in a chain — typically login). */
  familyId?: string;
  refreshToken: string;
  ttlSeconds: number;
  userAgent?: string | null;
  ipAddress?: string | null;
};

@Injectable()
export class SessionStore {
  private readonly logger = new Logger(SessionStore.name);
  private static readonly REFRESH_HASH_ROUNDS = 10;

  constructor(private readonly prisma: PrismaService) {}

  async create(
    input: CreateSessionInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Session> {
    const db = tx ?? this.prisma;
    const refreshTokenHash = await bcrypt.hash(
      input.refreshToken,
      SessionStore.REFRESH_HASH_ROUNDS,
    );
    return db.session.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        familyId: input.familyId ?? cryptoRandomUuid(),
        refreshTokenHash,
        expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
        userAgent: input.userAgent ?? null,
        ipAddress: input.ipAddress ?? null,
      },
    });
  }

  async findActiveById(sessionId: string): Promise<Session | null> {
    return this.prisma.session.findUnique({ where: { id: sessionId } });
  }

  async matchToken(session: Session, presentedToken: string): Promise<boolean> {
    return bcrypt.compare(presentedToken, session.refreshTokenHash);
  }

  /**
   * Rotate a session atomically:
   *   1. Insert a new session in the same family.
   *   2. Mark the old session revoked, `replacedById = new.id`, reason='rotated'.
   *
   * If the caller later detects something wrong (signature, expiry, etc.) the
   * transaction can be rolled back — nothing is left dangling.
   */
  async rotate(args: {
    previous: Session;
    refreshToken: string;
    ttlSeconds: number;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<Session> {
    return this.prisma.$transaction(async (tx) => {
      const created = await this.create(
        {
          tenantId: args.previous.tenantId,
          userId: args.previous.userId,
          familyId: args.previous.familyId,
          refreshToken: args.refreshToken,
          ttlSeconds: args.ttlSeconds,
          userAgent: args.userAgent,
          ipAddress: args.ipAddress,
        },
        tx,
      );
      await tx.session.update({
        where: { id: args.previous.id },
        data: {
          revokedAt: new Date(),
          revokedReason: SESSION_REVOKED_REASONS.rotated,
          replacedById: created.id,
          lastUsedAt: new Date(),
        },
      });
      return created;
    });
  }

  async revokeById(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  /**
   * Revoke every still-live session in a family. Called when a revoked
   * refresh token is presented again (replay/theft) — wiping the family
   * forces re-authentication for every device in that chain.
   */
  async revokeFamily(familyId: string, reason: SessionRevokeReason): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (result.count > 0) {
      this.logger.warn(
        `Revoked ${result.count} session(s) in family ${familyId} (reason=${reason})`,
      );
    }
    return result.count;
  }

  async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** Returns true if the session row is unusable (revoked or past expiry). */
  static isUnusable(session: Session, now = new Date()): boolean {
    return session.revokedAt !== null || session.expiresAt <= now;
  }
}

function cryptoRandomUuid(): string {
  // Node 16+ has crypto.randomUUID; available in all current LTS targets here.
  // Imported lazily to keep this file framework-agnostic.

  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  return randomUUID();
}
