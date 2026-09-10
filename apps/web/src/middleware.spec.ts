/**
 * @jest-environment node
 */
// `next/server` needs the Fetch API globals (Request/Response), which the
// project's default jsdom environment does not provide. Node supplies them
// natively, and middleware is server code anyway.
import { NextRequest } from "next/server";
import { middleware } from "./middleware";

/**
 * Password recovery shipped behind the auth gate: `/forgot-password` was not in
 * `PUBLIC_PATHS`, so a signed-out visitor was redirected to
 * `/login?redirect=/forgot-password` — the page was unreachable by exactly the
 * people who need it, and only appeared *after* signing in.
 *
 * These tests pin the allowlist so a new auth-adjacent route can't regress the
 * same way.
 */
function req(pathname: string, opts: { signedIn?: boolean } = {}) {
  const request = new NextRequest(new URL(`http://localhost:3000${pathname}`));
  if (opts.signedIn) request.cookies.set("pc_csrf", "token");
  return request;
}

/** Middleware returns `NextResponse.next()` (200) or a redirect (307/308). */
function isPassThrough(res: Response): boolean {
  return !res.headers.get("location");
}

function redirectTarget(res: Response): string | null {
  const loc = res.headers.get("location");
  return loc ? new URL(loc).pathname + new URL(loc).search : null;
}

describe("middleware auth gate", () => {
  describe("password recovery is reachable signed out", () => {
    it("lets /forgot-password through", () => {
      expect(isPassThrough(middleware(req("/forgot-password")))).toBe(true);
    });

    it("lets a /reset-password/:token link through", () => {
      expect(
        isPassThrough(middleware(req("/reset-password/abc123-token"))),
      ).toBe(true);
    });
  });

  describe("the other unauthenticated entry points still work", () => {
    it.each(["/login", "/register", "/verify-email", "/invite/some-token"])(
      "lets %s through",
      (path) => {
        expect(isPassThrough(middleware(req(path)))).toBe(true);
      },
    );
  });

  describe("protected routes still redirect", () => {
    it("bounces /dashboard to login with a redirect back", () => {
      const res = middleware(req("/dashboard"));
      expect(redirectTarget(res)).toBe("/login?redirect=%2Fdashboard");
    });

    it("bounces a deep app route", () => {
      const res = middleware(req("/products/manage"));
      expect(redirectTarget(res)).toBe("/login?redirect=%2Fproducts%2Fmanage");
    });

    it("lets a signed-in user reach /dashboard", () => {
      expect(isPassThrough(middleware(req("/dashboard", { signedIn: true })))).toBe(
        true,
      );
    });
  });

  describe("root", () => {
    it("sends a signed-out visitor to login", () => {
      expect(redirectTarget(middleware(req("/")))).toBe("/login");
    });

    it("sends a signed-in visitor to the dashboard", () => {
      expect(redirectTarget(middleware(req("/", { signedIn: true })))).toBe(
        "/dashboard",
      );
    });
  });

  describe("onboarding", () => {
    it("requires the onboarding cookie", () => {
      expect(redirectTarget(middleware(req("/onboarding/pharmacy")))).toBe(
        "/login",
      );
    });
  });
});
