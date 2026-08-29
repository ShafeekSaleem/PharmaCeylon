import { Module } from "@nestjs/common";
import { TenantController } from "./tenant.controller";
import { TenantService } from "./tenant.service";
import { TenantSettingsController } from "./tenant-settings.controller";
import { TenantSettingsService } from "./tenant-settings.service";

@Module({
  controllers: [TenantController, TenantSettingsController],
  providers: [TenantService, TenantSettingsService],
})
export class TenantModule {}
