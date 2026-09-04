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
import { ProductNmraLinkController } from "./product-nmra-link.controller";
import { ProductNmraLinkService } from "./product-nmra-link.service";
import { ProductOrganizeService } from "./product-organize.service";
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
    ProductNmraLinkController,
  ],
  providers: [
    ProductsService,
    ProductMetaService,
    ProductOrganizeService,
    ProductNmraLinkService,
    NmraImportService,
  ],
  exports: [ProductsService, ProductMetaService, ProductOrganizeService, ProductNmraLinkService],
})
export class ProductsModule {}
