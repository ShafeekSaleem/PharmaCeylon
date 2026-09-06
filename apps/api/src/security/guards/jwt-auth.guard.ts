import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Reflector } from "@nestjs/core";
import { ACCESS_COOKIE } from "../../auth/cookies";
import { AccessTokenPayload } from "../../auth/types/auth-token-payload.type";
import { UserContextService } from "../../auth/user-context.service";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { AuthenticatedRequest } from "../interfaces/authenticated-request.interface";

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

    request.user = {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      email: ctx.email,
      fullName: ctx.fullName,
      branchRoles: ctx.branchRoles,
      authMethod: extracted.method,
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
