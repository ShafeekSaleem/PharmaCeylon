import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { timingSafeEqual } from "node:crypto";
import { CSRF_COOKIE } from "../../auth/cookies";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";

/**
 * Double-submit CSRF guard.
 *
 * Only relevant when authentication came from a cookie (browser flow), because
 * that's the only case where a third-party site could trigger an authenticated
 * request without our consent. For `Bearer` auth, no cookie is auto-sent, so
 * CSRF doesn't apply.
 *
 * Safe methods (GET / HEAD / OPTIONS) are skipped — they must not have
 * side-effects per RFC 9110.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER = "x-csrf-token";

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    // Bearer auth ⇒ no cookies auto-sent ⇒ no CSRF exposure.
    if (request.user?.authMethod !== "cookie") {
      return true;
    }

    const headerValue = request.headers[CSRF_HEADER];
    const header = typeof headerValue === "string" ? headerValue : Array.isArray(headerValue) ? headerValue[0] : "";
    const cookie = request.cookies?.[CSRF_COOKIE] ?? "";

    if (!header || !cookie || !constantTimeEquals(header, cookie)) {
      throw new ForbiddenException("CSRF token missing or invalid");
    }
    return true;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
