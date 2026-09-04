import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CatalogModule } from "../catalog/catalog.module";
import { ProductsModule } from "../products/products.module";
import { CatalogTaskController } from "./catalog-task.controller";
import { CatalogTaskService } from "./catalog-task.service";

/**
 * Catalog Management's Work Queue. Depends on `ProductsModule` for the register-link service —
 * applying an NMRA task must go through exactly the same code path as linking from the product
 * page, so there is one implementation of the field-ownership policy rather than two.
 */
@Module({
  imports: [AuditModule, CatalogModule, ProductsModule],
  controllers: [CatalogTaskController],
  providers: [CatalogTaskService],
  exports: [CatalogTaskService],
})
export class CatalogTaskModule {}
