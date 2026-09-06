import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import {
  readCookieEnv,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "../auth/cookies";
import { Public } from "../security/decorators/public.decorator";
import { AcceptStaffInvitationDto } from "./dto/accept-staff-invitation.dto";
import { StaffInvitationsService } from "./staff-invitations.service";

@Public()
@Controller("staff-invitations")
@UseGuards(ThrottlerGuard)
export class StaffInvitationsController {
  constructor(
    private readonly invitations: StaffInvitationsService,
    private readonly config: ConfigService,
  ) {}

  @Get(":token")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  inspect(@Param("token") token: string) {
    return this.invitations.inspect(token);
  }

  @Post(":token/accept")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async accept(
    @Param("token") token: string,
    @Body() dto: AcceptStaffInvitationDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.invitations.accept(token, dto, requestMeta(req));
    const env = readCookieEnv(this.config);
    setAccessCookie(res, env, result.accessToken, result.accessTtlSeconds);
    setRefreshCookie(res, env, result.refreshToken, result.refreshTtlSeconds);
    setCsrfCookie(res, env, result.csrfToken, result.accessTtlSeconds);
    return result;
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
