import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { OnboardingRequest } from "./onboarding-session.guard";

export const CurrentOwnerRegistration = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<OnboardingRequest>().ownerRegistration,
);
