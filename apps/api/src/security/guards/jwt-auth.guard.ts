import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { ACCESS_COOKIE } from "../../auth/cookies";
import { AccessTokenPayload } from "../../auth/types/auth-token-payload.type";
import { UserContextService } from "../../auth/user-context.service";
import { COUNTER_ROUTE_KEY } from "../decorators/counter-route.decorator";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import {
  AuthenticatedRequest,
  RequestUser,
} from "../interfaces/authenticated-request.interface";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly reflector: Reflector,
    private readonly userContext: UserContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const extracted = this.extractToken(request);
    if (!extracted) {
      throw new UnauthorizedException("Missing access token");
    }

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(extracted.token, {
        secret: this.configService.getOrThrow<string>("JWT_ACCESS_SECRET"),
      });
    } catch {
      throw new UnauthorizedException("Invalid access token");
    }

    if (payload.type !== "access") {
      throw new UnauthorizedException("Invalid access token");
    }

    // Fetch fresh authorization context — bounded staleness via TTL cache.
    const ctx = await this.userContext.load(payload.sub, payload.tenantId);
    if (!ctx || !ctx.isActive) {
      throw new UnauthorizedException("User not found or inactive");
    }

    // Stateless invalidation: any bump in tokenVersion makes outstanding
    // access tokens unusable. The DB is the source of truth; the JWT only
    // proves the bearer knew it at issue time.
    if (ctx.tokenVersion !== payload.tokenVersion) {
      throw new UnauthorizedException("Access token superseded");
    }

    if (ctx.tenantId !== payload.tenantId) {
      // Defence in depth — should be impossible without DB tampering.
      throw new UnauthorizedException("Tenant mismatch");
    }

    // A PIN opened this login at a counter: it is good for that counter's routes only, and only
    // while its staff session is open. 403 for the route, so the client does not refresh; 401
    // once the session has ended, so its refresh fails too and the counter signs out.
    let counter: RequestUser["counter"];
    if (payload.counterSessionId !== undefined) {
      const counterRoute = this.reflector.getAllAndOverride<boolean>(
        COUNTER_ROUTE_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!counterRoute) {
        throw new ForbiddenException({
          code: "COUNTER_SESSION_ONLY",
          message: "Sign in with your email and password to do this.",
        });
      }
      const open = await this.userContext.openCounterSession(
        payload.counterSessionId,
        ctx.userId,
        ctx.tenantId,
      );
      if (!open) {
        throw new UnauthorizedException("Counter session ended");
      }
      counter = {
        workSessionId: payload.counterSessionId,
        branchId: open.branchId,
      };
    }

    request.user = {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      email: ctx.email,
      fullName: ctx.fullName,
      branchRoles: ctx.branchRoles,
      authMethod: extracted.method,
      tokenVersion: payload.tokenVersion,
      ...(counter ? { counter } : {}),
    };

    return true;
  }

  private extractToken(
    request: AuthenticatedRequest,
  ): { token: string; method: "cookie" | "bearer" } | null {
    // Prefer explicit Authorization header (mobile, scripts, server-to-server).
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) return { token, method: "bearer" };
    }
    // Fallback to httpOnly cookie (browser flow).
    const cookieToken = request.cookies?.[ACCESS_COOKIE];
    if (cookieToken) {
      return { token: cookieToken, method: "cookie" };
    }
    return null;
  }
}
