import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { UploadsModule } from "../uploads/uploads.module";
import { AuthController } from "./auth.controller";
import { OwnerRegistrationController } from "./owner-registration.controller";
import { AuthService } from "./auth.service";
import { OwnerRegistrationService } from "./owner-registration.service";
import { SessionStore } from "./session.store";
import { VerificationEmailService } from "./verification-email.service";
import { UserContextService } from "./user-context.service";

@Module({
  imports: [
    JwtModule.register({
      global: true,
    }),
    UploadsModule,
  ],
  controllers: [AuthController, OwnerRegistrationController],
  providers: [
    AuthService,
    OwnerRegistrationService,
    SessionStore,
    UserContextService,
    VerificationEmailService,
  ],
  exports: [AuthService, OwnerRegistrationService, SessionStore, UserContextService, JwtModule],
})
export class AuthModule {}
