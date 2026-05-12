import type { AuthUser } from "./auth-types";

/**
 * Browser session state.
 *
 * Tokens are NOT stored here anymore — they live in httpOnly cookies set by
 * the API (`pc_access`, `pc_refresh`) and cannot be touched by JS. The only
 * things we keep in localStorage are non-sensitive UI hints: the cached
 * user profile (so we can render the shell before /auth/me resolves) and
 * the currently-selected branch.
 *
 * The CSRF token lives in a NON-httpOnly cookie (`pc_csrf`) so JS can read
 * it from `document.cookie` and echo it as `X-CSRF-Token`. The browser should
 * call the API through the same origin as the web app (Next.js rewrite to
 * Nest); the cookie uses Path=/ so routes like `/login` can read it.
 */

const USER = "pharmaceylon_user_json";
const BRANCH = "pharmaceylon_branch_id";

const CSRF_COOKIE_NAME = "pc_csrf";

function emitAuthChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pharmaceylon-auth"));
  }
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

const emptySession = { user: null as AuthUser | null, branchId: null as string | null };

let cachedSession: { user: AuthUser | null; branchId: string | null } = emptySession;
let cachedRawUser: string | null = null;
let cachedRawBranch: string | null = null;

/**
 * Reads session from localStorage. Returns a stable object reference when the
 * stored keys are unchanged — required for `useSyncExternalStore(getSnapshot)`.
 */
export function loadStoredSession(): {
  user: AuthUser | null;
  branchId: string | null;
} {
  if (!canUseStorage()) {
    return emptySession;
  }
  const branchId = localStorage.getItem(BRANCH);
  const rawUser = localStorage.getItem(USER);
  if (rawUser === cachedRawUser && branchId === cachedRawBranch) {
    return cachedSession;
  }
  cachedRawUser = rawUser;
  cachedRawBranch = branchId;
  let user: AuthUser | null = null;
  if (rawUser) {
    try {
      user = JSON.parse(rawUser) as AuthUser;
    } catch {
      user = null;
    }
  }
  cachedSession = { user, branchId };
  return cachedSession;
}

export function persistUser(user: AuthUser): void {
  if (!canUseStorage()) return;
  localStorage.setItem(USER, JSON.stringify(user));
  emitAuthChanged();
}

export function setBranchId(branchId: string | null): void {
  if (!canUseStorage()) return;
  if (branchId) {
    localStorage.setItem(BRANCH, branchId);
  } else {
    localStorage.removeItem(BRANCH);
  }
  emitAuthChanged();
}

export function getBranchId(): string | null {
  if (!canUseStorage()) return null;
  return localStorage.getItem(BRANCH);
}

export function clearSession(): void {
  if (!canUseStorage()) return;
  localStorage.removeItem(USER);
  localStorage.removeItem(BRANCH);
  emitAuthChanged();
}

/** Read the CSRF token from the cookie jar (same origin as the API rewrite). */
export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie ? document.cookie.split("; ") : [];
  for (const raw of cookies) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const name = raw.slice(0, eq);
    if (name === CSRF_COOKIE_NAME) {
      return decodeURIComponent(raw.slice(eq + 1));
    }
  }
  return null;
}
