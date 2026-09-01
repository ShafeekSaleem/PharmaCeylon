import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardLayoutService } from "./dashboard-layout.service";

@Module({
  controllers: [DashboardController],
  providers: [DashboardLayoutService],
})
export class DashboardModule {}
