import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { ReportSyncFreshnessService } from "./report-sync-freshness.service";
import { SalesReportScopeService } from "./sales-report-scope.service";
import { ShiftCashReportService } from "./shift-cash-report.service";
import { CardAttemptsReportService } from "./card-attempts-report.service";
import { RefundAuthorizationsReportService } from "./refund-authorizations-report.service";
import { OfflineActivityReportService } from "./offline-activity-report.service";
import { StockDiscrepancyReportService } from "./stock-discrepancy-report.service";

@Module({
  imports: [CatalogModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportSyncFreshnessService,
    SalesReportScopeService,
    ShiftCashReportService,
    CardAttemptsReportService,
    RefundAuthorizationsReportService,
    OfflineActivityReportService,
    StockDiscrepancyReportService,
  ],
})
export class ReportsModule {}
