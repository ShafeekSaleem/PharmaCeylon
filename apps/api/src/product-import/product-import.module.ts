import { Module } from "@nestjs/common";
import { ProductImportController } from "./product-import.controller";
import { ProductImportService } from "./product-import.service";

/** "Bring your own product list" import: products plus optional opening stock, in one file. */
@Module({
  controllers: [ProductImportController],
  providers: [ProductImportService],
  exports: [ProductImportService],
})
export class ProductImportModule {}
