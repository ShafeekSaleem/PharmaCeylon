import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { CatalogModule } from "../catalog/catalog.module";
import { UploadsModule } from "../uploads/uploads.module";
import { AuthController } from "./auth.controller";
import { OwnerRegistrationController } from "./owner-registration.controller";
import { OnboardingDraftController } from "./onboarding-draft.controller";
import { AuthService } from "./auth.service";
import { OnboardingDraftService } from "./onboarding-draft.service";
import { OnboardingSessionGuard } from "./onboarding-session.guard";
import { OwnerRegistrationService } from "./owner-registration.service";
import { SessionStore } from "./session.store";
import { VerificationEmailService } from "./verification-email.service";
import { UserContextService } from "./user-context.service";
import { WorkspaceProvisioningService } from "./workspace-provisioning.service";

@Module({
  imports: [
    JwtModule.register({
      global: true,
    }),
    UploadsModule,
    CatalogModule,
  ],
  controllers: [AuthController, OwnerRegistrationController, OnboardingDraftController],
  providers: [
    AuthService,
    OwnerRegistrationService,
    OnboardingDraftService,
    OnboardingSessionGuard,
    SessionStore,
    UserContextService,
    VerificationEmailService,
    WorkspaceProvisioningService,
  ],
  exports: [AuthService, OwnerRegistrationService, SessionStore, UserContextService, JwtModule],
})
export class AuthModule {}
