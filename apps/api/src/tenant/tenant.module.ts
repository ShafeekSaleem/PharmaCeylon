import { Module } from "@nestjs/common";
import {
  CounterGrantSettingsController,
  CounterPolicyController,
} from "./counter-policy.controller";
import { CounterGrantSettingsService } from "./counter-grant-settings.service";
import { CounterPolicyService } from "./counter-policy.service";
import { AuthModule } from "../auth/auth.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { UploadsModule } from "../uploads/uploads.module";
import { BranchHoursController } from "./branch-hours.controller";
import { BranchHoursService } from "./branch-hours.service";
import { HolidaySuggestionsSource } from "./holiday-suggestions";
import { PosRolloutController } from "./pos-rollout.controller";
import { PosRolloutService } from "./pos-rollout.service";
import { TenantController } from "./tenant.controller";
import { TenantService } from "./tenant.service";
import { TenantSettingsController } from "./tenant-settings.controller";
import { TenantSettingsService } from "./tenant-settings.service";

@Module({
  imports: [AuthModule, UploadsModule, NotificationsModule],
  controllers: [
    TenantController,
    TenantSettingsController,
    BranchHoursController,
    PosRolloutController,
    CounterPolicyController,
    CounterGrantSettingsController,
  ],
  providers: [
    TenantService,
    TenantSettingsService,
    BranchHoursService,
    HolidaySuggestionsSource,
    PosRolloutService,
    CounterPolicyService,
    CounterGrantSettingsService,
  ],
})
export class TenantModule {}
