import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export type UserContext = {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  isActive: boolean;
  tokenVersion: number;
  branchRoles: Array<{ branchId: string; role: RoleName; roleId: string | null }>;
};

type CacheEntry = {
  value: UserContext;
  expiresAt: number;
};

/**
 * In-process TTL cache for per-request authorization context.
 *
 * Why not embed roles in the JWT?
 *   - Role/branch changes wouldn't take effect until token expiry.
 *
 * Why cache at all?
 *   - Every authenticated request would otherwise hit the DB twice
 *     (user + branchRoles JOIN). 30s TTL keeps it cheap while still
 *     bounding staleness.
 *
 * Cache is invalidated explicitly via `invalidate(userId)` whenever
 * `tokenVersion` is bumped (role change, password change, logout-all,
 * detected refresh-reuse). The guard *also* validates `tokenVersion` in
 * the JWT against the cached value, so a stale cache cannot grant access
 * after the version has been bumped on another node — once that node's
 * own cache TTL elapses, both nodes converge.
 *
 * For multi-instance deployments swap this implementation for Redis
 * with the same interface; nothing else changes.
 */
@Injectable()
export class UserContextService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ttlMs = Number(config.get("USER_CONTEXT_TTL_SECONDS", 30)) * 1000;
  }

  async load(userId: string): Promise<UserContext | null> {
    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const user = await this.prisma.appUser.findUnique({
      where: { id: userId },
      include: {
        userBranchRoles: { select: { branchId: true, role: true, roleId: true } },
      },
    });
    if (!user) {
      this.cache.delete(userId);
      return null;
    }

    const value: UserContext = {
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
      fullName: user.fullName,
      isActive: user.isActive,
      tokenVersion: user.tokenVersion,
      branchRoles: user.userBranchRoles.map((entry) => ({
        branchId: entry.branchId,
        role: entry.role,
        roleId: entry.roleId,
      })),
    };
    this.cache.set(userId, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Test/diagnostic helper. */
  clearAll(): void {
    this.cache.clear();
  }
}
