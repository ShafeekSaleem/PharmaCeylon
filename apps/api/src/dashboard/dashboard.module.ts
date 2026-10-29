import { Module } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardLayoutService } from "./dashboard-layout.service";
import { DailyWorkService } from "./daily-work.service";
import { DashboardMetricsService } from "./dashboard-metrics.service";

@Module({
  controllers: [DashboardController],
  providers: [
    DashboardLayoutService,
    DailyWorkService,
    DashboardMetricsService,
  ],
  exports: [DailyWorkService],
})
export class DashboardModule {}
