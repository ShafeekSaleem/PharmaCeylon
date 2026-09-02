import type { CookieOptions, Response } from "express";
import type { ConfigService } from "@nestjs/config";

export const ACCESS_COOKIE = "pc_access";
export const REFRESH_COOKIE = "pc_refresh";
export const CSRF_COOKIE = "pc_csrf";
export const ONBOARDING_COOKIE = "pc_onboarding";

/**
 * Cookie scope rules:
 * - access cookie is sent on every API call → Path = `/api/v1`
 * - refresh cookie is only needed by /auth/refresh and /auth/logout → Path = `/api/v1/auth`
 *   (limits exposure: refresh never leaks to non-auth endpoints)
 * - csrf cookie uses Path=/ so the SPA can read it from `document.cookie` on
 *   any app route (e.g. `/login`) while still being sent on `/api/v1/*` requests.
 */
export const ACCESS_COOKIE_PATH = "/api/v1";
export const REFRESH_COOKIE_PATH = "/api/v1/auth";
export const CSRF_COOKIE_PATH = "/";
export const ONBOARDING_COOKIE_PATH = "/";

export type SameSiteMode = "lax" | "strict" | "none";

export type CookieEnv = {
  secure: boolean;
  sameSite: SameSiteMode;
  domain?: string;
};

export function readCookieEnv(config: ConfigService): CookieEnv {
  const rawSameSite = (config.get<string>("COOKIE_SAMESITE") ?? "lax").toLowerCase();
  const sameSite: SameSiteMode =
    rawSameSite === "strict" || rawSameSite === "none" ? rawSameSite : "lax";
  const secure = String(config.get<string>("COOKIE_SECURE") ?? "false").toLowerCase() === "true";
  const domain = config.get<string>("COOKIE_DOMAIN") || undefined;

  if (sameSite === "none" && !secure) {
    // `SameSite=None` requires `Secure` per spec — most browsers reject the cookie otherwise.
    // Fail loudly in misconfigured prod rather than silently dropping cookies.
    throw new Error("COOKIE_SAMESITE=none requires COOKIE_SECURE=true");
  }

  return { secure, sameSite, domain };
}

function baseOptions(env: CookieEnv, path: string, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: env.secure,
    sameSite: env.sameSite,
    domain: env.domain,
    path,
    maxAge: maxAgeMs,
  };
}

export function setAccessCookie(
  res: Response,
  env: CookieEnv,
  token: string,
  ttlSeconds: number,
) {
  res.cookie(ACCESS_COOKIE, token, baseOptions(env, ACCESS_COOKIE_PATH, ttlSeconds * 1000));
}

export function setRefreshCookie(
  res: Response,
  env: CookieEnv,
  token: string,
  ttlSeconds: number,
) {
  res.cookie(REFRESH_COOKIE, token, baseOptions(env, REFRESH_COOKIE_PATH, ttlSeconds * 1000));
}

/**
 * CSRF cookie is intentionally NOT httpOnly — JS reads it and echoes it as
 * `X-CSRF-Token`. The cookie itself can't be forged cross-site; the header
 * cannot be set on cross-site form submits, so the equality check blocks CSRF.
 */
export function setCsrfCookie(
  res: Response,
  env: CookieEnv,
  token: string,
  ttlSeconds: number,
) {
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: env.secure,
    sameSite: env.sameSite,
    domain: env.domain,
    path: CSRF_COOKIE_PATH,
    maxAge: ttlSeconds * 1000,
  });
}

export function setOnboardingCookie(
  res: Response,
  env: CookieEnv,
  token: string,
  ttlSeconds: number,
) {
  res.cookie(
    ONBOARDING_COOKIE,
    token,
    baseOptions(env, ONBOARDING_COOKIE_PATH, ttlSeconds * 1000),
  );
}

export function clearOnboardingCookie(res: Response, env: CookieEnv) {
  res.clearCookie(ONBOARDING_COOKIE, {
    secure: env.secure,
    sameSite: env.sameSite,
    domain: env.domain,
    httpOnly: true,
    path: ONBOARDING_COOKIE_PATH,
  });
}

export function clearAuthCookies(res: Response, env: CookieEnv) {
  const common = {
    secure: env.secure,
    sameSite: env.sameSite,
    domain: env.domain,
  };
  res.clearCookie(ACCESS_COOKIE, { ...common, httpOnly: true, path: ACCESS_COOKIE_PATH });
  res.clearCookie(REFRESH_COOKIE, { ...common, httpOnly: true, path: REFRESH_COOKIE_PATH });
  res.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false, path: CSRF_COOKIE_PATH });
}
