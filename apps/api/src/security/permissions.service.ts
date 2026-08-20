import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { RoleName } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { defaultPermissionsForRole } from "./permission-catalog";

export type PermissionCandidate = {
  role: RoleName;
  roleId?: string | null;
};

type CacheEntry = {
  value: Set<string>;
  expiresAt: number;
};

/**
 * Resolves permission keys granted by a `Role`, with an in-process TTL cache
 * (same shape/rationale as `UserContextService`). Invalidated explicitly
 * whenever an admin edits a role's grants — see `RolesAdminService`.
 *
 * A candidate with no `roleId` (a `UserBranchRole` row created before this
 * tenant had seeded `Role` rows, or a test that mocks `UserContextService`
 * directly) falls back to the static built-in default matrix in
 * `permission-catalog.ts` — the exact set the old `@Roles(...)` decorators
 * encoded — so behavior for the 6 built-in roles never regresses even if a
 * DB row is missing.
 */
@Injectable()
export class PermissionsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ttlMs = Number(config.get("USER_CONTEXT_TTL_SECONDS", 30)) * 1000;
  }

  async getPermissionsForRole(roleId: string): Promise<Set<string>> {
    const now = Date.now();
    const cached = this.cache.get(roleId);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const rows = await this.prisma.rolePermission.findMany({
      where: { roleId },
      select: { permissionKey: true },
    });
    const value = new Set(rows.map((r) => r.permissionKey));
    this.cache.set(roleId, { value, expiresAt: now + this.ttlMs });
    return value;
  }

  async resolveGrantedKeys(candidates: PermissionCandidate[]): Promise<Set<string>> {
    const granted = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.roleId) {
        for (const key of await this.getPermissionsForRole(candidate.roleId)) {
          granted.add(key);
        }
      } else {
        for (const key of defaultPermissionsForRole(candidate.role)) {
          granted.add(key);
        }
      }
    }
    return granted;
  }

  async hasAnyPermission(
    candidates: PermissionCandidate[],
    requiredKeys: string[],
  ): Promise<boolean> {
    const granted = await this.resolveGrantedKeys(candidates);
    return requiredKeys.some((key) => granted.has(key));
  }

  invalidateRole(roleId: string): void {
    this.cache.delete(roleId);
  }

  /** Test/diagnostic helper. */
  clearAll(): void {
    this.cache.clear();
  }
}
