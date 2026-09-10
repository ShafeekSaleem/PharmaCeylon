import { NextRequest, NextResponse } from "next/server";

/**
 * Reachable without a session. Password recovery belongs here for the obvious
 * reason: everyone who needs it is locked out, so redirecting to /login first
 * makes the page unreachable by exactly the people it exists for.
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/register",
  "/verify-email",
  "/forgot-password",
]);

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname === "/") {
    const dest = request.cookies.has("pc_csrf") ? "/dashboard" : "/login";
    return NextResponse.redirect(new URL(dest, request.url));
  }

  if (pathname.startsWith("/_next") || pathname.startsWith("/api") || pathname.includes(".")) {
    return NextResponse.next();
  }

  if (
    PUBLIC_PATHS.has(pathname) ||
    pathname.startsWith("/invite/") ||
    // Token-bearing recovery link — the token is the credential.
    pathname.startsWith("/reset-password/")
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/onboarding")) {
    if (request.cookies.has("pc_onboarding")) {
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const hasAuthCookie = request.cookies.has("pc_csrf");
  if (!hasAuthCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
