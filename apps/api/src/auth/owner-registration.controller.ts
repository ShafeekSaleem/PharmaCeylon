import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { Public } from "../security/decorators/public.decorator";
import {
  ONBOARDING_COOKIE,
  readCookieEnv,
  setOnboardingCookie,
} from "./cookies";
import { CreateOwnerRegistrationDto } from "./dto/create-owner-registration.dto";
import { ResendOwnerVerificationDto } from "./dto/resend-owner-verification.dto";
import { VerifyOwnerRegistrationDto } from "./dto/verify-owner-registration.dto";
import { OwnerRegistrationService } from "./owner-registration.service";

type CookieAwareRequest = Request & {
  cookies?: Record<string, string>;
};

@Public()
@Controller("auth/owner-registration")
@UseGuards(ThrottlerGuard)
export class OwnerRegistrationController {
  constructor(
    private readonly registrations: OwnerRegistrationService,
    private readonly config: ConfigService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@Body() dto: CreateOwnerRegistrationDto) {
    return this.registrations.create(dto);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post("resend")
  resend(@Body() dto: ResendOwnerVerificationDto) {
    return this.registrations.resend(dto.email);
  }

  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("verify")
  async verify(
    @Body() dto: VerifyOwnerRegistrationDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.registrations.verify(dto.email, dto.code);
    setOnboardingCookie(
      res,
      readCookieEnv(this.config),
      result.onboardingToken,
      result.ttlSeconds,
    );
    return result.session;
  }

  @Get("status")
  status(@Req() req: CookieAwareRequest) {
    const token = req.cookies?.[ONBOARDING_COOKIE];
    if (!token) {
      throw new UnauthorizedException("Missing onboarding session");
    }
    return this.registrations.status(token);
  }
}
