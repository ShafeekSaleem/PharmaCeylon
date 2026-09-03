/// <reference types="multer" />
import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  UploadedFile,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FileInterceptor } from "@nestjs/platform-express";
import { Public } from "../security/decorators/public.decorator";
import { UploadsService } from "../uploads/uploads.service";
import { CurrentOwnerRegistration } from "./current-owner-registration.decorator";
import { SaveOnboardingDraftDto } from "./dto/save-onboarding-draft.dto";
import { OnboardingDraftService } from "./onboarding-draft.service";
import { OnboardingSessionGuard } from "./onboarding-session.guard";
import { VerifiedOwnerSession } from "./owner-registration.service";
import type { Request, Response } from "express";
import { AuthService } from "./auth.service";
import {
  clearOnboardingCookie,
  readCookieEnv,
  setAccessCookie,
  setCsrfCookie,
  setRefreshCookie,
} from "./cookies";
import { WorkspaceProvisioningService } from "./workspace-provisioning.service";

@Public()
@UseGuards(OnboardingSessionGuard)
@Controller("onboarding")
export class OnboardingDraftController {
  constructor(
    private readonly drafts: OnboardingDraftService,
    private readonly uploads: UploadsService,
    private readonly provisioning: WorkspaceProvisioningService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
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
    this.drafts.assertOpen(owner);
    return this.drafts.save(owner.registrationId, dto);
  }

  @Post("complete")
  async complete(
    @CurrentOwnerRegistration() owner: VerifiedOwnerSession,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const workspace = await this.provisioning.complete(owner);
    const tokens = await this.auth.issueProvisionedSession(
      workspace.userId,
      requestMeta(req),
    );
    const env = readCookieEnv(this.config);
    setAccessCookie(res, env, tokens.accessToken, tokens.accessTtlSeconds);
    setRefreshCookie(res, env, tokens.refreshToken, tokens.refreshTtlSeconds);
    setCsrfCookie(res, env, tokens.csrfToken, tokens.accessTtlSeconds);
    clearOnboardingCookie(res, env);
    return {
      user: tokens.user,
      tenantId: workspace.tenantId,
      branchId: workspace.branchId,
      tenantName: workspace.tenantName,
      branchName: workspace.branchName,
      alreadyCompleted: workspace.alreadyCompleted,
      nextPath: "/get-started",
    };
  }

  @Post("logo")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 2 * 1024 * 1024 } }),
  )
  async uploadLogo(
    @CurrentOwnerRegistration() owner: VerifiedOwnerSession,
    @UploadedFile() file: Express.Multer.File,
  ) {
    this.drafts.assertOpen(owner);
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
    this.drafts.assertOpen(owner);
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

function requestMeta(req: Request) {
  const userAgent = req.headers["user-agent"];
  const forwarded = req.headers["x-forwarded-for"];
  const ipAddress =
    (typeof forwarded === "string"
      ? forwarded.split(",")[0]?.trim()
      : Array.isArray(forwarded)
        ? forwarded[0]
        : null) ??
    req.ip ??
    null;
  return {
    userAgent: typeof userAgent === "string" ? userAgent : null,
    ipAddress,
  };
}
