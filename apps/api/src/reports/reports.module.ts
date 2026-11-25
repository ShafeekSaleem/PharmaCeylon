import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportSyncFreshnessService } from "./report-sync-freshness.service";
import { SalesReportScopeService } from "./sales-report-scope.service";

@Module({
  imports: [CatalogModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportSyncFreshnessService, SalesReportScopeService],
})
export class ReportsModule {}
