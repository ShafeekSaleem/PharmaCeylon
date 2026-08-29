/// <reference types="multer" />
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileInterceptor } from "@nestjs/platform-express";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { Public } from "../security/decorators/public.decorator";
import { CurrentUser } from "../security/decorators/current-user.decorator";
import { AuthService } from "./auth.service";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  readCookieEnv,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "./cookies";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { UpdateMyProfileDto } from "./dto/update-my-profile.dto";
import { RequestUser } from "../security/interfaces/authenticated-request.interface";

type CookieAwareRequest = Request & {
  cookies?: Record<string, string>;
};

@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post("login")
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(dto, requestMeta(req));
    this.writeAuthCookies(res, result);
    return this.toBodyResponse(result);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("refresh")
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: CookieAwareRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = dto.refreshToken ?? req.cookies?.[REFRESH_COOKIE];
    if (!token) {
      throw new UnauthorizedException("Missing refresh token");
    }
    const result = await this.authService.refresh(token, requestMeta(req));
    this.writeAuthCookies(res, result);
    return this.toBodyResponse(result);
  }

  /**
   * Single-device logout. Revokes the current refresh session and clears cookies.
   * Idempotent: silently succeeds even with no/expired refresh token.
   *
   * Auth is required (via JwtAuthGuard) so a CSRF / drive-by request can't
   * log someone out. The session to revoke is identified by reading the
   * refresh token from cookie or body.
   */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post("logout")
  async logout(
    @CurrentUser() _user: RequestUser,
    @Body() dto: RefreshTokenDto | undefined,
    @Req() req: CookieAwareRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = dto?.refreshToken ?? req.cookies?.[REFRESH_COOKIE] ?? null;
    await this.authService.logout(refreshToken);
    clearAuthCookies(res, readCookieEnv(this.configService));
  }

  /** Revoke every session for the user (everywhere) and bump tokenVersion. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post("logout-all")
  async logoutAll(
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user.userId);
    clearAuthCookies(res, readCookieEnv(this.configService));
  }

  @Get("me")
  me(@CurrentUser() user: RequestUser) {
    return this.authService.getMe(user.userId);
  }

  /**
   * Settings → General → My Profile. Self-scoped, no `@RequirePermission` — every
   * authenticated user (any role) can view/edit their own profile, same posture as `GET /auth/me`.
   */
  @Get("me/profile")
  getMyProfile(@CurrentUser() user: RequestUser) {
    return this.authService.getMyProfile(user.userId);
  }

  @Patch("me/profile")
  updateMyProfile(@CurrentUser() user: RequestUser, @Body() dto: UpdateMyProfileDto) {
    return this.authService.updateMyProfile(user.userId, dto);
  }

  @UseInterceptors(FileInterceptor("file"))
  @Post("me/avatar")
  updateMyAvatar(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.authService.updateMyAvatar(user.userId, file);
  }

  /** Hard-revokes every session (including this one) — the frontend should redirect to
   *  /login on success; the access token this request used is now dead. */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post("me/change-password")
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.changePassword(user.tenantId, user.userId, dto);
    clearAuthCookies(res, readCookieEnv(this.configService));
  }

  // ---------------------------------------------------------------------------

  private writeAuthCookies(
    res: Response,
    tokens: {
      accessToken: string;
      refreshToken: string;
      csrfToken: string;
      accessTtlSeconds: number;
      refreshTtlSeconds: number;
    },
  ) {
    const env = readCookieEnv(this.configService);
    setAccessCookie(res, env, tokens.accessToken, tokens.accessTtlSeconds);
    setRefreshCookie(res, env, tokens.refreshToken, tokens.refreshTtlSeconds);
    setCsrfCookie(res, env, tokens.csrfToken, tokens.accessTtlSeconds);
  }

  /**
   * Body shape preserved for non-browser clients (mobile, scripts). Browser
   * clients should ignore body tokens and rely on cookies — they cannot be
   * stored safely in JS anyway.
   */
  private toBodyResponse(result: Awaited<ReturnType<AuthService["login"]>>) {
    return {
      user: result.user,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      csrfToken: result.csrfToken,
      accessTtlSeconds: result.accessTtlSeconds,
      refreshTtlSeconds: result.refreshTtlSeconds,
    };
  }
}

function requestMeta(req: Request) {
  const ua = req.headers["user-agent"];
  const xff = req.headers["x-forwarded-for"];
  const ip =
    (typeof xff === "string" ? xff.split(",")[0]?.trim() : Array.isArray(xff) ? xff[0] : null) ??
    req.ip ??
    null;
  return {
    userAgent: typeof ua === "string" ? ua : null,
    ipAddress: ip,
  };
}
