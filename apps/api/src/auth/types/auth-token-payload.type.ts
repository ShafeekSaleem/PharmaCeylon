import { RoleName } from "@prisma/client";

export type BranchRolePayload = {
  branchId: string;
  role: RoleName;
};

/**
 * Access tokens are intentionally lean.
 *
 * Authorization data (email, roles, branchRoles) lives in the DB and is fetched
 * per-request by `UserContextService` (with a short in-process TTL cache).
 * That means role/branch changes take effect in ≤ cache TTL without waiting
 * for token expiry — see `AuthService.invalidateUserContext()`,
 * `AuthService.revokeAllSessions()`, and `tokenVersion`.
 */
export type AccessTokenPayload = {
  sub: string;
  tenantId: string;
  /** Bumped on logout-all / role change / refresh-reuse ⇒ invalidates outstanding access tokens. */
  tokenVersion: number;
  type: "access";
  iat?: number;
  exp?: number;
};

/**
 * Refresh tokens are bound to a server-side `Session` row.
 *
 * `sessionId` is the primary lookup key on refresh. `familyId` is the rotation
 * chain — if a revoked session is presented for refresh, every session in the
 * same family is wiped (reuse detection).
 */
export type RefreshTokenPayload = {
  sub: string;
  tenantId: string;
  sessionId: string;
  familyId: string;
  type: "refresh";
  iat?: number;
  exp?: number;
};

export type AnyTokenPayload = AccessTokenPayload | RefreshTokenPayload;
