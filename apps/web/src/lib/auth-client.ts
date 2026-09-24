import { getApiBaseUrl } from "./api-base";
import { ApiError, parseApiError, parseApiErrorBody } from "./api-error";
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

  // A JSON string body has to say so. Without the header Nest's parser leaves `req.body` empty,
  // and the request comes back as a validation failure on every field ("supplierId must be a
  // UUID, items must be an array") for a payload that was perfectly fine — a confusing enough
  // error that it is worth removing the chance to forget. Uploads pass FormData or a Blob,
  // which set their own content type, so only a string is assumed to be JSON.
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

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

export async function loginRequest(input: { email: string; password: string }): Promise<AuthUser> {
  const body = { email: input.email.trim().toLowerCase(), password: input.password };
  let res: Response;
  try {
    res = await fetch(`${base()}/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw mapNetworkError(err, "login");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiError(text, `Login failed (${res.status})`));
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
    throw new Error(parseApiError(text, `Context failed (${res.status})`));
  }
  return res.json();
}

export type TenantBranch = { id: string; code: string; name: string; city: string | null; timezone: string };

export const BRANCHES_CHANGED_EVENT = "pharmaceylon-branches-changed";

export function notifyBranchesChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(BRANCHES_CHANGED_EVENT));
  }
}

export async function fetchTenantBranches(): Promise<TenantBranch[]> {
  const res = await apiFetch("/tenant/branches");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiError(text, `Branches failed (${res.status})`));
  }
  return (await res.json()) as TenantBranch[];
}

/** Used for the app shell's breadcrumb badge on Settings pages — open read, any role. */
export async function fetchTenantDisplayName(): Promise<string> {
  const res = await apiFetch("/tenant/profile");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(parseApiError(text, `Tenant profile failed (${res.status})`));
  }
  const data = (await res.json()) as { displayName: string };
  return data.displayName;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(
      parseApiError(text, `Request failed (${res.status})`),
      res.status,
      parseApiErrorBody(text),
    );
  }
  if (!text.trim()) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}
