import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { Public } from "../security/decorators/public.decorator";
import { CurrentOwnerRegistration } from "./current-owner-registration.decorator";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";
import { OnboardingDraftService } from "./onboarding-draft.service";
import { OnboardingSessionGuard } from "./onboarding-session.guard";
import { VerifiedOwnerSession } from "./owner-registration.service";

@Public()
@UseGuards(OnboardingSessionGuard)
@Controller("onboarding")
export class OnboardingDraftController {
  constructor(private readonly drafts: OnboardingDraftService) {}

  @Get()
  get(@CurrentOwnerRegistration() owner: VerifiedOwnerSession) {
    return this.drafts.get(owner.registrationId);
  }

  @Put()
  save(
    @CurrentOwnerRegistration() owner: VerifiedOwnerSession,
    @Body() dto: SaveOnboardingDraftDto,
  ) {
    return this.drafts.save(owner.registrationId, dto);
  }
}
