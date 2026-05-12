import { getApiBaseUrl } from "./api-base";
import type { AuthResponse, AuthUser } from "./auth-types";
import { clearSession, getBranchId, persistUser, readCsrfToken } from "./auth-session";

const base = () => getApiBaseUrl();

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Build outgoing headers for an authenticated request.
 *
 * - `credentials: "include"` (set on the fetch call) ensures the browser
 *   sends httpOnly auth cookies on same-origin `/api/v1` requests.
 * - For mutating requests we echo the `pc_csrf` cookie value as
 *   `X-CSRF-Token` (same-origin API via Next rewrite so JS can read it).
 * - `x-branch-id` selects the active branch for the request.
 */
function buildHeaders(method: string, init: RequestInit): Headers {
  const headers = new Headers(init.headers);

  const branch = getBranchId();
  if (branch) {
    headers.set("x-branch-id", branch);
  }

  if (!SAFE_METHODS.has(method.toUpperCase())) {
    const csrf = readCsrfToken();
    if (csrf) {
      headers.set("X-CSRF-Token", csrf);
    }
  }

  return headers;
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${base()}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        // No body — the refresh token rides in pc_refresh cookie.
        // (For non-browser clients you'd send { refreshToken } in the body.)
        body: "{}",
      });
      if (!res.ok) {
        return false;
      }
      const data = (await res.json()) as AuthResponse;
      persistUser(data.user);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

function mapNetworkError(err: unknown, action: string): Error {
  const url = `${base()}/auth/${action}`;
  // fetch() rejects with TypeError on DNS / connection refused / TLS / CORS-preflight abort, etc.
  if (err instanceof TypeError) {
    return new Error(
      `Cannot reach the API at ${url}. With the default setup, NEXT_PUBLIC_API_BASE_URL should ` +
        `point at this Next app (e.g. http://localhost:3000/api/v1) and Nest should be reachable ` +
        `at API_PROXY_TARGET (see apps/web/next.config.ts).`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function loginRequest(input: {
  tenantCode: string;
  email: string;
  password: string;
}): Promise<AuthUser> {
  let res: Response;
  try {
    res = await fetch(`${base()}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw mapNetworkError(err, "login");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Login failed (${res.status})`);
  }
  const data = (await res.json()) as AuthResponse;
  persistUser(data.user);
  return data.user;
}

/** Single-device logout. Best-effort: clears local state regardless of network outcome. */
export async function logoutRequest(): Promise<void> {
  try {
    await fetch(`${base()}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders("POST", {}),
    });
  } catch {
    // Ignore — we always clear locally.
  } finally {
    clearSession();
  }
}

/** Sign out from every device + bump tokenVersion. */
export async function logoutAllRequest(): Promise<void> {
  try {
    await fetch(`${base()}/auth/logout-all`, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders("POST", {}),
    });
  } catch {
    // Ignore.
  } finally {
    clearSession();
  }
}

/** Authenticated fetch with cookies + optional `x-branch-id`. Auto-refreshes once on 401. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const url = `${base()}${normalized}`;
  const method = (init.method ?? "GET").toUpperCase();

  const doFetch = () =>
    fetch(url, {
      ...init,
      method,
      credentials: "include",
      headers: buildHeaders(method, init),
    });

  let res = await doFetch();

  if (res.status === 401 && normalized !== "/auth/refresh" && normalized !== "/auth/login") {
    const ok = await refreshAccessToken();
    if (ok) {
      res = await doFetch();
    } else {
      clearSession();
    }
  }
  return res;
}

export async function fetchMe(): Promise<AuthUser> {
  const res = await apiFetch("/auth/me");
  if (!res.ok) {
    throw new Error("Failed to load profile");
  }
  return (await res.json()) as AuthUser;
}

export async function fetchTenantContext(): Promise<unknown> {
  const res = await apiFetch("/tenant/context");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Context failed (${res.status})`);
  }
  return res.json();
}
