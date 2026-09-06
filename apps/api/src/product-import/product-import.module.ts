import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { CatalogTaskModule } from "../catalog-tasks/catalog-task.module";
import { ImportJobRunner } from "./import-job-runner";
import { ProductImportController } from "./product-import.controller";
import { ProductImportService } from "./product-import.service";

/** "Bring your own product list" import: products plus optional opening stock, in one file. */
@Module({
  imports: [CatalogModule, CatalogTaskModule],
  controllers: [ProductImportController],
  providers: [ProductImportService, ImportJobRunner],
  exports: [ProductImportService],
})
export class ProductImportModule {}
