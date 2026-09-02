/// <reference types="multer" />
import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Public } from "../security/decorators/public.decorator";
import { UploadsService } from "../uploads/uploads.service";
import { CurrentOwnerRegistration } from "./current-owner-registration.decorator";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";
import { OnboardingDraftService } from "./onboarding-draft.service";
import { OnboardingSessionGuard } from "./onboarding-session.guard";
import { VerifiedOwnerSession } from "./owner-registration.service";

@Public()
@UseGuards(OnboardingSessionGuard)
@Controller("onboarding")
export class OnboardingDraftController {
  constructor(
    private readonly drafts: OnboardingDraftService,
    private readonly uploads: UploadsService,
  ) {}

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

  @Post("logo")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 2 * 1024 * 1024 } }),
  )
  async uploadLogo(
    @CurrentOwnerRegistration() owner: VerifiedOwnerSession,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const current = await this.drafts.get(owner.registrationId);
    const uploaded = await this.uploads.uploadImage(file, "onboarding-logos");

    try {
      await this.drafts.save(owner.registrationId, {
        ...current.draft,
        businessLogoUrl: uploaded.url,
      });
    } catch (error) {
      await this.uploads.deleteImage(uploaded.url);
      throw error;
    }

    if (isOnboardingLogo(current.draft.businessLogoUrl)) {
      await this.uploads.deleteImage(current.draft.businessLogoUrl);
    }
    return uploaded;
  }

  @Delete("logo")
  async removeLogo(@CurrentOwnerRegistration() owner: VerifiedOwnerSession) {
    const current = await this.drafts.get(owner.registrationId);
    await this.drafts.save(owner.registrationId, {
      ...current.draft,
      businessLogoUrl: null,
    });
    if (isOnboardingLogo(current.draft.businessLogoUrl)) {
      await this.uploads.deleteImage(current.draft.businessLogoUrl);
    }
    return { url: null };
  }
}

function isOnboardingLogo(value: unknown): value is string {
  return (
    typeof value === "string" && value.startsWith("/uploads/onboarding-logos/")
  );
}
