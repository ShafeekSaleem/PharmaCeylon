import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { HeldSalesService } from "./held-sales.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { PosService } from "./pos.service";
import { SaleReadService } from "./sale-read.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";
import { SetupModule } from "../setup/setup.module";

@Module({
  imports: [CatalogModule, SetupModule],
  controllers: [SalesController],
  providers: [
    SalesService,
    PosService,
    SaleReadService,
    HeldSalesService,
    PharmacistApprovalService,
  ],
  exports: [SaleReadService],
})
export class SalesModule {}
