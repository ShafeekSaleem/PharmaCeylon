import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";

@Module({
  imports: [CatalogModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
