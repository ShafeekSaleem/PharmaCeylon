import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { UploadsModule } from "../uploads/uploads.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionStore } from "./session.store";
import { UserContextService } from "./user-context.service";

@Module({
  imports: [
    JwtModule.register({
      global: true,
    }),
    UploadsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionStore, UserContextService],
  exports: [AuthService, SessionStore, UserContextService, JwtModule],
})
export class AuthModule {}
