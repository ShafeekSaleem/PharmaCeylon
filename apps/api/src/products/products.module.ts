import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CatalogModule } from "../catalog/catalog.module";
import {
  BarcodeImportController,
  NmraImportController,
} from "../nmra/nmra-import.controller";
import { NmraImportService } from "../nmra/nmra-import.service";
import { ProductMetaController } from "./product-meta.controller";
import { ProductMetaService } from "./product-meta.service";
import { ProductsController } from "./products.controller";
import { ProductsService } from "./products.service";

/** Products + NMRA/barcode import endpoints. */
@Module({
  imports: [AuditModule, CatalogModule],
  controllers: [
    ProductMetaController,
    NmraImportController,
    BarcodeImportController,
    ProductsController,
  ],
  providers: [ProductsService, ProductMetaService, NmraImportService],
  exports: [ProductsService, ProductMetaService],
})
export class ProductsModule {}
