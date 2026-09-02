import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { ONBOARDING_COOKIE } from "./cookies";
import { OwnerRegistrationService, VerifiedOwnerSession } from "./owner-registration.service";

export type OnboardingRequest = Request & {
  cookies?: Record<string, string>;
  ownerRegistration?: VerifiedOwnerSession;
};

@Injectable()
export class OnboardingSessionGuard implements CanActivate {
  constructor(private readonly registrations: OwnerRegistrationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OnboardingRequest>();
    const token = request.cookies?.[ONBOARDING_COOKIE];
    if (!token) throw new UnauthorizedException("Missing onboarding session");
    request.ownerRegistration = await this.registrations.status(token);
    return true;
  }
}
