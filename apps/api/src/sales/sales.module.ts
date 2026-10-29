import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module";
import { HeldSalesService } from "./held-sales.service";
import { PharmacistApprovalService } from "./pharmacist-approval.service";
import { PosService } from "./pos.service";
import { RefundRequestsController } from "./refund-requests.controller";
import { RefundRequestsService } from "./refund-requests.service";
import { SaleReadService } from "./sale-read.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";
import { SetupModule } from "../setup/setup.module";
import { OperationalAuthorizationModule } from "../security/operational-authorization.module";

@Module({
  imports: [CatalogModule, SetupModule, OperationalAuthorizationModule],
  // Refund requests first: `/sales/refund-requests` must not reach `GET /sales/:id`.
  controllers: [RefundRequestsController, SalesController],
  providers: [
    SalesService,
    PosService,
    SaleReadService,
    HeldSalesService,
    PharmacistApprovalService,
    RefundRequestsService,
  ],
  exports: [SaleReadService, RefundRequestsService],
})
export class SalesModule {}
