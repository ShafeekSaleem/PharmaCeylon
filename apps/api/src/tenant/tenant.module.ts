import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { UploadsModule } from "../uploads/uploads.module";
import { PosRolloutController } from "./pos-rollout.controller";
import { PosRolloutService } from "./pos-rollout.service";
import { TenantController } from "./tenant.controller";
import { TenantService } from "./tenant.service";
import { TenantSettingsController } from "./tenant-settings.controller";
import { TenantSettingsService } from "./tenant-settings.service";

@Module({
  imports: [AuthModule, UploadsModule, NotificationsModule],
  controllers: [TenantController, TenantSettingsController, PosRolloutController],
  providers: [TenantService, TenantSettingsService, PosRolloutService],
})
export class TenantModule {}
